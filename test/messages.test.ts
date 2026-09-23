import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

/** Shaped like what Claude Code sends: block-based system and messages, client + Anthropic-run tools. */
const claudeRequest = (extra: Record<string, unknown> = {}) => ({
  model: "claude-test",
  max_tokens: 1024,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "what does main.py do?" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…", signature: "sig" },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "main.py" }] }] },
  ],
  tools: [
    {
      name: "Bash",
      description: "Run a shell command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    { name: "ExitPlanMode", description: "Leave plan mode.", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown) =>
    app.request("/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20", authorization: "Bearer oauth" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream };
}

const bash = { tool: { choice: "Bash" }, needs_tool: { noul: 0.9 } };
/** How Claude Code really runs: adaptive thinking, and a cache breakpoint on the newest message. */
const asClaudeCode = { thinking: { type: "adaptive" } };
const cachedTail = {
  messages: [{ role: "user", content: [{ type: "text", text: "list the files", cache_control: { type: "ephemeral" } }] }],
};

describe("POST /v1/messages", () => {
  it("splits block messages into turns Jev can read, skipping thinking", async () => {
    const { post, jev } = setup(bash);
    await post(claudeRequest());

    const { state, questions } = jev.requests[0]!;
    expect(state).toEqual({
      assistant_instructions: "You are Claude Code.",
      conversation: [
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", text: "Let me look." },
        { role: "assistant", tool_calls: [{ tool: "Bash", call_id: "toolu_1", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "Bash", call_id: "toolu_1", content: "main.py" },
      ],
    });
    const tool = questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual(["Bash", "ExitPlanMode", "web_search", NO_TOOL]);
  });

  it("forces Jev's tool when the conversation isn't cached, forwarding subscription headers and query untouched", async () => {
    const { post, upstream } = setup(bash);
    const res = await post(claudeRequest({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }));

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://llm.test/v1/messages?beta=true");
    expect(call.body.tool_choice).toEqual({ type: "tool", name: "Bash", disable_parallel_tool_use: true });
    expect(call.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(call.headers.get("authorization")).toBe("Bearer oauth");
  });

  it.each([
    ["extended thinking is on", asClaudeCode],
    ["the conversation is prompt-cached", cachedTail],
  ])("hints instead of forcing when %s, leaving everything the client sent untouched", async (_name, extra) => {
    const { post, upstream } = setup(bash);
    const body = claudeRequest(extra);
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(res.headers.get("x-jev-gateway-tool")).toBe("Bash");
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.messages.slice(0, -1)).toEqual(body.messages.slice(0, -1));
    const last = sent.messages.at(-1).content;
    expect(last.slice(0, -1)).toEqual(body.messages.at(-1)!.content);
    expect(last.at(-1).text).toContain('"Bash"');
  });

  it("does not hint silence: a confident no-tool answer leaves a hinted request alone", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const body = claudeRequest(asClaudeCode);
    const res = await post(body);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_tool_needed");
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("shortlists a roster too big for one question, then decides among the survivors", async () => {
    const many = Array.from({ length: 280 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing number ${i}.`,
      input_schema: { type: "object", properties: { q: { type: "string" } } },
    }));
    const jev = fakeJev({
      "shard:0": { choice: "tool_7" },
      "shard:1": { choice: "none_of_these" },
      "shard:2": { choice: "tool_200" },
      tool: { choice: "tool_200" },
      needs_tool: { noul: 0.9 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/messages", { method: "POST", body: JSON.stringify(claudeRequest({ ...asClaudeCode, tools: many })) });

    expect(jev.requests).toHaveLength(2);
    expect(Object.keys(jev.requests[0]!.questions)).toEqual(["shard:0", "shard:1", "shard:2"]);
    const final = jev.requests[1]!.questions.tool!;
    expect(final.type === "choice" && Object.keys(final.criteria)).toEqual(["tool_7", "tool_200", NO_TOOL]);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(res.headers.get("x-jev-gateway-tool")).toBe("tool_200");
  });

  it("streams a complete tool_use itself when the tool takes no open-ended input", async () => {
    const { post, upstream } = setup({ tool: { choice: "ExitPlanMode" }, needs_tool: { noul: 0.9 } });
    const res = await post(claudeRequest());
    expect(upstream.calls).toHaveLength(0);

    const events = (await res.text())
      .trim()
      .split("\n\n")
      .map((block) => JSON.parse(block.split("\n")[1]!.replace(/^data: /, "")));
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1].content_block).toMatchObject({ type: "tool_use", name: "ExitPlanMode" });
    expect(events[4].delta.stop_reason).toBe("tool_use");
  });

  it("maps tool_choice any to a required tool and leaves named choices alone", async () => {
    const required = setup(bash);
    await required.post(claudeRequest({ tool_choice: { type: "any" } }));
    const question = required.jev.requests[0]!.questions.tool!;
    expect(question.type === "choice" && NO_TOOL in question.criteria).toBe(false);

    const named = setup(bash);
    await named.post(claudeRequest({ tool_choice: { type: "tool", name: "Bash" } }));
    expect(named.jev.requests).toHaveLength(0);
  });
});

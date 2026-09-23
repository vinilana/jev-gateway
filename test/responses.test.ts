import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

/** Shaped like what Codex sends: function + free-form + provider-run tools, item-based input. */
const codexRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-codex",
  instructions: "You are Codex, a coding agent.",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>sandboxed</permissions>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "what does main.py do?" }] },
    { type: "reasoning", encrypted_content: "gAAAA…", summary: [] },
    { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1", output: "main.py\nREADME.md" },
  ],
  tools: [
    {
      type: "function",
      name: "shell",
      description: "Runs a shell command and returns its output.",
      parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } },
    },
    { type: "custom", name: "apply_patch", description: "Edit files by applying a patch." },
    { type: "function", name: "list_plans", description: "List saved plans.", parameters: { type: "object", properties: {} } },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  stream: true,
  store: false,
  ...extra,
});

/**
 * What Codex 0.154 really sends for its "responses-lite" models (captured with JEV_DEBUG_DUMP_DIR,
 * trimmed): no `tools`, no `instructions` — tools arrive as an `additional_tools` input item grouped
 * into namespaces, and the one that matters is `exec`, a free-form tool that runs JavaScript.
 */
const codexLiteRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-6-astra",
  input: [
    {
      type: "additional_tools",
      id: "at_1",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [
            {
              type: "custom",
              name: "exec",
              description: "Run JavaScript code to orchestrate/compose tool calls",
              format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" },
            },
            {
              type: "function",
              name: "wait",
              description: "Waits on a yielded `exec` cell.",
              strict: false,
              parameters: { type: "object", properties: { cell_id: { type: "string" } }, required: ["cell_id"] },
            },
          ],
        },
        {
          type: "namespace",
          name: "clock",
          description: "Tools for reading and waiting on time.",
          tools: [
            {
              type: "function",
              name: "sleep",
              description: "Pause execution for a specified duration.",
              strict: false,
              parameters: { type: "object", properties: { duration_ms: { type: "number" } }, required: ["duration_ms"] },
            },
          ],
        },
      ],
    },
    { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
    { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "sleep 10 ms, then run echo hi" }] },
    { type: "message", id: "msg_3", role: "assistant", content: [{ type: "output_text", text: "I’ll wait first." }], phase: "commentary" },
    { type: "function_call", id: "fc_1", name: "sleep", namespace: "clock", arguments: '{"duration_ms":10}', call_id: "call_1" },
    { type: "function_call_output", id: "fco_1", call_id: "call_1", output: "slept" },
    { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_2", name: "exec", input: 'text((await tools.exec_command({cmd:"echo hi"})).output);' },
    {
      type: "custom_tool_call_output",
      id: "ctco_1",
      call_id: "call_2",
      output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: "hi\n" }],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  stream: true,
  store: false,
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0], reply?: (body: any) => Response) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream.fetchImpl(input, init);
    return reply?.(upstream.calls.at(-1)!.body) ?? response;
  }) as typeof fetch;
  const logged: Record<string, unknown>[] = [];
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: fetchImpl, log: (entry) => logged.push(entry) });
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { post, jev, upstream, logged };
}

describe("POST /v1/responses", () => {
  it("gives Jev a readable transcript and every tool, including free-form and provider-run ones", async () => {
    const { post, jev } = setup({ tool: { choice: "shell" }, needs_tool: { noul: 0.9 } });
    await post(JSON.stringify(codexRequest()));

    const { state, questions } = jev.requests[0]!;
    expect(state).toEqual({
      assistant_instructions: "You are Codex, a coding agent.\n\n<permissions>sandboxed</permissions>",
      conversation: [
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", tool_calls: [{ tool: "shell", call_id: "call_1", arguments: '{"command":["ls"]}' }] },
        { role: "tool_result", tool: "shell", call_id: "call_1", content: "main.py\nREADME.md" },
      ],
    });
    const tool = questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual([
      "shell",
      "apply_patch",
      "list_plans",
      "web_search",
      NO_TOOL,
    ]);
  });

  it("forces function and free-form tools with the matching tool_choice shape", async () => {
    const shell = setup({ tool: { choice: "shell" }, needs_tool: { noul: 0.9 } });
    await shell.post(JSON.stringify(codexRequest()));
    expect(shell.upstream.calls[0]!.url).toBe("https://llm.test/v1/responses");
    expect(shell.upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", name: "shell" });

    const patch = setup({ tool: { choice: "apply_patch" }, needs_tool: { noul: 0.9 } });
    await patch.post(JSON.stringify(codexRequest()));
    expect(patch.upstream.calls[0]!.body.tool_choice).toEqual({ type: "custom", name: "apply_patch" });
  });

  it("leaves provider-run tools to the LLM", async () => {
    const { post, upstream } = setup({ tool: { choice: "web_search" }, needs_tool: { noul: 0.9 } });
    const res = await post(JSON.stringify(codexRequest()));
    expect(res.headers.get("x-jev-gateway-reason")).toBe("hosted_tool_selected");
    expect(upstream.calls[0]!.body.tool_choice).toBe("auto");
  });

  it("streams a complete function call itself when the tool takes no open-ended arguments", async () => {
    const { post, upstream } = setup({ tool: { choice: "list_plans" }, needs_tool: { noul: 0.9 } });
    const res = await post(JSON.stringify(codexRequest()));
    expect(upstream.calls).toHaveLength(0);

    const events = (await res.text())
      .trim()
      .split("\n\n")
      .map((block) => JSON.parse(block.split("\n")[1]!.replace(/^data: /, "")));
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.at(-2).item).toMatchObject({ type: "function_call", name: "list_plans", arguments: "{}" });
    expect(events.at(-1).response.output).toHaveLength(1);
  });

  it("reads zstd-compressed bodies and forwards untouched requests byte-for-byte", async () => {
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(codexRequest())));
    const jev = fakeJev({ tool: { choice: "shell", confidence: 0.2 }, needs_tool: { noul: 0.9 } });
    const seen: { body: unknown; encoding: string | null }[] = [];
    const app = createApp({
      config: testConfig(),
      askJev: jev.askJev,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ body: init?.body, encoding: new Headers(init?.headers).get("content-encoding") });
        return Response.json({});
      }) as typeof fetch,
    });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: compressed,
    });

    expect(jev.requests).toHaveLength(1);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("low_confidence");
    expect(Buffer.from(seen[0]!.body as Uint8Array).equals(compressed)).toBe(true);
    expect(seen[0]!.encoding).toBe("zstd");
  });

  it("replays the original request when upstream rejects the rewritten one", async () => {
    const { post, upstream } = setup({ tool: { choice: "shell" }, needs_tool: { noul: 0.9 } }, (body) =>
      body.tool_choice === "auto"
        ? Response.json({ id: "resp_ok" })
        : Response.json({ error: { message: "Unsupported tool_choice" } }, { status: 400 }),
    );
    const res = await post(JSON.stringify(codexRequest()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "resp_ok" });
    expect(res.headers.get("x-jev-gateway-reason")).toBe("upstream_rejected_forced");
    expect(upstream.calls.map((call) => call.body.tool_choice)).toEqual([{ type: "function", name: "shell" }, "auto"]);
  });

  it("finds tools declared as `additional_tools` input items, namespaces included", async () => {
    const { post, jev, upstream, logged } = setup({ tool: { choice: "exec" }, needs_tool: { noul: 0.9 } });
    await post(JSON.stringify(codexLiteRequest()));

    const { state, questions } = jev.requests[0]!;
    const tool = questions.tool!;
    expect(tool.type === "choice" && tool.criteria).toMatchObject({
      exec: "Run JavaScript code to orchestrate/compose tool calls",
      wait: "Waits on a yielded `exec` cell.",
      "clock.sleep": "[Tools for reading and waiting on time.] Pause execution for a specified duration.",
    });
    expect(state).toEqual({
      assistant_instructions: "You are Codex.",
      conversation: [
        { role: "user", text: "sleep 10 ms, then run echo hi" },
        { role: "assistant", text: "I’ll wait first." },
        { role: "assistant", tool_calls: [{ tool: "clock.sleep", call_id: "call_1", arguments: '{"duration_ms":10}' }] },
        { role: "tool_result", tool: "clock.sleep", call_id: "call_1", content: "slept" },
        { role: "assistant", tool_calls: [{ tool: "exec", call_id: "call_2", arguments: 'text((await tools.exec_command({cmd:"echo hi"})).output);' }] },
        { role: "tool_result", tool: "exec", call_id: "call_2", content: "Script completed\nOutput:\n\nhi\n" },
      ],
    });
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "custom", name: "exec" });
    // The declaration itself must reach upstream untouched.
    expect(upstream.calls[0]!.body.input[0]).toEqual(codexLiteRequest().input[0]);
    await settled();
    expect(logged[0]).toMatchObject({ tools: 3, mode: "forced", tool: "exec" });
  });

  it("never forces a namespaced tool: tool_choice cannot address one", async () => {
    // ChatGPT's backend answers 400 to both `tool_choice.namespace` and the bare name.
    const { post, upstream } = setup({ tool: { choice: "clock.sleep" }, needs_tool: { noul: 0.9 } });
    const res = await post(JSON.stringify(codexLiteRequest()));
    expect(res.headers.get("x-jev-gateway-reason")).toBe("namespaced_tool_selected");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body.tool_choice).toBe("auto");
  });

  it("stays out of the way when history lives server-side", async () => {
    const { post, jev } = setup({});
    const res = await post(JSON.stringify(codexRequest({ previous_response_id: "resp_123" })));
    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("previous_response_id");
  });
});

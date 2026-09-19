import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

/**
 * Stable OpenCode v1.18.31 wire compatibility (`stacked-to-main` slice 2, OC-2).
 *
 * Fixture provenance (all local, no real credentials, no model/provider APIs for
 * the fixtures themselves):
 * - `opencode --version` → `1.18.31`.
 * - Chat capture: fake upstream on 127.0.0.1:18791 returning a canned
 *   `chat.completion`; isolated `HOME=/tmp/opencode/oc2-capture/home`; provider
 *   from `bin/clients.mjs` `opencode.env("http://127.0.0.1:18791")`
 *   (`npm: "@ai-sdk/openai-compatible"`, `baseURL: "<origin>/v1"`); then
 *   `opencode run --dir /tmp/opencode/oc2-capture/work --format json
 *   "say hello in five words"`. Observed `POST /v1/chat/completions` with
 *   `model/max_tokens/reasoning_effort/messages/tools/tool_choice/stream/
 *   stream_options`, 9 native `type: "function"` tools, `tool_choice: "auto"`,
 *   `stream: true`, `stream_options: { include_usage: true }`; no top-level
 *   `store` or `previous_response_id`. A title-generation request in the same run
 *   omits `tools`/`tool_choice` entirely.
 * - Responses capture: fake upstream on 127.0.0.1:18792 returning a canned
 *   `response` object; same isolated HOME; provider `npm: "@ai-sdk/openai"`
 *   with `baseURL: "http://127.0.0.1:18792/v1"`; same `opencode run` scenario.
 *   Observed `POST /v1/responses` with
 *   `model/input/max_output_tokens/store/include/prompt_cache_key/reasoning/
 *   tools/tool_choice/stream`, same 9 native `type: "function"` tools,
 *   `tool_choice: "auto"`, `store: false`, `include:
 *   ["reasoning.encrypted_content"]`, `reasoning: { effort: "medium", summary:
 *   "auto" }`; no `previous_response_id`, no `additional_tools` items in any of
 *   the 1267 captured Responses bodies or 2 Chat bodies.
 * - Native roster captured (all `type: "function"`): apply_patch, bash, glob,
 *   grep, read, skill, task, todowrite, webfetch. Fixtures below keep the
 *   captured `bash`/`read` parameter shapes (descriptions trimmed) and use short
 *   stand-in system prompts instead of the ~10k-char captured OpenCode system
 *   prompt. Full captures live only in `/tmp/opencode/oc2-capture/` (outside the
 *   repo) and are not committed.
 * - MCP shape is illustrative, not captured: the AI SDK exposes MCP tools as
 *   `type: "function"` definitions identical on the wire to native tools. The
 *   `mcp__home__set_light` fixture below uses that same shape; its closed
 *   enum+boolean schema is what makes a `direct` answer valid.
 * - v2 is out of scope: no `previous_response_id` chaining, no namespaces, no
 *   `additional_tools` was observed on stable v1, so tests assert their absence
 *   rather than assuming v2 behavior.
 */

// --- Captured native shapes (descriptions trimmed, parameters preserved) ---

const bashChatTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Executes a given bash command in a persistent shell session.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        timeout: { type: "integer", description: "Optional timeout in milliseconds" },
        workdir: { type: "string", description: "The working directory to run the command in." },
      },
      required: ["command"],
    },
  },
};

const readChatTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file or directory from the local filesystem.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        filePath: { type: "string", description: "The absolute path to the file or directory to read" },
        offset: { type: "integer", description: "The line number to start reading from (1-indexed)" },
        limit: { type: "integer", description: "The maximum number of lines to read (defaults to 2000)" },
      },
      required: ["filePath"],
    },
  },
};

/** Illustrative MCP-originated tool: same function shape, closed schema so `direct` is valid. */
const mcpClosedChatTool = {
  type: "function",
  function: {
    name: "mcp__home__set_light",
    description: "MCP-originated tool: set a room light (same function-tool wire shape as native tools).",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", enum: ["kitchen", "office"] },
        on: { type: "boolean" },
      },
      required: ["room", "on"],
    },
  },
};

const bashResponsesTool = {
  type: "function",
  name: "bash",
  description: "Executes a given bash command in a persistent shell session.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      workdir: { type: "string", description: "The working directory to run the command in." },
    },
    required: ["command"],
  },
  strict: false,
};

const readResponsesTool = {
  type: "function",
  name: "read",
  description: "Read a file or directory from the local filesystem.",
  parameters: {
    type: "object",
    properties: { filePath: { type: "string", description: "The absolute path to the file or directory to read" } },
    required: ["filePath"],
  },
  strict: false,
};

/** Illustrative MCP-originated Responses tool: same function shape, closed schema. */
const mcpClosedResponsesTool = {
  type: "function",
  name: "mcp__home__set_light",
  description: "MCP-originated tool: set a room light (same function-tool wire shape as native tools).",
  parameters: {
    type: "object",
    properties: {
      room: { type: "string", enum: ["kitchen", "office"] },
      on: { type: "boolean" },
    },
    required: ["room", "on"],
  },
  strict: false,
};

/** Stable Chat Completions shape from `@ai-sdk/openai-compatible` (see provenance above). */
const opencodeChatRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5",
  max_tokens: 32000,
  reasoning_effort: "medium",
  messages: [
    { role: "system", content: "You are OpenCode, a pragmatic coding agent. (shortened stand-in)" },
    { role: "user", content: "list files in src" },
  ],
  tools: [bashChatTool, readChatTool],
  tool_choice: "auto",
  stream: true,
  stream_options: { include_usage: true },
  ...extra,
});

/** Stable Responses shape from `@ai-sdk/openai` (see provenance above). */
const opencodeResponsesRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5",
  input: [
    { role: "developer", content: "You are OpenCode, a pragmatic coding agent. (shortened stand-in)" },
    { role: "user", content: [{ type: "input_text", text: "list files in src" }] },
  ],
  max_output_tokens: 32000,
  store: false,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "ses_test_123",
  reasoning: { effort: "medium", summary: "auto" },
  tools: [bashResponsesTool, readResponsesTool],
  tool_choice: "auto",
  stream: true,
  ...extra,
});

function chatSetup(canned: Parameters<typeof fakeJev>[0], config = testConfig()) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream };
}

function responsesSetup(
  canned: Parameters<typeof fakeJev>[0],
  config = testConfig(),
  reply?: (body: any) => Response,
) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstream.fetchImpl(input, init);
    return reply?.(upstream.calls.at(-1)!.body) ?? response;
  }) as typeof fetch;
  const logged: Record<string, unknown>[] = [];
  const app = createApp({ config, askJev: jev.askJev, fetch: fetchImpl, log: (entry) => logged.push(entry) });
  const post = (body: unknown) =>
    app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream, logged };
}

describe("opencode chat completions (stable @ai-sdk/openai-compatible)", () => {
  it("offers native function tools to Jev with a readable transcript", async () => {
    const { post, jev } = chatSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    await post(opencodeChatRequest());

    expect(jev.requests).toHaveLength(1);
    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.conversation).toEqual([{ role: "user", text: "list files in src" }]);
    expect(state.assistant_instructions).toContain("OpenCode");
    const tool = questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual(["bash", "read", NO_TOOL]);
  });

  it("forces the native tool Jev picked and preserves provider fields", async () => {
    const { post, upstream } = chatSetup(
      { tool: { choice: "bash" }, needs_tool: { noul: 0.9 } },
      testConfig({ argsModel: "cheap-model" }),
    );
    const body = opencodeChatRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "bash" } });
    // Provider-specific fields travel untouched; only model/tool_choice are rewritten.
    expect(sent.model).toBe("cheap-model");
    expect(sent.max_tokens).toBe(32000);
    expect(sent.reasoning_effort).toBe("medium");
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.messages).toEqual(body.messages);
  });

  it("treats MCP-originated function tools like native ones", async () => {
    const body = opencodeChatRequest({ tools: [bashChatTool, mcpClosedChatTool] });
    // Closed MCP tool adds speculative arg questions; answer them so the forced path is reachable.
    const jev = fakeJev({
      tool: { choice: "bash" },
      needs_tool: { noul: 0.9 },
      "arg:1:room": { choice: "kitchen" },
      "arg:1:on": { noul: 0.95 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", function: { name: "bash" } });
    expect(jev.requests[0]!.questions.tool!.type === "choice" && Object.keys(jev.requests[0]!.questions.tool!.criteria)).toEqual([
      "bash",
      "mcp__home__set_light",
      NO_TOOL,
    ]);
  });

  it("answers directly when a closed MCP tool takes only known arguments", async () => {
    // Stable OpenCode sends `stream: true`, so the streaming direct path below is the
    // stable one; this covers the non-streaming JSON variant with `stream: false`.
    const body = opencodeChatRequest({ tools: [bashChatTool, mcpClosedChatTool], stream: false });
    const { post, upstream } = chatSetup({
      tool: { choice: "mcp__home__set_light" },
      needs_tool: { noul: 0.95 },
      "arg:1:room": { choice: "kitchen" },
      "arg:1:on": { noul: 0.96 },
    });
    const res = await post(body);
    const json = (await res.json()) as any;

    expect(upstream.calls).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    const call = json.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("mcp__home__set_light");
    expect(JSON.parse(call.function.arguments)).toEqual({ room: "kitchen", on: true });
  });

  it("streams a direct answer as chunks ending in [DONE] with usage", async () => {
    const body = opencodeChatRequest({
      tools: [bashChatTool, mcpClosedChatTool],
      stream_options: { include_usage: true },
    });
    const { post } = chatSetup({
      tool: { choice: "mcp__home__set_light" },
      needs_tool: { noul: 0.95 },
      "arg:1:room": { choice: "kitchen" },
      "arg:1:on": { noul: 0.96 },
    });
    const res = await post(body);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).trim().split("\n\n").map((line) => line.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const args = chunks.map((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? "").join("");
    expect(JSON.parse(args)).toEqual({ room: "kitchen", on: true });
    expect(chunks.at(-2)!.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.at(-1)).toHaveProperty("usage");
  });

  it("sets tool_choice none when Jev is confident no tool is needed", async () => {
    const { post, upstream } = chatSetup({
      tool: { choice: NO_TOOL },
      needs_tool: { noul: 0.05 },
    });
    const res = await post(opencodeChatRequest());

    expect(res.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(upstream.calls[0]!.body.tool_choice).toBe("none");
    // Provider fields still travel untouched on the none path.
    expect(upstream.calls[0]!.body.reasoning_effort).toBe("medium");
  });

  it("passes through untouched when the caller already decided or sent no tools", async () => {
    const decided = chatSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const decidedBody = opencodeChatRequest({ tool_choice: "none" });
    const decidedRes = await decided.post(decidedBody);
    expect(decided.jev.requests).toHaveLength(0);
    expect(decidedRes.headers.get("x-jev-gateway-reason")).toBe("tool_choice_already_decided");
    expect(decided.upstream.calls[0]!.body).toEqual(decidedBody);

    // The captured title-generation shape: no tools at all.
    const titleless = chatSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const { model, messages, max_tokens, stream, stream_options } = opencodeChatRequest();
    const titleBody = { model, messages, max_tokens, stream, stream_options };
    const titleRes = await titleless.post(titleBody);
    expect(titleless.jev.requests).toHaveLength(0);
    expect(titleRes.headers.get("x-jev-gateway-reason")).toBe("no_tools");
  });

  it("fails open on Jev errors and replays the original when upstream rejects the rewrite", async () => {
    const failing = fakeUpstream();
    const failingApp = createApp({
      config: testConfig(),
      askJev: async () => Promise.reject(new Error("529 overloaded")),
      fetch: failing.fetchImpl,
    });
    const failingRes = await failingApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opencodeChatRequest()),
    });
    expect(failingRes.headers.get("x-jev-gateway-reason")).toContain("jev_error");
    expect(failing.calls).toHaveLength(1);

    const chatUpstream = fakeUpstream();
    const chatJev = fakeJev({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const chatApp = createApp({
      config: testConfig(),
      askJev: chatJev.askJev,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = init?.body;
        const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "{}";
        const body = JSON.parse(text);
        await chatUpstream.fetchImpl(input, init);
        return body.tool_choice === "auto"
          ? Response.json({ id: "chatcmpl-ok" })
          : Response.json({ error: { message: "Unsupported tool_choice" } }, { status: 400 });
      }) as typeof fetch,
    });
    const res = await chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opencodeChatRequest()),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "chatcmpl-ok" });
    expect(res.headers.get("x-jev-gateway-reason")).toBe("upstream_rejected_forced");
  });
});

describe("opencode responses (stable @ai-sdk/openai)", () => {
  it("offers native function tools to Jev with a readable transcript", async () => {
    const { post, jev } = responsesSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    await post(opencodeResponsesRequest());

    expect(jev.requests).toHaveLength(1);
    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.conversation).toEqual([{ role: "user", text: "list files in src" }]);
    expect(state.assistant_instructions).toContain("OpenCode");
    const tool = questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual(["bash", "read", NO_TOOL]);
  });

  it("forces the native tool with the Responses tool_choice shape and preserves provider fields", async () => {
    const { post, upstream } = responsesSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const body = opencodeResponsesRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "function", name: "bash" });
    expect(sent.store).toBe(false);
    expect(sent.include).toEqual(["reasoning.encrypted_content"]);
    expect(sent.max_output_tokens).toBe(32000);
    expect(sent.prompt_cache_key).toBe("ses_test_123");
    expect(sent.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(sent.input).toEqual(body.input);
  });

  it("treats MCP-originated function tools like native ones", async () => {
    const jev = fakeJev({
      tool: { choice: "bash" },
      needs_tool: { noul: 0.9 },
      "arg:2:room": { choice: "office" },
      "arg:2:on": { noul: 0.92 },
    });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = opencodeResponsesRequest({ tools: [bashResponsesTool, readResponsesTool, mcpClosedResponsesTool] });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", name: "bash" });
    const tool = jev.requests[0]!.questions.tool!;
    expect(tool.type === "choice" && Object.keys(tool.criteria)).toEqual(["bash", "read", "mcp__home__set_light", NO_TOOL]);
  });

  it("answers directly for a closed MCP tool without calling upstream", async () => {
    // Fixture defaults to `stream: true` (the stable shape); use the non-streaming
    // variant here so the assertion reads the JSON body instead of the SSE stream.
    const body = opencodeResponsesRequest({
      tools: [bashResponsesTool, readResponsesTool, mcpClosedResponsesTool],
      stream: false,
    });
    const { post, upstream } = responsesSetup({
      tool: { choice: "mcp__home__set_light" },
      needs_tool: { noul: 0.95 },
      "arg:2:room": { choice: "office" },
      "arg:2:on": { noul: 0.93 },
    });
    const res = await post(body);
    const json = (await res.json()) as any;

    expect(upstream.calls).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(json.object).toBe("response");
    expect(json.output[0]).toMatchObject({ type: "function_call", name: "mcp__home__set_light" });
    expect(JSON.parse(json.output[0].arguments)).toEqual({ room: "office", on: true });
  });

  it("streams a direct Responses answer with the LLM-like event sequence", async () => {
    const body = opencodeResponsesRequest({
      tools: [bashResponsesTool, readResponsesTool, mcpClosedResponsesTool],
      stream: true,
    });
    const { post, upstream } = responsesSetup({
      tool: { choice: "mcp__home__set_light" },
      needs_tool: { noul: 0.95 },
      "arg:2:room": { choice: "office" },
      "arg:2:on": { noul: 0.93 },
    });
    const res = await post(body);

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
    expect(events.at(-2)!.item).toMatchObject({ type: "function_call", name: "mcp__home__set_light" });
  });

  it("records stable-v1 field provenance: top-level tools, store false, no previous_response_id", async () => {
    const chatBody = opencodeChatRequest();
    expect(chatBody).toHaveProperty("tools");
    expect(chatBody.tool_choice).toBe("auto");
    expect(chatBody).not.toHaveProperty("store");
    expect(chatBody).not.toHaveProperty("previous_response_id");

    const responsesBody = opencodeResponsesRequest();
    expect(responsesBody.tools).toHaveLength(2);
    expect(responsesBody.store).toBe(false);
    expect(responsesBody).not.toHaveProperty("previous_response_id");
    for (const item of responsesBody.input as { type?: string }[]) {
      expect(item.type).not.toBe("additional_tools");
    }

    // Server-side history stays fail-open even though stable OpenCode never sends it.
    const { post, jev } = responsesSetup({});
    const res = await post(opencodeResponsesRequest({ previous_response_id: "resp_123" }));
    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("previous_response_id");
  });

  it("fails open for decided choices and replays the original on upstream rejection", async () => {
    const decided = responsesSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } });
    const decidedBody = opencodeResponsesRequest({ tool_choice: "none" });
    const decidedRes = await decided.post(decidedBody);
    expect(decided.jev.requests).toHaveLength(0);
    expect(decidedRes.headers.get("x-jev-gateway-reason")).toBe("tool_choice_already_decided");

    const { post, upstream } = responsesSetup({ tool: { choice: "bash" }, needs_tool: { noul: 0.9 } }, testConfig(), (body) =>
      body.tool_choice === "auto"
        ? Response.json({ id: "resp_ok" })
        : Response.json({ error: { message: "Unsupported tool_choice" } }, { status: 400 }),
    );
    const res = await post(opencodeResponsesRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "resp_ok" });
    expect(res.headers.get("x-jev-gateway-reason")).toBe("upstream_rejected_forced");
    expect(upstream.calls.map((call) => call.body.tool_choice)).toEqual([{ type: "function", name: "bash" }, "auto"]);
    await settled();
  });
});

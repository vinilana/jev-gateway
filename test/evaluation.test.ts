import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { responsesAdapter } from "../src/adapters/responses.js";
import { createApp } from "../src/app.js";
import type { AskJev } from "../src/decide.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

const request = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-codex",
  input: [{ role: "user", content: "PRIVATE_PROMPT" }],
  tools: [{ type: "custom", name: "exec", description: "Run code" }],
  tool_choice: "auto",
  stream: false,
  ...extra,
});

const reply = {
  object: "response", id: "resp_fixture", model: "gpt-actual", status: "completed",
  output: [
    { type: "custom_tool_call", name: "exec", input: "PRIVATE_ARGUMENT" },
    { type: "message", content: [{ type: "output_text", text: "PRIVATE_REPLY" }] },
  ],
  usage: { input_tokens: 100, output_tokens: 20 },
};

const post = (app: ReturnType<typeof createApp>, body = request(), headers: Record<string, string> = {}) =>
  app.request("/v1/responses", {
    method: "POST", headers: { authorization: "Bearer PRIVATE_CREDENTIAL", ...headers }, body: JSON.stringify(body),
  });

const statusTool = { type: "function", name: "status", parameters: { type: "object", properties: { value: { const: "PRIVATE_ARGUMENT" } }, required: ["value"] } };

/** Jev stays silent until `release()`: the way to tell what happens while it is still thinking. */
function slowJev(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const askJev: AskJev = async (question) => { await gate; return jev.askJev(question); };
  return { askJev, release, requests: jev.requests };
}

describe("shadow evaluation", () => {
  it("forwards the request before Jev answers and logs its proposal once it does", async () => {
    const jev = slowJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
    const body = request();
    const pending = post(app, body);
    await settled();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    const response = await pending;
    expect(await response.json()).toEqual(reply);
    expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(response.headers.get("x-jev-gateway-reason")).toBe("shadow");
    for (const header of ["tool", "confidence", "latency-ms"]) expect(response.headers.get(`x-jev-gateway-${header}`)).toBeNull();
    await settled();
    expect(logged).toEqual([]);

    jev.release();
    await settled();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ mode: "passthrough", reason: "shadow", shadow: { mode: "forced", tool: "exec" }, jev: { choice: "exec" }, status: 200 });
  });

  it("measures the duration of the reply, not the wait for Jev", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const jev = slowJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.95 } });
      const logged: Record<string, unknown>[] = [];
      const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: fakeUpstream(reply).fetchImpl, log: e => logged.push(e) });
      const pending = post(app);
      await settled();
      clock = 5_000;
      jev.release();
      await (await pending).json();
      await settled();
      expect(logged[0]).toMatchObject({ durationMs: 0, jev: { latencyMs: 5_000 } });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["forced", { tool: { choice: "exec" }, needs_tool: { noul: 0.95 } }, {}, request(), { mode: "forced", tool: "exec", kind: "custom", confidence: 0.95 }],
    ["direct", { tool: { choice: "status" }, needs_tool: { noul: 0.95 } }, {}, request({ tools: [statusTool] }), { mode: "direct", tool: "status", confidence: 0.95 }],
    ["none", { tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } }, { onNone: "force_none" }, request(), { mode: "none", confidence: 0.95 }],
    ["no_tool_needed", { tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } }, { onNone: "passthrough" }, request(), { mode: "passthrough", reason: "no_tool_needed" }],
  ] as const)("logs a %s proposal, without arguments, and forwards the original request", async (_name, canned, config, body, proposal) => {
    const jev = fakeJev(canned);
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({
      config: testConfig({ shadow: true, argsModel: "gpt-cheaper", ...config }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e),
      buildId: "sha256:shadow-build",
    });
    const response = await post(app, body);
    expect(await response.json()).toEqual(reply);
    await settled();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(logged[0]).toMatchObject({ mode: "passthrough", reason: "shadow", shadowMode: true, sentModel: "gpt-codex", tools: 1, jev: { confidence: 0.95 }, gatewayBuildId: "sha256:shadow-build" });
    expect(logged[0]!.shadow).toEqual(proposal);
    expect(logged[0]).not.toHaveProperty("args");
    expect(JSON.stringify(logged)).not.toContain("PRIVATE_ARGUMENT");
  });

  it("forwards a streaming request untouched and still logs the proposal", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_sse", model: "gpt-actual" } },
      { type: "response.output_item.done", item: { type: "custom_tool_call", name: "exec", input: "PRIVATE_ARGUMENT" } },
      { type: "response.completed", response: { id: "resp_sse", model: "gpt-actual", usage: { input_tokens: 100, output_tokens: 20 } } },
    ];
    const stream = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    let forwarded = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = Buffer.from(init?.body as Uint8Array).toString("utf8");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.95 } });
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: fetchImpl, log: e => logged.push(e) });
    const body = request({ stream: true });
    const response = await post(app, body);
    expect(await response.text()).toBe(stream);
    await settled();
    expect(forwarded).toBe(JSON.stringify(body));
    expect(logged[0]).toMatchObject({
      reason: "shadow", shadow: { mode: "forced", tool: "exec" }, usage: { input: 100, output: 20 },
      response: { id: "resp_sse", tools: ["exec"], ending: "response.completed" },
    });
  });

  const weather = { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
  const lights = { name: "set_lights", parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } };
  const messageStream = [
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "message_delta", delta: {}, usage: { output_tokens: 7 } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  it.each<{
    format: string;
    path: string;
    body: Record<string, unknown>;
    canned: Parameters<typeof fakeJev>[0];
    answer: () => Response;
    logged: Record<string, unknown>;
  }>([
    {
      format: "Chat Completions, where a built-in listed twice is one tool for Jev",
      path: "/v1/chat/completions",
      body: {
        model: "gpt-test", messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
        tools: [{ type: "function", function: weather }, { type: "web_search" }, { type: "web_search" }],
      },
      canned: { tool: { choice: "get_weather" }, needs_tool: { noul: 0.95 } },
      answer: () => Response.json({ id: "chatcmpl_1", choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } }),
      logged: { model: "gpt-test", tools: 2, shadow: { mode: "forced", tool: "get_weather" }, usage: { input: 40, output: 5 } },
    },
    {
      format: "Gemini, where one group declares two functions",
      path: "/v1beta/models/gemini-2.0-flash:generateContent",
      body: { contents: [{ role: "user", parts: [{ text: "PRIVATE_PROMPT" }] }], tools: [{ functionDeclarations: [weather, lights] }] },
      canned: { tool: { choice: "get_weather" }, needs_tool: { noul: 0.95 }, "arg:1:on": { noul: 0.99 } },
      answer: () => Response.json({ candidates: [], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } }),
      logged: { model: "gemini-2.0-flash", tools: 2, shadow: { mode: "forced", tool: "get_weather" }, usage: { input: 30, output: 4 } },
    },
    {
      format: "Anthropic Messages as a stream, which can only be hinted",
      path: "/v1/messages",
      body: {
        model: "claude-test", max_tokens: 64, stream: true, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
        tools: [{ name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
      },
      canned: { tool: { choice: "Bash" }, needs_tool: { noul: 0.9 } },
      answer: () => new Response(messageStream, { headers: { "content-type": "text/event-stream" } }),
      logged: { model: "claude-test", tools: 1, shadow: { mode: "hint", tool: "Bash" }, usage: { input: 10, output: 7 } },
    },
  ])("forwards the original request and logs the proposal for $format", async ({ path, body, canned, answer, logged: expected }) => {
    let forwarded = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = Buffer.from(init?.body as Uint8Array).toString("utf8");
      return answer();
    }) as typeof fetch;
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: fakeJev(canned).askJev, fetch: fetchImpl, log: e => logged.push(e) });
    const response = await app.request(path, { method: "POST", body: JSON.stringify(body) });
    expect(await response.text()).toBe(await answer().text());
    await settled();
    expect(forwarded).toBe(JSON.stringify(body));
    expect(response.headers.get("x-jev-gateway-reason")).toBe("shadow");
    expect(logged[0]).toMatchObject({ mode: "passthrough", reason: "shadow", shadowMode: true, jev: { confidence: 0.95 }, ...expected });
    expect(JSON.stringify(logged)).not.toContain("PRIVATE_PROMPT");
  });

  it("does not add the hint to an Anthropic Messages request that would have been steered", async () => {
    const jev = fakeJev({ tool: { choice: "Bash" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
    const body = {
      model: "claude-test", max_tokens: 64, thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
      tools: [{ name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    };
    const response = await app.request("/v1/messages", { method: "POST", body: JSON.stringify(body) });
    await settled();
    expect(response.headers.get("x-jev-gateway-reason")).toBe("shadow");
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(logged[0]).toMatchObject({ reason: "shadow", shadow: { mode: "hint", tool: "Bash", confidence: 0.95 } });
  });

  it("preserves the unrouted requests: the bypass is logged as its own reason and Jev is not asked", async () => {
    const cases = [
      ["routing is off", { routing: false }, {}, request(), "routing_disabled"],
      ["the client opts out", {}, { "x-jev-gateway": "off" }, request(), "disabled_by_header"],
      ["the model is the Codex reviewer", {}, {}, request({ model: "codex-auto-review" }), "codex_auto_review"],
      ["the history holds an agent_message", {}, {}, request({ input: [{ type: "agent_message", content: "encrypted" }] }), "agent_message"],
    ] as const;
    for (const [name, config, headers, body, reason] of cases) {
      const jev = fakeJev({});
      const upstream = fakeUpstream(reply);
      const logged: Record<string, unknown>[] = [];
      const app = createApp({ config: testConfig({ shadow: true, ...config }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
      const response = await post(app, body, headers);
      await settled();
      expect(jev.requests, name).toHaveLength(0);
      expect(upstream.calls[0]!.body, name).toEqual(body);
      expect(logged[0], name).toMatchObject({ mode: "passthrough", reason, tools: 1, shadowMode: !("routing" in config) });
      expect(logged[0], name).not.toHaveProperty("shadow");
      expect(logged[0], name).not.toHaveProperty("jev");
      if (name === "routing is off" || name === "the client opts out") expect(response.headers.get("x-jev-gateway-reason"), name).toBe(reason);
    }
  });

  it("delivers the reply and logs the failure when Jev throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const upstream = fakeUpstream(reply);
      const logged: Record<string, unknown>[] = [];
      const askJev: AskJev = async () => { throw new Error("fixture timeout"); };
      const app = createApp({ config: testConfig({ shadow: true }), askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
      const body = request();
      const response = await post(app, body);
      expect(await response.json()).toEqual(reply);
      expect(upstream.calls[0]!.body).toEqual(body);
      expect(response.headers.get("x-jev-gateway-reason")).toBe("shadow");
      await settled();
      expect(logged[0]).toMatchObject({ mode: "passthrough", reason: "jev_error: fixture timeout", shadowMode: true, status: 200 });
      expect(logged[0]).not.toHaveProperty("shadow");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("still logs the line, with the failure, when the evaluation itself breaks", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    // A tool list that is not a list gets past decideFor's own guards. The evaluation settles long
    // before the reply has been read, so nothing may wait to handle its failure until then.
    const toInput = vi.spyOn(responsesAdapter, "toInput").mockReturnValue({ system: "", turns: [], tools: undefined, toolChoice: "auto" } as never);
    try {
      const upstream = fakeUpstream(reply);
      const logged: Record<string, unknown>[] = [];
      const app = createApp({ config: testConfig({ shadow: true }), askJev: fakeJev({}).askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
      const body = request();
      expect(await (await post(app, body)).json()).toEqual(reply);
      expect(upstream.calls[0]!.body).toEqual(body);
      await settled();
      expect(logged[0]).toMatchObject({ mode: "passthrough", reason: expect.stringMatching(/^router_error: /), status: 200, usage: { input: 100, output: 20 } });
      expect(rejections).toEqual([]);
    } finally {
      toInput.mockRestore();
      process.off("unhandledRejection", onRejection);
    }
  });

  it("forwards compressed request bytes and their encoding header as they came", async () => {
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.99 } });
    const bytes = zstdCompressSync(Buffer.from(JSON.stringify(request({ stream: true }))));
    let forwarded: Uint8Array | undefined;
    let headers: Headers | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = init?.body as Uint8Array;
      headers = new Headers(init?.headers);
      return Response.json(reply);
    }) as typeof fetch;
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: fetchImpl, log: e => logged.push(e) });
    await app.request("/v1/responses", { method: "POST", headers: { "content-encoding": "zstd" }, body: bytes });
    await settled();
    expect(jev.requests).toHaveLength(1);
    expect(Buffer.from(forwarded!)).toEqual(bytes);
    expect(headers!.get("content-encoding")).toBe("zstd");
    expect(logged[0]).toMatchObject({ reason: "shadow", shadow: { mode: "forced", tool: "exec" } });
  });

  it("tells the dashboard the shadow policy and Jev's pick, keeps the proposal object out, and drops the policy when routing is off", async () => {
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.95 } });
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: fakeUpstream(reply).fetchImpl, log: e => logged.push(e) });
    await post(app);
    await app.request("/dashboard/routing?enabled=false", { method: "POST" });
    await post(app);
    await settled();
    expect(logged.map((entry) => entry.shadowMode)).toEqual([true, false]);
    const feed = await (await app.request("/dashboard/events")).json();
    expect(feed.router).toMatchObject({ shadow: true, routing: false });
    expect(feed.events.map((event: Record<string, unknown>) => event.shadowMode)).toEqual([true, false]);
    expect(feed.events[0]).toMatchObject({ mode: "passthrough", reason: "shadow", jev: { choice: "exec" } });
    expect(feed.events[0]).not.toHaveProperty("shadow");
    expect(JSON.stringify(feed)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_CREDENTIAL/);
  });

  it("marks lines as not shadowed when the setting is off", async () => {
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig(), askJev: fakeJev({}).askJev, fetch: fakeUpstream(reply).fetchImpl, log: e => logged.push(e) });
    await post(app, request({ tools: [] }));
    await settled();
    expect(logged[0]).toMatchObject({ shadowMode: false });
    expect((await (await app.request("/dashboard/events")).json()).router.shadow).toBe(false);
  });

  it("keeps /router/decide a dry run: it returns the real decision and logs nothing", async () => {
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.95 } });
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ shadow: true }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e) });
    const decision = await (await app.request("/router/decide", { method: "POST", body: JSON.stringify(request()) })).json();
    await settled();
    expect(decision).toMatchObject({ mode: "forced", tool: "exec" });
    expect(upstream.calls).toHaveLength(0);
    expect(logged).toEqual([]);
  });
});

describe("evaluation metadata", () => {
  // The client's hangup is read at each place the log line is written, so every route that forwards
  // a reply needs its own case: a wrong signal there turns a hangup into a stream_error.
  const forced = { tool: { choice: "exec" }, needs_tool: { noul: 0.99 } };
  it.each([
    { name: "records client_aborted when the client hangs up on a passed-through reply before a terminal event", config: testConfig({ routing: false }), canned: {}, terminal: false },
    { name: "keeps response.completed when the client hangs up on a passed-through reply after it", config: testConfig({ routing: false }), canned: {}, terminal: true },
    { name: "records client_aborted when the client hangs up on a forced reply before a terminal event", config: testConfig(), canned: forced, terminal: false },
    { name: "keeps response.completed when the client hangs up on a forced reply after it", config: testConfig(), canned: forced, terminal: true },
  ])("$name", async ({ config, canned, terminal }) => {
    const abort = new AbortController();
    const logged: Record<string, unknown>[] = [];
    const payload = { type: terminal ? "response.completed" : "response.in_progress", response: { id: "resp_abort", usage: { input_tokens: 100, output_tokens: 2 } } };
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("fixture client abort")), { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const app = createApp({ config, askJev: fakeJev(canned).askJev, fetch: fetchImpl, log: e => logged.push(e) });
    const response = await app.request("/v1/responses", { method: "POST", body: JSON.stringify(request({ stream: true })), signal: abort.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    await settled();
    expect(logged[0]).toMatchObject({
      response: { id: "resp_abort", ending: terminal ? "response.completed" : "client_aborted" },
      usage: { input: 100, output: 2 },
    });
    expect(logged[0]!.response).not.toHaveProperty("interrupted");
  });

  it("records the sent model and reply metadata without request or reply content", async () => {
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig({ argsModel: "gpt-cheaper" }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e), buildId: "sha256:forced-build" });
    await (await post(app)).json();
    await settled();
    expect(logged[0]).toMatchObject({
      model: "gpt-codex", sentModel: "gpt-cheaper", requestId: expect.any(String), gatewayBuildId: "sha256:forced-build",
      response: { id: "resp_fixture", model: "gpt-actual", tools: ["exec"], ending: "response.completed" }, usage: { input: 100, output: 20 },
    });
    expect(logged[0]).not.toHaveProperty("gatewayVersion");
    expect(upstream.calls[0]!.body.model).toBe("gpt-cheaper");
    const feed = await (await app.request("/dashboard/events")).json();
    expect(feed.events[0]).toMatchObject({ model: "gpt-codex", mode: "forced", usage: { input: 100, output: 20 } });
    for (const field of ["requestId", "gatewayRunId", "gatewayBuildId", "sentModel", "response"]) expect(feed.events[0]).not.toHaveProperty(field);
    for (const value of [logged, feed]) expect(JSON.stringify(value)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_ARGUMENT|PRIVATE_REPLY|PRIVATE_CREDENTIAL/);
  });

  it("records the original model when upstream rejects the rewrite and the gateway retries", async () => {
    const jev = fakeJev({ tool: { choice: "exec" }, needs_tool: { noul: 0.99 } });
    const logged: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body));
      calls.push(body.model);
      return calls.length === 1 ? Response.json({ error: "unsupported tool choice" }, { status: 400 }) : Response.json(reply);
    }) as typeof fetch;
    const app = createApp({ config: testConfig({ argsModel: "gpt-cheaper" }), askJev: jev.askJev, fetch: fetchImpl, log: e => logged.push(e) });
    await (await post(app)).json();
    await settled();
    expect(calls).toEqual(["gpt-cheaper", "gpt-codex"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ sentModel: "gpt-codex", reason: "upstream_rejected_forced", response: { id: "resp_fixture" } });
  });

  it.each([false, true])("delivers direct-call arguments only to the client with stream=%s", async (stream) => {
    const jev = fakeJev({ tool: { choice: "status" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl, log: e => logged.push(e), buildId: "sha256:direct-build" });
    const body = request({ stream, tools: [statusTool] });
    const response = await (await post(app, body)).text();
    expect(response).toContain("PRIVATE_ARGUMENT");
    await settled();
    expect(upstream.calls).toHaveLength(0);
    expect(logged[0]).toMatchObject({ mode: "direct", tool: "status", requestId: expect.any(String), gatewayBuildId: "sha256:direct-build", response: { tools: ["status"] } });
    expect(logged[0]).not.toHaveProperty("args");
    expect(logged[0]).not.toHaveProperty("usage");
    expect(logged[0]).not.toHaveProperty("sentModel");
    const feed = await (await app.request("/dashboard/events")).json();
    expect(feed.events[0]).toMatchObject({ mode: "direct", tool: "status" });
    for (const field of ["args", "response"]) expect(feed.events[0]).not.toHaveProperty(field);
    for (const value of [logged, feed]) expect(JSON.stringify(value)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_ARGUMENT|PRIVATE_REPLY|PRIVATE_CREDENTIAL/);
  });

  it("logs a streamed direct reply as completed even when the client hangs up on it", async () => {
    const abort = new AbortController();
    const logged: Record<string, unknown>[] = [];
    const jev = fakeJev({ tool: { choice: "status" }, needs_tool: { noul: 0.99 } });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: fakeUpstream().fetchImpl, log: e => logged.push(e) });
    const body = request({ stream: true, tools: [statusTool] });
    const response = await app.request("/v1/responses", { method: "POST", body: JSON.stringify(body), signal: abort.signal });
    abort.abort();
    await response.text().catch(() => {});
    await settled();
    // The answer is built whole, so the hangup cannot cut it short.
    expect(logged[0]).toMatchObject({ mode: "direct", response: { tools: ["status"], ending: "response.completed" } });
    expect(logged[0]).not.toHaveProperty("args");
    expect(JSON.stringify(logged)).not.toContain("PRIVATE_ARGUMENT");
  });

  it("delivers the whole reply when the log cannot be written, without an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const upstream = fakeUpstream(reply);
      const app = createApp({
        config: testConfig({ routing: false }), askJev: fakeJev({}).askJev, fetch: upstream.fetchImpl,
        log: () => { throw new Error("disk full"); },
      });
      expect(await (await post(app)).json()).toEqual(reply);
      await settled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps the build ID across restarts while giving each run and request its own ID", async () => {
    const upstream = fakeUpstream(reply);
    const logged: Record<string, unknown>[] = [];
    const deps = { config: testConfig({ routing: false }), askJev: fakeJev({}).askJev, fetch: upstream.fetchImpl, log: (e: Record<string, unknown>) => logged.push(e), buildId: "sha256:baseline-build" };
    const app = createApp(deps);
    await (await post(app)).json();
    await (await post(app)).json();
    await (await post(createApp(deps))).json();
    await settled();
    expect(logged).toHaveLength(3);
    expect(logged[0]!.requestId).not.toBe(logged[1]!.requestId);
    expect(logged[0]!.gatewayRunId).toEqual(expect.any(String));
    expect(logged[0]!.gatewayRunId).toBe(logged[1]!.gatewayRunId);
    expect(logged[0]!.gatewayRunId).not.toBe(logged[2]!.gatewayRunId);
    for (const entry of logged) expect(entry.gatewayBuildId).toBe("sha256:baseline-build");
  });
});

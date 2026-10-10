import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { frame } from "../src/proto/connect.js";
import { concat, encodeVarint, field, utf8 } from "../src/proto/wire.js";
import { readReply } from "../src/usage.js";
import { chat, fakeJev, settled, testConfig } from "./helpers.js";

const sse = (events: object[]) =>
  new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const readUsage = async (response: Response) => (await readReply(response)).usage;

describe("usage in a reply", () => {
  it("reads a Responses stream, reasoning and cache included", async () => {
    const usage = await readUsage(
      sse([
        { type: "response.output_text.delta", delta: 'a "usage" lookalike' },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 13750,
              input_tokens_details: { cached_tokens: 9600 },
              output_tokens: 48,
              output_tokens_details: { reasoning_tokens: 32 },
            },
          },
        },
      ]),
    );
    expect(usage).toEqual({ input: 13750, cached: 9600, cacheWrite: 0, output: 48, reasoning: 32 });
  });

  it("recognises a stream that comes without a content-type, as the ChatGPT Codex backend sends it", async () => {
    const body = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { attribution: { items: { a: { input_tokens: 1 } } }, input_tokens: 5713, input_tokens_details: { cached_tokens: 4152 }, output_tokens: 7 } },
    })}\n\n`;
    expect(await readUsage(new Response(body))).toMatchObject({ input: 5713, cached: 4152, output: 7 });
  });

  it("adds Anthropic's three input buckets into one total and takes the final output count", async () => {
    const usage = await readUsage(
      sse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 210 } },
      ]),
    );
    expect(usage).toEqual({ input: 9512, cached: 9000, cacheWrite: 500, output: 210, reasoning: 0 });
  });

  it("reads plain JSON replies, and the Chat Completions vocabulary", async () => {
    const usage = await readUsage(
      Response.json({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      }),
    );
    expect(usage).toEqual({ input: 100, cached: 64, cacheWrite: 0, output: 20, reasoning: 8 });
  });

  it("reports nothing rather than zeros when the reply never said", async () => {
    expect(await readUsage(new Response("<html>bad gateway</html>", { status: 502 }))).toBeUndefined();
  });

  // exa's stats entry: { 5: counter key, 4: { 1: label, 2: fixed32 float } }, inside a field-28
  // group's field-2 list.
  const f32 = (no: number, v: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, v, true);
    return concat(encodeVarint(BigInt(no * 8 + 5)), bytes);
  };
  const entry = (key: string, v: number) => field(2, 2, concat(utf8(5, key), field(4, 2, concat(utf8(1, key), f32(2, v)))));
  const connect = (body: Uint8Array<ArrayBuffer>) =>
    new Response(body, { headers: { "content-type": "application/connect+proto" } });

  it("reads the token counters an exa stream carries in field 28", async () => {
    const stats = field(
      28,
      2,
      concat(utf8(1, "Tokens"), entry("input_tokens", 8448), entry("output_tokens", 85), entry("cached_input_tokens", 6752)),
    );
    const body = concat(frame(utf8(9, "done")), frame(stats), frame(new TextEncoder().encode("{}"), 0x2));
    expect(await readUsage(connect(body))).toEqual({ input: 8448, output: 85, cached: 6752, cacheWrite: 0, reasoning: 0 });
  });

  it("ignores counters it does not know and bodies it cannot peel", async () => {
    const stats = field(28, 2, concat(utf8(1, "Other"), entry("something_else", 3)));
    expect(await readUsage(connect(frame(stats)))).toBeUndefined();
    expect(await readUsage(connect(Uint8Array.of(1, 2, 3)))).toBeUndefined();
  });
});

describe("reply metadata", () => {
  it("keeps only explicit response metadata and qualified unique tool names", async () => {
    expect(await readReply(Response.json({
      object: "response", id: "resp_1", model: "gpt-5", status: "completed",
      output: [
        { type: "message", content: [{ text: "private answer" }] },
        { type: "function_call", namespace: "functions", name: "read_file", arguments: "private argument" },
        { type: "custom_tool_call", namespace: "tools", name: "apply_patch", input: "private patch" },
        { type: "function_call", namespace: "functions", name: "read_file", arguments: "another argument" },
        { type: "web_search_call", action: { query: "private query" } },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
      error: { message: "private failure" },
    }))).toEqual({
      usage: { input: 12, output: 3, cached: 0, cacheWrite: 0, reasoning: 0 },
      response: { id: "resp_1", model: "gpt-5", tools: ["functions.read_file", "tools.apply_patch", "web_search"], ending: "response.completed" },
    });
  });

  it("retains streamed calls when the terminal response has an empty output", async () => {
    expect(await readReply(sse([
      { type: "response.created", response: { id: "resp_stream", model: "gpt-stream", status: "in_progress", output: [] } },
      { type: "response.output_text.delta", delta: "private text with a usage lookalike" },
      { type: "response.function_call_arguments.delta", delta: "private arguments" },
      { type: "response.output_item.done", item: { type: "function_call", namespace: "functions", name: "shell", arguments: "private command" } },
      { type: "response.output_item.done", item: { type: "custom_tool_call", namespace: "tools", name: "patch", input: "private patch" } },
      { type: "response.output_item.done", item: { type: "file_search_call" } },
      { type: "response.output_item.done", item: { type: "function_call", namespace: "functions", name: "shell" } },
      { type: "response.completed", response: { id: "resp_stream", output: [], usage: { input_tokens: 7, output_tokens: 2 } } },
    ]))).toEqual({
      usage: { input: 7, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 },
      response: { id: "resp_stream", model: "gpt-stream", tools: ["functions.shell", "tools.patch", "file_search"], ending: "response.completed" },
    });
  });

  it("recognises compact Responses JSON without the optional object marker", async () => {
    expect(await readReply(Response.json({
      id: "resp_compact", model: "gpt-compact", status: "completed", output: [{ type: "function_call", name: "read" }],
    }))).toEqual({ response: { id: "resp_compact", model: "gpt-compact", tools: ["read"], ending: "response.completed" } });
  });

  it("preserves usage reported by an unfamiliar Responses lifecycle event", async () => {
    expect(await readReply(sse([
      { type: "response.queued", response: { id: "resp_queued", usage: { input_tokens: 6, output_tokens: 0 } } },
      { type: "response.completed", response: { id: "resp_queued", output: [] } },
    ]))).toEqual({
      usage: { input: 6, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      response: { id: "resp_queued", tools: [], ending: "response.completed" },
    });
  });

  it.each(["incomplete", "failed"])("reports the explicit %s terminal marker in JSON and SSE", async (status) => {
    const response = { object: "response", id: "resp_status", status, output: [], error: { message: "private error" } };
    for (const wire of [Response.json(response), sse([{ type: `response.${status}`, response }])]) {
      expect(await readReply(wire)).toEqual({ response: { id: "resp_status", tools: [], ending: `response.${status}` } });
    }
  });

  const chunks = (parts: string[], failing = false) => {
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < parts.length) controller.enqueue(new TextEncoder().encode(parts[index++]));
        else if (failing) controller.error(new Error("private connection error"));
        else controller.close();
      },
    }));
  };
  const aborted = () => AbortSignal.abort();

  it("recognises terminal events across chunk boundaries without a content-type or payload type", async () => {
    expect(await readReply(chunks([
      "ev", "ent: response.created\r\ndata: {\"response\":{\"id\":\"resp_chunks\",\"model\":\"gpt-chunks\"}}\r\n\r\n",
      "event: response.output_item.done\ndata: {\"item\":{\"type\":\"function_call\",\"name\":\"read\"}}\n\n",
      "event: response.comp", "leted\ndata: {\"response\":{\"output\":[]}}",
    ]))).toEqual({ response: { id: "resp_chunks", model: "gpt-chunks", tools: ["read"], ending: "response.completed" } });
  });

  const inProgress = "event: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"resp_partial\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n";
  const partialUsage = { input: 9, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 };

  it("ends as unterminated when a stream closes cleanly without a terminal event", async () => {
    expect(await readReply(chunks([inProgress]))).toEqual({ usage: partialUsage, response: { id: "resp_partial", tools: [], ending: "unterminated" } });
  });

  it("ends as stream_error when reading fails and the client did not abort", async () => {
    expect(await readReply(chunks([inProgress], true))).toEqual({ usage: partialUsage, response: { id: "resp_partial", tools: [], ending: "stream_error" } });
  });

  it.each([
    ["the stream closes cleanly", false],
    ["reading the stream fails", true],
  ])("ends as client_aborted when the client aborted before a terminal event and %s", async (_, failing) => {
    expect(await readReply(chunks([inProgress], failing), aborted())).toEqual({
      usage: partialUsage,
      response: { id: "resp_partial", tools: [], ending: "client_aborted" },
    });
  });

  const completed = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_done\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n";

  it.each([
    ["a read error", chunks([completed], true), undefined],
    ["an abort", chunks([completed]), aborted()],
    ["both", chunks([completed], true), aborted()],
  ])("keeps response.completed when it was followed by %s, which is how Codex hangs up", async (_, body, signal) => {
    expect(await readReply(body, signal)).toEqual({ usage: partialUsage, response: { id: "resp_done", tools: [], ending: "response.completed" } });
  });

  it("reports an error event of the Responses stream as its ending", async () => {
    const lifecycle = { type: "response.created", response: { id: "resp_err", model: "gpt-err" } };
    const error = { type: "error", code: "server_error", message: "private failure" };
    expect(await readReply(sse([lifecycle, error]))).toEqual({ response: { id: "resp_err", model: "gpt-err", tools: [], ending: "error" } });
    expect(await readReply(chunks([
      `event: response.created\ndata: ${JSON.stringify(lifecycle)}\n\n`, "event: error\ndata: {\"message\":\"private failure\"}\n\n",
    ]))).toEqual({ response: { id: "resp_err", model: "gpt-err", tools: [], ending: "error" } });
  });

  it("keeps the first terminal event when another event follows it", async () => {
    const done = { type: "response.completed", response: { id: "resp_first" } };
    expect(await readReply(sse([done, { type: "error", message: "late" }]))).toEqual({ response: { id: "resp_first", tools: [], ending: "response.completed" } });
  });

  it("ignores an error event from a stream that is not the Responses API", async () => {
    const overloaded = { type: "error", error: { type: "overloaded_error", message: "private" } };
    expect(await readReply(sse([{ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } }, overloaded])))
      .toEqual({ usage: { input: 3, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } });
    expect(await readReply(sse([overloaded]))).toEqual({});
  });

  it("does not infer completion from HTTP success or unsupported provider formats", async () => {
    expect(await readReply(Response.json({ object: "response", id: "resp_active", status: "in_progress", output: [] })))
      .toEqual({ response: { id: "resp_active", tools: [] } });
    for (const response of [new Response("<html>upstream error</html>"), Response.json({ error: { message: "private" } }), sse([{ choices: [] }])]) {
      expect(await readReply(response)).toEqual({});
    }
    expect(await readReply(Response.json({ usage: { prompt_tokens: 4, completion_tokens: 1 } })))
      .toEqual({ usage: { input: 4, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } });
  });

  it("bounds malformed metadata fields and the number of returned tools", async () => {
    const metadata = (await readReply(Response.json({
      object: "response", id: "x".repeat(10_000), model: { name: "private" }, status: "completed",
      output: [
        { type: "function_call", name: "x".repeat(10_000) },
        ...Array.from({ length: 300 }, (_, i) => ({ type: "function_call", name: `tool_${i}` })),
      ],
    }))).response;
    expect(metadata?.id).toBeUndefined();
    expect(metadata?.model).toBeUndefined();
    expect(metadata?.tools).toHaveLength(128);
    expect(metadata?.tools.every((name) => name.length <= 256)).toBe(true);
  });
});

describe("baseline mode", () => {
  const upstream = (async () =>
    Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } })) as unknown as typeof fetch;
  const post = (app: ReturnType<typeof createApp>) =>
    app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(chat("kitchen lights on")) });
  const feed = async (app: ReturnType<typeof createApp>) => {
    await settled();
    return (await (await app.request("/dashboard/events")).json()) as { router: { routing: boolean }; events: any[] };
  };

  it("meters traffic without ever asking Jev when routing starts off", async () => {
    const jev = fakeJev({});
    const app = createApp({ config: testConfig({ routing: false }), askJev: jev.askJev, fetch: upstream });
    const res = await post(app);

    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("routing_disabled");
    const { router, events } = await feed(app);
    expect(router.routing).toBe(false);
    expect(events[0]).toMatchObject({ mode: "passthrough", reason: "routing_disabled", usage: { input: 100, output: 20 } });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("can be switched at runtime, by this machine's pages only", async () => {
    const jev = fakeJev({ tool: { choice: "get_weather" }, needs_tool: { noul: 0.9 } });
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream });
    const flip = (enabled: string, origin?: string) =>
      app.request(`/dashboard/routing?enabled=${enabled}`, { method: "POST", headers: origin ? { origin } : {} });

    expect((await flip("false", "https://evil.example")).status).toBe(403);
    expect((await flip("maybe")).status).toBe(400);
    expect(await (await flip("false", "http://localhost:8789")).json()).toEqual({ routing: false });
    await post(app);
    expect(jev.requests).toHaveLength(0);

    await flip("true");
    await post(app);
    expect(jev.requests).toHaveLength(1);
    expect((await feed(app)).events.map((event) => event.mode)).toEqual(["passthrough", "forced"]);
  });
});

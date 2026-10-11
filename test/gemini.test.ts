import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { NO_TOOL } from "../src/questions.js";
import { readUsage } from "../src/usage.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

const geminiRequest = (extra: Record<string, unknown> = {}) => ({
  contents: [
    {
      role: "user",
      parts: [{ text: "what does main.py do?" }],
    },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "shell",
            args: { command: "ls" },
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "shell",
            response: { output: "main.py\nREADME.md" },
          },
        },
      ],
    },
  ],
  systemInstruction: {
    parts: [{ text: "You are a helpful coding assistant." }],
  },
  tools: [
    {
      functionDeclarations: [
        {
          name: "shell",
          description: "Runs a shell command.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    },
  ],
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0], reply?: unknown) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream(reply);
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown, path = "/v1beta/models/gemini-2.0-flash:generateContent") =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream, app };
}

const shellDecision = { tool: { choice: "shell" }, needs_tool: { noul: 0.95 } };

const listPlansTool = {
  functionDeclarations: [{ name: "list_plans", parameters: { type: "object", properties: {} } }],
};
const listPlansDecision = { tool: { choice: "list_plans" }, needs_tool: { noul: 0.95 } };
const listPlansContent = { role: "user", parts: [{ text: "list plans" }] };
const invalidCollectionCases: [string, unknown][] = [
  [
    "contents",
    geminiRequest({ contents: [null, "bad", [], listPlansContent], tools: [listPlansTool] }),
  ],
  [
    "parts",
    geminiRequest({ contents: [{ role: "user", parts: [null, "bad", [], { text: "list plans" }] }], tools: [listPlansTool] }),
  ],
  [
    "systemInstruction.parts",
    geminiRequest({ systemInstruction: { parts: [null, "bad", [], { text: "instructions" }] }, tools: [listPlansTool] }),
  ],
  ["tools", geminiRequest({ tools: [null, "bad", [], listPlansTool] })],
  [
    "functionDeclarations",
    geminiRequest({ tools: [{ functionDeclarations: [null, "bad", [], listPlansTool.functionDeclarations[0]] }] }),
  ],
  [
    "part text",
    geminiRequest({ contents: [{ role: "user", parts: [{ text: 17 }, { text: "list plans" }] }], tools: [listPlansTool] }),
  ],
  [
    "functionCall name",
    geminiRequest({
      contents: [{ role: "model", parts: [{ functionCall: { name: 17 } }, { text: "list plans" }] }],
      tools: [listPlansTool],
    }),
  ],
  [
    "functionResponse",
    geminiRequest({
      contents: [{ role: "user", parts: [{ functionResponse: { name: 17 } }, { text: "list plans" }] }],
      tools: [listPlansTool],
    }),
  ],
  [
    "functionDeclaration name",
    geminiRequest({ tools: [{ functionDeclarations: [{ name: 17 }, listPlansTool.functionDeclarations[0]] }] }),
  ],
];

describe("malformed Gemini collections", () => {
  it.each(invalidCollectionCases)("passes through the original request when %s contains malformed entries", async (_name, body) => {
    const { post, jev, upstream } = setup(listPlansDecision);
    const response = await post(body);

    expect(jev.requests).toHaveLength(0);
    expect(response.headers.get("x-jev-gateway-reason")).toBe("unreadable_request");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.body).toEqual(body);
  });

  it("keeps valid hosted tools and unknown multimodal part keys routable", async () => {
    const body = geminiRequest({
      contents: [
        {
          role: "user",
          parts: [
            { text: "list plans" },
            { inlineData: { mimeType: "image/png", data: "AA==" } },
            { futurePart: { value: true } },
          ],
        },
      ],
      tools: [listPlansTool, { googleSearch: {} }, { futureHostedTool: { enabled: true } }],
    });
    const { post, jev, upstream } = setup(listPlansDecision);
    const response = await post(body);

    expect(jev.requests).toHaveLength(1);
    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.body.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["list_plans"],
    });
    expect(response.status).toBe(200);
  });
});

describe("POST /v1beta/models/...:generateContent", () => {
  it("translates Gemini contents and systemInstruction into Jev turns and tool declarations", async () => {
    const { post, jev } = setup(shellDecision);
    await post(geminiRequest());

    const { state } = jev.requests[0]!;
    expect(state).toEqual({
      assistant_instructions: "You are a helpful coding assistant.",
      conversation: [
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", tool_calls: [{ tool: "shell", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "shell", content: '{"output":"main.py\\nREADME.md"}' },
      ],
    });
  });

  it("forces tool selection by updating toolConfig.functionCallingConfig", async () => {
    const { post, upstream } = setup(shellDecision);
    await post(geminiRequest());

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as {
      toolConfig?: { functionCallingConfig?: { mode: string; allowedFunctionNames?: string[] } };
    };
    expect(sent.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["shell"],
    });
  });

  it("forces the provider to make a closed-set call with its signature", async () => {
    const reply = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: { name: "set_lights", args: { room: "bedroom", on: true } },
                thoughtSignature: "provider-signature",
              },
            ],
          },
        },
      ],
    };
    const { post, jev, upstream } = setup({
      tool: { choice: "set_lights" },
      needs_tool: { noul: 0.95 },
      "arg:0:room": { choice: "bedroom" },
      "arg:0:on": { noul: 0.99 },
    }, reply);
    const response = await post(
      geminiRequest({
        tools: [
          {
            functionDeclarations: [
              {
                name: "set_lights",
                description: "Turn lights on or off",
                parameters: {
                  type: "object",
                  properties: {
                    room: { type: "string", enum: ["kitchen", "bedroom"] },
                    on: { type: "boolean" },
                  },
                  required: ["room", "on"],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    expect(Object.keys(jev.requests[0]!.questions)).not.toContain("arg:0:room");
    expect(upstream.calls[0]?.body.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["set_lights"],
    });
    expect(await response.json()).toEqual(reply);
  });

  it("disables tools when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({
      tool: { choice: NO_TOOL },
      needs_tool: { noul: 0.05 },
    });
    await post(geminiRequest());

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as {
      toolConfig?: { functionCallingConfig?: { mode: string } };
    };
    expect(sent.toolConfig?.functionCallingConfig).toEqual({
      mode: "NONE",
    });
  });

  it("auto-detects Gemini wire format in /router/decide", async () => {
    const { app } = setup(shellDecision);
    const res = await app.request("/router/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(geminiRequest()),
    });

    expect(res.status).toBe(200);
    const decision = (await res.json()) as { mode: string; tool?: string };
    expect(decision.mode).toBe("forced");
    expect(decision.tool).toBe("shell");
  });

  it("sends /v1beta paths upstream as they came, query included", async () => {
    const jev = fakeJev({ tool: { choice: "shell", confidence: 0.2 }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ upstreamBaseUrl: "https://generativelanguage.googleapis.com" }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    await app.request("/v1beta/models/gemini-2.5-pro:generateContent?key=abc", { method: "POST", body: JSON.stringify(geminiRequest()) });
    await app.request("/v1beta/models?pageSize=5");
    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=abc",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=5",
    ]);
  });

  it("records model and tools for countTokens without asking Jev", async () => {
    const jev = fakeJev(shellDecision);
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig(),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    const body = { contents: [listPlansContent] };
    const response = await app.request("/v1beta/models/gemini-2.5-pro:countTokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await settled();

    const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string; tools: number }[] };
    expect(response.status).toBe(200);
    expect(feed.events[0]).toMatchObject({ model: "gemini-2.5-pro", tools: 0 });
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls[0]?.body).toEqual(body);
  });

  it("preserves provider stream formats and reads the model from Gemini paths", async () => {
    const noArgs = { functionDeclarations: [{ name: "list_plans", description: "List saved plans.", parameters: { type: "object", properties: {} } }] };
    const canned = { tool: { choice: "list_plans" }, needs_tool: { noul: 0.9 } };
    const reply = {
      candidates: [{ content: { role: "model", parts: [{ text: "provider reply" }] } }],
      usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 1, totalTokenCount: 124 },
    };
    const request = geminiRequest({ tools: [noArgs] });
    const routed = async (path: string) => {
      const urls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        urls.push(url.pathname + url.search);
        if (url.searchParams.get("alt") === "sse") {
          return new Response("data: " + JSON.stringify(reply) + "\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (/:streamGenerateContent$/.test(url.pathname)) {
          return new Response(JSON.stringify([reply]), { headers: { "content-type": "application/json" } });
        }
        return Response.json(reply);
      }) as typeof fetch;
      const app = createApp({ config: testConfig(), askJev: fakeJev(canned).askJev, fetch: fetchImpl });
      const response = await app.request(path, { method: "POST", body: JSON.stringify(request) });
      await settled();
      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string }[] };
      return {
        type: response.headers.get("content-type"),
        mode: response.headers.get("x-jev-gateway-mode"),
        text: await response.text(),
        model: feed.events[0]?.model,
        urls,
      };
    };

    const sse = await routed("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    expect(sse.type).toContain("text/event-stream");
    expect(JSON.parse(sse.text.replace(/^data: /, "")).candidates[0].content.parts[0].text).toBe("provider reply");
    expect(sse.mode).toBe("forced");
    expect(sse.model).toBe("gemini-2.5-pro");
    expect(sse.urls[0]).toContain("gemini-2.5-pro:streamGenerateContent?alt=sse");

    const array = await routed("/v1beta/models/gemini-2.5-pro:streamGenerateContent");
    expect(array.type).toContain("application/json");
    expect(JSON.parse(array.text)[0].usageMetadata).toEqual(reply.usageMetadata);

    expect((await routed("/v1beta/models/gemini-2.5-pro:generateContent")).type).toContain("application/json");
  });

  it("offers Google-run tools to Jev without forcing them, and respects allowedFunctionNames", async () => {
    const two = { functionDeclarations: [{ name: "shell", description: "Runs a shell command." }, { name: "read_file", description: "Reads a file." }] };
    const hosted = setup({ tool: { choice: "googleSearch" }, needs_tool: { noul: 0.9 } });
    const res = await hosted.post(geminiRequest({ tools: [two, { googleSearch: {} }] }));
    expect(res.headers.get("x-jev-gateway-reason")).toBe("hosted_tool_selected");

    const narrowed = setup({ tool: { choice: "read_file" }, needs_tool: { noul: 0.9 } });
    await narrowed.post(geminiRequest({ tools: [two], toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] } } }));
    const question = narrowed.jev.requests[0]!.questions.tool!;
    expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["read_file"]);
  });

  it("meters a streamed Gemini reply", async () => {
    const body = `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 64 } })}\n\n`;
    expect(await readUsage(new Response(body))).toMatchObject({ input: 100, output: 20, cached: 64 });
  });

  describe("Cloud Code and internal /v1internal routing", () => {
    const wrappedInternalRequest = (extra: Record<string, unknown> = {}) => ({
      project: "projects/test-project/locations/global",
      model: "gemini-3.8-flash-high",
      requestId: "req-123",
      request: geminiRequest(extra),
    });

    it("filters out thinking blocks (thought: true) from conversation turns", async () => {
      const { post, jev } = setup(shellDecision);
      const reqWithThought = wrappedInternalRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "what does main.py do?" }],
          },
          {
            role: "model",
            parts: [
              { text: "Thinking about the files in the directory...", thought: true },
              {
                functionCall: {
                  name: "hidden_thought_call",
                  args: { command: "do not include" },
                },
                thought: true,
              },
              {
                functionCall: {
                  name: "shell",
                  args: { command: "ls" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "shell",
                  response: { output: "main.py\nREADME.md" },
                },
              },
            ],
          },
        ],
      });
      await post(reqWithThought, "/v1internal:streamGenerateContent");

      const { state } = jev.requests[0]!;
      expect((state as Record<string, unknown>).conversation).toEqual([
        { role: "user", text: "what does main.py do?" },
        { role: "assistant", tool_calls: [{ tool: "shell", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "shell", content: "{\"output\":\"main.py\\nREADME.md\"}" },
      ]);
    });

    it("records model from top-level or wrapped request in dashboard events", async () => {
      const { post, app } = setup(shellDecision);
      await post(wrappedInternalRequest(), "/v1internal:streamGenerateContent");
      await settled();

      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string }[] };
      expect(feed.events[0]?.model).toBe("gemini-3.8-flash-high");
    });

    it("records a nested model when the envelope has no top-level model", async () => {
      const { post, app } = setup(shellDecision);
      const body = { ...wrappedInternalRequest(), model: undefined, request: geminiRequest({ model: "nested-gemini" }) };
      await post(body, "/v1internal:generateContent");
      await settled();

      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string }[] };
      expect(feed.events[0]?.model).toBe("nested-gemini");
    });

    it("counts declared and distinct hosted tools in a wrapped request with routing off", async () => {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({
        config: testConfig({ routing: false }),
        askJev: jev.askJev,
        fetch: upstream.fetchImpl,
      });
      const declarations = ["one", "two", "three", "four", "five"].map((name) => ({ name }));
      const original = wrappedInternalRequest({
        tools: [
          { functionDeclarations: declarations },
          { googleSearch: {} },
          { googleSearch: {}, urlContext: {} },
        ],
      });
      await app.request("/v1internal:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(original),
      });
      await settled();

      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { tools: number }[] };
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]?.body).toEqual(original);
      expect(feed.events[0]?.tools).toBe(7);
    });

    it("keeps the wrapped model in dashboard events when its tool groups are malformed", async () => {
      const { post, app, jev } = setup(listPlansDecision);
      const malformed = {
        ...wrappedInternalRequest({ model: "nested-gemini", tools: [null] }),
        model: undefined,
      };
      await post(malformed, "/v1internal:generateContent");
      await settled();

      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string }[] };
      expect(jev.requests).toHaveLength(0);
      expect(feed.events[0]?.model).toBe("nested-gemini");
    });

    it("keeps wrapped metadata when allowedFunctionNames is malformed in baseline mode", async () => {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({
        config: testConfig({ routing: false }),
        askJev: jev.askJev,
        fetch: upstream.fetchImpl,
      });
      const original = {
        ...wrappedInternalRequest({
          model: "known-model",
          tools: [listPlansTool],
          toolConfig: { functionCallingConfig: { allowedFunctionNames: { length: 1 } } },
        }),
        model: undefined,
      };
      await app.request("/v1internal:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(original),
      });
      await settled();

      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string; tools: number }[] };
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]?.body).toEqual(original);
      expect(feed.events[0]).toMatchObject({ model: "known-model", tools: 1 });
    });

    it("disables tools inside a wrapped request when Jev is confident no tool is needed", async () => {
      const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
      const original = wrappedInternalRequest();
      await post(original, "/v1internal:generateContent");

      expect(upstream.calls[0]?.body).toEqual({
        ...original,
        request: {
          ...original.request,
          toolConfig: { functionCallingConfig: { mode: "NONE" } },
        },
      });
    });

    it("leaves a wrapped request with tool choice NONE untouched", async () => {
      const { post, upstream, jev } = setup(shellDecision);
      const original = wrappedInternalRequest({ toolConfig: { functionCallingConfig: { mode: "NONE" } } });
      const response = await post(original, "/v1internal:generateContent");

      expect(jev.requests).toHaveLength(0);
      expect(response.headers.get("x-jev-gateway-reason")).toBe("tool_choice_already_decided");
      expect(upstream.calls[0]?.body).toEqual(original);
    });

    it("uses only the inner request fields when an envelope also has outer lookalikes", async () => {
      const { post, jev, upstream } = setup(listPlansDecision);
      const innerTools = {
        functionDeclarations: [
          { name: "list_plans", parameters: { type: "object", properties: {} } },
          { name: "read_file", parameters: { type: "object", properties: {} } },
        ],
      };
      const original = {
        ...wrappedInternalRequest({
          contents: [listPlansContent],
          systemInstruction: { parts: [{ text: "inner instructions" }] },
          tools: [innerTools],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
        }),
        contents: [{ role: "user", parts: [{ text: "outer decoy" }] }],
        systemInstruction: { parts: [{ text: "outer instructions" }] },
        tools: [{ functionDeclarations: [{ name: "outer_tool" }] }],
        toolConfig: { functionCallingConfig: { mode: "NONE" as const } },
      };
      await post(original, "/v1internal:generateContent");

      expect(jev.requests).toHaveLength(1);
      expect(jev.requests[0]?.state).toMatchObject({
        assistant_instructions: "inner instructions",
        conversation: [{ role: "user", text: "list plans" }],
      });
      const question = jev.requests[0]!.questions.tool!;
      expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["list_plans", "read_file"]);
      expect(upstream.calls[0]?.body).toEqual({
        ...original,
        request: {
          ...original.request,
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["list_plans"] } },
        },
      });
    });

    it("respects allowedFunctionNames inside a wrapped request", async () => {
      const { post, jev } = setup(listPlansDecision);
      const two = {
        functionDeclarations: [
          { name: "list_plans", parameters: { type: "object", properties: {} } },
          { name: "read_file", parameters: { type: "object", properties: {} } },
        ],
      };
      await post(wrappedInternalRequest({
        contents: [listPlansContent],
        tools: [two],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["list_plans"] } },
      }), "/v1internal:generateContent");

      expect(jev.requests).toHaveLength(1);
      const question = jev.requests[0]!.questions.tool!;
      expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["list_plans"]);
    });

    it("passes a malformed internal envelope upstream without asking Jev", async () => {
      const { post, upstream, jev } = setup(shellDecision);
      const malformed = { ...geminiRequest(), request: [] };
      await post(malformed, "/v1internal:generateContent");

      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]?.body).toEqual(malformed);
    });

    it("passes an empty wrapped request through even when outer lookalikes are present", async () => {
      const { post, upstream, jev } = setup(listPlansDecision);
      const malformed = {
        ...wrappedInternalRequest(),
        contents: [listPlansContent],
        tools: [listPlansTool],
        request: {},
      };
      const response = await post(malformed, "/v1internal:generateContent");

      expect(jev.requests).toHaveLength(0);
      expect(response.headers.get("x-jev-gateway-reason")).toBe("no_messages");
      expect(upstream.calls[0]?.body).toEqual(malformed);
    });

    it.each([400, 422])("replays the original wrapped body when the provider rejects a rewrite with %i", async (status) => {
      const jev = fakeJev(shellDecision);
      const sent: unknown[] = [];
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        const text = typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "";
        sent.push(JSON.parse(text));
        return sent.length === 1 ? Response.json({ error: "unsupported rewrite" }, { status }) : Response.json({ ok: true });
      }) as typeof fetch;
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: fetchImpl });
      const original = wrappedInternalRequest();
      const response = await app.request("/v1internal:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(original),
      });

      expect(sent).toHaveLength(2);
      const rewritten = sent[0] as {
        request: { toolConfig?: { functionCallingConfig?: { mode: string; allowedFunctionNames?: string[] } } };
      };
      expect(rewritten.request.toolConfig?.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["shell"],
      });
      expect(sent[1]).toEqual(original);
      expect(response.headers.get("x-jev-gateway-reason")).toBe("upstream_rejected_forced");
    });

    it("translates Cloud Code internal wrapped request into Jev turns and tool declarations", async () => {
      const { post, jev } = setup(shellDecision);
      await post(wrappedInternalRequest(), "/v1internal:generateContent");

      const { state } = jev.requests[0]!;
      expect(state).toEqual({
        assistant_instructions: "You are a helpful coding assistant.",
        conversation: [
          { role: "user", text: "what does main.py do?" },
          { role: "assistant", tool_calls: [{ tool: "shell", arguments: '{"command":"ls"}' }] },
        { role: "tool_result", tool: "shell", content: '{"output":"main.py\\nREADME.md"}' },
        ],
      });
    });

    it("forces tool selection in wrapped request.toolConfig", async () => {
      const { post, upstream } = setup(shellDecision);
      const original = wrappedInternalRequest();
      await post(original, "/v1internal:streamGenerateContent");

      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]?.body).toEqual({
        ...original,
        request: {
          ...original.request,
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["shell"] } },
        },
      });
    });

    it("uses the provider response for wrapped calls so its signature is preserved", async () => {
      const reply = {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "set_lights", args: { room: "bedroom", on: true } },
                    thoughtSignature: "cloudcode-provider-signature",
                  },
                ],
              },
            },
          ],
        },
      };
      const { post, upstream } = setup({
        tool: { choice: "set_lights" },
        needs_tool: { noul: 0.95 },
        "arg:0:room": { choice: "bedroom" },
        "arg:0:on": { noul: 0.99 },
      }, reply);
      const response = await post(
        wrappedInternalRequest({
          tools: [
            {
              functionDeclarations: [
                {
                  name: "set_lights",
                  description: "Turn lights on or off",
                  parameters: {
                    type: "object",
                    properties: {
                      room: { type: "string", enum: ["kitchen", "bedroom"] },
                      on: { type: "boolean" },
                    },
                    required: ["room", "on"],
                  },
                },
              ],
            },
          ],
        }),
        "/v1internal:generateContent",
      );

      expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]?.body.request?.toolConfig?.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["set_lights"],
      });
      expect(await response.json()).toEqual(reply);
    });

    it("forwards the provider's JSON-array and SSE formats for wrapped streams", async () => {
      const canned = { tool: { choice: "list_plans" }, needs_tool: { noul: 0.9 } };
      const noArgs = { functionDeclarations: [{ name: "list_plans", parameters: { type: "object", properties: {} } }] };
      const providerReply = { response: { candidates: [{ content: { role: "model", parts: [{ text: "provider reply" }] } }] } };
      const routed = async (path: string) => {
        const sent: Record<string, any>[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = init?.body;
          const text = typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "";
          sent.push(JSON.parse(text));
          const url = new URL(String(input));
          return url.searchParams.get("alt") === "sse"
            ? new Response("data: " + JSON.stringify(providerReply) + "\n\n", { headers: { "content-type": "text/event-stream" } })
            : new Response(JSON.stringify([providerReply]), { headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        const jev = fakeJev(canned);
        const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: fetchImpl });
        const response = await app.request(path, {
          method: "POST",
          body: JSON.stringify(wrappedInternalRequest({ tools: [noArgs] })),
        });
        return { response, text: await response.text(), sent };
      };

      const array = await routed("/v1internal:streamGenerateContent");
      expect(array.response.headers.get("content-type")).toContain("application/json");
      expect(array.response.headers.get("x-jev-gateway-mode")).toBe("forced");
      expect(JSON.parse(array.text)[0].response.candidates[0].content.parts[0].text).toBe("provider reply");
      expect(array.sent[0]?.request?.toolConfig?.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["list_plans"],
      });

      const sse = await routed("/v1internal:streamGenerateContent?alt=sse");
      expect(sse.response.headers.get("content-type")).toContain("text/event-stream");
      expect(sse.response.headers.get("x-jev-gateway-mode")).toBe("forced");
      expect(JSON.parse(sse.text.replace(/^data: /, "")).response.candidates[0].content.parts[0].text).toBe("provider reply");
    });

    it("proxies management calls untouched with their credentials and headers", async () => {
      const jev = fakeJev(shellDecision);
      const calls: { url: string; headers: Headers; body: unknown }[] = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: body ? await new Response(body).json() : undefined,
        });
        return Response.json({ ok: true });
      }) as typeof fetch;
      const app = createApp({
        config: testConfig({ upstreamBaseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
        askJev: jev.askJev,
        fetch: fetchImpl,
      });
      const headers = {
        authorization: "Bearer client-oauth-token",
        "content-type": "application/json",
        "x-goog-api-key": "client-api-key",
        "x-goog-api-client": "test-client/1",
      };

      await app.request("/v1internal:loadCodeAssist", { method: "POST", headers, body: JSON.stringify({ project: "proj-1" }) });
      await app.request("/v1internal:fetchAvailableModels", { method: "POST", headers, body: "{}" });
      await app.request("/v1internal/models/gemini-3.8-flash-high", {
        method: "POST",
        headers,
        body: JSON.stringify(geminiRequest()),
      });
      await app.request("/v1beta/projects/test-project/locations/global", {
        method: "POST",
        headers,
        body: JSON.stringify(geminiRequest()),
      });

      expect(calls.map((c) => c.url)).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        "https://daily-cloudcode-pa.googleapis.com/v1internal/models/gemini-3.8-flash-high",
        "https://daily-cloudcode-pa.googleapis.com/v1beta/projects/test-project/locations/global",
      ]);
      for (const call of calls) {
        expect(call.headers.get("authorization")).toBe(headers.authorization);
        expect(call.headers.get("x-goog-api-key")).toBe(headers["x-goog-api-key"]);
        expect(call.headers.get("x-goog-api-client")).toBe(headers["x-goog-api-client"]);
        expect(call.headers.get("content-type")).toBe(headers["content-type"]);
      }
      expect(jev.requests).toHaveLength(0);
      expect(calls[2]?.body).toEqual(geminiRequest());
      expect(calls[3]?.body).toEqual(geminiRequest());
    });

    it("auto-detects wrapped internal request in /router/decide", async () => {
      const { app } = setup(shellDecision);
      const res = await app.request("/router/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wrappedInternalRequest()),
      });

      expect(res.status).toBe(200);
      const decision = (await res.json()) as { mode: string; tool?: string };
      expect(decision.mode).toBe("forced");
      expect(decision.tool).toBe("shell");
    });
  });
});

describe("Gemini direct response methods", () => {
  const req = { request: geminiRequest() };
  const call = { tool: "shell", args: { command: "ls" }, inputTokens: 10 };

  it("returns an unwrapped provider response for a Cloud Code request", () => {
    expect(geminiAdapter.directJson(req, call)).toMatchObject({
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" } } }] } }],
    });
  });

  it("keeps direct stream answers in SSE or JSON-array format", () => {
    const array = geminiAdapter.directStream(req, call, new URL("https://gateway.test/v1internal:streamGenerateContent"));
    const sse = geminiAdapter.directStream(req, call, new URL("https://gateway.test/v1internal:streamGenerateContent?alt=sse"));

    expect(typeof array).toBe("object");
    if (typeof array !== "string") {
      expect(array.contentType).toBe("application/json");
      const body = typeof array.body === "string" ? array.body : Buffer.from(array.body).toString("utf8");
      expect(JSON.parse(body)[0]).toHaveProperty("candidates");
    }
    expect(typeof sse).toBe("string");
    if (typeof sse === "string") expect(JSON.parse(sse.replace(/^data: /, ""))).toHaveProperty("candidates");
  });
});

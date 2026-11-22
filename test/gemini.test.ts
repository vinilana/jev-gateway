import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { readReply } from "../src/usage.js";
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

function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
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

  it("answers directly without an upstream call when all arguments are resolved", async () => {
    const { post, upstream } = setup({
      tool: { choice: "set_lights" },
      needs_tool: { noul: 0.95 },
      "arg:0:room": { choice: "bedroom" },
      "arg:0:on": { noul: 0.99 },
    });
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

    expect(upstream.calls).toHaveLength(0);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ functionCall?: { name: string; args: unknown } }> } }>;
    };
    expect(body.candidates[0]!.content.parts[0]!.functionCall).toEqual({
      name: "set_lights",
      args: { room: "bedroom", on: true },
    });
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

  it("reads the model and the choice to stream from the path", async () => {
    const noArgs = { functionDeclarations: [{ name: "list_plans", description: "List saved plans.", parameters: { type: "object", properties: {} } }] };
    const canned = { tool: { choice: "list_plans" }, needs_tool: { noul: 0.9 } };
    const direct = async (path: string) => {
      const app = createApp({ config: testConfig(), askJev: fakeJev(canned).askJev, fetch: fakeUpstream().fetchImpl });
      const res = await app.request(path, { method: "POST", body: JSON.stringify(geminiRequest({ tools: [noArgs] })) });
      await settled();
      const feed = (await (await app.request("/dashboard/events")).json()) as { events: { model?: string }[] };
      return { type: res.headers.get("content-type"), text: await res.text(), model: feed.events[0]?.model };
    };

    const sse = await direct("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    expect(sse.type).toContain("text/event-stream");
    expect(JSON.parse(sse.text.replace(/^data: /, "")).candidates[0].content.parts[0].functionCall.name).toBe("list_plans");
    expect(sse.model).toBe("gemini-2.5-pro");

    const array = await direct("/v1beta/models/gemini-2.5-pro:streamGenerateContent");
    expect(array.type).toContain("application/json");
    expect(JSON.parse(array.text)[0].usageMetadata).toEqual({ promptTokenCount: 123, candidatesTokenCount: 0, totalTokenCount: 123 });

    expect((await direct("/v1beta/models/gemini-2.5-pro:generateContent")).type).toContain("application/json");
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

  it("keeps the URL model when malformed tools prevent reading body metadata", async () => {
    const logged: Record<string, unknown>[] = [];
    const upstream = fakeUpstream();
    const jev = fakeJev({});
    const app = createApp({ config: testConfig({ routing: false }), askJev: jev.askJev, fetch: upstream.fetchImpl, log: entry => logged.push(entry) });
    const body = geminiRequest({ tools: [null] });
    const response = await app.request("/v1beta/models/gemini-fixture:generateContent", { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    await response.json();
    await settled();
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(jev.requests).toEqual([]);
    expect(logged[0]).toMatchObject({ model: "gemini-fixture", sentModel: "gemini-fixture", reason: "routing_disabled" });
  });

  const decl = (name: string) => ({ name, parameters: { type: "object", properties: {} } });
  const toolCases = [
    { name: "functions grouped in one entry", tools: [{ functionDeclarations: [decl("a"), decl("b")] }], toolConfig: undefined, expected: 2 },
    { name: "functions beside a hosted tool", tools: [{ functionDeclarations: [decl("a"), decl("b")] }, { googleSearch: {} }], toolConfig: undefined, expected: 3 },
    {
      name: "functions narrowed by allowedFunctionNames",
      tools: [{ functionDeclarations: [decl("a"), decl("b"), decl("c")] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["a", "b"] } },
      expected: 2,
    },
  ];
  it.each([true, false].flatMap((routing) => toolCases.map((tools) => ({ ...tools, routing, mode: routing ? "on" : "off" }))))(
    "logs $expected tools for $name with routing $mode, the same count whether or not Jev is asked",
    async ({ tools, toolConfig, expected, routing }) => {
      const logged: Record<string, unknown>[] = [];
      const app = createApp({
        config: testConfig({ routing }), askJev: fakeJev({ tool: { choice: "a" }, needs_tool: { noul: 0.95 } }).askJev,
        fetch: fakeUpstream().fetchImpl, log: (entry) => logged.push(entry),
      });
      await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST", body: JSON.stringify(geminiRequest({ tools, toolConfig })),
      });
      await settled();
      expect(logged[0]).toMatchObject({ tools: expected });
    },
  );

  it("meters a streamed Gemini reply", async () => {
    const body = `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 64 } })}\n\n`;
    expect((await readReply(new Response(body))).usage).toMatchObject({ input: 100, output: 20, cached: 64 });
  });
});

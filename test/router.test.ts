import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { chatAdapter } from "../src/adapters/chat.js";
import { NO_TOOL, planTool } from "../src/questions.js";
import { buildState } from "../src/state.js";
import type { RouterInput, RouterTool } from "../src/types.js";
import { chat, fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const lightsAnswers = {
  tool: { choice: "set_lights" },
  needs_tool: { noul: 0.97 },
  "arg:1:room": { choice: "kitchen" },
  "arg:1:on": { noul: 0.98 },
  "arg:1:brightness": { choice: "50" },
  "stated:1:brightness": { noul: 0.04 },
};

function setup(canned: Parameters<typeof fakeJev>[0], config = testConfig()) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config, askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key", ...headers },
      body: JSON.stringify(body),
    });
  return { app, post, jev, upstream };
}

describe("planTool", () => {
  it("marks a tool closed-set only when every parameter is an enum, boolean or const", () => {
    const [weather, lights] = (chatAdapter.toInput(chat("hi"), 100) as RouterInput).tools as [RouterTool, RouterTool];
    expect(planTool(weather).closedParams).toBeUndefined();
    expect(planTool(lights).closedParams?.map((param) => param.kind)).toEqual(["enum", "boolean", "enum"]);
  });
});

describe("chatAdapter.toInput + buildState", () => {
  it("names the tool behind each tool result and keeps the newest turns within budget", () => {
    const input = chatAdapter.toInput(
      {
        model: "m",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "x".repeat(500) },
          {
            role: "assistant",
            tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "sunny" },
        ],
      },
      100,
    ) as RouterInput;
    const state = buildState(input, { maxStateChars: 200, maxMessageChars: 100 });
    expect(state.assistant_instructions).toBe("Be brief.");
    expect(state.earlier_turns_omitted).toBe(1);
    expect(state.conversation).toEqual([
      { role: "assistant", tool_calls: [{ tool: "get_weather", arguments: "{}" }] },
      { role: "tool_result", tool: "get_weather", content: "sunny" },
    ]);
  });
});

describe("POST /v1/chat/completions", () => {
  it("never answers directly with JEV_DIRECT_CALLS=false, not even for a tool that takes no arguments", async () => {
    const ping = { type: "function", function: { name: "ping", description: "Check the service is up.", parameters: { type: "object", properties: {} } } };
    const { post, upstream } = setup({ tool: { choice: "ping" }, needs_tool: { noul: 0.95 } }, testConfig({ directCalls: false }));
    const res = await post(chat("is the service up?", { tools: [ping] }));

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
  });

  it("answers directly, without the LLM, when Jev can fill every argument", async () => {
    const { post, upstream } = setup(lightsAnswers);
    const res = await post(chat("turn on the kitchen lights"));
    const json = (await res.json()) as any;

    expect(upstream.calls).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    const call = json.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("set_lights");
    // brightness is optional and was not stated, so it is left to the tool's default.
    expect(JSON.parse(call.function.arguments)).toEqual({ room: "kitchen", on: true });
  });

  it("maps enum labels back to their typed values when an optional argument is stated", async () => {
    const { post } = setup({ ...lightsAnswers, "stated:1:brightness": { noul: 0.93 } });
    const json = (await (await post(chat("kitchen lights on at half brightness"))).json()) as any;
    expect(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      room: "kitchen",
      on: true,
      brightness: 50,
    });
  });

  it("streams a direct answer as chat.completion.chunk events", async () => {
    const { post } = setup(lightsAnswers);
    const res = await post(chat("kitchen lights on", { stream: true, stream_options: { include_usage: true } }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).trim().split("\n\n").map((line) => line.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const args = chunks.map((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? "").join("");
    expect(JSON.parse(args)).toEqual({ room: "kitchen", on: true });
    expect(chunks.at(-2).choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.at(-1).usage.prompt_tokens).toBe(123);
  });

  it("forces the tool Jev picked and lets the LLM fill open-ended arguments", async () => {
    const { post, upstream } = setup(
      { ...lightsAnswers, tool: { choice: "get_weather" } },
      testConfig({ argsModel: "cheap-model" }),
    );
    const res = await post(chat("weather in Lisbon?"));

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    expect(upstream.calls[0]!.body.model).toBe("cheap-model");
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer client-key");
  });

  it("falls back to forcing the tool when an argument is uncertain", async () => {
    const { post, upstream } = setup({ ...lightsAnswers, "arg:1:room": { choice: "office", confidence: 0.4 } });
    const res = await post(chat("lights on"));
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.tool_choice.function.name).toBe("set_lights");
  });

  it("sets tool_choice none when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({ ...lightsAnswers, tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const res = await post(chat("thanks, that's all!"));
    expect(res.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(upstream.calls[0]!.body.tool_choice).toBe("none");
  });

  it("does not offer the no-tool option when the caller requires a tool", async () => {
    const { post, jev } = setup(lightsAnswers);
    await post(chat("kitchen lights on", { tool_choice: "required" }));
    const question = jev.requests[0]!.questions.tool!;
    expect(question.type === "choice" && NO_TOOL in question.criteria).toBe(false);
  });

  it.each([
    ["low confidence", { ...lightsAnswers, tool: { choice: "set_lights", confidence: 0.4 } }, "low_confidence"],
    ["disagreeing answers", { ...lightsAnswers, needs_tool: { noul: 0.1 } }, "jev_answers_disagree"],
  ])("forwards the request untouched on %s", async (_name, canned, reason) => {
    const { post, upstream } = setup(canned);
    const body = chat("hmm");
    const res = await post(body);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(reason);
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("fails open when Jev errors", async () => {
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig(),
      askJev: async () => Promise.reject(new Error("529 overloaded")),
      fetch: upstream.fetchImpl,
    });
    const res = await app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(chat("hi")) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-reason")).toContain("jev_error");
    expect(upstream.calls).toHaveLength(1);
  });

  it.each([
    ["there are no tools", { model: "m", messages: [{ role: "user", content: "hi" }] }, {}],
    ["the caller already chose a tool", chat("hi", { tool_choice: "none" }), {}],
    ["the caller opts out", chat("hi"), { "x-jev-gateway": "off" }],
  ])("never consults Jev when %s", async (_name, body, headers) => {
    const { post, jev, upstream } = setup(lightsAnswers);
    const res = await post(body, headers);
    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(upstream.calls[0]!.headers.has("x-jev-gateway")).toBe(false);
  });
});

describe("gateway", () => {
  it("proxies other /v1 routes and swaps in the upstream key", async () => {
    const upstream = fakeUpstream({ data: [] });
    const app = createApp({
      config: testConfig({ upstreamApiKey: "sk-upstream", routerApiKey: "router-key" }),
      askJev: fakeJev({}).askJev,
      fetch: upstream.fetchImpl,
    });

    expect((await app.request("/v1/models")).status).toBe(401);
    const res = await app.request("/v1/models?limit=5", { headers: { authorization: "Bearer router-key" } });
    expect(res.status).toBe(200);
    expect(upstream.calls[0]!.url).toBe("https://llm.test/v1/models?limit=5");
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer sk-upstream");
  });

  it("reports the decision without calling upstream on /router/decide", async () => {
    const { app, upstream } = setup(lightsAnswers);
    const res = await app.request("/router/decide", { method: "POST", body: JSON.stringify(chat("kitchen lights on")) });
    expect(await res.json()).toMatchObject({ mode: "direct", tool: "set_lights", jev: { choice: "set_lights" } });
    expect(upstream.calls).toHaveLength(0);
  });
});

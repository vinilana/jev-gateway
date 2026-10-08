import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createAskJev } from "../src/jev.js";
import { NO_TOOL } from "../src/questions.js";
import { chat, fakeJev, fakeUpstream } from "./helpers.js";

const config = loadConfig({
  JEV_PROVIDER: "local",
  LOCAL_CLEF_API_KEY: "local-secret",
  UPSTREAM_BASE_URL: "https://llm.test/v1",
  JEV_DIRECT_CALLS: "false",
});

describe("local decisions through the gateway", () => {
  const modes = [
    { mode: "forced", choice: "get_weather", confidence: 0.95, needs: 0.97 },
    { mode: "none", choice: NO_TOOL, confidence: 0.95, needs: 0.03 },
    { mode: "passthrough", choice: "get_weather", confidence: 0.4, needs: 0.97 },
  ];

  for (const stream of [false, true]) {
    it.each(modes)(`returns $mode and preserves the main response with stream=${stream}`, async (scenario) => {
      const jev = fakeJev({
        tool: { choice: scenario.choice, confidence: scenario.confidence },
        needs_tool: { noul: scenario.needs },
      });
      const localFetch: typeof fetch = async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-secret");
        return Response.json(await jev.askJev(JSON.parse(String(init?.body))));
      };
      const upstream = fakeUpstream({ id: "main-response", choices: [] });
      const sse = 'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n';
      const app = createApp({
        config, askJev: createAskJev(config, localFetch),
        fetch: async (...args) => {
          const response = await upstream.fetchImpl(...args);
          return stream ? new Response(sse, { headers: { "content-type": "text/event-stream" } }) : response;
        },
      });
      const body = chat("Weather in Paris?", { stream });
      const response = await app.request("/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer client-secret" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-jev-gateway-mode")).toBe(scenario.mode);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer client-secret");
      const expected = scenario.mode === "forced"
        ? { ...body, tool_choice: { type: "function", function: { name: "get_weather" } } }
        : scenario.mode === "none" ? { ...body, tool_choice: "none" } : body;
      expect(upstream.calls[0]!.body).toEqual(expected);
      if (stream) expect(await response.text()).toBe(sse);
      else expect(await response.json()).toEqual({ id: "main-response", choices: [] });
    });
  }

  it.each([false, true])("answers directly from local probabilities without calling the main LLM (stream=%s)", async (stream) => {
    const jev = fakeJev({ tool: { choice: "toggle" }, needs_tool: { noul: 0.97 }, "arg:0:on": { noul: 0.99 } });
    const localFetch: typeof fetch = async (_url, init) => Response.json(await jev.askJev(JSON.parse(String(init?.body))));
    const upstream = fakeUpstream();
    const app = createApp({ config: { ...config, directCalls: true }, askJev: createAskJev(config, localFetch), fetch: upstream.fetchImpl });
    const response = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(chat("Turn it on", {
        stream,
        tools: [{ type: "function", function: {
          name: "toggle", parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
        } }],
      })),
    });
    expect(response.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(upstream.calls).toHaveLength(0);
    if (stream) {
      const events = (await response.text()).trim().split("\n\n").map((event) => event.replace(/^data: /, ""));
      expect(events.at(-1)).toBe("[DONE]");
      const args = events.slice(0, -1).map((event) => JSON.parse(event).choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? "").join("");
      expect(JSON.parse(args)).toEqual({ on: true });
    } else {
      const body = await response.json();
      expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "toggle", arguments: '{"on":true}' });
    }
  });

  it.each([404, 501, 503])("preserves the original client request when the local server returns %i", async (status) => {
    let calls = 0;
    const localFetch: typeof fetch = async () => {
      calls++;
      return new Response("model unavailable", { status });
    };
    const upstream = fakeUpstream();
    const app = createApp({ config, askJev: createAskJev(config, localFetch), fetch: upstream.fetchImpl });
    const body = chat("Weather in Paris?");
    const response = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(response.headers.get("x-jev-gateway-reason")).toContain(`jev_error: ${status}`);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(calls).toBe(status === 503 ? 2 : 1);
  });

  it("discards partial batch answers when a later local batch fails", async () => {
    const paramNames = Array.from({ length: 80 }, (_, i) => `p${i}`);
    const jev = fakeJev({
      tool: { choice: "configure" }, needs_tool: { noul: 0.97 },
      ...Object.fromEntries(paramNames.map((name) => [`arg:0:${name}`, { noul: 0.99 }])),
    });
    let calls = 0;
    const localFetch: typeof fetch = async (_url, init) => {
      if (++calls > 1) return new Response("busy", { status: 503 });
      const request = JSON.parse(String(init?.body)) as SystemOneRequest<Questions>;
      return Response.json(await jev.askJev(request));
    };
    const upstream = fakeUpstream();
    const app = createApp({ config: { ...config, directCalls: true }, askJev: createAskJev(config, localFetch), fetch: upstream.fetchImpl });
    const body = chat("Configure every option", { tools: [{ type: "function", function: {
      name: "configure", parameters: {
        type: "object", properties: Object.fromEntries(paramNames.map((name) => [name, { type: "boolean" }])), required: paramNames,
      },
    } }] });
    const response = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(calls).toBe(3);
  });
});

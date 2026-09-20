import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadProfiles } from "../src/profiles.js";
import { chat, fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

const profiles = loadProfiles({ CODEX_HOME: "/nonexistent", JEV_OPENCODE_UPSTREAM_BASE_URL: "https://opencode-upstream.test/v1/" });

describe("one gateway, several tools", () => {
  it("gives every tool an upstream of its own", () => {
    expect(Object.fromEntries(profiles.map((profile) => [profile.name, profile.upstream]))).toEqual({
      codex: "https://api.openai.com/v1",
      claude: "https://api.anthropic.com/v1",
      opencode: "https://opencode-upstream.test/v1",
      gemini: "https://generativelanguage.googleapis.com",
    });
  });

  it("sends each prefix to its own upstream, without the prefix, and credits the tool", async () => {
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: fakeJev({}).askJev, fetch: upstream.fetchImpl, profiles });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body) });

    await post("/claude/v1/messages?beta=true", { model: "c", messages: [{ role: "user", content: "hi" }] });
    await post("/opencode/v1/chat/completions", { model: "o", messages: [{ role: "user", content: "hi" }] });
    await post("/gemini/v1beta/models/g:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    await post("/v1/chat/completions", { model: "plain", messages: [{ role: "user", content: "hi" }] });
    await app.request("/codex/v1/models");

    expect(upstream.calls.map((call) => call.url)).toEqual([
      "https://api.anthropic.com/v1/messages?beta=true",
      "https://opencode-upstream.test/v1/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/models/g:generateContent",
      "https://llm.test/v1/chat/completions",
      "https://api.openai.com/v1/models",
    ]);

    await settled();
    const feed = (await (await app.request("/dashboard/events")).json()) as { router: { tools: { name: string }[] }; events: { client: string }[] };
    expect(feed.events.map((event) => event.client)).toEqual(["claude", "opencode", "gemini", "standalone"]);
    expect(feed.router.tools.map((tool) => tool.name)).toEqual(["codex", "claude", "opencode", "gemini"]);
  });

  it("routes a tool's requests through Jev like any other", async () => {
    const jev = fakeJev({ tool: { choice: "get_weather" }, needs_tool: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream.fetchImpl, profiles });
    const res = await app.request("/opencode/v1/chat/completions", { method: "POST", body: JSON.stringify(chat("weather in Lisbon?")) });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls[0]!.body.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });
});

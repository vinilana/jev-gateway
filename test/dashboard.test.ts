import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AskJev } from "../src/decide.js";
import { createEventLog, type RouteEvent } from "../src/events.js";
import { NO_TOOL } from "../src/questions.js";
import { chat, fakeJev, fakeUpstream, testConfig, settled } from "./helpers.js";

type Feed = { router: Record<string, unknown>; events: RouteEvent[] };

const SECRET = "the launch codes are 0000";

const lights = {
  tool: { choice: "set_lights" },
  needs_tool: { noul: 0.97 },
  "arg:1:room": { choice: "kitchen" },
  "arg:1:on": { noul: 0.98 },
  "arg:1:brightness": { choice: "50" },
  "stated:1:brightness": { noul: 0.04 },
};

function setup(askJev: AskJev, config = testConfig(), upstreamReply?: unknown) {
  const app = createApp({ config, askJev, fetch: fakeUpstream(upstreamReply).fetchImpl });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-client-credential" },
      body: JSON.stringify(body),
    });
  const feed = async (query = "") => {
    await settled();
    return (await (await app.request(`/dashboard/events${query}`)).json()) as Feed;
  };
  return { app, post, feed };
}

describe("GET /dashboard/events", () => {
  it("records one event per routed request, whatever the mode", async () => {
    const answers = [
      lights,
      { ...lights, tool: { choice: "get_weather" } },
      { ...lights, tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } },
      { ...lights, tool: { choice: "get_weather", confidence: 0.4 } },
    ];
    const askJev: AskJev = (request) => {
      const canned = answers.shift();
      if (!canned) throw new Error("connect ETIMEDOUT");
      return fakeJev(canned).askJev(request);
    };
    const { post, feed } = setup(askJev);
    for (let i = 0; i < 5; i++) await post("/v1/chat/completions", chat(SECRET));
    await post("/v1/chat/completions", chat(SECRET, { tools: undefined }));
    await post("/v1/messages", {
      model: "claude-test",
      max_tokens: 64,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: SECRET }],
      tools: [{ name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    });

    const { events, router } = await feed();
    expect(events.map((event) => [event.mode, event.reason ?? event.tool])).toEqual([
      ["direct", "set_lights"],
      ["forced", "get_weather"],
      ["none", undefined],
      ["passthrough", "low_confidence"],
      ["passthrough", "jev_error: connect ETIMEDOUT"],
      ["passthrough", "no_tools"],
      ["passthrough", "jev_error: connect ETIMEDOUT"],
    ]);
    expect(events[1]).toMatchObject({ seq: 2, path: "/v1/chat/completions", model: "gpt-test", tools: 2, confidence: 0.95, status: 200 });
    expect(events[1]!.jev).toMatchObject({ choice: "get_weather", inputTokens: 123 });
    // `direct` never reaches upstream, and a failed Jev call leaves no trace to report.
    expect(events[0]!.status).toBeUndefined();
    expect(events[4]!.jev).toBeUndefined();
    expect(router).toMatchObject({ client: "standalone", upstream: "https://llm.test/v1", jevModel: "jev-latest", recorded: 7 });
  });

  it("reports a hint for requests that can only be nudged", async () => {
    const { post, feed } = setup(fakeJev({ tool: { choice: "Bash" }, needs_tool: { noul: 0.9 } }).askJev);
    await post("/v1/messages", {
      model: "claude-test",
      max_tokens: 64,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "list the files" }],
      tools: [{ name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    });
    expect((await feed()).events[0]).toMatchObject({ mode: "hint", tool: "Bash", path: "/v1/messages" });
  });

  it("shows which model actually served the request, when an upstream router served a different one", async () => {
    const { post, feed } = setup(
      fakeJev({ ...lights, tool: { choice: "get_weather" } }).askJev,
      undefined,
      { model: "claude-haiku-4-5-20251001", choices: [{ message: { role: "assistant" }, finish_reason: "stop" }] },
    );
    await post("/v1/chat/completions", chat("what's the weather?", { model: "jevonian/auto" }));
    expect((await feed()).events[0]).toMatchObject({ model: "jevonian/auto", servedModel: "claude-haiku-4-5-20251001" });
  });

  it("leaves servedModel unset when the upstream serves the model that was asked for", async () => {
    const { post, feed } = setup(fakeJev({ ...lights, tool: { choice: "get_weather" } }).askJev, undefined, { model: "gpt-test", choices: [] });
    await post("/v1/chat/completions", chat("what's the weather?"));
    const event = (await feed()).events[0];
    expect(event?.model).toBe("gpt-test");
    expect(event?.servedModel).toBeUndefined();
  });

  it("exposes metadata only: no prompt, no tool arguments, no credentials", async () => {
    const { post, feed } = setup(fakeJev(lights).askJev);
    await post("/v1/chat/completions", chat(SECRET));

    const body = JSON.stringify(await feed());
    expect(body).toContain("set_lights");
    for (const leak of [SECRET, "kitchen", "args", "sk-client-credential"]) expect(body).not.toContain(leak);
  });

  it("returns only what is newer than `since`", async () => {
    const { post, feed } = setup(fakeJev({ ...lights, tool: { choice: "get_weather" } }).askJev);
    for (let i = 0; i < 3; i++) await post("/v1/chat/completions", chat("weather in Lisbon?"));
    expect((await feed("?since=2")).events.map((event) => event.seq)).toEqual([3]);
  });

  it("lets a dashboard on another local port read it, and nobody else", async () => {
    const { app } = setup(fakeJev({}).askJev);
    const allowed = async (origin: string) =>
      (await app.request("/dashboard/events", { headers: { origin } })).headers.get("access-control-allow-origin");
    expect(await allowed("http://localhost:8790")).toBe("http://localhost:8790");
    expect(await allowed("http://127.0.0.1:8789")).toBe("http://127.0.0.1:8789");
    expect(await allowed("https://evil.example")).toBeNull();
    expect(await allowed("http://localhost.evil.example")).toBeNull();
  });
});

describe("createEventLog", () => {
  const entry = (n: number) => ({ event: "route", path: "/v1/responses", tools: n, mode: "passthrough", reason: "no_tools" });

  it("keeps the newest events up to its capacity, numbering every one", () => {
    const log = createEventLog({ capacity: 3 });
    for (let n = 1; n <= 5; n++) log.record(entry(n));
    expect(log.since(0).map((event) => [event.seq, event.tools])).toEqual([[3, 3], [4, 4], [5, 5]]);
    expect(log.last).toBe(5);
  });

  it("replays a launcher log so history survives a restart, skipping what isn't a route event", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jev-events-")), "codex.log");
    writeFileSync(
      file,
      [
        "jev-gateway listening on http://localhost:8790 → https://llm.test/v1 (jev: jev-latest)",
        JSON.stringify({ time: "2026-01-01T10:00:00.000Z", ...entry(4), model: "gpt-test", status: 200 }),
        '{"time":"2026-01-01T10:00:01.000Z","event":"route","mo',
        JSON.stringify({ time: "2026-01-01T10:00:02.000Z", event: "route", path: "/v1/responses", tools: 2, mode: "direct", tool: "set_lights", args: { room: "kitchen" }, confidence: 0.9 }),
      ].join("\n") + "\n",
    );
    const log = createEventLog({ historyFile: file });
    expect(log.since(0)).toEqual([
      { seq: 1, time: "2026-01-01T10:00:00.000Z", path: "/v1/responses", model: "gpt-test", tools: 4, mode: "passthrough", reason: "no_tools", status: 200 },
      { seq: 2, time: "2026-01-01T10:00:02.000Z", path: "/v1/responses", tools: 2, mode: "direct", tool: "set_lights", confidence: 0.9 },
    ]);
    expect(createEventLog({ historyFile: join(tmpdir(), "jev-events-missing.log") }).since(0)).toEqual([]);
  });
});

describe("GET /dashboard", () => {
  it("serves a self-contained page", async () => {
    const { app } = setup(fakeJev({}).askJev);
    const res = await app.request("/dashboard");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("/dashboard/events");
    // Nothing to fetch but our own JSON: no CDN, no external stylesheet or script.
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i);
  });

  it("sits behind ROUTER_API_KEY, which a browser may present as ?key=", async () => {
    const config = testConfig({ routerApiKey: "gateway-key", upstreamApiKey: "sk-upstream" });
    const { app } = setup(fakeJev({}).askJev, config);
    for (const path of ["/dashboard", "/dashboard/events"]) {
      expect((await app.request(path)).status).toBe(401);
      expect((await app.request(`${path}?key=wrong`)).status).toBe(401);
      expect((await app.request(`${path}?key=gateway-key`)).status).toBe(200);
      expect((await app.request(path, { headers: { authorization: "Bearer gateway-key" } })).status).toBe(200);
    }
    // The query form is for the dashboard alone.
    expect((await app.request("/v1/models?key=gateway-key")).status).toBe(401);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exaAdapter } from "../src/adapters/exa.js";
import { createApp } from "../src/app.js";
import { argKey } from "../src/questions.js";
import { frame, peel } from "../src/proto/connect.js";
import { concat, field, readFields, text, utf8 } from "../src/proto/wire.js";
import { fakeJev, testConfig } from "./helpers.js";

const PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const userMsg = (body: string) => field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 1n), utf8(3, body)));
const toolDef = (name: string, schema = "{}") => field(10, 2, concat(utf8(1, name), utf8(2, `does ${name}`), utf8(3, schema)));
const exaRequest = (...parts: Uint8Array[]) => frame(concat(...parts));

/** An upstream stand-in that keeps the raw body bytes, unlike fakeUpstream's JSON.parse. */
const rawUpstream = (replyBody: Uint8Array<ArrayBuffer>) => {
  const calls: { url: string; body: Uint8Array | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body instanceof Uint8Array ? init.body : undefined });
    return new Response(replyBody, { status: 200, headers: { "content-type": "application/connect+proto" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const reply = concat(frame(utf8(9, "done")), frame(new TextEncoder().encode("{}"), 0x2));
const app = (askJev: ReturnType<typeof fakeJev>["askJev"], fetchImpl: typeof fetch) =>
  createApp({ config: testConfig({ upstreamBaseUrl: "https://server.codeium.com" }), askJev, fetch: fetchImpl });

const post = (target: ReturnType<typeof app>, path: string, body: Uint8Array<ArrayBuffer>) =>
  target.request(path, { method: "POST", headers: { "content-type": "application/connect+proto" }, body });

describe("the exa route", () => {
  it("passes requests without tools straight through, flagged as no_tools", async () => {
    const upstream = rawUpstream(reply);
    const body = exaRequest(userMsg("hi"));
    const res = await post(app(fakeJev({}).askJev, upstream.fetchImpl), PATH, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_tools");
    expect(upstream.calls[0]?.url).toBe(`https://server.codeium.com${PATH}`);
    expect(upstream.calls[0]?.body).toEqual(body);
  });

  it("rewrites the hinted request and sends it upstream re-framed", async () => {
    const jev = fakeJev({ needs_tool: { noul: 0.9 }, tool: { choice: "exec", confidence: 0.9 } });
    const upstream = rawUpstream(reply);
    const res = await post(
      app(jev.askJev, upstream.fetchImpl),
      PATH,
      exaRequest(userMsg("run echo hi"), toolDef("exec", '{"type":"object","properties":{"command":{"type":"string"}}}')),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(res.headers.get("x-jev-gateway-tool")).toBe("exec");
    const sent = upstream.calls[0]!.body!;
    const messages = readFields(peel(sent)[0]!.payload).filter((f) => f.field === 3);
    expect(messages).toHaveLength(2);
    expect(text(readFields(messages[1]!.bytes!).find((f) => f.field === 3))).toContain('"exec"');
  });

  it("answers a fully resolved call itself, as a Connect stream", async () => {
    const schema = '{"type":"object","properties":{"on":{"type":"boolean"}},"required":["on"]}';
    const jev = fakeJev({
      needs_tool: { noul: 0.9 },
      tool: { choice: "set_lights", confidence: 0.95 },
      [argKey(0, "on")]: { noul: 0.9 },
    });
    const upstream = rawUpstream(reply);
    const res = await post(app(jev.askJev, upstream.fetchImpl), PATH, exaRequest(userMsg("lights on"), toolDef("set_lights", schema)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/connect+proto");
    const frames = peel(new Uint8Array(await res.arrayBuffer()));
    expect(frames.at(-1)).toEqual({ flags: 2, payload: new TextEncoder().encode("{}") });
    expect(upstream.calls).toHaveLength(0);
  });

  it("dumps a structural summary, never the decoded session token", async () => {
    const dumps: Record<string, unknown>[] = [];
    const upstream = rawUpstream(reply);
    const target = createApp({
      config: testConfig({ upstreamBaseUrl: "https://server.codeium.com" }),
      askJev: fakeJev({}).askJev,
      fetch: upstream.fetchImpl,
      dump: (_kind, data) => dumps.push(data),
    });
    // Field 1 is client metadata; field 1.3 is the devin-session-token JWT.
    const meta = field(1, 2, concat(utf8(1, "devin-cli"), utf8(3, "devin-session-token$SECRETJWT")));
    await post(target, PATH, exaRequest(meta, userMsg("hi")));
    const dumped = JSON.stringify(dumps[0]?.body);
    // The token travels as raw bytes; a byte map on disk is still the token.
    expect(dumped).not.toContain("SECRETJWT");
    expect(dumped).not.toContain('"bytes"');
    expect(dumped).not.toContain('"raw"');
    expect(dumped).toContain('"fields"');
  });

  it("labels a body it cannot read because of content-encoding", async () => {
    const upstream = rawUpstream(reply);
    const res = await app(fakeJev({}).askJev, upstream.fetchImpl).request(PATH, {
      method: "POST",
      headers: { "content-type": "application/connect+proto", "content-encoding": "gzip" },
      body: exaRequest(userMsg("hi")),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("unsupported_encoding");
  });

  it("fails open to passthrough when re-encoding the rewritten request throws", async () => {
    const jev = fakeJev({ needs_tool: { noul: 0.9 }, tool: { choice: "exec", confidence: 0.9 } });
    const upstream = rawUpstream(reply);
    const encode = exaAdapter.encode!.bind(exaAdapter);
    exaAdapter.encode = () => {
      throw new Error("encode exploded");
    };
    try {
      const body = exaRequest(userMsg("run echo hi"), toolDef("exec", '{"type":"object","properties":{"command":{"type":"string"}}}'));
      const res = await post(app(jev.askJev, upstream.fetchImpl), PATH, body);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
      expect(res.headers.get("x-jev-gateway-reason")).toContain("router_error: encode exploded");
      expect(upstream.calls[0]?.body).toEqual(body);
    } finally {
      exaAdapter.encode = encode;
    }
  });
});

describe("the catch-all forward", () => {
  it("proxies other exa endpoints untouched, and nothing else", async () => {
    const upstream = rawUpstream(Uint8Array.of(9, 9, 9));
    const target = app(fakeJev({}).askJev, upstream.fetchImpl);
    const seat = await target.request("/exa.seat_management_pb.SeatManagementService/GetUserStatus", {
      method: "POST",
      headers: { "content-type": "application/connect+proto" },
      body: frame(Uint8Array.of(1)),
    });
    expect(seat.status).toBe(200);
    expect(upstream.calls[0]?.url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    const misc = await target.request("/favicon.ico");
    expect(misc.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
  });

  it("never forwards dashboard misses — and their ?key= — upstream", async () => {
    const upstream = rawUpstream(reply);
    const target = createApp({
      config: testConfig({ upstreamBaseUrl: "https://server.codeium.com", routerApiKey: "router-secret" }),
      askJev: fakeJev({}).askJev,
      fetch: upstream.fetchImpl,
    });
    const res = await target.request("/dashboard/nope?key=router-secret");
    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
    // The real dashboard still answers when the key is right.
    expect((await target.request("/dashboard/events?key=router-secret")).status).toBe(200);
    expect(upstream.calls).toHaveLength(0);
  });

  it("still answers /health locally", async () => {
    const upstream = rawUpstream(reply);
    const res = await app(fakeJev({}).askJev, upstream.fetchImpl).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
    expect(upstream.calls).toHaveLength(0);
  });
});

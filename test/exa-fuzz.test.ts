import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exaAdapter } from "../src/adapters/exa.js";
import { createApp } from "../src/app.js";
import { frame, peel } from "../src/proto/connect.js";
import { concat, encodeVarint, field, utf8 } from "../src/proto/wire.js";
import { fakeJev, testConfig } from "./helpers.js";

/** Deterministic PRNG so a failure reproduces from the seed. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(20260924);
const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;

const userMsg = (body: string) => field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 1n), utf8(3, body)));
const toolDef = (name: string, schema = "{}") => field(10, 2, concat(utf8(1, name), utf8(2, `does ${name}`), utf8(3, schema)));

/** A field with a fixed-width wire type, which `field()` does not build. */
const fixed = (no: number, wire: 1 | 5, bytes: number) => {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = Math.floor(rng() * 256);
  return concat(encodeVarint(BigInt(no * 8 + wire)), data);
};

const randomRequest = (): Uint8Array => {
  const parts: Uint8Array[] = [];
  const n = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) {
    parts.push(
      pick([
        () => userMsg(`msg ${Math.floor(rng() * 1e6)}`),
        () => toolDef(`tool_${Math.floor(rng() * 100)}`, `{"type":"object","properties":{"x":{"type":"string"}}}`),
        () => field(1, 2, utf8(1, "meta")),
        () => field(Math.floor(rng() * 40) + 11, 0, BigInt(Math.floor(rng() * 1e9))),
        () => {
          const wire = pick([1, 5] as const);
          return fixed(Math.floor(rng() * 40) + 12, wire, wire === 1 ? 8 : 4);
        },
      ])(),
    );
  }
  return frame(concat(...parts));
};

describe("exa wire stability", () => {
  it("re-encodes any well-formed request byte-for-byte", () => {
    for (let i = 0; i < 300; i++) {
      const original = randomRequest();
      const req = exaAdapter.parse!(original);
      expect(req, `parse failed on case ${i}`).toBeDefined();
      expect(exaAdapter.encode!(req!)).toEqual(original);
    }
  });

  it("never throws on mutated or truncated bodies", () => {
    const base = frame(concat(userMsg("run echo hi"), toolDef("exec", '{"type":"object"}')));
    for (let i = 0; i < 500; i++) {
      const mutated = new Uint8Array(base);
      const mutations = Math.floor(rng() * 4);
      for (let m = 0; m < mutations; m++) mutated[Math.floor(rng() * mutated.length)] = Math.floor(rng() * 256);
      const body = rng() < 0.4 ? mutated.subarray(0, Math.floor(rng() * mutated.length)) : mutated;

      const req = exaAdapter.parse!(body); // undefined → passthrough, the client's problem
      if (!req) continue;
      const input = exaAdapter.toInput(req);
      expect(input === null || typeof input === "object").toBe(true);
      const hinted = exaAdapter.apply(req, { mode: "hint", tool: "exec", confidence: 0.9 });
      expect(() => peel(exaAdapter.encode!(hinted) as Uint8Array)).not.toThrow();
    }
  });

  it("answers garbage with a passthrough, never an error", async () => {
    const calls: unknown[] = [];
    const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(input);
      return new Response("upstream says hi", { status: 200 });
    }) as typeof fetch;
    const app = createApp({ config: testConfig({ upstreamBaseUrl: "https://server.codeium.com" }), askJev: fakeJev({}).askJev, fetch: upstream });

    const shapes = [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(255, 255, 255, 255, 255, 255),
      frame(Uint8Array.of(0x0b)), // wire type 3: illegal
      new TextEncoder().encode('{"not":"connect"}'),
    ];
    for (let i = 0; i < 200; i++) {
      const garbage = new Uint8Array(Math.floor(rng() * 64));
      for (let b = 0; b < garbage.length; b++) garbage[b] = Math.floor(rng() * 256);
      shapes.push(garbage);
    }
    for (const body of shapes) {
      const res = await app.request("/exa.api_server_pb.ApiServerService/GetChatMessage", {
        method: "POST",
        headers: { "content-type": "application/connect+proto" },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    }
    expect(calls.length).toBe(shapes.length);
  });

  it("keeps decisions independent under concurrent load", async () => {
    const calls: unknown[] = [];
    const upstream = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push(1);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const jev = fakeJev({ needs_tool: { noul: 0.9 }, tool: { choice: "exec", confidence: 0.9 } });
    const app = createApp({ config: testConfig({ upstreamBaseUrl: "https://server.codeium.com" }), askJev: jev.askJev, fetch: upstream });
    const body = frame(concat(userMsg("run echo hi"), toolDef("exec", '{"type":"object","properties":{"command":{"type":"string"}}}')));

    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.request("/exa.api_server_pb.ApiServerService/GetChatMessage", {
          method: "POST",
          headers: { "content-type": "application/connect+proto" },
          body,
        }),
      ),
    );
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    }
    expect(calls.length).toBe(40);
    expect(jev.requests.length).toBe(40);
  });
});

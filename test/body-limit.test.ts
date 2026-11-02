import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

/** A JSON body that is small on the wire and large once inflated. */
function compressedBody(decompressedBytes: number) {
  return gzipSync(Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(decompressedBytes) }] })));
}

function appWithCounter() {
  const seen: { upstreamCalls: number } = { upstreamCalls: 0 };
  const app = createApp({
    config: testConfig(),
    askJev: (async () => {
      throw new Error("not reached");
    }) as never,
    fetch: (async () => {
      seen.upstreamCalls += 1;
      return Response.json({});
    }) as typeof fetch,
  });
  return { app, seen };
}

describe("compressed request bodies", () => {
  it("answers 413 instead of buffering an unbounded decompression", async () => {
    const { app, seen } = appWithCounter();
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-encoding": "gzip" },
      body: compressedBody(64 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
    // The bomb is refused here, never forwarded upstream.
    expect(seen.upstreamCalls).toBe(0);
  });

  it("still reads a compressed body under the cap", async () => {
    const { app, seen } = appWithCounter();
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-encoding": "gzip" },
      body: compressedBody(64 * 1024),
    });
    expect(res.status).not.toBe(413);
    expect(seen.upstreamCalls).toBe(1);
  });
});

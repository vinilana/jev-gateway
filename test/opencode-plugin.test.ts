import { expect, it } from "vitest";
import plugin from "../src/opencode-plugin.js";

async function setup(options: Record<string, unknown> = {}) {
  let hook!: (event: { request: Request }) => void;
  let disposed = 0;
  const cleanup = await plugin.setup({
    options,
    session: {
      hook: async (_name: string, handler: typeof hook) => {
        hook = handler;
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
  });
  return { hook, cleanup, disposed: () => disposed };
}

it("redirects final post-auth requests without consuming streams or changing model/auth/query/abort", async () => {
  const instance = await setup({
    routes: { "https://provider.test/v1/messages": "http://127.0.0.1:8792/v1/messages" },
  });
  const controller = new AbortController();
  const body = JSON.stringify({ model: "user-selected", messages: [{ role: "user", content: "hello" }] });
  const event = {
    request: new Request("https://provider.test/v1/messages?beta=true&beta=second", {
      method: "POST",
      headers: { authorization: "Bearer post-auth", "x-opencode-session": "session-a" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit),
  };
  instance.hook(event);
  expect(event.request.url).toBe("http://127.0.0.1:8792/v1/messages?beta=true&beta=second");
  expect(event.request.headers.get("authorization")).toBe("Bearer post-auth");
  expect(event.request.headers.get("x-opencode-session")).toBe("session-a");
  expect(await event.request.text()).toBe(body);
  controller.abort();
  expect(event.request.signal.aborted).toBe(true);
  await instance.cleanup();
  await instance.cleanup();
  expect(instance.disposed()).toBe(1);
});

it("passes through unmatched inference, discovery and auth requests by default", async () => {
  const instance = await setup();
  for (const [method, path] of [
    ["POST", "/v1/messages"],
    ["POST", "/oauth/token"],
    ["GET", "/v1/models"],
  ]) {
    const request = new Request(`https://provider.test${path}`, { method });
    const event = { request };
    instance.hook(event);
    expect(event.request).toBe(request);
  }
  await instance.cleanup();
});

it("strict mode rejects unmatched inference but leaves auth and discovery alone", async () => {
  const instance = await setup({ unmatched: "reject" });
  for (const path of [
    "/v1/messages",
    "/v1/responses",
    "/v1/chat/completions",
    "/v1beta/models/test:streamGenerateContent",
  ]) {
    expect(() => instance.hook({ request: new Request(`https://provider.test${path}`, { method: "POST" }) })).toThrow(
      /Jev route missing/,
    );
  }
  instance.hook({ request: new Request("https://provider.test/oauth/token", { method: "POST" }) });
  await instance.cleanup();
});

it("validates options and restricts credential-carrying destinations to loopback HTTP", async () => {
  for (const options of [
    { unmatched: "invalid" },
    { routes: null },
    { routes: [] },
    ...[
      "http://remote.test:8792/v1/messages",
      "http://user:password@127.0.0.1:8792/v1/messages",
      "https://127.0.0.1:8792/v1/messages",
      "http://127.0.0.1:8792/v1/messages?override=true",
    ].map((destination) => ({ routes: { "https://provider.test/v1/messages": destination } })),
    { routes: { "https://provider.test/v1/messages?ignored=true": "http://127.0.0.1:8792/v1/messages" } },
  ])
    await expect(setup(options)).rejects.toThrow();
});

it("accepts an explicit default HTTP port and IPv6 loopback", async () => {
  for (const destination of ["http://127.0.0.1:80/v1/messages", "http://[::1]:8792/v1/messages"]) {
    const instance = await setup({ routes: { "https://provider.test/v1/messages": destination } });
    const event = { request: new Request("https://provider.test/v1/messages", { method: "POST" }) };
    instance.hook(event);
    expect(event.request.url).toBe(new URL(destination).href);
    await instance.cleanup();
  }
});

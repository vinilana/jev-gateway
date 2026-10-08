import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ensureMitmCerts, setupMitm } from "../src/mitm.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

const antigravityLauncherBin = fileURLToPath(new URL("../bin/jev-antigravity.mjs", import.meta.url));

const cloudcodeRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gemini-2.5-pro",
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

function setup(canned: Parameters<typeof fakeJev>[0], configExtra = {}) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({
    config: testConfig({ upstreamBaseUrl: "https://daily-cloudcode-pa.googleapis.com", ...configExtra }),
    askJev: jev.askJev,
    fetch: upstream.fetchImpl,
  });
  const post = (body: unknown, path = "/v1internal:streamGenerateContent", headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream, app };
}

const shellDecision = { tool: { choice: "shell" }, needs_tool: { noul: 0.95 } };

describe("POST /v1internal:streamGenerateContent and /v1internal:generateContent", () => {
  it("translates Cloud Code contents and systemInstruction into Jev turns and tool declarations", async () => {
    const { post, jev } = setup(shellDecision);
    await post(cloudcodeRequest());

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

  it("translates messages array format into Jev turns", async () => {
    const { post, jev } = setup(shellDecision);
    await post({
      messages: [
        { role: "user", content: "hello world" },
        { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "pwd" } } }] },
      ],
      tools: [
        {
          functionDeclarations: [{ name: "shell", description: "Runs shell." }],
        },
      ],
    });

    const { state } = jev.requests[0]!;
    expect((state as { conversation?: unknown } | undefined)?.conversation).toEqual([
      { role: "user", text: "hello world" },
      { role: "assistant", tool_calls: [{ tool: "shell", arguments: '{"command":"pwd"}' }] },
    ]);
  });

  it("forces tool selection by updating toolConfig.functionCallingConfig", async () => {
    const { post, upstream } = setup(shellDecision);
    await post(cloudcodeRequest());

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
      cloudcodeRequest({
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

  it("synthesizes SSE stream for direct answer on :streamGenerateContent", async () => {
    const noArgs = {
      functionDeclarations: [
        { name: "list_plans", description: "List saved plans.", parameters: { type: "object", properties: {} } },
      ],
    };
    const canned = { tool: { choice: "list_plans" }, needs_tool: { noul: 0.9 } };
    const { post, upstream } = setup(canned);
    const res = await post(cloudcodeRequest({ tools: [noArgs] }), "/v1internal:streamGenerateContent");

    expect(upstream.calls).toHaveLength(0);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    const parsed = JSON.parse(text.replace(/^data:\s*/, "").trim());
    expect(parsed.candidates[0].content.parts[0].functionCall.name).toBe("list_plans");
  });

  it("disables tools when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({
      tool: { choice: NO_TOOL },
      needs_tool: { noul: 0.05 },
    });
    await post(cloudcodeRequest());

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as {
      toolConfig?: { functionCallingConfig?: { mode: string } };
    };
    expect(sent.toolConfig?.functionCallingConfig).toEqual({
      mode: "NONE",
    });
  });

  it("falls back to passthrough if request has no tools", async () => {
    const { post, upstream } = setup(shellDecision);
    const res = await post({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(upstream.calls).toHaveLength(1);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_tools");
  });

  it("falls back to passthrough if request has no messages or contents", async () => {
    const { post, upstream } = setup(shellDecision);
    const res = await post({ tools: cloudcodeRequest().tools });
    expect(upstream.calls).toHaveLength(1);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_messages");
  });

  it("replays original request when upstream rejects rewritten tool choice", async () => {
    const jev = fakeJev(shellDecision);
    const upstream = fakeUpstream();
    // Simulate upstream rejecting forced mode with 400
    let attempt = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: "mode ANY not allowed" }), { status: 400 });
      }
      return upstream.fetchImpl(url, init);
    };

    const app = createApp({
      config: testConfig({ upstreamBaseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
      askJev: jev.askJev,
      fetch: fetchImpl,
    });

    const res = await app.request("/v1internal:streamGenerateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cloudcodeRequest()),
    });

    expect(attempt).toBe(2);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("upstream_rejected_forced");
  });

  it("forwards /v1internal:loadCodeAssist and other endpoints untouched while preserving Authorization header", async () => {
    const { app, upstream } = setup(shellDecision);
    const res = await app.request("/v1internal:loadCodeAssist", {
      method: "POST",
      headers: {
        authorization: "Bearer ya29.test-oauth-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ metadata: { ide: "antigravity" } }),
    });

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer ya29.test-oauth-token");
  });

  it("forwards /v1internal/* subpaths untouched", async () => {
    const { app, upstream } = setup(shellDecision);
    const res = await app.request("/v1internal/customSubpath?foo=bar", {
      method: "GET",
      headers: { authorization: "Bearer ya29.custom" },
    });

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal/customSubpath?foo=bar");
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer ya29.custom");
  });

  it("supports cloudcode format in /router/decide", async () => {
    const { app } = setup(shellDecision);
    const res = await app.request("/router/decide?format=cloudcode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cloudcodeRequest()),
    });

    expect(res.status).toBe(200);
    const decision = (await res.json()) as { mode: string; tool?: string };
    expect(decision.mode).toBe("forced");
    expect(decision.tool).toBe("shell");
  });

  it("handles snake_case function_declarations without treating them as hosted tools", async () => {
    const { post, jev } = setup(shellDecision);
    await post({
      contents: [{ role: "user", parts: [{ text: "run it" }] }],
      tools: [
        {
          function_declarations: [
            { name: "bash_cmd", description: "Execute bash" },
          ],
        },
      ],
    });

    expect(Object.keys(jev.requests[0]!.questions.tool!.criteria ?? {})).toContain("bash_cmd");
    expect(Object.keys(jev.requests[0]!.questions.tool!.criteria ?? {})).not.toContain("function_declarations");
  });

  it("handles snake_case tool_config and function_calling_config in apply", async () => {
    const { post, upstream } = setup(shellDecision);
    await post({
      contents: [{ role: "user", parts: [{ text: "execute" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "shell",
              description: "Shell",
              parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
            },
          ],
        },
      ],
      tool_config: {
        function_calling_config: {
          mode: "AUTO",
        },
      },
    });

    expect(upstream.calls).toHaveLength(1);
    const sent = upstream.calls[0]!.body as Record<string, unknown>;
    expect(sent.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["shell"],
      },
    });
    expect(sent.tool_config).toBeUndefined();
  });

  it("extracts model and stream from URL in fromUrl", async () => {
    const { cloudcodeAdapter } = await import("../src/adapters/cloudcode.js");
    const parsed = cloudcodeAdapter.fromUrl!(new URL("https://daily-cloudcode-pa.googleapis.com/v1internal/models/gemini-2.5-pro:streamGenerateContent"));
    expect(parsed.model).toBe("gemini-2.5-pro");
    expect(parsed.stream).toBe(true);
  });
});

describe("HTTPS MITM proxy and CONNECT tunneling", () => {
  it("generates CA, host certificates, and bundle with ensureMitmCerts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jev-test-mitm-"));
    try {
      const certs = ensureMitmCerts(tempDir);
      expect(existsSync(certs.caCertPath)).toBe(true);
      expect(existsSync(certs.caKeyPath)).toBe(true);
      expect(existsSync(certs.hostCertPath)).toBe(true);
      expect(existsSync(certs.hostKeyPath)).toBe(true);
      expect(existsSync(certs.bundlePath)).toBe(true);

      const caCert = new X509Certificate(certs.caCert);
      const hostCert = new X509Certificate(certs.hostCert);

      expect(caCert.subject).toContain("Jev Gateway CA");
      expect(hostCert.subject).toContain("daily-cloudcode-pa.googleapis.com");
      expect(hostCert.subjectAltName).toContain("DNS:daily-cloudcode-pa.googleapis.com");
      expect(hostCert.verify(caCert.publicKey)).toBe(true);

      const bundle = readFileSync(certs.bundlePath, "utf8");
      expect(bundle).toContain(readFileSync(certs.caCertPath, "utf8").trim());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("intercepts CONNECT daily-cloudcode-pa.googleapis.com:443 and terminates TLS to Hono app", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jev-test-mitm-"));
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ upstreamBaseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
      askJev: fakeJev(shellDecision).askJev,
      fetch: upstream.fetchImpl,
    });

    const server = http.createServer();
    const { certs, close } = setupMitm(server, app.fetch, { certDir: tempDir });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // Connect to proxy using HTTP CONNECT
      const result = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          method: "CONNECT",
          path: "daily-cloudcode-pa.googleapis.com:443",
        });

        req.on("connect", (_res, socket) => {
          const tlsClient = tls.connect(
            {
              socket,
              servername: "daily-cloudcode-pa.googleapis.com",
              ca: [certs!.caCert],
            },
            () => {
              const body = JSON.stringify({ metadata: { test: true } });
              tlsClient.write(
                `POST /v1internal:loadCodeAssist HTTP/1.1\r\n` +
                  `Host: daily-cloudcode-pa.googleapis.com\r\n` +
                  `Authorization: Bearer ya29.mitm-token\r\n` +
                  `Content-Type: application/json\r\n` +
                  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                  `Connection: close\r\n\r\n` +
                  body,
              );
            },
          );

          let data = "";
          tlsClient.on("data", (d) => {
            data += d.toString();
          });
          tlsClient.on("end", () => resolve(data));
          tlsClient.on("error", reject);
        });

        req.on("error", reject);
        req.end();
      });

      expect(result).toContain("HTTP/1.1 200");
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
      expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer ya29.mitm-token");
    } finally {
      close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("formats fallback tls.rootCertificates without duplicate BEGIN/END markers", () => {
    const sample = tls.rootCertificates.slice(0, 10);
    for (const c of sample) {
      expect(() => new X509Certificate(c)).not.toThrow();
      expect(c.split("-----BEGIN CERTIFICATE-----").length - 1).toBe(1);
    }
  });

  it("terminates TLS cleanly when CONNECT request pipelines early data in head", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jev-test-mitm-head-"));
    const upstream = fakeUpstream();
    const app = createApp({
      config: testConfig({ upstreamBaseUrl: "https://daily-cloudcode-pa.googleapis.com" }),
      askJev: fakeJev(shellDecision).askJev,
      fetch: upstream.fetchImpl,
    });

    const server = http.createServer();
    const { certs, close } = setupMitm(server, app.fetch, { certDir: tempDir });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const rawSocket = net.connect(port, "127.0.0.1");
      await new Promise<void>((res) => rawSocket.on("connect", res));

      const tlsPromise = new Promise<string>((resolve, reject) => {
        let headersDone = false;
        let buffer = Buffer.alloc(0);

        rawSocket.on("data", (data) => {
          if (!headersDone) {
            buffer = Buffer.concat([buffer, data]);
            const idx = buffer.indexOf("\r\n\r\n");
            if (idx !== -1) {
              headersDone = true;
              const leftover = buffer.subarray(idx + 4);
              rawSocket.removeAllListeners("data");
              if (leftover.length > 0) rawSocket.unshift(leftover);

              const tlsClient = tls.connect(
                {
                  socket: rawSocket,
                  servername: "daily-cloudcode-pa.googleapis.com",
                  ca: [certs!.caCert],
                },
                () => {
                  const body = JSON.stringify({ metadata: { test: true } });
                  tlsClient.write(
                    `POST /v1internal:loadCodeAssist HTTP/1.1\r\n` +
                      `Host: daily-cloudcode-pa.googleapis.com\r\n` +
                      `Authorization: Bearer ya29.mitm-token\r\n` +
                      `Content-Type: application/json\r\n` +
                      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                      `Connection: close\r\n\r\n` +
                      body,
                  );
                },
              );

              let reply = "";
              tlsClient.on("data", (d) => {
                reply += d.toString();
              });
              tlsClient.on("end", () => resolve(reply));
              tlsClient.on("error", reject);
            }
          }
        });
        rawSocket.on("error", reject);
      });

      rawSocket.write("CONNECT daily-cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: daily-cloudcode-pa.googleapis.com:443\r\n\r\n");
      const result = await tlsPromise;
      expect(result).toContain("HTTP/1.1 200");
    } finally {
      close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tunnels non-intercepted hostnames via plain TCP", async () => {
    // Create a plain echo TCP server to act as external destination
    const echoServer = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(`ECHO:${data.toString()}`));
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", () => resolve()));
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    const proxyServer = http.createServer();
    const app = createApp({ config: testConfig(), askJev: fakeJev({}).askJev });
    const { close } = setupMitm(proxyServer, app.fetch);
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          method: "CONNECT",
          path: `127.0.0.1:${echoPort}`,
        });

        req.on("connect", (_res, socket) => {
          socket.write("HELLO_TCP");
          socket.on("data", (d) => {
            socket.destroy();
            resolve(d.toString());
          });
          socket.on("error", reject);
        });

        req.on("error", reject);
        req.end();
      });

      expect(response).toBe("ECHO:HELLO_TCP");
    } finally {
      close();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it("handles IPv6 host targets in CONNECT tunneling without crashing", async () => {
    const echoServer = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(`IPV6_ECHO:${data.toString()}`));
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "::1", () => resolve()));
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    const proxyServer = http.createServer();
    const app = createApp({ config: testConfig(), askJev: fakeJev({}).askJev });
    const { close } = setupMitm(proxyServer, app.fetch);
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxyServer.address() as net.AddressInfo).port;

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          method: "CONNECT",
          path: `[::1]:${echoPort}`,
        });

        req.on("connect", (_res, socket) => {
          socket.write("PING_IPV6");
          socket.on("data", (d) => {
            socket.destroy();
            resolve(d.toString());
          });
          socket.on("error", reject);
        });

        req.on("error", reject);
        req.end();
      });

      expect(response).toBe("IPV6_ECHO:PING_IPV6");
    } finally {
      close();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it("regenerates host cert when CA cert is regenerated", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jev-test-mitm-cascade-"));
    try {
      const certs1 = ensureMitmCerts(tempDir);
      const caCert1 = new X509Certificate(certs1.caCert);
      const hostCert1 = new X509Certificate(certs1.hostCert);
      expect(hostCert1.verify(caCert1.publicKey)).toBe(true);

      // Force CA to be invalid/re-created by truncating ca.pem
      writeFileSync(certs1.caCertPath, "INVALID_CA", "utf8");

      const certs2 = ensureMitmCerts(tempDir);
      const caCert2 = new X509Certificate(certs2.caCert);
      const hostCert2 = new X509Certificate(certs2.hostCert);
      // New host cert must be verified by the new CA cert, not left with the old one
      expect(hostCert2.verify(caCert2.publicKey)).toBe(true);
      expect(certs2.caCert.toString()).not.toBe(certs1.caCert.toString());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("jev-antigravity launcher spec", () => {
  const agy = clients.antigravity;

  it("identifies itself as jev-antigravity for agy client on port 8794", () => {
    expect(agy.name).toBe("jev-antigravity");
    expect(agy.client).toBe("agy");
    expect(agy.portEnv).toBe("JEV_ANTIGRAVITY_PORT");
    expect(agy.defaultPort).toBe(8794);
  });

  it("defaults upstream to daily-cloudcode-pa with JEV_ANTIGRAVITY_UPSTREAM_BASE_URL override", () => {
    const prev = process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL;
    try {
      delete process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL;
      expect(agy.upstream()).toBe("https://daily-cloudcode-pa.googleapis.com");
      process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL = "https://custom-cloudcode.google.com";
      expect(agy.upstream()).toBe("https://custom-cloudcode.google.com");
    } finally {
      if (prev !== undefined) process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL = prev;
      else delete process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL;
    }
  });

  it("injects uppercase and lowercase proxy env vars and SSL_CERT_FILE pointing to bundle.pem", () => {
    const env = agy.env("http://127.0.0.1:8794");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8794");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8794");
    expect(env.https_proxy).toBe("http://127.0.0.1:8794");
    expect(env.http_proxy).toBe("http://127.0.0.1:8794");
    expect(env.SSL_CERT_FILE).toContain(".jev-gateway/certs/bundle.pem");
  });

  it("includes port 8794 in dashboard peer ports list", () => {
    const dashboardHtml = readFileSync(fileURLToPath(new URL("../src/dashboard.html", import.meta.url)), "utf8");
    expect(dashboardHtml).toContain('"8794"');
  });

  it("--gateway-help prints launcher help without starting anything", () => {
    const out = execFileSync(process.execPath, [antigravityLauncherBin, "--gateway-help"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("jev-antigravity: agy with tool selection routed through Jev");
    expect(out).toContain("JEV_ANTIGRAVITY_PORT");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
// @ts-expect-error plain ESM module without types
import type { configureCodexDesktopApp as ConfigureCodexDesktopApp } from "../bin/codex-app.mjs";

type Configure = typeof ConfigureCodexDesktopApp;

async function withTemporaryCodexHome(run: (home: string, configure: Configure) => void) {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-app-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  try {
    // @ts-expect-error plain ESM module without types
    const { configureCodexDesktopApp } = await import("../bin/codex-app.mjs");
    run(home, configureCodexDesktopApp);
  } finally {
    vi.resetModules();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: { close(callback: (error?: Error) => void): unknown }) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("Codex desktop configuration", () => {
  it("updates only the gateway provider, keeps unrelated settings, backs up the original, and is idempotent", async () => {
    await withTemporaryCodexHome((home, configure) => {
      const configHome = join(home, ".codex");
      const configPath = join(configHome, "config.toml");
      mkdirSync(configHome, { recursive: true });
      const original = [
        'model_provider = "openai" # keep this comment',
        "",
        "[model_providers.openai]",
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        "",
        "[model_providers.jev-gateway]",
        'name = "old-name"',
        'base_url = "http://old-gateway/v1" # update the URL, keep this comment',
        'wire_api = "chat"',
        "requires_openai_auth = false",
        'custom_setting = "keep me"',
        "",
      ].join("\r\n");
      writeFileSync(configPath, original, "utf8");

      const first = configure("http://127.0.0.1:8790");
      const updated = readFileSync(configPath, "utf8");
      expect(first).toMatchObject({ changed: true, configPath, backupPath: join(home, ".jev-gateway", "codex-config.before-app-setup.toml") });
      expect(readFileSync(first.backupPath!, "utf8")).toBe(original);
      expect(updated).toContain('model_provider = "jev-gateway" # keep this comment');
      expect(updated).toContain("[model_providers.openai]\r\nname = \"OpenAI\"");
      expect(updated).toContain('[model_providers.jev-gateway]\r\nname = "jev-gateway"');
      expect(updated).toContain('base_url = "http://127.0.0.1:8790/v1" # update the URL, keep this comment');
      expect(updated).toContain('wire_api = "responses"');
      expect(updated).toContain("requires_openai_auth = true");
      expect(updated).toContain('custom_setting = "keep me"');

      expect(configure("http://127.0.0.1:8790")).toMatchObject({ changed: false, configPath });
      expect(readFileSync(configPath, "utf8")).toBe(updated);
      expect(existsSync(first.backupPath!)).toBe(true);
    });
  });

  it("creates a default provider config when Codex has no config yet", async () => {
    await withTemporaryCodexHome((home, configure) => {
      const result = configure("http://127.0.0.1:8790");
      const config = readFileSync(result.configPath, "utf8");
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBeUndefined();
      expect(config).toContain('model_provider = "jev-gateway"');
      expect(config).toContain('[model_providers.jev-gateway]');
      expect(config).toContain('base_url = "http://127.0.0.1:8790/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain("requires_openai_auth = true");
    });
  });

  it("refuses ambiguous duplicate provider tables without changing the file", async () => {
    await withTemporaryCodexHome((home, configure) => {
      const configHome = join(home, ".codex");
      const configPath = join(configHome, "config.toml");
      mkdirSync(configHome, { recursive: true });
      const original = '[model_providers.jev-gateway]\nname = "one"\n\n[model_providers.jev-gateway]\nname = "two"\n';
      writeFileSync(configPath, original, "utf8");
      expect(() => configure("http://127.0.0.1:8790")).toThrow("duplicate [model_providers.jev-gateway] tables");
      expect(readFileSync(configPath, "utf8")).toBe(original);
    });
  });

  it("forwards a Codex Responses request through a live local gateway to a local upstream", async () => {
    let received: { path: string; authorization: string | undefined; body: unknown } | undefined;
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "resp-local-smoke", object: "response", status: "completed", output: [] }));
      });
    });
    const upstreamPort = await listen(upstream);
    const config = loadConfig({ UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, JEV_ROUTING: "false" });
    const app = createApp({ config, askJev: async () => { throw new Error("Jev must not be called in baseline mode"); } });
    const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });

    try {
      await new Promise<void>((resolve, reject) => {
        gateway.once("error", reject);
        gateway.once("listening", resolve);
      });
      const gatewayPort = (gateway.address() as AddressInfo).port;
      const codexRequest = { model: "gpt-5-codex", input: "local Codex app smoke test", stream: false };
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer saved-codex-session", "content-type": "application/json" },
        body: JSON.stringify(codexRequest),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
      expect(await response.json()).toMatchObject({ id: "resp-local-smoke", status: "completed" });
      expect(received).toEqual({ path: "/v1/responses", authorization: "Bearer saved-codex-session", body: codexRequest });
    } finally {
      await close(gateway);
      await close(upstream);
    }
  });
});

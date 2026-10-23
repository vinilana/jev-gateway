import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");
const { detectOpencode, opencodeConfigContent } = clients as any;

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  args?: (origin: string) => string[];
  env?: (origin: string) => Record<string, string>;
  configHelp: (origin: string) => string;
  notices?: (origin: string, argv: string[], inherited?: object, context?: unknown) => Promise<string[]>;
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;
const devin = clients.devin as LauncherSpec;

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

const managedEnv = ["OPENCODE_CONFIG_CONTENT", "JEV_OPENCODE_UPSTREAM_BASE_URL", "JEV_OPENCODE_MODEL", "JEV_CODEX_UPSTREAM_BASE_URL", "JEV_CLAUDE_UPSTREAM_BASE_URL", "JEV_DEVIN_UPSTREAM_BASE_URL", "CODEX_HOME", "OPENAI_API_KEY", "OPENCODE_API_KEY", "PATH"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

/** Stub binaries and servers a test started, undone after it. */
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const key of managedEnv) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const inlineConfig = (originOverride = origin) => {
  const env = opencode.env?.(originOverride);
  expect(env).toBeDefined();
  return JSON.parse(env!.OPENCODE_CONFIG_CONTENT as string) as any;
};

describe("jev-opencode spec", () => {
  it("identifies itself as the opencode launcher on its own port", () => {
    expect(opencode.name).toBe("jev-opencode");
    // launcher.mjs spawns the gateway with JEV_CLIENT: spec.client, so this is what reaches it.
    expect(opencode.client).toBe("opencode");
    expect(opencode.portEnv).toBe("JEV_OPENCODE_PORT");
    expect(opencode.defaultPort).toBe(8791);
    expect([codex.defaultPort, claude.defaultPort]).not.toContain(opencode.defaultPort);
  });

  it("defaults upstream to OpenAI with a JEV_OPENCODE_UPSTREAM_BASE_URL override", () => {
    expect(opencode.upstream()).toBe("https://api.openai.com/v1");
    process.env.JEV_OPENCODE_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(opencode.upstream()).toBe("https://llm.test/v1");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_UPSTREAM_BASE_URL");
  });

  it("selects jev-gateway/<model> by default with a JEV_OPENCODE_MODEL override", () => {
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5");
    expect(inlineConfig().small_model).toBe("jev-gateway/gpt-5");
    process.env.JEV_OPENCODE_MODEL = "gpt-5-mini";
    expect(inlineConfig().model).toBe("jev-gateway/gpt-5-mini");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_MODEL");
  });

  it("injects a stable custom-provider config pointing at the gateway, not at TypeSafe", () => {
    const config = inlineConfig();
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    const provider = config.provider["jev-gateway"];
    // Chat Completions path: the gateway already routes POST /v1/chat/completions.
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(`${origin}/v1`);
    // The user's own OpenAI credential flows through untouched; never a hardcoded secret.
    expect(provider.options.apiKey).toBe("{env:OPENAI_API_KEY}");
    expect(Object.keys(provider.models)).toEqual(["gpt-5"]);
    const raw = JSON.stringify(config);
    expect(raw.toLowerCase()).not.toContain("typesafe");
    expect(raw).not.toContain("/.config/");
    expect(raw).not.toContain("~");
  });

  it("keeps the experimental native LLM and code modes disabled for the launched process", () => {
    const env = opencode.env!(origin);
    expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBe("false");
    expect(env.OPENCODE_EXPERIMENTAL_CODE_MODE).toBe("false");
  });

  it("adds no leading client args, so user flags (including -m) forward untouched", () => {
    // launcher.mjs appends the raw argv after spec.args; with no injected --model, the injected
    // config model above stays the default while a user `-m provider/model` keeps top priority.
    expect(opencode.args).toBeUndefined();
    expect(typeof opencode.env).toBe("function");
  });

  it("prints permanent wiring help rooted at the gateway", () => {
    const help = opencode.configHelp(origin);
    expect(help).toContain(`${origin}/v1`);
    expect(help).toContain("jev-gateway/gpt-5");
    expect(help).toContain("opencode.json");
    expect(help).toContain("jev-opencode --start");
    expect(help).toContain("--model jev-gateway/gpt-5");
    // The file workflow below needs no shell quoting; the JSON block must parse as-is.
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonBlock) as any;
    expect(parsed.model).toBe("jev-gateway/gpt-5");
    expect(parsed.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
    // No raw-JSON shell one-liner: single-quoting breaks on apostrophes in custom model IDs.
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    process.env.JEV_OPENCODE_MODEL = "other-model";
    expect(opencode.configHelp(origin)).toContain("jev-gateway/other-model");
  });

  it("stays safe when a custom model ID contains an apostrophe", () => {
    process.env.JEV_OPENCODE_MODEL = "o'brien";
    const config = inlineConfig();
    expect(config.model).toBe("jev-gateway/o'brien");
    expect(Object.keys(config.provider["jev-gateway"].models)).toEqual(["o'brien"]);
    const help = opencode.configHelp(origin);
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    expect(() => JSON.parse(jsonBlock)).not.toThrow();
    expect((JSON.parse(jsonBlock) as any).model).toBe("jev-gateway/o'brien");
  });
});

const custom = (baseURL: string) => ({ model: "proxy/custom", provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL } } } });

describe("following OpenCode's selected provider", () => {
  const model = (id: string) => ({ model: `${id}/kimi-k2.6` });

  it("uses separate Zen and Go upstreams and moves only the selected provider", () => {
    for (const [id, upstream] of [["opencode", "https://opencode.ai/zen/v1"], ["opencode-go", "https://opencode.ai/zen/go/v1"]] as const) {
      const setup = detectOpencode(model(id), {});
      expect(setup).toEqual({ upstream, rebind: id });
      const config = JSON.parse(opencodeConfigContent(origin, undefined, setup));
      expect(config.model).toBeUndefined();
      expect(config.provider).toEqual({ [id]: { options: { baseURL: `${origin}/v1` } } });
    }
  });

  it("follows a custom provider without copying its credential or dropping inherited settings", () => {
    const resolved = { model: "proxy/custom", provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "resolved-secret" } } } };
    const setup = detectOpencode(resolved, { OPENAI_API_KEY: "key" });
    expect(setup).toEqual({ upstream: "http://127.0.0.1:8317/v1", rebind: "proxy" });
    const inherited = JSON.stringify({ model: "proxy/custom", provider: { proxy: { options: { apiKey: "{env:PROXY_KEY}" }, models: { custom: {} } } } });
    const config = JSON.parse(opencodeConfigContent(origin, inherited, setup));
    expect(config.provider.proxy.options).toEqual({ apiKey: "{env:PROXY_KEY}", baseURL: `${origin}/v1` });
    expect(config.provider.proxy.models).toEqual({ custom: {} });
    expect(JSON.stringify(config)).not.toContain("resolved-secret");
  });

  it("follows a selected provider at any API path", () => {
    expect(detectOpencode(custom("https://api.groq.com/openai/v1"), {})).toEqual({ upstream: "https://api.groq.com/openai/v1", rebind: "proxy" });
  });

  it("does not follow an address that holds a secret or another gateway, and says which provider it left", () => {
    const env = { OPENAI_API_KEY: "key", PROXY_TOKEN: "tok-0123456789" };
    const addresses = [
      "https://proxy.example/tok-0123456789/v1", "https://proxy.example/v1?key=secret", "https://user:pass@proxy.example/v1",
      "http://0.0.0.0:8791/v1", "http://[::ffff:127.0.0.1]:8791/v1", "http://127.0.0.1:8790/v1", "http://127.0.0.1:8792/v1", "http://localhost:8793/v1",
    ];
    for (const baseURL of addresses) {
      expect(detectOpencode(custom(baseURL), env)).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5", unfollowed: "proxy" });
    }
  });

  it("honours explicit settings and uses a Zen key only when there is no OpenAI key", () => {
    expect(detectOpencode(model("opencode-go"), { JEV_OPENCODE_MODEL: "gpt-5-mini" })).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5-mini" });
    expect(detectOpencode(undefined, { OPENCODE_API_KEY: "key" })).toEqual({ upstream: "https://opencode.ai/zen/v1", rebind: "opencode" });
    expect(detectOpencode(undefined, { OPENCODE_API_KEY: "key", OPENAI_API_KEY: "other" })).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
  });

  it("takes JEV_OPENCODE_UPSTREAM_BASE_URL as given, at any path", () => {
    const groq = "https://api.groq.com/openai/v1";
    expect(detectOpencode(model("opencode-go"), { JEV_OPENCODE_UPSTREAM_BASE_URL: groq })).toEqual({ upstream: groq, model: "gpt-5" });
  });

  it("moves Zen or Go when JEV_OPENCODE_UPSTREAM_BASE_URL is that provider's own address, for when OpenCode cannot say", () => {
    expect(detectOpencode(undefined, { JEV_OPENCODE_UPSTREAM_BASE_URL: "https://opencode.ai/zen/go/v1/" })).toEqual({ upstream: "https://opencode.ai/zen/go/v1/", rebind: "opencode-go" });
    expect(detectOpencode(undefined, { JEV_OPENCODE_UPSTREAM_BASE_URL: "https://opencode.ai/zen/v1" })).toEqual({ upstream: "https://opencode.ai/zen/v1", rebind: "opencode" });
    expect(detectOpencode(undefined, { JEV_OPENCODE_UPSTREAM_BASE_URL: "https://opencode.ai/zen/v1", JEV_OPENCODE_MODEL: "gpt-5" })).toEqual({ upstream: "https://opencode.ai/zen/v1", model: "gpt-5" });
  });
});

const noHealth = async () => new Response("not found", { status: 404 });
const jevHealth = async () => Response.json({ status: "ok", pid: 1, upstream: "https://api.openai.com/v1", jev: "typesafe" });

/** A stand-in `opencode` on PATH that records each call and prints `replies[i]` when its arguments contain `i`. */
function stubOpencode(replies: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "jev-opencode-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  const quote = (line: string) => `'${line.replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries(replies).map(([args, lines]) => `  *"${args}"*) printf '%s\\n' ${lines.map(quote).join(" ")} ;;`).join("\n");
  writeFileSync(join(dir, "opencode"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  return {
    PATH: `${dir}:${savedEnv.PATH ?? ""}`,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

const goDefault = { "debug config": ['{"model":"opencode-go/kimi-k2.6","agent":{}}'] };

describe("asking OpenCode which provider to follow", () => {
  const detect = (opencode as any).detect as (env: object, fetchImpl: typeof fetch) => Promise<any>;

  it("uses the v2 local API model and provider response when debug config is unavailable", async () => {
    const cli = stubOpencode({
      "model.default": ['{"data":{"providerID":"proxy","modelID":"custom"}}'],
      "provider.list": ['{"data":[{"id":"proxy","package":"@ai-sdk/openai-compatible","settings":{"baseURL":"http://127.0.0.1:8317/v1"}}]}'],
    });
    expect(await detect({ PATH: cli.PATH }, noHealth)).toMatchObject({ upstream: "http://127.0.0.1:8317/v1", rebind: "proxy" });
  });

  it("finds the JSON after log lines that start with a bracket", async () => {
    const cli = stubOpencode({ "debug config": ["[plugin] loaded", '{"model":"opencode-go/kimi-k2.6"}'] });
    expect(await detect({ PATH: cli.PATH }, noHealth)).toMatchObject({ upstream: "https://opencode.ai/zen/go/v1", rebind: "opencode-go" });
  });

  it("asks OpenCode nothing when the user already chose a model, an upstream, or no check", async () => {
    const cli = stubOpencode(goDefault);
    for (const choice of [{ JEV_OPENCODE_MODEL: "gpt-5" }, { JEV_OPENCODE_UPSTREAM_BASE_URL: "https://api.groq.com/openai/v1" }, { JEV_OPENCODE_CHECK: "off" }]) {
      expect((await detect({ PATH: cli.PATH, ...choice }, noHealth)).rebind).toBeUndefined();
    }
    expect(cli.calls()).toEqual([]);
  });

  it("does not try the v2 API when v1 answers without a model", async () => {
    const cli = stubOpencode({ "debug config": ['{"agent":{}}'] });
    expect(await detect({ PATH: cli.PATH, OPENAI_API_KEY: "key" }, noHealth)).toMatchObject({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
    expect(cli.calls()).toEqual(["debug config"]);
  });

  it("asks OpenCode once for both the upstream and the coverage notice", async () => {
    const cli = stubOpencode({ "debug config": ['{"model":"opencode-go/kimi-k2.6","agent":{"review":{"model":"opencode-go/glm-5"},"docs":{"model":"xai/grok-4"}}}'] });
    const env = { PATH: cli.PATH };
    const setup = await detect(env, noHealth);
    const lines = (await opencode.notices!(origin, [], env, setup)).join("\n");
    expect(cli.calls()).toEqual(["debug config"]);
    expect(lines).toContain('agent "docs" (xai/grok-4)');
    expect(lines).not.toContain("review");
    expect(lines).not.toContain("default model");
  });

  it("falls back with a one-line warning when the selected provider is a Jev gateway on an unknown port", async () => {
    const cli = stubOpencode({ "debug config": [JSON.stringify(custom("http://127.0.0.1:8317/v1"))] });
    const setup = await detect({ PATH: cli.PATH, OPENAI_API_KEY: "key" }, jevHealth);
    expect(setup).toMatchObject({ upstream: "https://api.openai.com/v1", model: "gpt-5", unfollowed: "proxy" });
    expect(setup.warning).toMatch(/^the default model's provider "proxy" .*https:\/\/api\.openai\.com\/v1\.$/);
  });

  it("stops with one line when JEV_OPENCODE_UPSTREAM_BASE_URL is a Jev gateway, known port or not", async () => {
    for (const [upstream, health] of [["http://127.0.0.1:8793/v1", noHealth], ["http://127.0.0.1:8317/v1", jevHealth]] as const) {
      const failure = detect({ JEV_OPENCODE_UPSTREAM_BASE_URL: upstream }, health);
      await expect(failure).rejects.toThrow(/^JEV_OPENCODE_UPSTREAM_BASE_URL points at a Jev gateway/);
      await expect(failure).rejects.not.toThrow(/\n/);
    }
  });
});

describe("jev-opencode commands", () => {
  const home = () => mkdtempSync(join(tmpdir(), "jev-opencode-home-"));
  const run = async (args: string[], env: Record<string, string>) => {
    const dir = home();
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [launcherBin, ...args], {
        encoding: "utf8", timeout: 30_000, env: { HOME: dir, XDG_CONFIG_HOME: dir, JEV_SKIP_PROJECT_ENV: "1", BROWSER: "none", ...env },
      });
      return { code: 0, stdout, stderr };
    } catch (error: any) {
      return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * A running gateway, started from a project whose provider is not this one's. The launcher runs as
   * its own process here, so it can only be reached on a port; the server listens on loopback only.
   */
  async function otherGateway() {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") return response.end(JSON.stringify({ status: "ok", pid: 1, upstream: "https://opencode.ai/zen/v1", jev: "typesafe" }));
      response.end("{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    return { port: String(port) };
  }

  it("prints the config without asking OpenCode", async () => {
    const cli = stubOpencode(goDefault);
    const { code, stdout } = await run(["--print-config"], { PATH: cli.PATH });
    expect(code).toBe(0);
    expect(stdout).toContain(`${origin}/v1`);
    expect(cli.calls()).toEqual([]);
  });

  it("opens the dashboard and switches routing on a gateway started from another project", async () => {
    const cli = stubOpencode(goDefault);
    const gateway = await otherGateway();
    for (const args of [["--dashboard"], ["--routing", "off"]]) {
      const { code, stderr } = await run(args, { PATH: cli.PATH, JEV_OPENCODE_PORT: gateway.port });
      expect(stderr).toBe("");
      expect(code).toBe(0);
    }
    expect(cli.calls()).toEqual([]);
  });

  it("says in one line which provider it did not follow, wherever it chooses the upstream", async () => {
    const cli = stubOpencode({ "debug config": [JSON.stringify(custom("http://127.0.0.1:8790/v1"))] });
    const { stderr } = await run(["--status"], { PATH: cli.PATH, JEV_OPENCODE_PORT: "1", OPENAI_API_KEY: "key" });
    expect(stderr.trim().split("\n")).toEqual([expect.stringMatching(/^jev-opencode: the default model's provider "proxy" /)]);
  });

  it("stops with one line, not a stack trace, when the upstream is a Jev gateway", async () => {
    const { code, stderr } = await run(["--start"], { PATH: savedEnv.PATH ?? "", JEV_OPENCODE_PORT: "1", JEV_OPENCODE_UPSTREAM_BASE_URL: "http://127.0.0.1:8792/v1" });
    expect(code).toBe(1);
    expect(stderr.trim().split("\n")).toEqual([expect.stringMatching(/^jev-opencode: JEV_OPENCODE_UPSTREAM_BASE_URL points at a Jev gateway/)]);
  });
});

describe("jev-opencode entrypoint", () => {
  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-opencode"]).toBe("bin/jev-opencode.mjs");
    expect(pkg.scripts.opencode).toBe("node bin/jev-opencode.mjs");
  });

  it("--gateway-help describes the opencode launcher without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--gateway-help"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("jev-opencode: opencode with tool selection routed through Jev");
    expect(out).toContain("--print-config");
  });

  it("--print-config prints the gateway-rooted provider config without starting anything", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-opencode-home-"));
    try {
      const out = execFileSync(process.execPath, [launcherBin, "--print-config"], {
        encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, JEV_SKIP_PROJECT_ENV: "1" },
      });
      expect(out).toContain("http://127.0.0.1:8791/v1");
      expect(out).toContain("jev-gateway");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("jev-devin spec", () => {
  it("identifies itself as the devin launcher on its own port", () => {
    expect(devin.name).toBe("jev-devin");
    expect(devin.client).toBe("devin");
    expect(devin.portEnv).toBe("JEV_DEVIN_PORT");
    expect(devin.defaultPort).toBe(8792);
    expect([codex.defaultPort, claude.defaultPort, opencode.defaultPort]).not.toContain(devin.defaultPort);
  });

  it("defaults upstream to the exa backend with a JEV_DEVIN_UPSTREAM_BASE_URL override", () => {
    expect(devin.upstream()).toBe("https://server.codeium.com");
    process.env.JEV_DEVIN_UPSTREAM_BASE_URL = "https://exa.test";
    expect(devin.upstream()).toBe("https://exa.test");
    expect(devin.upstreamHelp).toContain("JEV_DEVIN_UPSTREAM_BASE_URL");
  });

  it("points the CLI at the gateway through the variable compiled into it", () => {
    // The name is a leftover from the binary's windsurf backend; there is no DEVIN_* equivalent.
    expect(devin.env!(origin)).toEqual({ WINDSURF_API_SERVER_URL: origin });
    expect(devin.configHelp(origin)).toContain(`WINDSURF_API_SERVER_URL=${origin}`);
    expect(devin.configHelp(origin)).toContain("jev-devin --start");
  });
});

describe("jev-devin entrypoint", () => {
  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-devin"]).toBe("bin/jev-devin.mjs");
    expect(pkg.scripts.devin).toBe("node bin/jev-devin.mjs");
    expect(pkg.keywords).toContain("devin");
  });
});

describe("existing launchers", () => {
  it("keeps the codex and claude specs intact", () => {
    expect(codex.name).toBe("jev-codex");
    expect(codex.client).toBe("codex");
    expect(codex.defaultPort).toBe(8790);
    // No readable login (CODEX_HOME is pointed at nothing): falls back to the API backend.
    process.env.CODEX_HOME = "/nonexistent-jev-test-dir";
    expect(codex.upstream()).toBe("https://api.openai.com/v1");
    expect(codex.args!(origin).join(" ")).toContain('model_provider="jev-gateway"');

    expect(claude.name).toBe("jev-claude");
    expect(claude.client).toBe("claude");
    expect(claude.defaultPort).toBe(8789);
    expect(claude.upstream()).toBe("https://api.anthropic.com/v1");
    expect(claude.env!(origin)).toEqual({ ANTHROPIC_BASE_URL: origin });
  });
});

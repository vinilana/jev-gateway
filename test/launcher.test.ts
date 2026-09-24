import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));

const managedEnv = ["OPENCODE_CONFIG_CONTENT", "JEV_OPENCODE_UPSTREAM_BASE_URL", "JEV_OPENCODE_MODEL", "JEV_CODEX_UPSTREAM_BASE_URL", "JEV_CLAUDE_UPSTREAM_BASE_URL", "CODEX_HOME", "OPENAI_API_KEY", "OPENCODE_API_KEY", "PATH"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
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

describe("following OpenCode's selected provider", () => {
  const model = (id: string) => ({ model: `${id}/kimi-k2.6` });

  it("uses separate Zen and Go upstreams and moves only the selected provider", () => {
    for (const [id, upstream] of [["opencode", "https://opencode.ai/zen/v1"], ["opencode-go", "https://opencode.ai/zen/go/v1"]] as const) {
      const setup = detectOpencode(model(id), {});
      expect(setup).toEqual({ upstream, rebind: id });
      const config = JSON.parse(opencodeConfigContent(origin, undefined, setup));
      expect(config.model).toBeUndefined();
      expect(config.provider).toEqual({ [id]: { options: { baseURL: `${origin}/v1` } } });
      expect(detectOpencode(model(id), { JEV_OPENCODE_UPSTREAM_BASE_URL: upstream })).toEqual({ upstream, rebind: id });
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

  it("rejects secret-bearing URLs and the other local gateway ports", () => {
    for (const baseURL of ["https://proxy.example/secret-token/v1", "https://proxy.example/v1?key=secret", "http://0.0.0.0:8791/v1", "http://[::ffff:127.0.0.1]:8791/v1", "http://127.0.0.1:8790/v1"]) {
      const resolved = { model: "proxy/custom", provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL } } } };
      expect(detectOpencode(resolved, { OPENAI_API_KEY: "key" })).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
    }
    expect(() => detectOpencode(undefined, { JEV_OPENCODE_UPSTREAM_BASE_URL: "http://127.0.0.1:8790/v1" })).toThrow(/JEV_OPENCODE_UPSTREAM_BASE_URL/);
    expect(() => detectOpencode(undefined, { JEV_OPENCODE_UPSTREAM_BASE_URL: "https://proxy.example/secret-token/v1" })).toThrow(/JEV_OPENCODE_UPSTREAM_BASE_URL/);
  });

  it("honours explicit settings and uses a Zen key only when there is no OpenAI key", () => {
    expect(detectOpencode(model("opencode-go"), { JEV_OPENCODE_MODEL: "gpt-5-mini" })).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5-mini" });
    expect(detectOpencode(undefined, { OPENCODE_API_KEY: "key" })).toEqual({ upstream: "https://opencode.ai/zen/v1", rebind: "opencode" });
    expect(detectOpencode(undefined, { OPENCODE_API_KEY: "key", OPENAI_API_KEY: "other" })).toEqual({ upstream: "https://api.openai.com/v1", model: "gpt-5" });
  });

  it("uses the v2 local API model and provider response when debug config is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-opencode-cli-"));
    const cli = join(dir, "opencode");
    writeFileSync(cli, `#!/bin/sh\ncase "$*" in\n  *model.default*) echo '{"data":{"providerID":"proxy","modelID":"custom"}}' ;;\n  *provider.list*) echo '{"data":[{"id":"proxy","package":"@ai-sdk/openai-compatible","settings":{"baseURL":"http://127.0.0.1:8317/v1"}}]}' ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
    try {
      process.env.PATH = `${dir}:${process.env.PATH}`;
      const noHealth = async () => new Response("not found", { status: 404 });
      expect(await (opencode as any).detect({ PATH: process.env.PATH }, noHealth)).toEqual({ upstream: "http://127.0.0.1:8317/v1", rebind: "proxy" });
      const gateway = async () => Response.json({ status: "ok", pid: 1, upstream: "https://api.openai.com/v1", jev: "typesafe" });
      await expect((opencode as any).detect({
        PATH: process.env.PATH, JEV_OPENCODE_MODEL: "gpt-5", JEV_OPENCODE_UPSTREAM_BASE_URL: "http://127.0.0.1:8792/v1",
      }, gateway)).rejects.toThrow(/another Jev gateway/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

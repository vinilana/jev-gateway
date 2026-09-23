import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  args?: (origin: string) => string[];
  env?: (origin: string, environment?: Record<string, string | undefined>, auth?: Record<string, OpenCodeAuthEntry>) => Record<string, string>;
  setupAppPreflight?: () => unknown;
  configHelp: (origin: string, environment?: Record<string, string | undefined>, auth?: Record<string, OpenCodeAuthEntry>) => string;
}

interface OpenCodeAuthEntry {
  type: "api" | "oauth";
  key?: string;
}

interface OpenCodeRoute {
  providerId: string;
  modelId: string;
  model: string;
  upstream: string;
  credentialSource: string;
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));

const managedEnv = ["JEV_OPENCODE_UPSTREAM_BASE_URL", "JEV_OPENCODE_MODEL", "JEV_CODEX_UPSTREAM_BASE_URL", "JEV_CLAUDE_UPSTREAM_BASE_URL", "CODEX_HOME", "OPENAI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OPENAI_API_KEY = "test-only-key";
});

afterEach(() => {
  for (const key of managedEnv) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const inlineConfig = (
  originOverride = origin,
  environment: Record<string, string | undefined> = { ...process.env, OPENAI_API_KEY: "test-only-key" },
  auth: Record<string, OpenCodeAuthEntry> = {},
) => {
  const env = opencode.env?.(originOverride, environment, auth);
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
    expect(opencode.setupAppPreflight).toBeTypeOf("function");
    expect([codex.defaultPort, claude.defaultPort]).not.toContain(opencode.defaultPort);
  });

  it("defaults upstream to OpenAI with a JEV_OPENCODE_UPSTREAM_BASE_URL override", () => {
    expect(opencode.upstream()).toBe("https://api.openai.com/v1");
    process.env.JEV_OPENCODE_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(opencode.upstream()).toBe("https://llm.test/v1");
    expect(opencode.upstreamHelp).toContain("JEV_OPENCODE_UPSTREAM_BASE_URL");
  });

  it("uses a saved OpenRouter credential without exposing or copying its key", () => {
    const resolve = (clients as unknown as { resolveOpenCodeRoute?: (input: { env: Record<string, string | undefined>; auth: Record<string, OpenCodeAuthEntry> }) => OpenCodeRoute }).resolveOpenCodeRoute;
    expect(resolve).toBeTypeOf("function");
    if (!resolve) return;

    const route = resolve({
      env: {},
      auth: {
        openai: { type: "oauth" },
        openrouter: { type: "api", key: "test-only-secret" },
      },
    });

    expect(route).toMatchObject({
      providerId: "openrouter",
      modelId: "openai/gpt-5",
      model: "openrouter/openai/gpt-5",
      upstream: "https://openrouter.ai/api/v1",
      credentialSource: "opencode-auth-store",
    });
    expect(JSON.stringify(route)).not.toContain("test-only-secret");
  });

  it("configures the built-in OpenRouter provider to use the gateway without embedding the saved key", () => {
    const config = inlineConfig(origin, {}, { openrouter: { type: "api", key: "test-only-secret" } });
    expect(config.model).toBe("openrouter/openai/gpt-5");
    expect(config.small_model).toBe("openrouter/openai/gpt-5");
    expect(config.provider.openrouter.options).toEqual({ baseURL: `${origin}/v1` });
    expect(JSON.stringify(config)).not.toContain("test-only-secret");
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
    const env = opencode.env!(origin, { OPENAI_API_KEY: "test-only-key" }, {});
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
    const help = opencode.configHelp(origin, { ...process.env, OPENAI_API_KEY: "test-only-key" }, {});
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
    expect(opencode.configHelp(origin, { ...process.env, OPENAI_API_KEY: "test-only-key" }, {})).toContain("jev-gateway/other-model");
  });

  it("stays safe when a custom model ID contains an apostrophe", () => {
    process.env.JEV_OPENCODE_MODEL = "o'brien";
    const config = inlineConfig();
    expect(config.model).toBe("jev-gateway/o'brien");
    expect(Object.keys(config.provider["jev-gateway"].models)).toEqual(["o'brien"]);
    const help = opencode.configHelp(origin, { ...process.env, OPENAI_API_KEY: "test-only-key" }, {});
    expect(help).not.toContain("OPENCODE_CONFIG_CONTENT='");
    const jsonBlock = help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1);
    expect(() => JSON.parse(jsonBlock)).not.toThrow();
    expect((JSON.parse(jsonBlock) as any).model).toBe("jev-gateway/o'brien");
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
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("http://127.0.0.1:8791/v1");
    expect(out).toContain("jev-gateway");
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

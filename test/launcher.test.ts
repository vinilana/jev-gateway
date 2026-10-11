import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: (settingsFile?: string) => string;
  upstreamHelp: string;
  args?: (origin: string) => string[];
  env?: (origin: string) => Record<string, string>;
  configHelp: (origin: string) => string;
}

const opencode = clients.opencode as LauncherSpec;
const codex = clients.codex as LauncherSpec;
const claude = clients.claude as LauncherSpec;
const devin = clients.devin as LauncherSpec;
const antigravity = clients.antigravity as LauncherSpec;
const agyLauncherBin = fileURLToPath(new URL("../bin/jev-antigravity.mjs", import.meta.url));

const origin = "http://127.0.0.1:8791";
const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));

const managedEnv = ["OPENCODE_CONFIG_CONTENT", "JEV_OPENCODE_UPSTREAM_BASE_URL", "JEV_OPENCODE_MODEL", "JEV_CODEX_UPSTREAM_BASE_URL", "JEV_CLAUDE_UPSTREAM_BASE_URL", "JEV_DEVIN_UPSTREAM_BASE_URL", "CODEX_HOME", "JEV_ANTIGRAVITY_UPSTREAM_BASE_URL", "GEMINI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
const temporaryDirs: string[] = [];

function antigravitySettings(content?: string) {
  const dir = mkdtempSync(join(tmpdir(), "jev-antigravity-"));
  temporaryDirs.push(dir);
  const path = join(dir, "settings.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

function isolatedLauncherEnv() {
  const home = mkdtempSync(join(tmpdir(), "jev-launcher-home-"));
  temporaryDirs.push(home);
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    JEV_SKIP_PROJECT_ENV: "1",
  };
}

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
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

describe("jev-opencode entrypoint", () => {
  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-opencode"]).toBe("bin/jev-opencode.mjs");
    expect(pkg.scripts.opencode).toBe("node bin/jev-opencode.mjs");
  });

  it("--gateway-help describes the opencode launcher without starting anything", () => {
    const env = isolatedLauncherEnv();
    const out = execFileSync(process.execPath, [launcherBin, "--gateway-help"], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    expect(out).toContain("jev-opencode: opencode with tool selection routed through Jev");
    expect(out).toContain("--print-config");
    expect(out).toContain(join(env.HOME, ".jev-gateway", ".env"));
  });

  it("--print-config prints the gateway-rooted provider config without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], {
      encoding: "utf8",
      timeout: 30_000,
      env: isolatedLauncherEnv(),
    });
    expect(out).toContain("http://127.0.0.1:8791/v1");
    expect(out).toContain("jev-gateway");
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

describe("jev-antigravity spec", () => {
  it("identifies itself as the antigravity launcher on its own port", () => {
    expect(antigravity.name).toBe("jev-antigravity");
    expect(antigravity.client).toBe("agy");
    expect(antigravity.portEnv).toBe("JEV_ANTIGRAVITY_PORT");
    expect(antigravity.defaultPort).toBe(8795);
    expect([codex.defaultPort, claude.defaultPort, opencode.defaultPort, (clients.gemini as LauncherSpec).defaultPort]).not.toContain(antigravity.defaultPort);
  });

  it("defaults upstream to Cloud Code when settings.json is missing", () => {
    expect(antigravity.upstream(antigravitySettings())).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  it("follows the model provider in settings.json", () => {
    const path = antigravitySettings(JSON.stringify({ modelProvider: "cloudcode" }));
    expect(antigravity.upstream(path)).toBe("https://daily-cloudcode-pa.googleapis.com");
    writeFileSync(path, JSON.stringify({ modelProvider: "gemini" }));
    expect(antigravity.upstream(path)).toBe("https://generativelanguage.googleapis.com");
  });

  it("keeps the default Cloud Code provider when GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const path = antigravitySettings();
    expect(antigravity.upstream(path)).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  it("uses Gemini when settings select that provider and GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const path = antigravitySettings(JSON.stringify({ modelProvider: "gemini" }));
    expect(antigravity.upstream(path)).toBe("https://generativelanguage.googleapis.com");
  });

  it("gives the explicit upstream override precedence over the settings provider", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.JEV_ANTIGRAVITY_UPSTREAM_BASE_URL = "https://custom-cloudcode.test";
    const path = antigravitySettings(JSON.stringify({ modelProvider: "gemini" }));
    expect(antigravity.upstream(path)).toBe("https://custom-cloudcode.test");
    expect(antigravity.upstreamHelp).toContain("JEV_ANTIGRAVITY_UPSTREAM_BASE_URL");
  });

  it("falls back to Cloud Code when settings.json is invalid", () => {
    expect(antigravity.upstream(antigravitySettings("{"))).toBe("https://daily-cloudcode-pa.googleapis.com");
  });

  it("points Cloud Code and Gemini provider requests at the gateway", () => {
    const env = antigravity.env!("http://127.0.0.1:8787");
    expect(env).toEqual({
      CLOUD_CODE_URL: "http://127.0.0.1:8787",
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:8787",
    });
  });

  it("keeps GEMINI_API_BASE on the Gemini launcher", () => {
    expect((clients.gemini as LauncherSpec).env!("http://127.0.0.1:8787")).toEqual({
      GEMINI_API_BASE: "http://127.0.0.1:8787",
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:8787",
    });
  });

  it("prints permanent wiring help without recommending the broken plan mode", () => {
    const help = antigravity.configHelp("http://127.0.0.1:8787");
    expect(help).toContain("CLOUD_CODE_URL=http://127.0.0.1:8787 agy");
    expect(help).not.toContain("--mode plan");
    expect(help).toContain('settings.json modelProvider: "gemini" and GEMINI_API_KEY set');
    expect(help).toContain("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787 agy");
    expect(help).not.toContain("GEMINI_API_BASE");
  });
});

describe("jev-antigravity entrypoint", () => {
  it("is registered in package.json with runnable scripts", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-antigravity"]).toBe("bin/jev-antigravity.mjs");
    expect(pkg.bin["jev-agy"]).toBe("bin/jev-antigravity.mjs");
    expect(pkg.scripts.antigravity).toBe("node bin/jev-antigravity.mjs");
    expect(pkg.scripts.agy).toBe("node bin/jev-antigravity.mjs");
  });

  it("is executable as an npm CLI entrypoint", () => {
    expect(statSync(agyLauncherBin).mode & 0o111).toBeGreaterThan(0);
  });

  it("--gateway-help describes the antigravity launcher without starting anything", () => {
    const env = isolatedLauncherEnv();
    const out = execFileSync(process.execPath, [agyLauncherBin, "--gateway-help"], {
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    expect(out).toContain("jev-antigravity: agy with tool selection routed through Jev");
    expect(out).toContain("--print-config");
    expect(out).toContain(join(env.HOME, ".jev-gateway", ".env"));
  });

  it("--print-config prints the antigravity environment configuration without starting anything", () => {
    const out = execFileSync(process.execPath, [agyLauncherBin, "--print-config"], {
      encoding: "utf8",
      timeout: 30_000,
      env: isolatedLauncherEnv(),
    });
    expect(out).toContain("CLOUD_CODE_URL=http://127.0.0.1:8795 agy");
  });
});

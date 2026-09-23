import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

type OpenCodeApp = {
  mergeOpenCodeDesktopConfig?: (source: string, origin: string, route: OpenCodeRoute) => { text: string; changed: boolean };
  configureOpenCodeDesktopApp?: (origin: string, route: OpenCodeRoute) => { changed: boolean; configPath: string; backupPath?: string };
  restartOpenCodeDesktopApp?: (dependencies?: {
    platform?: string;
    wait?: (milliseconds: number) => Promise<void>;
    execCommand?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => string;
    launchProcess?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<void>;
  }) => Promise<{ restarted: boolean; wasOpen?: boolean; reason?: string }>;
};

interface OpenCodeRoute {
  providerId: string;
  modelId: string;
  model: string;
  upstream: string;
  credentialSource: string;
  apiKeyEnv?: string;
}

const legacyRoute = (modelId = "gpt-5"): OpenCodeRoute => ({
  providerId: "jev-gateway",
  modelId,
  model: `jev-gateway/${modelId}`,
  upstream: "https://api.openai.com/v1",
  credentialSource: "environment",
  apiKeyEnv: "OPENAI_API_KEY",
});

const appModulePath = "../bin/opencode-app.mjs";
async function importAppModule() {
  return await import(appModulePath).catch(() => undefined) as OpenCodeApp | undefined;
}

async function withTemporaryOpenCodeHome(run: (home: string, app: OpenCodeApp | undefined) => void) {
  const home = mkdtempSync(join(tmpdir(), "jev-opencode-app-"));
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_DATA_HOME = join(home, ".local", "share");
  vi.resetModules();
  try {
    run(home, await importAppModule());
  } finally {
    vi.resetModules();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

describe("OpenCode Desktop setup", () => {
  it("exposes setup and restart through the OpenCode launcher", () => {
    const opencode = clients.opencode as {
      appLabel?: string;
      setupApp?: unknown;
      restartApp?: unknown;
    };

    expect(opencode.appLabel).toBe("OpenCode Desktop app");
    expect(opencode.setupApp).toBeTypeOf("function");
    expect(opencode.restartApp).toBeTypeOf("function");
  });

  it("merges gateway defaults into JSONC while preserving comments and unrelated providers", async () => {
    const source = `{
  "$schema": "https://opencode.ai/config.json",
  // Keep my existing default notes.
  "model": "openai/gpt-4.1",
  "autoupdate": false,
  "provider": {
    "openai": { "models": { "gpt-4.1": { "name": "Keep this model" } } },
    "jev-gateway": {
      "options": { "timeout": 120000 },
      "models": { "custom-model": { "name": "Keep this model too" } }
    }
  },
}`;

    const app = await importAppModule();
    const result = app?.mergeOpenCodeDesktopConfig?.(source, "http://127.0.0.1:8791", legacyRoute());
    expect(result).toBeDefined();
    if (!result) return;

    const config = parse(result.text) as any;
    expect(result.changed).toBe(true);
    expect(result.text).toContain("// Keep my existing default notes.");
    expect(config.model).toBe("jev-gateway/gpt-5");
    expect(config.small_model).toBe("jev-gateway/gpt-5");
    expect(config.autoupdate).toBe(false);
    expect(config.provider.openai.models["gpt-4.1"].name).toBe("Keep this model");
    expect(config.provider["jev-gateway"].options).toMatchObject({
      baseURL: "http://127.0.0.1:8791/v1",
      apiKey: "{env:OPENAI_API_KEY}",
      timeout: 120000,
    });
    expect(config.provider["jev-gateway"].models).toMatchObject({
      "custom-model": { name: "Keep this model too" },
      "gpt-5": { name: "Jev Gateway (gpt-5)" },
    });

    const repeated = app?.mergeOpenCodeDesktopConfig?.(result.text, "http://127.0.0.1:8791", legacyRoute());
    expect(repeated).toEqual({ text: result.text, changed: false });
  });

  it("uses a stored OpenRouter provider as the default without writing its secret", async () => {
    await withTemporaryOpenCodeHome((home, app) => {
      const route: OpenCodeRoute = {
        providerId: "openrouter",
        modelId: "openai/gpt-5",
        model: "openrouter/openai/gpt-5",
        upstream: "https://openrouter.ai/api/v1",
        credentialSource: "opencode-auth-store",
      };
      const result = app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", route);
      expect(result?.changed).toBe(true);
      const config = parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")) as any;
      expect(config.model).toBe("openrouter/openai/gpt-5");
      expect(config.small_model).toBe("openrouter/openai/gpt-5");
      expect(config.provider.openrouter.options).toEqual({ baseURL: "http://127.0.0.1:8791/v1" });
      expect(JSON.stringify(config)).not.toContain("test-only-secret");
    });
  });

  it("backs up and updates an existing global JSONC config only once", async () => {
    await withTemporaryOpenCodeHome((home, app) => {
      const configHome = join(home, ".config", "opencode");
      const configPath = join(configHome, "opencode.jsonc");
      mkdirSync(configHome, { recursive: true });
      const original = '{\n  // User preferences stay here.\n  "autoupdate": false,\n}\n';
      writeFileSync(configPath, original, "utf8");

      const result = app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", legacyRoute("gpt-5-mini"));
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.changed).toBe(true);
      expect(result.configPath).toBe(configPath);
      expect(result.backupPath).toBe(join(home, ".jev-gateway", "opencode-config.before-app-setup.jsonc"));
      expect(readFileSync(result.backupPath!, "utf8")).toBe(original);
      const config = parse(readFileSync(configPath, "utf8")) as any;
      expect(config.model).toBe("jev-gateway/gpt-5-mini");
      expect(config.provider["jev-gateway"].options.apiKey).toBe("{env:OPENAI_API_KEY}");
      expect(config.autoupdate).toBe(false);

      const updated = readFileSync(configPath, "utf8");
      expect(app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", legacyRoute("gpt-5-mini"))).toMatchObject({ changed: false, configPath });
      expect(readFileSync(configPath, "utf8")).toBe(updated);
      expect(existsSync(result.backupPath!)).toBe(true);
    });
  });

  it("creates the normal global JSON config when no OpenCode config exists", async () => {
    await withTemporaryOpenCodeHome((home, app) => {
      const result = app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", legacyRoute());
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.changed).toBe(true);
      expect(result.configPath).toBe(join(home, ".config", "opencode", "opencode.json"));
      expect(result.backupPath).toBeUndefined();
      expect(parse(readFileSync(result.configPath, "utf8"))).toMatchObject({
        model: "jev-gateway/gpt-5",
        small_model: "jev-gateway/gpt-5",
      });
    });
  });

  it("honors XDG_CONFIG_HOME loaded after the launcher imports its client settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "jev-opencode-xdg-"));
    const previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_CONFIG_HOME;
    vi.resetModules();
    try {
      const app = await importAppModule();
      process.env.XDG_CONFIG_HOME = join(home, "custom-config");
      const result = app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", legacyRoute());
      expect(result?.configPath).toBe(join(home, "custom-config", "opencode", "opencode.json"));
    } finally {
      vi.resetModules();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to guess when both global JSON and JSONC configs exist", async () => {
    await withTemporaryOpenCodeHome((home, app) => {
      const configHome = join(home, ".config", "opencode");
      mkdirSync(configHome, { recursive: true });
      writeFileSync(join(configHome, "opencode.json"), "{}\n");
      writeFileSync(join(configHome, "opencode.jsonc"), "{}\n");

      expect(() => app?.configureOpenCodeDesktopApp?.("http://127.0.0.1:8791", legacyRoute())).toThrow(/both.*opencode\.json/i);
      expect(readFileSync(join(configHome, "opencode.json"), "utf8")).toBe("{}\n");
      expect(readFileSync(join(configHome, "opencode.jsonc"), "utf8")).toBe("{}\n");
    });
  });

  it("lists app setup in OpenCode launcher help", () => {
    const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));
    const help = execFileSync(process.execPath, [launcherBin, "--gateway-help"], { encoding: "utf8", timeout: 30_000 });
    expect(help).toContain("--setup-app");
    expect(help).toContain("OpenCode Desktop app");
  });

  it("does not configure the app when no supported API credential is available", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-opencode-no-key-"));
    const launcherBin = fileURLToPath(new URL("../bin/jev-opencode.mjs", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), JEV_SKIP_PROJECT_ENV: "1", JEV_OPENCODE_PORT: "0" };
    delete env.OPENAI_API_KEY;
    delete env.TYPESAFE_API_KEY;
    delete env.OPENROUTER_API_KEY;
    delete env.AI_GATEWAY_API_KEY;

    try {
      const result = spawnSync(process.execPath, [launcherBin, "--setup-app"], { encoding: "utf8", env, timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No supported OpenAI or OpenRouter API credential");
      expect(result.stderr).toContain("No OpenCode Desktop app configuration was changed");
      expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gracefully restarts only OpenCode Desktop with the setup environment", async () => {
    const app = await importAppModule();
    expect(app?.restartOpenCodeDesktopApp).toBeTypeOf("function");
    if (!app?.restartOpenCodeDesktopApp) return;

    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "local-test-key";
    let desktopOpen = true;
    const commands: string[] = [];
    let launchOptions: any;
    try {
      const result = await app.restartOpenCodeDesktopApp({
        platform: "win32",
        wait: async () => {},
        execCommand: (_command: string, args: string[], options?: any) => {
          const script = args.at(-1) ?? "";
          commands.push(script);
          if (script.includes("CreateShortcut")) {
            return JSON.stringify({ target: process.execPath, arguments: "", workingDirectory: process.cwd() });
          }
          if (script.includes("CloseMainWindow")) {
            desktopOpen = false;
            return "";
          }
          if (script.includes("$started = Start-Process @startOptions")) {
            launchOptions = options;
            desktopOpen = true;
            return '{"pid":1234}';
          }
          if (script.includes("@(Get-Process -Name OpenCode")) return desktopOpen ? "1" : "0";
          throw new Error(`Unexpected command: ${script}`);
        },
      });

      expect(result).toEqual({ restarted: true, wasOpen: true });
      expect(commands.some((command) => command.includes("Get-Process -Name OpenCode"))).toBe(true);
      expect(commands.some((command) => command.includes("opencode-cli"))).toBe(false);
      expect(commands.some((command) => command.includes("$started = Start-Process @startOptions"))).toBe(true);
      expect(launchOptions.env.OPENAI_API_KEY).toBe("local-test-key");
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  it("reports a failed restart when the desktop process never appears", async () => {
    const app = await importAppModule();
    expect(app?.restartOpenCodeDesktopApp).toBeTypeOf("function");
    if (!app?.restartOpenCodeDesktopApp) return;

    let launchAttempted = false;
    const result = await app.restartOpenCodeDesktopApp({
      platform: "win32",
      wait: async () => {},
      execCommand: (_command: string, args: string[]) => {
        const script = args.at(-1) ?? "";
        if (script.includes("CreateShortcut")) {
          return JSON.stringify({ target: process.execPath, arguments: "", workingDirectory: process.cwd() });
        }
        if (script.includes("$started = Start-Process @startOptions")) {
          launchAttempted = true;
          return "";
        }
        if (script.includes("@(Get-Process -Name OpenCode")) return "0";
        return "";
      },
    });

    expect(launchAttempted).toBe(true);
    expect(result).toMatchObject({ restarted: false, wasOpen: false });
  });
});

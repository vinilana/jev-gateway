import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { applyJson, disable, disableAutostart, disableCodex, enable, enableAutostart, enableCodex, readState, restoreJson } from "../bin/enable.mjs";

const ORIGIN = "http://127.0.0.1:8787";

describe("Codex config.toml", () => {
  const original = `model = "gpt-6-astra"\nmodel_provider = "openai"\nservice_tier = "fast"\n\n[projects."/work"]\ntrust_level = "trusted"\n\n[mcp_servers.playwright]\ncommand = "npx"\n`;

  it("puts the provider choice before the first table and the provider table last", () => {
    const enabled = enableCodex(original, `${ORIGIN}/codex/v1`);
    const lines = enabled.split("\n");
    expect(lines[1]).toBe('model_provider = "jev-gateway"');
    expect(lines.indexOf('model_provider = "jev-gateway"')).toBeLessThan(lines.findIndex((line: string) => line.startsWith("[")));
    // The user's own choice would be a duplicate key: it waits in a comment.
    expect(enabled).toContain('# jev-gateway:was model_provider = "openai"');
    expect(enabled.trimEnd().split("\n").slice(-6, -1)).toEqual([
      "[model_providers.jev-gateway]",
      'name = "jev-gateway"',
      'base_url = "http://127.0.0.1:8787/codex/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ]);
  });

  it("comes back byte for byte, however many times it is enabled", () => {
    const twice = enableCodex(enableCodex(original, "http://old/codex/v1"), `${ORIGIN}/codex/v1`);
    expect(twice.match(/model_providers\.jev-gateway/g)).toHaveLength(1);
    expect(twice).not.toContain("http://old");
    expect(disableCodex(twice)).toBe(original);
    expect(disableCodex(enableCodex("", ORIGIN))).toBe("");
    expect(disableCodex(original)).toBe(original);
  });

  it("leaves a model_provider inside a table alone, and refuses a clashing table", () => {
    const nested = `[profiles.x]\nmodel_provider = "other"\n`;
    expect(enableCodex(nested, ORIGIN)).toContain('[profiles.x]\nmodel_provider = "other"');
    expect(() => enableCodex(`[model_providers.jev-gateway]\nname = "mine"\n`, ORIGIN)).toThrow(/already defines/);
  });
});

describe("JSON settings", () => {
  it("sets a value, remembers what was there, and restores it without leftovers", () => {
    const fresh = applyJson("", [[["env", "ANTHROPIC_BASE_URL"], `${ORIGIN}/claude`]]);
    expect(JSON.parse(fresh.text)).toEqual({ env: { ANTHROPIC_BASE_URL: `${ORIGIN}/claude` } });
    expect(JSON.parse(restoreJson(fresh.text, fresh.previous))).toEqual({});

    const mine = JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "https://corp-proxy", FOO: "1" } });
    const applied = applyJson(mine, [[["env", "ANTHROPIC_BASE_URL"], `${ORIGIN}/claude`]]);
    expect(JSON.parse(restoreJson(applied.text, applied.previous))).toEqual(JSON.parse(mine));
  });
});

describe("enable and disable on disk", () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-enable-"));
    return { HOME: dir, CODEX_HOME: join(dir, ".codex") };
  };

  it("edits each tool's own file, keeps the original beside it, and undoes it all", () => {
    const env = home();
    mkdirSync(env.CODEX_HOME);
    const codexFile = join(env.CODEX_HOME, "config.toml");
    writeFileSync(codexFile, 'model = "gpt-6-astra"\n');
    const claudeFile = join(env.HOME, ".claude", "settings.json");

    enable("codex", ORIGIN, env);
    enable("claude", ORIGIN, env);
    enable("gemini", ORIGIN, env);
    enable("codex", ORIGIN, env); // twice is fine

    expect(readFileSync(codexFile, "utf8")).toContain("/codex/v1");
    expect(readFileSync(`${codexFile}.before-jev-gateway`, "utf8")).toBe('model = "gpt-6-astra"\n');
    expect(JSON.parse(readFileSync(claudeFile, "utf8")).env.ANTHROPIC_BASE_URL).toBe(`${ORIGIN}/claude`);
    expect(readFileSync(join(env.HOME, ".gemini", ".env"), "utf8")).toBe(`GOOGLE_GEMINI_BASE_URL=${ORIGIN}/gemini\n`);
    expect(Object.keys(readState(env)).sort()).toEqual(["claude", "codex", "gemini"]);

    for (const name of ["codex", "claude", "gemini"]) disable(name, env);
    expect(readFileSync(codexFile, "utf8")).toBe('model = "gpt-6-astra"\n');
    expect(JSON.parse(readFileSync(claudeFile, "utf8"))).toEqual({});
    expect(readFileSync(join(env.HOME, ".gemini", ".env"), "utf8").trim()).toBe("");
    expect(readState(env)).toEqual({});
    expect(disable("codex", env)).toBeUndefined();
  });

  it("refuses an OpenCode config it cannot parse rather than rewriting it", () => {
    const env = home();
    const file = join(env.HOME, ".config", "opencode", "opencode.json");
    mkdirSync(join(env.HOME, ".config", "opencode"), { recursive: true });
    writeFileSync(file, '{\n  // my notes\n  "model": "openai/gpt-5"\n}\n');
    expect(() => enable("opencode", ORIGIN, env)).toThrow();
    expect(readFileSync(file, "utf8")).toContain("// my notes");
  });
});

describe("autostart", () => {
  it("adds one managed line to a shell file and removes it cleanly", () => {
    const rc = "export PATH=$HOME/bin:$PATH\nalias ll='ls -l'\n";
    const on = enableAutostart(enableAutostart(rc));
    expect(on.match(/jev-gateway start/g)).toHaveLength(1);
    expect(on.startsWith(rc)).toBe(true);
    expect(disableAutostart(on)).toBe(rc);
  });
});

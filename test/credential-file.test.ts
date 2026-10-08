import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PROVIDERS } from "../src/jev.js";

const roots: string[] = [];
const file = (content: string) => {
  const root = mkdtempSync(join(tmpdir(), "jev-credential-"));
  roots.push(root);
  const path = join(root, "key");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("decision-provider credential files", () => {
  for (const [provider, { keyEnv }] of Object.entries(PROVIDERS)) {
    it(`detects a file-only ${provider} configuration without mutating the environment`, () => {
      const env = { [`${keyEnv}_FILE`]: file("  fixture-secret\n") };
      const config = loadConfig(env);
      expect(config.jevProvider).toBe(provider);
      expect(config.jevApiKey).toBe("fixture-secret");
      expect(env).not.toHaveProperty(keyEnv);
    });
  }

  it("honors an explicit provider and reads only its credential", () => {
    expect(
      loadConfig({
        JEV_PROVIDER: "openrouter",
        TYPESAFE_API_KEY_FILE: "/missing",
        OPENROUTER_API_KEY_FILE: file("selected"),
      }).jevApiKey,
    ).toBe("selected");
  });

  it("retains the existing provider order when several credential sources are configured", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "first", OPENROUTER_API_KEY_FILE: "/not-read" }).jevProvider).toBe(
      "typesafe",
    );
  });

  it("rejects conflicting sources for the selected provider", () => {
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: "secret-do-not-print", TYPESAFE_API_KEY_FILE: file("another-secret") }),
    ).toThrow(/TYPESAFE_API_KEY.*TYPESAFE_API_KEY_FILE/);
  });

  it("accepts a file alongside an empty environment value", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: " ", TYPESAFE_API_KEY_FILE: file("file-secret") }).jevApiKey).toBe(
      "file-secret",
    );
  });

  it("rejects missing, empty and explicitly blank file paths without exposing contents or paths", () => {
    for (const path of ["/missing-private-fixture", file("\n \t"), ""]) {
      expect(() => loadConfig({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY_FILE: path })).toThrow(
        /TYPESAFE_API_KEY_FILE/,
      );
      try {
        loadConfig({ TYPESAFE_API_KEY_FILE: path });
      } catch (error) {
        expect(String(error)).not.toContain("missing-private-fixture");
      }
    }
  });
});

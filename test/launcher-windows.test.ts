import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore: cmd-shim is used only to create real npm fixtures.
import cmdShim from "cmd-shim";

const launcher = new URL("../bin/launcher.mjs", import.meta.url).href;
const argv = ["", "two words", 'a"b', "中文", "{\"name\":\"two words\"}", "a&b", "a|b", "a^b", "%JEV_LITERAL_TEST%", "!literal!", "trailing\\", "first\nsecond"];

async function launch(kind: string, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "jev-launcher-"));
  const bin = join(dir, kind === "local" ? "node_modules/.bin" : "bin space");
  mkdirSync(bin, { recursive: true });
  const echo = join(dir, "echo.mjs");
  writeFileSync(echo, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), injected: process.env.JEV_TEST_INJECTED })); process.exit(Number(process.env.JEV_TEST_EXIT ?? 0));');
  if (kind === "other-interpreter") writeFileSync(echo, "#!/usr/bin/env python\nprint(1)");
  await cmdShim(kind === "native-shim" ? process.execPath : echo, join(bin, "fixture-client"));
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, `import { runLauncher } from ${JSON.stringify(launcher)};
    globalThis.fetch = async () => new Response(JSON.stringify({ status: "ok", upstream: "http://fixture.invalid/v1" }));
    await runLauncher({ name: "fixture-launcher", client: ${JSON.stringify(kind === "native" ? process.execPath : kind === "missing" ? "missing-fixture" : "fixture-client")},
      portEnv: "JEV_TEST_PORT", defaultPort: 1, upstream: () => "http://fixture.invalid/v1", upstreamHelp: "fixture",
      args: () => ${JSON.stringify(["native", "native-shim"].includes(kind) ? [echo, "leading argument"] : ["leading argument"])},
      env: () => ({ JEV_TEST_INJECTED: "yes" }), configHelp: () => "fixture" });`);
  try {
    return await new Promise<{code: number | null, stdout: string, stderr: string}>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...argv], { env: { ...process.env,
        HOME: dir, USERPROFILE: dir, JEV_SKIP_PROJECT_ENV: "1", JEV_TEST_PORT: "1",
        JEV_TEST_NODE: process.execPath, JEV_TEST_ECHO: echo, JEV_TEST_EXIT: String(exitCode), JEV_LITERAL_TEST: "must remain literal", PATH: bin + ";" + process.env.PATH } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (v) => stdout += v);
      child.stderr.on("data", (v) => stderr += v);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")("Windows client launch", () => {
  for (const kind of ["cmd", "local", "native-shim"]) {
    for (const code of [0, 37]) {
      it(`runs ${kind} clients with literal args and preserves exit ${code}`, async () => {
        const result = await launch(kind, code);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(code);
        expect(JSON.parse(result.stdout)).toEqual({ argv: ["leading argument", ...argv], injected: "yes" });
      });
    }
  }
  for (const kind of ["missing", "other-interpreter"]) {
    it(`reports ${kind} clients without running another interpreter`, async () => {
      const result = await launch(kind);
      expect(result.code).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("fixture-launcher: could not");
    });
  }

});

describe("native client launch", () => {
  for (const code of [0, 37]) {
    it(`forwards literal args and exit ${code} to a native executable`, async () => {
      const result = await launch("native", code);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout)).toEqual({ argv: ["leading argument", ...argv], injected: "yes" });
    });
  }
});

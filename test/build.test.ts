import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readBuildId } from "../src/build.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";

const directories: string[] = [];
const artifacts = {
  "index.js": "export const gateway = 1;",
  "index.ts": "export const gateway: number = 1;",
  "adapters/chat.js": "export const adapter = {};",
  "providers.json": '{"provider":"fixture"}',
  "dashboard.html": "<html>fixture</html>",
};

function fixture(reverse = false) {
  const directory = mkdtempSync(join(tmpdir(), "jev-build-"));
  directories.push(directory);
  const files = Object.entries(artifacts);
  for (const [name, contents] of reverse ? files.reverse() : files) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("gateway build identity", () => {
  it("identifies the same artifacts across installation paths and creation order", () => {
    const first = readBuildId(fixture());
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readBuildId(fixture(true))).toBe(first);
  });

  it.each(Object.keys(artifacts))("changes when %s changes without a package version bump", (file) => {
    const directory = fixture();
    const manifest = join(directory, "package.json");
    writeFileSync(manifest, '{"version":"0.5.0"}');
    const before = readBuildId(directory);
    writeFileSync(join(directory, file), "changed artifact");
    expect(readBuildId(directory)).not.toBe(before);
  });

  it("includes relative file names so renamed artifacts get a different identity", () => {
    const directory = fixture();
    const before = readBuildId(directory);
    renameSync(join(directory, "adapters/chat.js"), join(directory, "adapters/messages.js"));
    expect(readBuildId(directory)).not.toBe(before);
  });

  it("ignores env files and source maps when identifying the runtime artifacts", () => {
    const directory = fixture();
    const before = readBuildId(directory);
    writeFileSync(join(directory, ".env"), "PRIVATE_CREDENTIAL=secret");
    writeFileSync(join(directory, "index.js.map"), '{"sourcesContent":["PRIVATE_PROMPT"]}');
    expect(readBuildId(directory)).toBe(before);
  });

  it("keeps a running app's identity when files change until a new app loads the new build", async () => {
    const directory = fixture();
    const buildId = readBuildId(directory);
    const logged: Record<string, unknown>[] = [];
    const deps = {
      config: testConfig({ routing: false }), askJev: fakeJev({}).askJev,
      fetch: fakeUpstream().fetchImpl, log: (entry: Record<string, unknown>) => logged.push(entry),
    };
    const app = createApp({ ...deps, buildId });
    const post = (target: typeof app) => target.request("/v1/responses", { method: "POST", body: '{"model":"fixture","input":[]}' });
    await (await post(app)).text();
    writeFileSync(join(directory, "index.js"), "export const gateway = 2;");
    await (await post(app)).text();
    const nextBuildId = readBuildId(directory);
    await (await post(createApp({ ...deps, buildId: nextBuildId }))).text();
    await settled();
    expect(nextBuildId).not.toBe(buildId);
    expect(logged.map(entry => entry.gatewayBuildId)).toEqual([buildId, buildId, nextBuildId]);
  });
});

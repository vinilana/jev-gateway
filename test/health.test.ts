import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 1),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
const childProcess = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error("unexpected spawn"); }) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: filesystem.closeSync,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).startsWith("test/fixtures/status-health-home") ? false : actual.existsSync(path),
    mkdirSync: filesystem.mkdirSync,
    openSync: filesystem.openSync,
    readFileSync: actual.readFileSync,
    rmSync: filesystem.rmSync,
    writeFileSync: filesystem.writeFileSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: childProcess.spawn };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "test/fixtures/status-health-home" };
});

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  configHelp: (origin: string) => string;
}

const upstream = "https://llm.test/v1";
const spec: LauncherSpec = {
  name: "jev-health-test",
  client: "health-test",
  portEnv: "JEV_HEALTH_TEST_PORT",
  defaultPort: 54322,
  upstream: () => upstream,
  upstreamHelp: "",
  configHelp: () => "",
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let runLauncher: (launcherSpec: LauncherSpec) => Promise<void>;
let originalArgv: string[];
let output: string[];
let healthFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.stubEnv("JEV_SKIP_PROJECT_ENV", "1");
  // @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
  ({ runLauncher } = await import("../bin/launcher.mjs"));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  originalArgv = process.argv;
  process.argv = [...process.argv.slice(0, 2), "--start"];
  output = [];

  vi.stubEnv("JEV_HEALTH_TEST_PORT", "54322");
  vi.stubEnv("JEV_SKIP_PROJECT_ENV", "1");
  vi.stubEnv("JEV_PROVIDER", "");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code}) called`);
  });
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.map(String).join(" ")));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function installFetch(handler: FetchHandler): void {
  healthFetch = vi.fn(handler);
  vi.stubGlobal("fetch", healthFetch);
}

async function startWithoutKey(): Promise<string> {
  process.argv = [...process.argv.slice(0, 2), "--start"];
  await expect(runLauncher(spec)).rejects.toThrow("process.exit(1) called");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(output.join("\n")).toContain("no API key for Jev");
  return output.join("\n");
}

describe("shared launcher health validation", () => {
  it("does not treat status:error as a running gateway even when its upstream matches", async () => {
    installFetch(async () => Response.json({ status: "error", upstream }));

    await startWithoutKey();
  });

  it.each([
    ["an empty object", {}],
    ["an array", []],
    ["null", null],
  ])("rejects %s when --start checks health", async (_description, body) => {
    installFetch(async () => Response.json(body));

    await startWithoutKey();
  });

  it("rejects a successful HTTP response when its JSON is malformed", async () => {
    installFetch(async () => new Response("not-json"));

    await startWithoutKey();
  });

  it("rejects an HTTP error even when its body says status ok", async () => {
    installFetch(async () => Response.json({ status: "ok", upstream }, { status: 503 }));

    await startWithoutKey();
  });

  it("rejects health when the connection is refused", async () => {
    installFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });

    await startWithoutKey();
  });

  it("accepts status:ok with the expected upstream when --start checks health", async () => {
    installFetch(async () => Response.json({ status: "ok", upstream }));

    process.argv = [...process.argv.slice(0, 2), "--start"];
    await runLauncher(spec);

    expect(process.exit).not.toHaveBeenCalled();
    expect(healthFetch).toHaveBeenCalledTimes(1);
    expect(String(healthFetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:54322/health");
    expect(output.join("\n")).toContain("router up on http://127.0.0.1:54322");
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty object", {}],
    ["an array", []],
    ["null", null],
    ["an error status", { status: "error", pid: 424242 }],
  ])("does not kill a PID from %s when --stop checks health", async (_description, body) => {
    installFetch(async () => Response.json(body));
    process.argv = [...process.argv.slice(0, 2), "--stop"];

    await runLauncher(spec);

    expect(process.kill).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("no router was running");
    expect(filesystem.rmSync).toHaveBeenCalledTimes(2);
  });

  it("does not kill a PID from an HTTP error even when its body says status ok", async () => {
    installFetch(async () => Response.json({ status: "ok", pid: 424242 }, { status: 503 }));
    process.argv = [...process.argv.slice(0, 2), "--stop"];

    await runLauncher(spec);

    expect(process.kill).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("no router was running");
  });

  it("does not kill a PID when a successful response contains malformed JSON", async () => {
    installFetch(async () => new Response("not-json"));
    process.argv = [...process.argv.slice(0, 2), "--stop"];

    await runLauncher(spec);

    expect(process.kill).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("no router was running");
  });

  it("does not kill a PID when the health connection is refused", async () => {
    installFetch(async () => { throw new Error("ECONNREFUSED"); });
    process.argv = [...process.argv.slice(0, 2), "--stop"];

    await runLauncher(spec);

    expect(process.kill).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("no router was running");
  });

  it("accepts status:ok with a PID when --stop checks health", async () => {
    installFetch(async () => Response.json({ status: "ok", pid: 424242 }));
    process.argv = [...process.argv.slice(0, 2), "--stop"];

    await runLauncher(spec);

    expect(process.kill).toHaveBeenCalledWith(424242);
    expect(output.join("\n")).toContain("stopped router (pid 424242)");
    expect(filesystem.rmSync).toHaveBeenCalledTimes(2);
  });
});

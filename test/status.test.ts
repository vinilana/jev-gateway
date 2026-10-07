import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createAskJev } from "../src/jev.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "test/fixtures/status-home" };
});

interface LauncherSpec {
  name: string;
  client: string;
  portEnv: string;
  defaultPort: number;
  upstream: () => string;
  upstreamHelp: string;
  configHelp: (origin: string) => string;
  notices?: (origin: string, argv: string[]) => Promise<string[]>;
}

const spec: LauncherSpec = {
  name: "jev-status-test",
  client: "status-test",
  portEnv: "JEV_STATUS_TEST_PORT",
  defaultPort: 54321,
  upstream: () => "https://llm.test/v1",
  upstreamHelp: "",
  configHelp: () => "",
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let runLauncher: (launcherSpec: LauncherSpec) => Promise<void>;
let originalArgv: string[];
let output: string[];
let statusFetch: ReturnType<typeof vi.fn>;
let providerFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  // launcher.mjs captures its env-file paths at import time; keep both paths inside test fixtures.
  vi.stubEnv("JEV_SKIP_PROJECT_ENV", "1");
  // @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
  ({ runLauncher } = await import("../bin/launcher.mjs"));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  originalArgv = process.argv;
  process.argv = [...process.argv.slice(0, 2), "--status"];
  output = [];
  providerFetch = vi.fn(async () => Response.json({}));

  vi.stubEnv("JEV_STATUS_TEST_PORT", "54321");
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
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.map(String).join(" ")));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function installFetch(handler: FetchHandler): void {
  statusFetch = vi.fn(handler);
  vi.stubGlobal("fetch", statusFetch);
}

function installAppFetch(app: ReturnType<typeof createApp>): void {
  installFetch(async (input, init) => app.request(String(input), init));
}

async function runStatus(launcherSpec: LauncherSpec = spec): Promise<string> {
  await runLauncher(launcherSpec);
  expect(process.exit).not.toHaveBeenCalled();
  expect(statusFetch).toHaveBeenCalledTimes(1);
  expect(String(statusFetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:54321/health");
  // --status reads only the local health endpoint; it never probes Jev with a provider key.
  expect(providerFetch).not.toHaveBeenCalled();
  return output.join("\n");
}

const isNotRunning = (text: string) => expect(text).not.toContain("not running");

describe("--status", () => {
  it("accepts a complete healthy response and reports the server's Jev provider", async () => {
    installFetch(async () => Response.json({
      status: "ok",
      pid: 123,
      upstream: "https://server-a.test/v1",
      jev: "typesafe",
    }));

    const text = await runStatus();

    expect(text).toContain("router up on http://127.0.0.1:54321");
    expect(text).toContain("https://server-a.test/v1");
    expect(text).toContain("server Jev provider: TypeSafe");
    expect(text).toContain("CLI key: none configured for the local provider, run `jev-status-test --setup`");
    expect(text).not.toContain("Jev authentication:");
  });

  it("passes status arguments to notices and prints them on a healthy response", async () => {
    installFetch(async () => Response.json({ status: "ok" }));
    process.argv = [...process.argv.slice(0, 2), "--status", "--model", "custom/model"];
    const notices = vi.fn(async (_origin: string, argv: string[]) => [`received ${argv.join(" ")}`, "another notice"]);

    const text = await runStatus({ ...spec, notices });

    expect(notices).toHaveBeenCalledWith("http://127.0.0.1:54321", ["--model", "custom/model"]);
    expect(text).toContain("jev-status-test: received --model custom/model");
    expect(text).toContain("another notice");
  });

  it("prints notices when health cannot be confirmed", async () => {
    installFetch(async () => { throw new Error("ECONNREFUSED"); });
    const notices = vi.fn(async (_origin: string, _argv: string[]) => ["gateway settings remain available"]);

    const text = await runStatus({ ...spec, notices });

    expect(text).toContain("jev-status-test: gateway settings remain available");
  });

  it("accepts the minimal healthy response used by a server with its own router key", async () => {
    const config = loadConfig({
      ROUTER_API_KEY: "server-router-fixture",
      UPSTREAM_API_KEY: "server-upstream-fixture",
      JEV_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "server-jev-fixture",
    });
    const app = createApp({ config, askJev: async () => { throw new Error("health must not ask Jev"); } });
    installAppFetch(app);

    const text = await runStatus();

    expect(text).toContain("router up on http://127.0.0.1:54321");
    expect(text).toContain("CLI key: none configured for the local provider, run `jev-status-test --setup`");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("server-router-fixture");
    expect(text).not.toContain("server-jev-fixture");
  });

  it.each([
    ["an empty object", {}],
    ["an array", []],
    ["null", null],
    ["an error status", { status: "error" }],
  ])("does not treat %s as a healthy response", async (_description, body) => {
    installFetch(async () => Response.json(body));

    const text = await runStatus();

    expect(text).toContain("health not confirmed on http://127.0.0.1:54321");
    expect(text).toContain("invalid health response");
    isNotRunning(text);
  });

  it.each([401, 503])("reports HTTP %s even when the error body says status ok", async (status) => {
    installFetch(async () => Response.json({ status: "ok" }, { status }));

    const text = await runStatus();

    expect(text).toContain("health not confirmed on http://127.0.0.1:54321");
    expect(text).toContain(`HTTP ${status}`);
    isNotRunning(text);
  });

  it("reports invalid JSON separately from an invalid health body", async () => {
    installFetch(async () => new Response("not-json"));

    const text = await runStatus();

    expect(text).toContain("health not confirmed on http://127.0.0.1:54321");
    expect(text).toContain("invalid JSON response");
    isNotRunning(text);
  });

  it.each([
    ["a timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
    ["an aborted request", Object.assign(new Error("request aborted"), { name: "AbortError" })],
  ])("reports %s without claiming the router is stopped", async (_description, error) => {
    installFetch(async () => { throw error; });

    const text = await runStatus();

    expect(text).toContain("health not confirmed on http://127.0.0.1:54321");
    expect(text).toContain("request timed out");
    isNotRunning(text);
  });

  it.each([
    ["a cause code", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    ["a direct code", Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })],
  ])("reports that the router is not running when connection refusal has %s", async (_description, error) => {
    installFetch(async () => { throw error; });

    const text = await runStatus();

    expect(text).toContain("jev-status-test: router is not running");
    expect(text).not.toContain("health not confirmed");
  });

  it("reports a timeout while reading a successful response body", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(timeout) });
    installFetch(async () => new Response(body));

    const text = await runStatus();

    expect(text).toContain("health not confirmed on http://127.0.0.1:54321");
    expect(text).toContain("request timed out");
    isNotRunning(text);
  });

  it("does not print details from an unknown fetch failure", async () => {
    installFetch(async () => {
      throw Object.assign(new TypeError("fetch failed: secret-fixture-detail"), {
        cause: new Error("secret-fixture-detail"),
      });
    });

    const text = await runStatus();

    expect(text).toContain("connection failed");
    expect(text).not.toContain("secret-fixture-detail");
  });

  it("reports local key presence without checking its validity", async () => {
    installFetch(async () => Response.json({ status: "ok" }));
    vi.stubEnv("JEV_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "invalid-fixture-key");

    const text = await runStatus();

    expect(text).toContain("CLI key: OpenRouter");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).toContain("CLI key: OpenRouter (OPENROUTER_API_KEY)");
    expect(text).not.toContain("validity not checked");
    expect(text).not.toContain("invalid-fixture-key");
    expect(text).not.toContain("Jev authentication:");
  });

  it("does not report another provider's key as configured for the selected local provider", async () => {
    installFetch(async () => Response.json({ status: "ok", upstream: "https://server.test/v1", jev: "typesafe" }));
    vi.stubEnv("JEV_PROVIDER", "openrouter");
    vi.stubEnv("TYPESAFE_API_KEY", "typesafe-only-fixture-key");

    const text = await runStatus();

    expect(text).toContain("CLI key: none configured for the local provider, run `jev-status-test --setup`");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(text).not.toContain("typesafe-only-fixture-key");
  });

  it("shows a server provider independently from a different CLI provider", async () => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: "https://server-a.test/v1",
      JEV_PROVIDER: "typesafe",
      TYPESAFE_API_KEY: "server-a-fixture-key",
    });
    const app = createApp({ config, askJev: async () => { throw new Error("health must not ask Jev"); } });
    installAppFetch(app);
    vi.stubEnv("JEV_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "cli-b-fixture-key");

    const text = await runStatus();

    expect(text).toContain("server Jev provider: TypeSafe");
    expect(text).toContain("CLI key: OpenRouter");
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(text).not.toContain("cli-b-fixture-key");
  });

  it("keeps the server's provider separate from the CLI's key and never probes it", async () => {
    const config = loadConfig({
      UPSTREAM_BASE_URL: "https://server-a.test/v1",
      JEV_PROVIDER: "typesafe",
      TYPESAFE_API_KEY: "server-a-fixture-key",
    });
    const askJev = createAskJev(config, providerFetch as unknown as typeof fetch);
    const app = createApp({ config, askJev });
    installAppFetch(app);
    vi.stubEnv("JEV_PROVIDER", "typesafe");
    vi.stubEnv("TYPESAFE_API_KEY", "cli-b-fixture-key");

    const text = await runStatus();

    expect(text).toContain("server Jev provider: TypeSafe");
    expect(text).toContain("CLI key: TypeSafe");
    expect(text).toContain("TYPESAFE_API_KEY");
    expect(text).not.toContain("cli-b-fixture-key");

    let authorizationMatchedServerKey = false;
    providerFetch.mockImplementation(async (_input, init) => {
      authorizationMatchedServerKey =
        new Headers(init?.headers).get("authorization") === "Bearer server-a-fixture-key";
      return Response.json({
        model: "m",
        answers: { tool: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } },
        usage: { input_tokens: 10, output_tokens: 0 },
      });
    });
    await askJev({
      model: "m",
      state: "s",
      questions: { tool: { type: "choice", instructions: "?", criteria: { a: null, b: null } } },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(authorizationMatchedServerKey).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const globTool = {
  type: "function",
  function: {
    name: "glob",
    description: "Find files by pattern",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
};

const kiloRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5",
  max_tokens: 32000,
  messages: [
    { role: "system", content: "You are Kilo, a software engineer." },
    { role: "user", content: "list the files here" },
  ],
  tools: [bashTool, globTool],
  tool_choice: "auto",
  stream: true,
  stream_options: { include_usage: true },
  ...extra,
});

function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream };
}

describe("kilo chat completions", () => {
  it("offers Kilo's function tools to Jev", async () => {
    const { post, jev } = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    await post(kiloRequest());

    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.assistant_instructions).toContain("Kilo");
    expect(questions.tool.type === "choice" && Object.keys(questions.tool.criteria)).toEqual(["bash", "glob", NO_TOOL]);
  });

  it("forces the tool Jev picked", async () => {
    const { post, upstream } = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    const body = kiloRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "glob" } });
  });

  it("sets tool_choice none when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const res = await post(kiloRequest());

    expect(res.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(upstream.calls[0]!.body.tool_choice).toBe("none");
  });
});

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

const kilo = clients.kilo as LauncherSpec;
const others = [clients.codex, clients.claude, clients.opencode, clients.gemini, clients.devin] as LauncherSpec[];
const origin = "http://127.0.0.1:8785";
const launcherBin = fileURLToPath(new URL("../bin/jev-kilo.mjs", import.meta.url));

const managedEnv = ["JEV_KILO_UPSTREAM_BASE_URL", "JEV_KILO_MODEL"] as const;
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

const inlineConfig = () => JSON.parse(kilo.env!(origin).KILO_CONFIG_CONTENT as string) as any;

describe("jev-kilo spec", () => {
  it("identifies itself as the kilo launcher on its own port", () => {
    expect(kilo.name).toBe("jev-kilo");
    expect(kilo.client).toBe("kilo");
    expect(kilo.portEnv).toBe("JEV_KILO_PORT");
    expect(kilo.defaultPort).toBe(8785);
    expect(others.map((spec) => spec.defaultPort)).not.toContain(kilo.defaultPort);
  });

  it("defaults upstream to Kilo Gateway with override support", () => {
    expect(kilo.upstream()).toBe("https://api.kilo.ai/api/openrouter");
    process.env.JEV_KILO_UPSTREAM_BASE_URL = "http://127.0.0.1:8795/v1";
    expect(kilo.upstream()).toBe("http://127.0.0.1:8795/v1");
  });

  it("selects jev-gateway/<model> by default with override support", () => {
    expect(inlineConfig().model).toBe("jev-gateway/kilo-auto/free");
    process.env.JEV_KILO_MODEL = "jevonian/auto";
    expect(inlineConfig().model).toBe("jev-gateway/jevonian/auto");
  });

  it("prints config help", () => {
    const help = kilo.configHelp(origin);
    expect(help).toContain("jev-kilo --start");
    expect(help).toContain("kilo.json");
  });
});

describe("jev-kilo entrypoint", () => {
  it("is registered in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-kilo"]).toBe("bin/jev-kilo.mjs");
    expect(pkg.scripts.kilo).toBe("node bin/jev-kilo.mjs");
  });

  it("--print-config prints config without starting", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("http://127.0.0.1:8785/v1");
  });
});

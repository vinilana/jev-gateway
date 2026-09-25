import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const clients = await import("../bin/clients.mjs");

const runCmdTool = {
  type: "function",
  function: {
    name: "run_command",
    description: "Run a terminal command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const qwenRequest = (extra: Record<string, unknown> = {}) => ({
  model: "qwen-plus",
  messages: [
    { role: "system", content: "You are Qwen Code, a helpful AI coding assistant." },
    { role: "user", content: "Check git status" },
  ],
  tools: [runCmdTool],
  tool_choice: "auto",
  stream: true,
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

describe("qwen chat completions", () => {
  it("offers Qwen's function tools to Jev", async () => {
    const { post, jev } = setup({ tool: { choice: "run_command" }, needs_tool: { noul: 0.95 } });
    await post(qwenRequest());

    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.assistant_instructions).toContain("Qwen");
    expect(questions.tool.type === "choice" && Object.keys(questions.tool.criteria)).toEqual(["run_command", NO_TOOL]);
  });

  it("forces the tool Jev picked", async () => {
    const { post, upstream } = setup({ tool: { choice: "run_command" }, needs_tool: { noul: 0.95 } });
    const body = qwenRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "run_command" } });
  });

  it("sets tool_choice none when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const res = await post(qwenRequest());

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

const qwen = clients.qwen as LauncherSpec;
const others = [clients.codex, clients.claude, clients.opencode, clients.gemini, clients.devin, clients.kilo] as LauncherSpec[];
const origin = "http://127.0.0.1:8787";
const launcherBin = fileURLToPath(new URL("../bin/jev-qwen.mjs", import.meta.url));

const managedEnv = ["JEV_QWEN_UPSTREAM_BASE_URL", "JEV_QWEN_MODEL"] as const;
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

describe("jev-qwen spec", () => {
  it("identifies itself as the qwen launcher on its own port", () => {
    expect(qwen.name).toBe("jev-qwen");
    expect(qwen.client).toBe("qwen");
    expect(qwen.portEnv).toBe("JEV_QWEN_PORT");
    expect(qwen.defaultPort).toBe(8787);
    expect(others.map((spec) => spec.defaultPort)).not.toContain(qwen.defaultPort);
  });

  it("defaults upstream to DashScope with override support", () => {
    expect(qwen.upstream()).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    process.env.JEV_QWEN_UPSTREAM_BASE_URL = "http://127.0.0.1:8793/v1";
    expect(qwen.upstream()).toBe("http://127.0.0.1:8793/v1");
  });

  it("configures cli arguments pointing to the gateway endpoint", () => {
    const args = qwen.args!(origin);
    expect(args).toContain("--auth-type");
    expect(args).toContain("openai");
    expect(args).toContain("--openai-base-url");
    expect(args).toContain(`${origin}/v1`);
    expect(args).toContain("-m");
    expect(args).toContain("qwen-plus");
  });

  it("allows overriding model via JEV_QWEN_MODEL", () => {
    process.env.JEV_QWEN_MODEL = "jevonian/auto";
    const args = qwen.args!(origin);
    expect(args).toContain("jevonian/auto");
  });

  it("prints config help", () => {
    const help = qwen.configHelp(origin);
    expect(help).toContain("jev-qwen --start");
    expect(help).toContain(`${origin}/v1`);
  });
});

describe("jev-qwen entrypoint", () => {
  it("is registered in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-qwen"]).toBe("bin/jev-qwen.mjs");
    expect(pkg.scripts.qwen).toBe("node bin/jev-qwen.mjs");
  });

  it("--print-config prints config without starting", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("http://127.0.0.1:8787/v1");
  });
});

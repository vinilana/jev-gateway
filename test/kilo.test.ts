import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const clientsModule: string = "../bin/clients.mjs";
const clients = await import(clientsModule);


const globTool = {
  type: "function",
  function: {
    name: "glob",
    description: "Fast file pattern matching tool that works with any codebase size.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: { description: "The glob pattern to match files against", type: "string" },
        path: { description: "The directory to search in.", type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Executes a given bash command in a persistent shell session.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { description: "The command to execute", type: "string" },
        timeout: { description: "Optional timeout in milliseconds", type: "number" },
        workdir: { description: "The working directory to run the command in.", type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const kiloRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5",
  max_tokens: 32000,
  reasoningSummary: "auto",
  reasoning_effort: "medium",
  messages: [
    { role: "system", content: "You are Kilo, a highly skilled software engineer. (shortened stand-in)" },
    { role: "user", content: '"list the files here"\n' },
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

describe("kilo chat completions (@ai-sdk/openai-compatible)", () => {
  it("offers Kilo's function tools to Jev", async () => {
    const { post, jev } = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    await post(kiloRequest());

    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.assistant_instructions).toContain("Kilo");
    expect(questions.tool.type === "choice" && Object.keys(questions.tool.criteria)).toEqual(["bash", "glob", NO_TOOL]);
  });

  it("forces the tool Jev picked and keeps Kilo's own fields, reasoningSummary included", async () => {
    const { post, upstream } = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    const body = kiloRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    const sent = upstream.calls[0]!.body;
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "glob" } });
    expect(sent.reasoningSummary).toBe("auto");
    expect(sent.reasoning_effort).toBe("medium");
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.messages).toEqual(body.messages);
  });

  it("sets tool_choice none when Jev is confident no tool is needed", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const res = await post(kiloRequest());

    expect(res.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(upstream.calls[0]!.body.tool_choice).toBe("none");
  });

  it("forwards no credential when Kilo sent none, and the user's key untouched when it did", async () => {
    const anonymous = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    await anonymous.post(kiloRequest());
    expect(anonymous.upstream.calls[0]!.headers.get("authorization")).toBeNull();

    const signedIn = setup({ tool: { choice: "glob" }, needs_tool: { noul: 0.9 } });
    await signedIn.post(kiloRequest(), { authorization: "Bearer kilo-user-key" });
    expect(signedIn.upstream.calls[0]!.headers.get("authorization")).toBe("Bearer kilo-user-key");
  });

  it("passes the title request, which has no tools, through without asking Jev", async () => {
    const { post, jev, upstream } = setup({});
    const { tools: _tools, tool_choice: _choice, reasoningSummary: _summary, reasoning_effort: _effort, ...title } = kiloRequest();
    const res = await post(title);

    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_tools");
    expect(upstream.calls[0]!.body).toEqual(title);
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
const others = [clients.codex, clients.claude, clients.opencode, clients.gemini] as LauncherSpec[];
const origin = "http://127.0.0.1:8793";
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
  it("identifies itself as the kilo launcher on a port no other launcher uses", () => {
    expect(kilo.name).toBe("jev-kilo");
    expect(kilo.client).toBe("kilo");
    expect(kilo.portEnv).toBe("JEV_KILO_PORT");
    expect(kilo.defaultPort).toBe(8793);
    expect(others.map((spec) => spec.defaultPort)).not.toContain(kilo.defaultPort);
  });

  it("defaults upstream to the Kilo Gateway with a JEV_KILO_UPSTREAM_BASE_URL override", () => {
    expect(kilo.upstream()).toBe("https://api.kilo.ai/api/openrouter");
    process.env.JEV_KILO_UPSTREAM_BASE_URL = "https://llm.test/v1";
    expect(kilo.upstream()).toBe("https://llm.test/v1");
    expect(kilo.upstreamHelp).toContain("JEV_KILO_UPSTREAM_BASE_URL");
  });

  it("selects jev-gateway/<model> by default with a JEV_KILO_MODEL override", () => {
    expect(inlineConfig().model).toBe("jev-gateway/kilo-auto/free");
    expect(inlineConfig().small_model).toBe("jev-gateway/kilo-auto/free");
    process.env.JEV_KILO_MODEL = "anthropic/claude-sonnet-4";
    expect(inlineConfig().model).toBe("jev-gateway/anthropic/claude-sonnet-4");
    expect(Object.keys(inlineConfig().provider["jev-gateway"].models)).toEqual(["anthropic/claude-sonnet-4"]);
  });

  it("injects a chat-completions provider through KILO_CONFIG_CONTENT, keyed by the user's own Kilo key", () => {
    const env = kilo.env!(origin);
    expect(Object.keys(env)).toEqual(["KILO_CONFIG_CONTENT"]);
    const provider = inlineConfig().provider["jev-gateway"];
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(`${origin}/v1`);
    expect(provider.options.apiKey).toBe("{env:KILO_API_KEY}");
    expect(JSON.stringify(inlineConfig()).toLowerCase()).not.toContain("typesafe");
  });

  it("adds no leading client args, so a user -m keeps priority", () => {
    expect(kilo.args).toBeUndefined();
  });

  it("prints permanent wiring help whose JSON parses as-is", () => {
    const help = kilo.configHelp(origin);
    expect(help).toContain("jev-kilo --start");
    expect(help).toContain("kilo.jsonc");
    expect(help).toContain("--model jev-gateway/kilo-auto/free");
    const parsed = JSON.parse(help.slice(help.indexOf("{"), help.lastIndexOf("}") + 1)) as any;
    expect(parsed.provider["jev-gateway"].options.baseURL).toBe(`${origin}/v1`);
  });
});

describe("jev-kilo entrypoint", () => {
  it("is registered in package.json with a runnable script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    expect(pkg.bin["jev-kilo"]).toBe("bin/jev-kilo.mjs");
    expect(pkg.scripts.kilo).toBe("node bin/jev-kilo.mjs");
  });

  it("--print-config prints the gateway-rooted provider config without starting anything", () => {
    const out = execFileSync(process.execPath, [launcherBin, "--print-config"], { encoding: "utf8", timeout: 30_000 });
    expect(out).toContain("http://127.0.0.1:8793/v1");
    expect(out).toContain("{env:KILO_API_KEY}");
  });
});

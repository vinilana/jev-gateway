import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIRO_CHAT_TARGET } from "../src/adapters/kiro.js";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const clientsModule: string = "../bin/clients.mjs";
const clients = await import(clientsModule);


const executeBash = {
  toolSpecification: {
    name: "execute_bash",
    description: "Execute the specified bash command.",
    inputSchema: {
      json: {
        type: "object",
        required: ["command"],
        properties: {
          command: { description: "Bash command to execute", type: "string" },
          summary: { description: "A brief explanation of what the command does", type: "string" },
        },
      },
    },
  },
};

const fsRead = {
  toolSpecification: {
    name: "fs_read",
    description: "Tool for reading files, directories and images.",
    inputSchema: { json: { type: "object", required: ["operations"], properties: { operations: { type: "array" } } } },
  },
};

const session = {
  toolSpecification: {
    name: "session",
    description: "Manage the session.",
    inputSchema: { json: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["clear", "compact"] } } } },
  },
};

const context = "--- CONTEXT ENTRY BEGIN ---\nCurrent time: Tuesday, 2026-09-22T22:54:31.837-03:00\n--- CONTEXT ENTRY END ---\n\n";
const typed = (text: string) => `${context}--- USER MESSAGE BEGIN ---\n${text}--- USER MESSAGE END ---`;

const userMessage = (content: string, extra: Record<string, unknown> = {}) => ({
  userInputMessage: {
    content,
    userInputMessageContext: { envState: { operatingSystem: "linux", currentWorkingDirectory: "/work" }, tools: [executeBash, fsRead], ...extra },
    origin: "KIRO_CLI",
    modelId: "auto",
  },
});

const kiroRequest = (current = userMessage(typed("list the files here")), history: unknown[] = []) => ({
  conversationState: {
    conversationId: "89ca6671-ed20-4b96-b382-f3fc4d7e40cb",
    history: [
      { userInputMessage: { content: "--- CONTEXT ENTRY BEGIN ---\n--- CONTEXT ENTRY END ---\n\nFollow this instruction", origin: "KIRO_CLI", modelId: "auto" } },
      { assistantResponseMessage: { content: "I will fully incorporate this information." } },
      ...history,
    ],
    currentMessage: current,
    chatTriggerType: "MANUAL",
    agentContinuationId: "8aa466bc-a089-4a50-a2a9-dd27dc831c45",
    agentTaskType: "vibe",
  },
  profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/TEST",
});

const toolResultTurn = () =>
  kiroRequest(userMessage("", { toolResults: [{ toolUseId: "toolu_1", content: [{ text: "# Total entries: 1\n\na.txt" }], status: "success" }] }), [
    { userInputMessage: { content: typed("list the files here"), origin: "KIRO_CLI", modelId: "auto" } },
    {
      assistantResponseMessage: {
        messageId: "1f0e3843",
        content: "I'll list the files in the current directory.",
        toolUses: [{ toolUseId: "toolu_1", name: "fs_read", input: { operations: [{ path: "/work", mode: "Directory" }] } }],
      },
    },
  ]);

function setup(canned: Parameters<typeof fakeJev>[0], askJev?: Parameters<typeof createApp>[0]["askJev"]) {
  const jev = fakeJev(canned);
  const upstream = fakeUpstream();
  const app = createApp({ config: testConfig({ upstreamBaseUrl: "https://q.test" }), askJev: askJev ?? jev.askJev, fetch: upstream.fetchImpl });
  const post = (body: unknown, target: string | null = KIRO_CHAT_TARGET) =>
    app.request("/?origin=KIRO_CLI", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        authorization: "Bearer kiro-token",
        ...(target ? { "x-amz-target": target } : {}),
      },
      body: JSON.stringify(body),
    });
  return { post, jev, upstream };
}

describe("kiro GenerateAssistantResponse", () => {
  it("offers Kiro's tools to Jev with the typed text, not the context entries", async () => {
    const { post, jev } = setup({ tool: { choice: "execute_bash" }, needs_tool: { noul: 0.9 } });
    await post(kiroRequest());

    const { state, questions } = jev.requests[0]! as { state: any; questions: any };
    expect(state.conversation.at(-1)).toEqual({ role: "user", text: "list the files here" });
    expect(JSON.stringify(state)).not.toContain("Current time");
    expect(Object.keys(questions.tool.criteria)).toEqual(["execute_bash", "fs_read", NO_TOOL]);
  });

  it("reads tool calls and their results back as turns, by name", async () => {
    const { post, jev } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.1 } });
    await post(toolResultTurn());

    const conversation = (jev.requests[0]!.state as any).conversation;
    expect(conversation.slice(-3)).toEqual([
      { role: "assistant", text: "I'll list the files in the current directory." },
      { role: "assistant", tool_calls: [{ tool: "fs_read", arguments: '{"operations":[{"path":"/work","mode":"Directory"}]}' }] },
      { role: "tool_result", tool: "fs_read", content: "# Total entries: 1\n\na.txt" },
    ]);
  });

  it("appends a hint after the current message and leaves everything else as sent", async () => {
    const { post, upstream } = setup({ tool: { choice: "execute_bash" }, needs_tool: { noul: 0.9 } });
    const body = kiroRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(res.headers.get("x-jev-gateway-tool")).toBe("execute_bash");
    const sent = upstream.calls[0]!.body;
    const content: string = sent.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith(body.conversationState.currentMessage.userInputMessage.content)).toBe(true);
    expect(content).toMatch(/suggests the "execute_bash" tool[^]*<\/system-reminder>$/);
    const { content: _content, ...restSent } = sent.conversationState.currentMessage.userInputMessage;
    const { content: _original, ...restOriginal } = body.conversationState.currentMessage.userInputMessage;
    expect(restSent).toEqual(restOriginal);
    expect({ ...sent.conversationState, currentMessage: undefined }).toEqual({ ...body.conversationState, currentMessage: undefined });
    expect(sent.profileArn).toBe(body.profileArn);
  });

  it("puts the hint alone into a tool-result turn, which carries no text", async () => {
    const { post, upstream } = setup({ tool: { choice: "execute_bash" }, needs_tool: { noul: 0.9 } });
    await post(toolResultTurn());

    const current = upstream.calls[0]!.body.conversationState.currentMessage.userInputMessage;
    expect(current.content).toMatch(/^<system-reminder>/);
    expect(current.userInputMessageContext.toolResults).toHaveLength(1);
  });

  it("never asks Jev for arguments, since it cannot answer in Kiro's place", async () => {
    const body = kiroRequest(userMessage(typed("compact the session"), { tools: [executeBash, session] }));
    const { post, jev, upstream } = setup({ tool: { choice: "session" }, needs_tool: { noul: 0.95 } });
    const res = await post(body);

    expect(Object.keys(jev.requests[0]!.questions)).toEqual(["tool", "needs_tool"]);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(upstream.calls).toHaveLength(1);
  });

  it("hints a tool that takes no arguments instead of trying to answer for it", async () => {
    const noArgs = { toolSpecification: { name: "introspect", description: "Describe Kiro itself.", inputSchema: { json: { type: "object", properties: {} } } } };
    const body = kiroRequest(userMessage(typed("what can you do?"), { tools: [executeBash, noArgs] }));
    const { post, upstream } = setup({ tool: { choice: "introspect" }, needs_tool: { noul: 0.95 } });
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("hint");
    expect(upstream.calls[0]!.body.conversationState.currentMessage.userInputMessage.content).toContain('"introspect"');
  });

  it("forwards untouched when Jev finds no tool is needed, since a hint cannot ask for silence", async () => {
    const { post, upstream } = setup({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const body = kiroRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-reason")).toBe("no_tool_needed");
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("forwards untouched when Jev fails", async () => {
    const { post, upstream } = setup({}, async () => {
      throw new Error("jev down");
    });
    const body = kiroRequest();
    const res = await post(body);

    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("sends the call to the upstream's root with the query and Kiro's own token", async () => {
    const { post, upstream } = setup({ tool: { choice: "execute_bash" }, needs_tool: { noul: 0.9 } });
    await post(kiroRequest());

    expect(upstream.calls[0]!.url).toBe("https://q.test/?origin=KIRO_CLI");
    expect(upstream.calls[0]!.headers.get("authorization")).toBe("Bearer kiro-token");
    expect(upstream.calls[0]!.headers.get("x-amz-target")).toBe(KIRO_CHAT_TARGET);
  });

  it("proxies Kiro's other operations without asking Jev", async () => {
    const { post, jev, upstream } = setup({});
    const body = { origin: "KIRO_CLI", profileArn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/TEST" };
    const res = await post(body, "AmazonCodeWhispererService.ListAvailableModels");

    expect(res.status).toBe(200);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls[0]!.url).toBe("https://q.test/?origin=KIRO_CLI");
    expect(upstream.calls[0]!.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
  });

  it("does not forward a POST to / that names no operation", async () => {
    const { post, upstream } = setup({});
    const res = await post(kiroRequest(), null);

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
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

const kiro = clients.kiro as LauncherSpec;
const others = [clients.codex, clients.claude, clients.opencode, clients.gemini] as LauncherSpec[];
const origin = "http://127.0.0.1:8793";

describe("jev-kiro spec", () => {
  const saved = {
    HOME: process.env.HOME,
    BASH_ENV: process.env.BASH_ENV,
    JEV_KIRO_REGION: process.env.JEV_KIRO_REGION,
    JEV_KIRO_UPSTREAM_BASE_URL: process.env.JEV_KIRO_UPSTREAM_BASE_URL,
  };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jev-kiro-"));
    process.env.HOME = home;
    delete process.env.BASH_ENV;
    delete process.env.JEV_KIRO_REGION;
    delete process.env.JEV_KIRO_UPSTREAM_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const userSettings = () => {
    mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
    mkdirSync(join(home, ".kiro", "agents"));
    writeFileSync(join(home, ".kiro", "settings", "cli.json"), JSON.stringify({ "chat.defaultModel": "claude-sonnet-4" }));
    writeFileSync(join(home, ".kiro", "settings", "mcp.json"), "{}");
    writeFileSync(join(home, ".gitconfig"), "[user]\n");
  };

  it("runs kiro-cli on a port no other launcher uses", () => {
    expect(kiro.name).toBe("jev-kiro");
    expect(kiro.client).toBe("kiro-cli");
    expect(kiro.defaultPort).toBe(8793);
    expect(others.map((spec) => spec.defaultPort)).not.toContain(kiro.defaultPort);
    expect(kiro.args).toBeUndefined();
  });

  it("forwards to the regional Kiro API, with overrides", () => {
    expect(kiro.upstream()).toBe("https://q.us-east-1.amazonaws.com");
    process.env.JEV_KIRO_REGION = "eu-central-1";
    expect(kiro.upstream()).toBe("https://q.eu-central-1.amazonaws.com");
    process.env.JEV_KIRO_UPSTREAM_BASE_URL = "https://kiro.test";
    expect(kiro.upstream()).toBe("https://kiro.test");
  });

  it("points Kiro at the gateway from a home of its own, leaving the user's settings as they were", () => {
    userSettings();
    const before = readFileSync(join(home, ".kiro", "settings", "cli.json"), "utf8");
    const env = kiro.env!(origin);

    expect(Object.keys(env)).toEqual(["HOME", "BASH_ENV"]);
    const own = env.HOME!;
    expect(own).toBe(join(home, ".jev-gateway", "kiro-home"));
    const cli = JSON.parse(readFileSync(join(own, ".kiro", "settings", "cli.json"), "utf8"));
    expect(cli).toEqual({ "chat.defaultModel": "claude-sonnet-4", "api.codewhisperer.service": { endpoint: origin, region: "us-east-1" } });
    expect(readFileSync(join(home, ".kiro", "settings", "cli.json"), "utf8")).toBe(before);
    expect(readlinkSync(join(own, ".gitconfig"))).toBe(join(home, ".gitconfig"));
    expect(readlinkSync(join(own, ".kiro", "agents"))).toBe(join(home, ".kiro", "agents"));
    expect(readlinkSync(join(own, ".kiro", "settings", "mcp.json"))).toBe(join(home, ".kiro", "settings", "mcp.json"));
    expect(lstatSync(join(own, ".kiro", "settings", "cli.json")).isSymbolicLink()).toBe(false);
  });

  it("follows the real home on the next launch: new entries appear, removed ones go", () => {
    userSettings();
    kiro.env!(origin);
    writeFileSync(join(home, ".npmrc"), "");
    rmSync(join(home, ".gitconfig"));
    const own = kiro.env!(origin).HOME!;

    expect(readlinkSync(join(own, ".npmrc"))).toBe(join(home, ".npmrc"));
    expect(() => lstatSync(join(own, ".gitconfig"))).toThrow();
  });

  it("gives the commands Kiro runs the real home back, keeping any BASH_ENV of the user's", () => {
    writeFileSync(join(home, "mine.sh"), "export FROM_USER_BASH_ENV=yes\n");
    process.env.BASH_ENV = join(home, "mine.sh");
    const env = kiro.env!(origin);
    const out = execFileSync("bash", ["-c", 'echo "$HOME|$FROM_USER_BASH_ENV"'], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(out.trim()).toBe(`${home}|yes`);
    process.env.BASH_ENV = env.BASH_ENV;
    expect(readFileSync(kiro.env!(origin).BASH_ENV!, "utf8")).not.toContain(". ");
  });

  it("keeps and reports files written inside its own home instead of removing them", () => {
    userSettings();
    const own = kiro.env!(origin).HOME!;
    rmSync(join(own, ".gitconfig"));
    writeFileSync(join(own, ".gitconfig"), "[user]\n  name = changed inside kiro\n");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    kiro.env!(origin);

    expect(readFileSync(join(own, ".gitconfig"), "utf8")).toContain("changed inside kiro");
    expect(warn.mock.calls.flat().join("\n")).toContain(join(own, ".gitconfig"));
    warn.mockRestore();
  });

  it("puts back a link that went missing between launches", () => {
    userSettings();
    const own = kiro.env!(origin).HOME!;
    rmSync(join(own, ".gitconfig"));
    expect(() => kiro.env!(origin)).not.toThrow();
    expect(readlinkSync(join(own, ".gitconfig"))).toBe(join(home, ".gitconfig"));
  });

  it("works before Kiro has ever written settings", () => {
    const own = kiro.env!(origin).HOME!;
    expect(JSON.parse(readFileSync(join(own, ".kiro", "settings", "cli.json"), "utf8"))).toEqual({
      "api.codewhisperer.service": { endpoint: origin, region: "us-east-1" },
    });
  });

  it("prints the settings entry for plain kiro-cli", () => {
    const help = kiro.configHelp(origin);
    expect(help).toContain("jev-kiro --start");
    expect(help).toContain(`"endpoint": "${origin}"`);
  });
});

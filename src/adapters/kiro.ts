import type { Decision } from "../decide.js";
import { textOf, truncate } from "../state.js";
import type { Json, JsonSchema, RouterInput, RouterTool, Turn } from "../types.js";
import type { Adapter } from "./adapter.js";


interface KiroTool {
  toolSpecification?: { name: string; description?: string; inputSchema?: { json?: JsonSchema } };
}

interface ToolResult {
  toolUseId?: string;
  content?: unknown;
  status?: string;
}

interface UserInputMessage {
  content?: string;
  userInputMessageContext?: { tools?: KiroTool[]; toolResults?: ToolResult[]; [key: string]: unknown };
  modelId?: string;
  [key: string]: unknown;
}

interface AssistantResponseMessage {
  content?: string;
  toolUses?: { toolUseId?: string; name?: string; input?: Json }[];
  [key: string]: unknown;
}

type HistoryEntry = { userInputMessage?: UserInputMessage; assistantResponseMessage?: AssistantResponseMessage };

export interface KiroRequest {
  conversationState?: {
    history?: HistoryEntry[];
    currentMessage?: { userInputMessage?: UserInputMessage };
    [key: string]: unknown;
  };
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

export const KIRO_CHAT_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const USER_MESSAGE = /--- USER MESSAGE BEGIN ---\n?([\s\S]*?)--- USER MESSAGE END ---/;

const userText = (content: string | undefined) => (content === undefined ? "" : (USER_MESSAGE.exec(content)?.[1] ?? content));

const resultText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((part: { text?: unknown; json?: unknown }) => (typeof part?.text === "string" ? part.text : JSON.stringify(part?.json ?? part)))
        .join("\n")
    : textOf(content);

function toTools(raw: KiroTool[]): RouterTool[] {
  return raw.flatMap((tool) => {
    const spec = tool?.toolSpecification;
    if (typeof spec?.name !== "string") return [];
    return [{ kind: "function" as const, name: spec.name, description: spec.description, parameters: spec.inputSchema?.json }];
  });
}

function toInput(req: KiroRequest, maxMessageChars: number): RouterInput | { skip: string } {
  const state = req.conversationState;
  const current = state?.currentMessage?.userInputMessage;
  if (!current) return { skip: "no_messages" };
  const clip = (value: unknown) => truncate(textOf(value), maxMessageChars);

  const toolNameById = new Map<string, string>();
  const turns: Turn[] = [];
  const addUser = (message: UserInputMessage) => {
    for (const result of message.userInputMessageContext?.toolResults ?? []) {
      const tool = toolNameById.get(result.toolUseId ?? "") ?? "unknown";
      turns.push({ role: "tool_result", tool, content: truncate(resultText(result.content), maxMessageChars) });
    }
    const text = userText(message.content);
    if (text.trim()) turns.push({ role: "user", text: clip(text) });
  };
  for (const entry of Array.isArray(state.history) ? state.history : []) {
    if (entry.userInputMessage) addUser(entry.userInputMessage);
    const reply = entry.assistantResponseMessage;
    if (!reply) continue;
    if (reply.content?.trim()) turns.push({ role: "assistant", text: clip(reply.content) });
    for (const use of reply.toolUses ?? []) {
      if (use.toolUseId && use.name) toolNameById.set(use.toolUseId, use.name);
      turns.push({ role: "assistant", tool_calls: [{ tool: use.name ?? "unknown", arguments: clip(JSON.stringify(use.input ?? {})) }] });
    }
  }
  addUser(current);

  const tools = current.userInputMessageContext?.tools;
  return {
    system: "",
    turns,
    tools: toTools(Array.isArray(tools) ? tools : []),
    toolChoice: "auto",
    steer: "hint",
    direct: false,
  };
}

function apply(req: KiroRequest, decision: Decision): KiroRequest {
  if (decision.mode !== "hint") return req;
  const state = req.conversationState;
  const current = state?.currentMessage?.userInputMessage;
  if (!state || !current) return req;
  const hint =
    `<system-reminder>A tool-routing model suggests the "${decision.tool}" tool is the most relevant next step. ` +
    "Ignore this if it does not fit what the user actually asked for.</system-reminder>";
  const content = current.content ? `${current.content}\n\n${hint}` : hint;
  return { ...req, conversationState: { ...state, currentMessage: { ...state.currentMessage, userInputMessage: { ...current, content } } } };
}

const unsupported = (): never => {
  throw new Error("kiro_direct_unsupported");
};

export const kiroAdapter: Adapter<KiroRequest> = { toInput, apply, directJson: unsupported, directStream: unsupported };

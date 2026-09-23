import { randomBytes, randomUUID } from "node:crypto";
import type { Decision } from "../decide.js";
import { textOf } from "../state.js";
import type { ChatRequest, DirectCall, RouterInput, RouterTool, ToolDef, Turn } from "../types.js";
import { sse, type Adapter } from "./adapter.js";

/** OpenAI Chat Completions (`POST /v1/chat/completions`). */

/**
 * Tools that are not functions (a provider's built-ins, custom tools) cannot be forced through
 * `tool_choice: { type: "function" }`. They are still offered to Jev, so it is not blind to them:
 * picking one passes the request through, and picking a function leaves them in the list untouched.
 */
function toTools(rawTools: ToolDef[]): RouterTool[] {
  const tools: RouterTool[] = [];
  const builtIns = new Set<string>();
  for (const tool of rawTools) {
    if (tool.type === "function") {
      const { name, description, parameters } = tool.function!;
      tools.push({ kind: "function", name, description, parameters });
    } else if (tool.custom?.name) {
      tools.push({ kind: "hosted", name: tool.custom.name, description: tool.custom.description });
    } else if (!builtIns.has(tool.type)) {
      // The same built-in listed twice is one option; two functions with one name stay two, so
      // that `decide` can refuse the ambiguity.
      builtIns.add(tool.type);
      tools.push({ kind: "hosted", name: tool.type, description: `The provider's built-in ${tool.type} tool.` });
    }
  }
  return tools;
}

function toInput(req: ChatRequest, maxMessageChars: number): RouterInput | { skip: string } {
  if (!Array.isArray(req.messages)) return { skip: "no_messages" };
  const rawTools = Array.isArray(req.tools) ? req.tools : [];
  // A function with no name is a body upstream will refuse; it is not ours to guess at.
  if (rawTools.some((tool) => tool.type === "function" ? !tool.function?.name : typeof tool.type !== "string")) {
    return { skip: "malformed_tools" };
  }

  const toolNameByCallId = new Map<string, string>();
  for (const message of req.messages) {
    for (const call of message.tool_calls ?? []) toolNameByCallId.set(call.id, call.function.name);
  }

  const system: string[] = [];
  const turns: Turn[] = [];
  for (const message of req.messages) {
    const text = textOf(message.content);
    if (message.role === "system" || message.role === "developer") {
      if (text) system.push(text);
    } else if (message.role === "tool") {
      turns.push({
        role: "tool_result",
        ...(typeof message.tool_call_id === "string" ? { call_id: message.tool_call_id } : {}),
        tool: toolNameByCallId.get(message.tool_call_id ?? "") ?? "unknown",
        content: text,
      });
    } else if (message.tool_calls?.length) {
      turns.push({
        role: message.role,
        ...(text ? { text } : {}),
        tool_calls: message.tool_calls.map((call) => ({
          tool: call.function.name,
          ...(typeof call.id === "string" ? { call_id: call.id } : {}),
          arguments: call.function.arguments,
        })),
      });
    } else {
      turns.push({ role: message.role, text });
    }
  }

  const choice = req.tool_choice ?? "auto";
  return {
    system: system.join("\n\n"),
    turns,
    tools: toTools(rawTools),
    toolChoice: choice === "auto" || choice === "required" ? choice : "decided",
  };
}

function apply(req: ChatRequest, decision: Decision, argsModel?: string): ChatRequest {
  if (decision.mode === "forced") {
    return {
      ...req,
      model: argsModel ?? req.model,
      tool_choice: { type: "function", function: { name: decision.tool } },
    };
  }
  if (decision.mode === "none") return { ...req, tool_choice: "none" };
  return req;
}

const usageOf = (call: DirectCall) => ({
  prompt_tokens: call.inputTokens,
  completion_tokens: 0,
  total_tokens: call.inputTokens,
});

const ids = () => ({
  id: `chatcmpl-jev-${randomUUID()}`,
  callId: `call_${randomBytes(12).toString("hex")}`,
  created: Math.floor(Date.now() / 1000),
});

/** A chat.completion carrying the tool call Jev decided on, shaped like an LLM's. */
function directJson(req: ChatRequest, call: DirectCall) {
  const { id, callId, created } = ids();
  return {
    id,
    object: "chat.completion",
    created,
    model: req.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            { id: callId, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } },
          ],
        },
        logprobs: null,
        finish_reason: "tool_calls",
      },
    ],
    usage: usageOf(call),
    system_fingerprint: "jev-gateway",
  };
}

/** The same tool call as a chat.completion.chunk stream, for `stream: true` clients. */
function directStream(req: ChatRequest, call: DirectCall): string {
  const { id, callId, created } = ids();
  const base = { id, object: "chat.completion.chunk", created, model: req.model, system_fingerprint: "jev-gateway" };
  const delta = (delta: object, finish_reason: string | null = null) => ({
    ...base,
    choices: [{ index: 0, delta, logprobs: null, finish_reason }],
  });
  const chunks: object[] = [
    delta({
      role: "assistant",
      content: null,
      tool_calls: [{ index: 0, id: callId, type: "function", function: { name: call.tool, arguments: "" } }],
    }),
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.args) } }] }),
    delta({}, "tool_calls"),
  ];
  if (req.stream_options?.include_usage) chunks.push({ ...base, choices: [], usage: usageOf(call) });
  return sse([...chunks.map((chunk) => ({ data: JSON.stringify(chunk) })), { data: "[DONE]" }]);
}

export const chatAdapter: Adapter<ChatRequest> = { toInput, apply, directJson, directStream };

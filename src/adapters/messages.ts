import { randomBytes } from "node:crypto";
import type { Decision } from "../decide.js";
import { textOf } from "../state.js";
import type { DirectCall, Json, JsonSchema, RouterInput, RouterTool, Turn } from "../types.js";
import { sse, type Adapter } from "./adapter.js";

/** Anthropic Messages API (`POST /v1/messages`) — the wire format Claude Code speaks. */

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Json;
  tool_use_id?: string;
  content?: unknown;
}

interface MessagesTool {
  /** Absent (or "custom") for client tools; versioned, e.g. `web_search_20250305`, for Anthropic-run ones. */
  type?: string;
  name: string;
  description?: string;
  input_schema?: JsonSchema;
}

export interface MessagesRequest {
  model?: string;
  system?: string | Block[];
  messages?: { role: string; content: string | Block[] }[];
  tools?: MessagesTool[];
  tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type: string };
  stream?: boolean;
  [key: string]: unknown;
}

const isClientTool = (tool: MessagesTool) => tool.type === undefined || tool.type === "custom";

function toTools(raw: MessagesTool[]): RouterTool[] {
  return raw
    .filter((tool) => typeof tool?.name === "string")
    .map((tool) =>
      isClientTool(tool)
        ? { kind: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }
        : { kind: "hosted", name: tool.name, description: tool.description ?? `Anthropic's built-in ${tool.name} tool.` },
    );
}

function toInput(req: MessagesRequest, maxMessageChars: number): RouterInput | { skip: string } {
  if (!Array.isArray(req.messages)) return { skip: "no_messages" };

  const toolNameById = new Map<string, string>();
  const turns: Turn[] = [];
  for (const message of req.messages) {
    if (typeof message.content === "string") {
      turns.push({ role: message.role, text: message.content });
      continue;
    }
    // One message can interleave prose, tool calls and tool results; Jev reads them as separate turns.
    const text: Block[] = [];
    const flushText = () => {
      if (text.length) turns.push({ role: message.role, text: textOf(text.splice(0)) });
    };
    for (const block of message.content ?? []) {
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        flushText();
        if (block.id && block.name) toolNameById.set(block.id, block.name);
        turns.push({
          role: "assistant",
          tool_calls: [{ tool: block.name ?? "unknown", ...(typeof block.id === "string" ? { call_id: block.id } : {}), arguments: JSON.stringify(block.input ?? {}) }],
        });
      } else if (block.type === "tool_result" || block.type.endsWith("_tool_result")) {
        flushText();
        turns.push({
          role: "tool_result",
          ...(typeof block.tool_use_id === "string" ? { call_id: block.tool_use_id } : {}),
          tool: toolNameById.get(block.tool_use_id ?? "") ?? "unknown",
          content: textOf(block.content),
        });
      } else if (block.type !== "thinking" && block.type !== "redacted_thinking") {
        text.push(block);
      }
    }
    flushText();
  }

  const choice = req.tool_choice?.type ?? "auto";
  const thinking = req.thinking?.type !== undefined && req.thinking.type !== "disabled";
  // Two reasons not to touch tool_choice: the API rejects a forced tool while extended thinking
  // is on, and any tool_choice change invalidates the cached conversation — which an agent like
  // Claude Code re-reads on every turn. A trailing hint does neither.
  const cached = JSON.stringify(req.messages).includes('"cache_control"') || "cache_control" in req;
  return {
    system: textOf(req.system),
    turns,
    tools: toTools(Array.isArray(req.tools) ? req.tools : []),
    toolChoice: choice === "auto" ? "auto" : choice === "any" ? "required" : "decided",
    steer: thinking || cached ? "hint" : "tool_choice",
  };
}

/**
 * Suggest Jev's pick in a block appended after everything the client sent. Cache breakpoints sit
 * on the client's own blocks, so the cached prefix stays byte-identical to what the client will
 * resend next turn; the wording leaves the model free to disagree. The name goes into a block
 * the model takes for the host's, which is safe only because `decide` refuses any name that is
 * not a single inert token (SAFE_TOOL_NAME) before a decision can carry it here.
 */
function withHint(req: MessagesRequest, tool: string): MessagesRequest {
  const messages = req.messages ?? [];
  const last = messages.at(-1);
  if (last?.role !== "user") return req;
  const hint: Block = {
    type: "text",
    text:
      `<system-reminder>A tool-routing model suggests the "${tool}" tool is the most relevant next step. ` +
      "Ignore this if it does not fit what the user actually asked for.</system-reminder>",
  };
  const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  return { ...req, messages: [...messages.slice(0, -1), { ...last, content: [...content, hint] }] };
}

function apply(req: MessagesRequest, decision: Decision, argsModel?: string): MessagesRequest {
  if (decision.mode === "hint") return withHint(req, decision.tool);
  const parallel =
    req.tool_choice?.disable_parallel_tool_use === undefined
      ? {}
      : { disable_parallel_tool_use: req.tool_choice.disable_parallel_tool_use };
  if (decision.mode === "forced") {
    return { ...req, model: argsModel ?? req.model, tool_choice: { type: "tool", name: decision.tool, ...parallel } };
  }
  if (decision.mode === "none") return { ...req, tool_choice: { type: "none" } };
  return req;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function build(req: MessagesRequest, call: DirectCall) {
  const block = { type: "tool_use", id: `toolu_jev_${hex(12)}`, name: call.tool, input: call.args };
  const usage = {
    input_tokens: call.inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  const message = {
    id: `msg_jev_${hex(12)}`,
    type: "message",
    role: "assistant",
    model: req.model ?? "jev-gateway",
    content: [block],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  };
  return { block, message, usage };
}

function directJson(req: MessagesRequest, call: DirectCall) {
  return build(req, call).message;
}

/** The event sequence Claude itself streams for a single tool call. */
function directStream(req: MessagesRequest, call: DirectCall): string {
  const { block, message, usage } = build(req, call);
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
  return sse(events.map((event) => ({ event: event.type as string, data: JSON.stringify(event) })));
}

export const messagesAdapter: Adapter<MessagesRequest> = { toInput, apply, directJson, directStream };

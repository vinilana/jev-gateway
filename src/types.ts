/** The subset of the OpenAI Chat Completions shapes the router needs to understand. */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ContentPart {
  type: string;
  text?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content?: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: Json[];
  const?: Json;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDef {
  type: string;
  function?: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
  };
  /** `type: "custom"`: free-form input instead of JSON arguments. */
  custom?: { name: string; description?: string };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: string; function?: { name: string }; [key: string]: unknown };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Wire-format-neutral shapes: what the decision logic sees, whichever API the client spoke.
// ---------------------------------------------------------------------------

export type Turn = { [key: string]: Json };

export interface RouterTool {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  /**
   * `function`: JSON-schema arguments. `custom`: free-form text input (e.g. Codex's apply_patch).
   * `hosted`: run by the provider (web search, …) — offered to Jev so it isn't blind to them,
   * but never forced.
   */
  kind: "function" | "custom" | "hosted";
  /**
   * Set when `name` is namespace-qualified (`clock.sleep`). Such tools are offered to Jev but
   * never forced: `tool_choice` has no way to address them (see README, "Codex on a subscription").
   */
  namespace?: string;
}

export interface RouterInput {
  system: string;
  turns: Turn[];
  tools: RouterTool[];
  /** `decided`: the caller already fixed the outcome (`none`, a named tool, …). */
  toolChoice: "auto" | "required" | "decided";
  /**
   * How the LLM can be steered towards Jev's pick (default `tool_choice`). `hint` appends a note to
   * the conversation instead, for requests where rewriting tool_choice is rejected or too costly.
   */
  steer?: "tool_choice" | "hint";
  direct?: boolean;
}

/** A tool call Jev produced in full, to be rendered in the client's wire format. */
export interface DirectCall {
  tool: string;
  args: Record<string, Json>;
  /** Jev input tokens, reported as prompt tokens since no LLM ran. */
  inputTokens: number;
}

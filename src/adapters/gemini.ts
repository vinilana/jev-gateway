import { truncate } from "../state.js";
import type { DirectCall, Json, JsonSchema, RouterInput } from "../types.js";
import { type Adapter, sse } from "./adapter.js";

export interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  [key: string]: unknown;
}

export interface GeminiRequest {
  model?: string;
  stream?: boolean;
  contents?: GeminiContent[];
  tools?: GeminiTool[];
  toolConfig?: {
    functionCallingConfig?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
    };
    [key: string]: unknown;
  };
  systemInstruction?: {
    parts?: Array<{ text?: string }>;
  };
  [key: string]: unknown;
}

/** The functions the router can offer, and the names of the tools Google runs itself beside them. */
function visibleTools(tools: GeminiTool[], allowed: Set<string> | undefined) {
  const declarations = tools.flatMap((tool) => tool.functionDeclarations ?? []).filter((fn) => !allowed || allowed.has(fn.name));
  // Hosted tools must be counted the same way for routed and baseline requests.
  const hosted = [...new Set(tools.flatMap((tool) => Object.keys(tool).filter((key) => key !== "functionDeclarations")))];
  return { declarations, hosted };
}

// A caller that lists allowedFunctionNames has already narrowed the choice: Jev picks among those.
const allowedFunctions = (config: { allowedFunctionNames?: string[] } | undefined) =>
  config?.allowedFunctionNames?.length ? new Set(config.allowedFunctionNames) : undefined;

/** Google Gemini API (`POST /v1beta/models/...:generateContent` and `:streamGenerateContent`). */
function toInput(req: GeminiRequest, maxMessageChars: number): RouterInput | { skip: string } {
  if (!Array.isArray(req.contents)) return { skip: "no_messages" };
  const config = req.toolConfig?.functionCallingConfig;
  const { declarations: rawDecls, hosted } = visibleTools(req.tools ?? [], allowedFunctions(config));
  if (rawDecls.length === 0) return { skip: "no_tools" };

  const systemParts = (req.systemInstruction?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const system = truncate(systemParts.join("\n\n"), maxMessageChars);

  const turns: RouterInput["turns"] = [];
  for (const content of req.contents) {
    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: Array<{ tool: string; arguments: string }> = [];

    for (const part of content.parts ?? []) {
      if (part.text) {
        textParts.push(part.text);
      } else if (part.functionCall) {
        toolCalls.push({
          tool: part.functionCall.name,
          arguments: truncate(JSON.stringify(part.functionCall.args ?? {}), maxMessageChars),
        });
      } else if (part.functionResponse) {
        turns.push({
          role: "tool_result",
          tool: part.functionResponse.name,
          content: truncate(JSON.stringify(part.functionResponse.response ?? {}), maxMessageChars),
        });
      }
    }

    if (textParts.length || toolCalls.length) {
      turns.push({
        role,
        ...(textParts.length ? { text: truncate(textParts.join("\n"), maxMessageChars) } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls as unknown as Json[] } : {}),
      });
    }
  }

  const mode = config?.mode ?? "AUTO";
  const toolChoice = mode === "AUTO" ? "auto" : mode === "ANY" ? "required" : "decided";

  return {
    system,
    turns,
    tools: [
      ...rawDecls.map((fn) => ({ kind: "function" as const, name: fn.name, description: fn.description, parameters: fn.parameters })),
      ...hosted.map((name) => ({ kind: "hosted" as const, name, description: `Google's built-in ${name} tool.` })),
    ],
    toolChoice,
  };
}

function apply(req: GeminiRequest, decision: Parameters<Adapter<GeminiRequest>["apply"]>[1]): GeminiRequest {
  const clone = structuredClone(req);
  if (decision.mode === "forced") {
    clone.toolConfig = {
      ...clone.toolConfig,
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [decision.tool],
      },
    };
    return clone;
  }
  if (decision.mode === "none") {
    clone.toolConfig = {
      ...clone.toolConfig,
      functionCallingConfig: {
        mode: "NONE",
      },
    };
    return clone;
  }
  return clone;
}

function directJson(req: GeminiRequest, call: DirectCall): object {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: call.tool,
                args: call.args,
              },
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    // No LLM ran: Jev's input tokens are the whole cost, and nothing was generated.
    usageMetadata: { promptTokenCount: call.inputTokens, candidatesTokenCount: 0, totalTokenCount: call.inputTokens },
  };
}

/** `streamGenerateContent` streams SSE only with `?alt=sse`; without it, the reply is a JSON array of chunks. */
function directStream(req: GeminiRequest, call: DirectCall, url: URL) {
  const chunk = JSON.stringify(directJson(req, call));
  return url.searchParams.get("alt") === "sse" ? sse([{ data: chunk }]) : { body: `[${chunk}]`, contentType: "application/json" };
}

/** Gemini names the model and chooses streaming in the path: `/v1beta/models/<model>:streamGenerateContent`. */
function fromUrl(url: URL) {
  const match = /\/models\/([^/:]+):(\w+)/.exec(url.pathname);
  return { model: match?.[1], stream: match?.[2] === "streamGenerateContent" };
}

/** Count individual functions and hosted tools, even when routing is switched off. */
function metadata(req: GeminiRequest | undefined) {
  if (!Array.isArray(req?.tools)) return {};
  const { declarations, hosted } = visibleTools(req.tools, allowedFunctions(req.toolConfig?.functionCallingConfig));
  return { tools: declarations.length + hosted.length };
}

export const geminiAdapter: Adapter<GeminiRequest> = {
  toInput,
  apply,
  directJson,
  directStream,
  fromUrl,
  metadata,
};

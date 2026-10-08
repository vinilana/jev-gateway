import type { DirectCall, Json, JsonSchema, RouterInput } from "../types.js";
import { type Adapter, sse } from "./adapter.js";

export interface GeminiPart {
  text?: string;
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
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

/** Google Gemini API (`POST /v1beta/models/...:generateContent` and `:streamGenerateContent`). */
function toInput(req: GeminiRequest, maxMessageChars: number): RouterInput | { skip: string } {
  if (!Array.isArray(req.contents)) return { skip: "no_messages" };
  const config = req.toolConfig?.functionCallingConfig;
  // A caller that lists allowedFunctionNames has already narrowed the choice: Jev picks among those.
  const allowed = config?.allowedFunctionNames?.length ? new Set(config.allowedFunctionNames) : undefined;
  const rawDecls = (req.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).filter((fn) => !allowed || allowed.has(fn.name));
  if (rawDecls.length === 0) return { skip: "no_tools" };
  // Tools Google runs itself (googleSearch, codeExecution, urlContext) are entries without
  // declarations. Jev sees them so it isn't blind to them, but they can't be forced by name.
  const hosted = (req.tools ?? []).flatMap((tool) => Object.keys(tool).filter((key) => key !== "functionDeclarations"));

  const systemParts = (req.systemInstruction?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const system = systemParts.join("\n\n");

  const turns: RouterInput["turns"] = [];
  for (const content of req.contents) {
    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: Array<{ tool: string; arguments: string; call_id?: string }> = [];
    const flush = () => {
      if (textParts.length || toolCalls.length) turns.push({ role,
        ...(textParts.length ? { text: textParts.splice(0).join("\n") } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls.splice(0) as unknown as Json[] } : {}) });
    };

    for (const part of content.parts ?? []) {
      if (part.text) {
        textParts.push(part.text);
      } else if (part.functionCall) {
        toolCalls.push({
          tool: part.functionCall.name,
          ...(typeof part.functionCall.id === "string" ? { call_id: part.functionCall.id } : {}),
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      } else if (part.functionResponse) {
        flush();
        turns.push({
          role: "tool_result",
          tool: part.functionResponse.name,
          ...(typeof part.functionResponse.id === "string" ? { call_id: part.functionResponse.id } : {}),
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
    }

    flush();
  }

  const mode = config?.mode ?? "AUTO";
  const toolChoice = mode === "AUTO" ? "auto" : mode === "ANY" ? "required" : "decided";

  return {
    system,
    turns,
    tools: [
      ...rawDecls.map((fn) => ({ kind: "function" as const, name: fn.name, description: fn.description, parameters: fn.parameters })),
      ...[...new Set(hosted)].map((name) => ({ kind: "hosted" as const, name, description: `Google's built-in ${name} tool.` })),
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

export const geminiAdapter: Adapter<GeminiRequest> = {
  toInput,
  apply,
  directJson,
  directStream,
  fromUrl,
};

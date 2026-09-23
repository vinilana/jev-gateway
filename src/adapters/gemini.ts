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
  /** Cloud Code / internal requests wrap the payload in an inner `request` object. */
  request?: {
    model?: string;
    contents?: GeminiContent[];
    tools?: GeminiTool[];
    toolConfig?: GeminiRequest["toolConfig"];
    systemInstruction?: GeminiRequest["systemInstruction"];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Google Gemini API and Cloud Code (`/v1beta/models/...`, `/v1internal:streamGenerateContent`). */
function toInput(req: GeminiRequest, maxMessageChars: number): RouterInput | { skip: string } {
  const contents = req.contents ?? req.request?.contents;
  if (!Array.isArray(contents)) return { skip: "no_messages" };
  const toolConfig = req.toolConfig ?? req.request?.toolConfig;
  const config = toolConfig?.functionCallingConfig;
  // A caller that lists allowedFunctionNames has already narrowed the choice: Jev picks among those.
  const allowed = config?.allowedFunctionNames?.length ? new Set(config.allowedFunctionNames) : undefined;
  const tools = req.tools ?? req.request?.tools;
  const rawDecls = (tools ?? [])
    .filter((t): t is GeminiTool => Boolean(t && typeof t === "object"))
    .flatMap((t) => t.functionDeclarations ?? [])
    .filter((fn): fn is GeminiFunctionDeclaration => Boolean(fn && typeof fn === "object" && typeof fn.name === "string"))
    .filter((fn) => !allowed || allowed.has(fn.name));
  if (rawDecls.length === 0) return { skip: "no_tools" };
  // Tools Google runs itself (googleSearch, codeExecution, urlContext) are entries without
  // declarations. Jev sees them so it isn't blind to them, but they can't be forced by name.
  const hosted = (tools ?? [])
    .filter((t): t is GeminiTool => Boolean(t && typeof t === "object"))
    .flatMap((tool) => Object.keys(tool).filter((key) => key !== "functionDeclarations"));

  const systemInstruction = req.systemInstruction ?? req.request?.systemInstruction;
  const systemParts = (systemInstruction?.parts ?? [])
    .filter((p): p is { text?: string } => Boolean(p && typeof p === "object"))
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const system = truncate(systemParts.join("\n\n"), maxMessageChars);

  const turns: RouterInput["turns"] = [];
  for (const content of contents) {
    if (!content || typeof content !== "object") continue;
    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: Array<{ tool: string; arguments: string }> = [];

    for (const part of content.parts ?? []) {
      if (!part || typeof part !== "object") continue;
      if (part.text && !part.thought) {
        textParts.push(part.text);
      } else if (part.functionCall && typeof part.functionCall === "object" && typeof part.functionCall.name === "string") {
        toolCalls.push({
          tool: part.functionCall.name,
          arguments: truncate(JSON.stringify(part.functionCall.args ?? {}), maxMessageChars),
        });
      } else if (part.functionResponse && typeof part.functionResponse === "object" && typeof part.functionResponse.name === "string") {
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
      ...[...new Set(hosted)].map((name) => ({ kind: "hosted" as const, name, description: `Google's built-in ${name} tool.` })),
    ],
    toolChoice,
  };
}

function apply(req: GeminiRequest, decision: Parameters<Adapter<GeminiRequest>["apply"]>[1]): GeminiRequest {
  const clone = structuredClone(req);
  const target = clone.request && typeof clone.request === "object" ? clone.request : clone;
  if (decision.mode === "forced") {
    target.toolConfig = {
      ...target.toolConfig,
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [decision.tool],
      },
    };
    return clone;
  }
  if (decision.mode === "none") {
    target.toolConfig = {
      ...target.toolConfig,
      functionCallingConfig: {
        mode: "NONE",
      },
    };
    return clone;
  }
  return clone;
}

function directJson(req: GeminiRequest, call: DirectCall): object {
  const candidate = {
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
  if (req.request && typeof req.request === "object") {
    return { response: candidate };
  }
  return candidate;
}

/** `streamGenerateContent` streams SSE with `?alt=sse` or on internal endpoints; without it, the reply is a JSON array. */
function directStream(req: GeminiRequest, call: DirectCall, url: URL) {
  const chunk = JSON.stringify(directJson(req, call));
  return url.searchParams.get("alt") === "sse" || url.pathname.startsWith("/v1internal")
    ? sse([{ data: chunk }])
    : { body: `[${chunk}]`, contentType: "application/json" };
}

/** Gemini and Cloud Code name the model or choice to stream in the path: `/models/<model>`, `:streamGenerateContent`. */
function fromUrl(url: URL) {
  const match = /\/models\/([^/:]+)/.exec(url.pathname);
  const stream = url.pathname.includes(":streamGenerateContent");
  return { model: match?.[1], stream };
}

export const geminiAdapter: Adapter<GeminiRequest> = {
  toInput,
  apply,
  directJson,
  directStream,
  fromUrl,
};
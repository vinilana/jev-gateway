import { truncate } from "../state.js";
import type { DirectCall, Json, JsonSchema, RouterInput } from "../types.js";
import { type Adapter, sse } from "./adapter.js";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
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

function innerRequest(req: GeminiRequest | undefined): GeminiRequest | undefined {
  if (!req || !("request" in req)) return req;
  const inner = req.request;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isRecord(value)) return false;
  if (value.thought !== undefined && typeof value.thought !== "boolean") return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  const functionCall = value.functionCall;
  if (
    functionCall !== undefined &&
    (!isRecord(functionCall) || typeof functionCall.name !== "string" ||
      (functionCall.args !== undefined && !isRecord(functionCall.args)))
  ) return false;
  const functionResponse = value.functionResponse;
  if (
    functionResponse !== undefined &&
    (!isRecord(functionResponse) || typeof functionResponse.name !== "string" ||
      (functionResponse.response !== undefined && !isRecord(functionResponse.response)))
  ) return false;
  return true;
}

function isGeminiContent(value: unknown): value is GeminiContent {
  if (!isRecord(value)) return false;
  if (value.role !== undefined && typeof value.role !== "string") return false;
  return value.parts === undefined || (Array.isArray(value.parts) && value.parts.every(isGeminiPart));
}

function isFunctionDeclaration(value: unknown): value is GeminiFunctionDeclaration {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  return value.parameters === undefined || isRecord(value.parameters);
}

function isGeminiTool(value: unknown): value is GeminiTool {
  if (!isRecord(value)) return false;
  const declarations = value.functionDeclarations;
  return declarations === undefined || (Array.isArray(declarations) && declarations.every(isFunctionDeclaration));
}

function toInput(req: GeminiRequest, maxMessageChars: number): RouterInput | { skip: string } {
  const inner = innerRequest(req);
  if (!inner) return { skip: "malformed_envelope" };
  const rawContents: unknown = inner.contents;
  if (rawContents === undefined) return { skip: "no_messages" };
  if (!Array.isArray(rawContents) || !rawContents.every(isGeminiContent)) return { skip: "unreadable_request" };
  const contents = rawContents as GeminiContent[];
  const toolConfig = inner.toolConfig;
  const config = toolConfig?.functionCallingConfig;
  // A caller that lists allowedFunctionNames has already narrowed the choice: Jev picks among those.
  const allowed = config?.allowedFunctionNames?.length ? new Set(config.allowedFunctionNames) : undefined;
  const rawTools: unknown = inner.tools ?? [];
  if (!Array.isArray(rawTools) || !rawTools.every(isGeminiTool)) return { skip: "unreadable_request" };
  const tools = rawTools as GeminiTool[];
  const rawDecls = tools.flatMap((tool) => tool.functionDeclarations ?? []).filter((fn) => !allowed || allowed.has(fn.name));
  if (rawDecls.length === 0) return { skip: "no_tools" };
  // Tools Google runs itself (googleSearch, codeExecution, urlContext) are entries without
  // declarations. Jev sees them so it isn't blind to them, but they can't be forced by name.
  const hosted = tools.flatMap((tool) => Object.keys(tool).filter((key) => key !== "functionDeclarations"));

  const systemInstruction: unknown = inner.systemInstruction;
  if (
    systemInstruction !== undefined &&
    (!isRecord(systemInstruction) ||
      (systemInstruction.parts !== undefined &&
        (!Array.isArray(systemInstruction.parts) || !systemInstruction.parts.every(isGeminiPart))))
  ) return { skip: "unreadable_request" };
  const systemParts = isRecord(systemInstruction) && Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
  const system = truncate(
    systemParts
      .map((part) => part.text)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n\n"),
    maxMessageChars,
  );

  const turns: RouterInput["turns"] = [];
  for (const content of contents) {
    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: Array<{ tool: string; arguments: string }> = [];

    for (const part of content.parts ?? []) {
      if (part.thought === true) continue;
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
      ...[...new Set(hosted)].map((name) => ({ kind: "hosted" as const, name, description: `Google's built-in ${name} tool.` })),
    ],
    // Gemini replays provider signatures on later turns; synthetic calls cannot carry them.
    directCalls: false,
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

function directJson(_req: GeminiRequest, call: DirectCall): object {
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

/** `streamGenerateContent` returns SSE only when its URL asks for `alt=sse`; otherwise it is a JSON array. */
function directStream(req: GeminiRequest, call: DirectCall, url: URL) {
  const chunk = JSON.stringify(directJson(req, call));
  return url.searchParams.get("alt") === "sse"
    ? sse([{ data: chunk }])
    : { body: `[${chunk}]`, contentType: "application/json" };
}

/** Model metadata lives in the Gemini path or the Cloud Code envelope. */
function metadata(req: GeminiRequest | undefined, url: URL) {
  const beta = /^\/v1beta\/models\/([^/:]+)(?::|$)/.exec(url.pathname);
  const inner = innerRequest(req);
  const model = typeof inner?.model === "string" ? inner.model : beta?.[1];
  const toolGroups = Array.isArray(inner?.tools) ? inner.tools.filter(isGeminiTool) : undefined;
  const config = inner?.toolConfig?.functionCallingConfig;
  const rawAllowedNames: unknown = config?.allowedFunctionNames;
  const allowedNames =
    Array.isArray(rawAllowedNames) && rawAllowedNames.every((name): name is string => typeof name === "string")
      ? rawAllowedNames
      : undefined;
  const allowed = allowedNames?.length ? new Set(allowedNames) : undefined;
  const tools = toolGroups
    ? toolGroups.flatMap((tool) => tool.functionDeclarations ?? []).filter((fn) => !allowed || allowed.has(fn.name)).length +
      new Set(toolGroups.flatMap((tool) => Object.keys(tool).filter((key) => key !== "functionDeclarations"))).size
    : undefined;
  return { model, tools };
}

/** Google Gemini API and Cloud Code (`/v1beta/models/...`, `/v1internal:streamGenerateContent`). */
export const geminiAdapter: Adapter<GeminiRequest> = {
  toInput,
  apply,
  directJson,
  directStream,
  metadata,
};

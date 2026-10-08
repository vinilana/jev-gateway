import { truncate } from "../state.js";
import type { DirectCall, Json, JsonSchema, RouterInput } from "../types.js";
import { type Adapter, sse } from "./adapter.js";

export interface CloudCodePart {
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

export interface CloudCodeContent {
  role?: string;
  parts?: CloudCodePart[];
}

export interface CloudCodeMessage {
  role?: string;
  content?: string | CloudCodePart[];
  parts?: CloudCodePart[];
  [key: string]: unknown;
}

export interface CloudCodeFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

export interface CloudCodeTool {
  functionDeclarations?: CloudCodeFunctionDeclaration[];
  function_declarations?: CloudCodeFunctionDeclaration[];
  [key: string]: unknown;
}

export interface CloudCodeRequest {
  model?: string;
  stream?: boolean;
  request?: CloudCodeRequest;
  contents?: CloudCodeContent[];
  messages?: CloudCodeMessage[];
  tools?: CloudCodeTool[];
  toolConfig?: {
    functionCallingConfig?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
      allowed_function_names?: string[];
    };
    function_calling_config?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
      allowed_function_names?: string[];
    };
    [key: string]: unknown;
  };
  tool_config?: {
    functionCallingConfig?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
      allowed_function_names?: string[];
    };
    function_calling_config?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
      allowed_function_names?: string[];
    };
    [key: string]: unknown;
  };
  systemInstruction?: {
    parts?: Array<{ text?: string }>;
  };
  [key: string]: unknown;
}

function getInner(req: CloudCodeRequest): CloudCodeRequest {
  if (req && typeof req === "object" && "request" in req && req.request && typeof req.request === "object") {
    return req.request as CloudCodeRequest;
  }
  return req;
}

function normalizeContents(req: CloudCodeRequest): CloudCodeContent[] | undefined {
  if (Array.isArray(req.contents)) return req.contents;
  if (Array.isArray(req.messages)) {
    return req.messages.map((m) => {
      if (Array.isArray(m.parts)) return { role: m.role, parts: m.parts };
      if (typeof m.content === "string") return { role: m.role, parts: [{ text: m.content }] };
      if (Array.isArray(m.content)) return { role: m.role, parts: m.content };
      return { role: m.role, parts: [] };
    });
  }
  return undefined;
}

/** Google Cloud Code API (`POST /v1internal:streamGenerateContent` and `:generateContent`). */
function toInput(req: CloudCodeRequest, maxMessageChars: number): RouterInput | { skip: string } {
  const inner = getInner(req);
  const contents = normalizeContents(inner) ?? normalizeContents(req);
  if (!contents || contents.length === 0) return { skip: "no_messages" };

  const toolConfig = inner.toolConfig ?? inner.tool_config ?? req.toolConfig ?? req.tool_config;
  const config = toolConfig?.functionCallingConfig ?? toolConfig?.function_calling_config;
  const allowedNames = config?.allowedFunctionNames ?? config?.allowed_function_names;
  const allowed = allowedNames?.length ? new Set(allowedNames) : undefined;
  const toolsList = inner.tools ?? req.tools ?? [];
  const rawDecls = toolsList
    .flatMap((t) => t.functionDeclarations ?? t.function_declarations ?? [])
    .filter((fn) => !allowed || allowed.has(fn.name));
  if (rawDecls.length === 0) return { skip: "no_tools" };

  const hosted = toolsList.flatMap((tool) =>
    Object.keys(tool).filter((key) => key !== "functionDeclarations" && key !== "function_declarations"),
  );

  const systemInstruction = inner.systemInstruction ?? req.systemInstruction;
  const systemParts = (systemInstruction?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const system = truncate(systemParts.join("\n\n"), maxMessageChars);

  const turns: RouterInput["turns"] = [];
  for (const content of contents) {
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
      ...[...new Set(hosted)].map((name) => ({ kind: "hosted" as const, name, description: `Google's built-in ${name} tool.` })),
    ],
    toolChoice,
  };
}

function apply(req: CloudCodeRequest, decision: Parameters<Adapter<CloudCodeRequest>["apply"]>[1], argsModel?: string): CloudCodeRequest {
  const clone = structuredClone(req);
  const hasWrapper = clone.request && typeof clone.request === "object";
  const target = hasWrapper ? (clone.request as CloudCodeRequest) : clone;

  if (decision.mode === "forced") {
    const baseConfig = (target.toolConfig ?? target.tool_config ?? {}) as Record<string, unknown>;
    delete target.tool_config;
    delete baseConfig.function_calling_config;
    target.toolConfig = {
      ...baseConfig,
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [decision.tool],
      },
    };
  } else if (decision.mode === "none") {
    const baseConfig = (target.toolConfig ?? target.tool_config ?? {}) as Record<string, unknown>;
    delete target.tool_config;
    delete baseConfig.function_calling_config;
    target.toolConfig = {
      ...baseConfig,
      functionCallingConfig: {
        mode: "NONE",
      },
    };
  }

  if (argsModel) {
    clone.model = argsModel;
    if (hasWrapper) (clone.request as CloudCodeRequest).model = argsModel;
  }

  return clone;
}

function directJson(req: CloudCodeRequest, call: DirectCall): object {
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
    usageMetadata: { promptTokenCount: call.inputTokens, candidatesTokenCount: 0, totalTokenCount: call.inputTokens },
  };
}

function directStream(req: CloudCodeRequest, call: DirectCall, url: URL) {
  const chunk = JSON.stringify(directJson(req, call));
  return url.searchParams.get("alt") === "json"
    ? { body: `[${chunk}]`, contentType: "application/json" }
    : sse([{ data: chunk }]);
}

function fromUrl(url: URL) {
  const match = /\/models\/([^/:]+):(\w+)/.exec(url.pathname);
  return {
    model: match?.[1],
    stream: url.pathname.endsWith(":streamGenerateContent") || url.pathname.includes("streamGenerateContent"),
  };
}

export const cloudcodeAdapter: Adapter<CloudCodeRequest> = {
  toInput,
  apply,
  directJson,
  directStream,
  fromUrl,
};

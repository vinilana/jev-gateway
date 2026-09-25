export const MULTIMODAL_SKIP = "multimodal_content";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retained attachments still matter; only protocol text containers are readable by Jev. */
function textParts(content: unknown, types: string[]): boolean {
  if (content == null || typeof content === "string") return false;
  if (!Array.isArray(content)) return true;
  return content.some((part: unknown) => !isRecord(part) || typeof part.type !== "string"
    || !types.includes(part.type) || (typeof part.text !== "string" && typeof part.refusal !== "string")
    || ["image_url", "input_audio", "file", "file_id"].some((key) => Object.hasOwn(part, key)));
}

export function hasChatMultimodal(messages: unknown): boolean {
  return Array.isArray(messages) && messages.some((message: unknown) => isRecord(message)
    && (textParts(message.content, ["text", "refusal"]) || message.audio != null));
}

const RESPONSES_TRACES = new Set([
  "additional_tools", "reasoning", "function_call", "custom_tool_call", "local_shell_call",
  "web_search_call", "file_search_call", "computer_call",
]);

export function hasResponsesMultimodal(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((item: unknown) => {
    if (!isRecord(item)) return false;
    if (typeof item.type === "string" && RESPONSES_TRACES.has(item.type)) return false;
    if (typeof item.type === "string" && item.type.endsWith("_call_output")) {
      return textParts(item.output, ["input_text", "output_text", "text", "refusal"]);
    }
    if (item.type !== undefined && item.type !== "message") return true;
    return textParts(item.content, ["input_text", "output_text", "text", "refusal"]);
  });
}

function messageBlocks(content: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (content == null || typeof content === "string") return false;
  if (!Array.isArray(content)) {
    return !isRecord(content) || content.type !== "web_search_tool_result_error";
  }
  return content.some((block: unknown) => {
    if (!isRecord(block)) return true;
    if (block.type === "text") return typeof block.text !== "string";
    if (["tool_use", "server_tool_use", "thinking", "redacted_thinking", "web_search_result",
      "web_search_tool_result_error"].includes(String(block.type))) return false;
    if (block.type === "tool_result" || block.type === "web_search_tool_result") {
      return messageBlocks(block.content, depth + 1);
    }
    return true;
  });
}

export function hasMessagesMultimodal(req: { system?: unknown; messages?: unknown }): boolean {
  return messageBlocks(req.system) || (Array.isArray(req.messages)
    && req.messages.some((message: unknown) => isRecord(message) && messageBlocks(message.content)));
}

const GEMINI_PART_KEYS = new Set(["text", "functionCall", "functionResponse", "thought", "thoughtSignature"]);

function geminiParts(parts: unknown, depth = 0): boolean {
  if (depth > 32 || !Array.isArray(parts)) return true;
  return parts.some((part: unknown) => {
    if (!isRecord(part) || Object.keys(part).some((key) => !GEMINI_PART_KEYS.has(key))) return true;
    if (typeof part.text === "string" || isRecord(part.functionCall)) return false;
    if (isRecord(part.functionResponse)) {
      // Media lives in functionResponse.parts, not in arbitrary application JSON under response.
      return part.functionResponse.parts !== undefined && geminiParts(part.functionResponse.parts, depth + 1);
    }
    return true;
  });
}

export function hasGeminiMultimodal(contents: unknown): boolean {
  return Array.isArray(contents) && contents.some((content: unknown) => isRecord(content)
    && content.parts !== undefined && geminiParts(content.parts));
}

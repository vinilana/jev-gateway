export const MULTIMODAL_SKIP = "multimodal_content";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MEDIA_TYPES = new Set([
  "image_url", "input_audio", "file", "input_image", "input_file", "image", "document",
]);
const RESULT_TYPES = new Set([
  "tool_result", "web_search_tool_result", "web_fetch_tool_result", "tool_search_output",
  "code_interpreter_call", "image_generation_call", "code_execution_result", "bash_code_execution_result", "text_editor_code_execution_result",
]);

function isResult(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string"
    && (RESULT_TYPES.has(value.type) || value.type.endsWith("_call_output") || value.type.endsWith("_tool_result"));
}

function hasMedia(content: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(content)) return content.some(part => hasMedia(part, depth + 1));
  if (!isRecord(content)) return false;
  if (typeof content.type === "string" && MEDIA_TYPES.has(content.type)) return true;
  if (content.type === "image_generation_call" && typeof content.result === "string" && content.result.length > 0) return true;
  if (["image_url", "input_audio", "file", "file_id"].some(key => content[key] != null)) return true;
  // Follow protocol content containers, never arbitrary tool arguments/results.
  return isResult(content)
    && (hasMedia(content.content, depth + 1) || hasMedia(content.output, depth + 1)
      || (content.type === "code_interpreter_call" && hasMedia(content.outputs, depth + 1)));
}

function latestBatch(items: unknown[], result: (item: unknown) => boolean): unknown[] {
  if (!items.length) return [];
  let start = items.length - 1;
  if (result(items[start])) {
    while (start > 0 && result(items[start - 1])) start--;
  }
  return items.slice(start);
}

export function hasChatMultimodal(messages: unknown): boolean {
  return Array.isArray(messages)
    && latestBatch(messages, message => isRecord(message) && message.role === "tool")
      .some(message => isRecord(message) && (hasMedia(message.content) || message.audio != null));
}

export function hasResponsesMultimodal(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Referenced items are opaque even when they precede a new text-only turn.
  if (input.some(item => isRecord(item) && item.type === "item_reference")) return true;
  const interactions = input.filter(item => isRecord(item)
    && (item.role !== undefined || item.type === "message" || isResult(item)
      || (typeof item.type === "string" && MEDIA_TYPES.has(item.type))));
  return latestBatch(interactions, isResult).some(item => isRecord(item)
    && (hasMedia(item) || hasMedia(item.content) || hasMedia(item.output)));
}

export function hasMessagesMultimodal(req: { system?: unknown; messages?: unknown }): boolean {
  const resultMessage = (message: unknown): boolean => isRecord(message)
    && Array.isArray(message.content) && message.content.length > 0 && message.content.every(isResult);
  return hasMedia(req.system) || (Array.isArray(req.messages)
    && latestBatch(req.messages, resultMessage)
      .some(message => isRecord(message) && hasMedia(message.content)));
}

function hasGeminiMedia(parts: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  return Array.isArray(parts) && parts.some(part => {
    if (!isRecord(part)) return false;
    if (part.inlineData != null || part.fileData != null) return true;
    // Gemini separates response parts from application JSON in response/args.
    return isRecord(part.functionResponse) && hasGeminiMedia(part.functionResponse.parts, depth + 1);
  });
}

export function hasGeminiMultimodal(contents: unknown): boolean {
  const resultContent = (content: unknown): boolean => isRecord(content)
    && Array.isArray(content.parts) && content.parts.length > 0
    && content.parts.every(part => isRecord(part) && isRecord(part.functionResponse));
  return Array.isArray(contents) && latestBatch(contents, resultContent)
    .some(content => isRecord(content) && hasGeminiMedia(content.parts));
}

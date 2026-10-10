import { peel } from "./proto/connect.js";
import { readFields, text } from "./proto/wire.js";

/**
 * Token usage of one LLM call, in one vocabulary whatever the provider's. `input` is everything
 * the model read, cached or not — Anthropic reports its three input buckets separately, OpenAI
 * reports a total with the cached part inside; both end up here as a total plus its cached share.
 */
export interface Usage {
  input: number;
  output: number;
  /** Part of `input` served from the prompt cache (billed at a fraction). */
  cached: number;
  /** Part of `input` written to the prompt cache (Anthropic only; billed at a premium). */
  cacheWrite: number;
  /** Part of `output` spent on hidden reasoning, when the provider says (OpenAI). */
  reasoning: number;
}

/**
 * How a Responses reply ended. The first three and `error` are events the API sent, and the
 * first one that arrives stays, whatever the client does afterwards. The last three mean no
 * terminal event arrived. Absent when a non-streamed reply is still in progress.
 */
export type ResponseEnding =
  | "response.completed"
  | "response.incomplete"
  | "response.failed"
  | "error"
  | "client_aborted"
  | "stream_error"
  | "unterminated";

/** Explicit Responses metadata, without generated text or tool arguments. */
export interface ResponseMetadata {
  id?: string;
  model?: string;
  tools: string[];
  ending?: ResponseEnding;
}

type Raw = Record<string, unknown>;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});

/** Fold one provider `usage` object into the running total; later reports override earlier ones. */
function merge(into: Partial<Usage>, raw: Raw): void {
  if ("prompt_tokens" in raw || "completion_tokens" in raw) {
    // Chat Completions
    into.input = num(raw.prompt_tokens);
    into.output = num(raw.completion_tokens);
    into.cached = num(obj(raw.prompt_tokens_details).cached_tokens);
    into.reasoning = num(obj(raw.completion_tokens_details).reasoning_tokens);
  } else if ("cache_read_input_tokens" in raw || "cache_creation_input_tokens" in raw) {
    // Anthropic, message_start: the input side, with a placeholder output count.
    into.cached = num(raw.cache_read_input_tokens);
    into.cacheWrite = num(raw.cache_creation_input_tokens);
    into.input = num(raw.input_tokens) + into.cached + into.cacheWrite;
    into.output = num(raw.output_tokens);
  } else if ("promptTokenCount" in raw || "candidatesTokenCount" in raw) {
    // Google Gemini API (usageMetadata)
    into.input = num(raw.promptTokenCount);
    into.output = num(raw.candidatesTokenCount);
    into.cached = num(raw.cachedContentTokenCount);
  } else {
    // Responses API — or Anthropic's message_delta, which only updates the output count.
    if ("input_tokens" in raw) {
      into.input = num(raw.input_tokens);
      into.cached = num(obj(raw.input_tokens_details).cached_tokens);
    }
    if ("output_tokens" in raw) {
      into.output = num(raw.output_tokens);
      into.reasoning = num(obj(raw.output_tokens_details).reasoning_tokens);
    }
  }
}

function collect(payload: unknown, into: Partial<Usage>): void {
  const root = obj(payload);
  // Where each API keeps it: top level (JSON replies, chat chunks, message_delta),
  // `response.usage` (Responses events), `message.usage` (Anthropic message_start), `usageMetadata` (Gemini).
  for (const holder of [root, obj(root.response), obj(root.message)]) {
    if (holder.usage && typeof holder.usage === "object") merge(into, holder.usage as Raw);
    if (holder.usageMetadata && typeof holder.usageMetadata === "object") merge(into, holder.usageMetadata as Raw);
  }
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function collectTool(payload: unknown, into: ResponseMetadata): void {
  if (into.tools.length >= 128) return;
  const item = obj(payload);
  let name: string | undefined;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    name = metadataString(item.name);
    const namespace = metadataString(item.namespace);
    if (name && namespace) name = metadataString(`${namespace}.${name}`);
  } else if (typeof item.type === "string" && /^[a-z][a-z0-9_]*_call$/.test(item.type)) {
    name = metadataString(item.type.slice(0, -5));
  }
  if (name && !into.tools.includes(name)) into.tools.push(name);
}

function collectMetadata(payload: unknown, current: ResponseMetadata | undefined, event?: string): ResponseMetadata | undefined {
  const root = obj(payload);
  const type = metadataString(root.type) ?? event;
  // Messages streams also send `error` events, so only a stream already known as Responses counts.
  if (type === "error") {
    if (current) current.ending ??= "error";
    return current;
  }
  const responseEvent = type?.startsWith("response.") === true;
  if (!responseEvent && root.object !== "response" && !(Array.isArray(root.output) && typeof root.status === "string")) return current;
  const into = current ?? { tools: [] };
  const reply = responseEvent ? obj(root.response) : root;
  const id = metadataString(reply.id);
  const model = metadataString(reply.model);
  if (id) into.id = id;
  if (model) into.model = model;
  if (Array.isArray(reply.output)) {
    for (const item of reply.output) collectTool(item, into);
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") collectTool(root.item, into);
  const status = responseEvent ? type?.slice(9) : reply.status;
  if (status === "completed" || status === "incomplete" || status === "failed") into.ending ??= `response.${status}`;
  return into;
}

/** exa's counters ride in field-28 stats groups: entries keyed by name, valued as fixed32
 *  floats — the wire carries "model" strings in the same shape, so unknown keys are skipped. */
async function readConnectUsage(response: Response): Promise<Usage | undefined> {
  const found: Partial<Usage> = {};
  try {
    for (const { payload } of peel(new Uint8Array(await response.arrayBuffer()))) {
      for (const group of readFields(payload)) {
        if (group.field !== 28) continue;
        for (const entry of readFields(group.bytes ?? new Uint8Array())) {
          if (entry.field !== 2) continue;
          const e = readFields(entry.bytes ?? new Uint8Array());
          const wrapper = e.find((f) => f.field === 4)?.bytes;
          const value = wrapper ? readFields(wrapper).find((f) => f.field === 2)?.bytes : undefined;
          if (!value || value.length !== 4) continue;
          const v = new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true);
          const key = text(e.find((f) => f.field === 5));
          if (key === "input_tokens") found.input = v;
          else if (key === "output_tokens") found.output = v;
          else if (key === "cached_input_tokens") found.cached = v;
        }
      }
    }
  } catch {
    // A truncated body peels nothing: report nothing rather than guess.
  }
  if (found.input === undefined && found.output === undefined) return undefined;
  return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, ...found };
}

/**
 * Read a reply to its end and report what it cost and, for the Responses API, how it ended. Works
 * on a clone, in the background: the client's own stream is never delayed. A stream cut short
 * (Codex hangs up as soon as it has `response.completed`) still yields whatever arrived before
 * the cut. `signal` is the client's: it tells an abort apart from an upstream failure.
 */
export async function readReply(response: Response, signal?: AbortSignal): Promise<{ usage?: Usage; response?: ResponseMetadata }> {
  // Connect streams are binary: peel envelopes instead of scanning lines.
  if (response.headers.get("content-type")?.includes("connect+proto")) {
    const usage = await readConnectUsage(response);
    return usage ? { usage } : {};
  }
  const found: Partial<Usage> = {};
  let metadata: ResponseMetadata | undefined;
  let readFailed = false;
  // Told apart by content, not by header: the ChatGPT Codex backend streams events without
  // sending any content-type at all.
  let streaming: boolean | undefined;
  let pending = "";
  let event: string | undefined;
  const scan = (line: string) => {
    if (line.startsWith("event:")) {
      event = metadataString(line.slice(6).trim());
      if (event?.startsWith("response.")) metadata ??= { tools: [] };
      return;
    }
    if (!line.trim()) {
      event = undefined;
      return;
    }
    if (!line.startsWith("data:")) return;
    // Text and argument deltas can be large. Their type suffices to detect Responses without
    // parsing their contents; only lifecycle events, output items and usage need JSON parsing.
    const type = line.match(/"type"\s*:\s*"(response\.[a-z_.]+|error)"/)?.[1] ?? event;
    if (type?.startsWith("response.")) metadata ??= { tools: [] };
    if (type?.startsWith("response.") && type.endsWith(".delta")) return;
    const relevant = type !== undefined && /^(response\.(created|in_progress|completed|incomplete|failed|output_item\.(added|done))|error)$/.test(type);
    if (!relevant && !line.includes('"usage')) return;
    try {
      const payload: unknown = JSON.parse(line.slice(5));
      collect(payload, found);
      metadata = collectMetadata(payload, metadata, event);
    } catch {
      // A line cut short by the client hanging up.
    }
  };
  try {
    for await (const chunk of response.body?.pipeThrough(new TextDecoderStream()) ?? []) {
      pending += chunk;
      streaming ??= /^\s*$/.test(pending) ? undefined : !/^\s*[{[]/.test(pending);
      if (!streaming) continue;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(scan);
    }
  } catch {
    // Cut mid-stream: keep what was seen.
    readFailed = true;
  }
  if (streaming) scan(pending);
  else {
    try {
      const payload: unknown = JSON.parse(pending);
      collect(payload, found);
      metadata = collectMetadata(payload, metadata);
    } catch {
      // Not JSON (an HTML error page, an empty body): nothing to report.
    }
  }
  // The abort is checked before the read error because the proxy sometimes closes a cancelled
  // client's stream quietly (plain EOF) and sometimes errors it. A terminal event already seen
  // wins over both: Codex hangs up right after `response.completed`, which says nothing about
  // the reply.
  if (metadata && streaming) metadata.ending ??= signal?.aborted ? "client_aborted" : readFailed ? "stream_error" : "unterminated";
  const usage = found.input === undefined && found.output === undefined
    ? undefined
    : { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, ...found };
  return { ...(usage ? { usage } : {}), ...(metadata ? { response: metadata } : {}) };
}

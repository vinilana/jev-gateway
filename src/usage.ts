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
 * Read a reply to its end and report what it cost. Works on a clone, in the background: the
 * client's own stream is never delayed. A stream cut short (Codex hangs up as soon as it has
 * `response.completed`) still yields whatever usage arrived before the cut.
 */
export async function readUsage(response: Response): Promise<Usage | undefined> {
  // Connect streams are binary: peel envelopes instead of scanning lines.
  if (response.headers.get("content-type")?.includes("connect+proto")) return readConnectUsage(response);
  const found: Partial<Usage> = {};
  // Told apart by content, not by header: the ChatGPT Codex backend streams events without
  // sending any content-type at all.
  let streaming: boolean | undefined;
  let pending = "";
  const scan = (line: string) => {
    // Most stream events are text deltas; only the few that mention usage are worth parsing.
    // (`"usage` with no closing quote also matches Gemini's `usageMetadata`.)
    if (!line.startsWith("data:") || !line.includes('"usage')) return;
    try {
      collect(JSON.parse(line.slice(5)), found);
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
    // Aborted mid-stream: keep what was seen.
  }
  if (streaming) scan(pending);
  else {
    try {
      collect(JSON.parse(pending), found);
    } catch {
      // Not JSON (an HTML error page, an empty body): nothing to report.
    }
  }
  if (found.input === undefined && found.output === undefined) return undefined;
  return { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, ...found };
}

/**
 * Read a reply until it says which model actually served it. An upstream that is itself a router
 * (OpenRouter, a local proxy such as Jevonian, LiteLLM) can serve a request made for one model id
 * with a different one, and every wire format this gateway understands echoes back the model that
 * served it, in the same places `collect` already reads `usage` from: top level (JSON replies,
 * chat chunks), `response` (Responses events), or `message` (Anthropic's `message_start`). That
 * served model, not the one asked for, is what the dashboard's Model column should show.
 *
 * Works on a clone, like `readUsage`, with the same streaming-or-plain-JSON detection — but stops
 * at the first model found instead of reading to the end, since the model never changes mid-reply.
 */
export async function readServedModel(response: Response): Promise<string | undefined> {
  // exa's wire is binary and does not carry a model string worth decoding for this.
  if (response.headers.get("content-type")?.includes("connect+proto")) return undefined;
  const find = (payload: unknown): string | undefined => {
    const root = obj(payload);
    for (const holder of [root, obj(root.response), obj(root.message)]) {
      if (typeof holder.model === "string" && holder.model) return holder.model;
    }
    return undefined;
  };
  let streaming: boolean | undefined;
  let pending = "";
  const scan = (line: string): string | undefined => {
    // Most stream events carry no model at all; only a `data:` line that mentions one is worth parsing.
    if (!line.startsWith("data:") || !line.includes('"model"')) return undefined;
    try {
      return find(JSON.parse(line.slice(5)));
    } catch {
      return undefined; // a line cut short by the client hanging up
    }
  };
  try {
    for await (const chunk of response.body?.pipeThrough(new TextDecoderStream()) ?? []) {
      pending += chunk;
      streaming ??= /^\s*$/.test(pending) ? undefined : !/^\s*[{[]/.test(pending);
      if (!streaming) continue;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const model = scan(line);
        if (model) return model;
      }
    }
  } catch {
    // Aborted mid-stream: fall through to whatever is left in `pending` below.
  }
  try {
    return streaming ? scan(pending) : find(JSON.parse(pending));
  } catch {
    return undefined;
  }
}

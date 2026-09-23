import type { Config } from "./config.js";
import type { Json, RouterInput, Turn } from "./types.js";

export type Limits = Pick<Config, "maxStateChars" | "maxMessageChars">;

/** Keep the head and tail of long text; the middle is what matters least for routing. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = " …[truncated]… ";
  if (max < marker.length) return prefix(text, max);
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  const tailStart = text.length - (keep - head);
  const tail = text.slice(tailStart);
  return prefix(text, head) + marker + (/^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail);
}

function prefix(text: string, max: number): string {
  const result = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/u.test(result) ? result.slice(0, -1) : result;
}

/** Jev is text-only: flatten content parts and leave a placeholder for anything else. */
export function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: { type?: string; text?: unknown }) =>
      typeof part?.text === "string" ? part.text : `[${part?.type ?? "attachment"}]`,
    )
    .join("\n");
}

function record(value: Json | undefined): value is Turn {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge dependency spans, so call A, call B, result A, result B remain one ordered group. */
function interactionGroups(turns: Turn[]): { start: number; end: number; ambiguous: boolean }[] {
  const ends = turns.map((_turn, index) => index);
  const invalid = new Set<number>();
  const calls: { index: number; id: Json | undefined; name: Json | undefined; done: boolean }[] = [];
  const byId = new Map<string, typeof calls>();
  turns.forEach((turn, index) => {
    for (const call of Array.isArray(turn.tool_calls) ? turn.tool_calls : []) {
      if (!record(call)) { invalid.add(index); continue; }
      const entry = { index, id: call.call_id, name: call.tool, done: false };
      calls.push(entry);
      if (typeof entry.id === "string") {
        const prior = byId.get(entry.id) ?? [];
        if (prior.length) { invalid.add(index); prior.forEach((item) => invalid.add(item.index)); }
        prior.push(entry);
        byId.set(entry.id, prior);
      }
    }
    if (turn.role !== "tool_result") return;
    const candidates = typeof turn.call_id === "string" ? byId.get(turn.call_id) ?? []
      : calls.filter((call) => call.id === undefined && !call.done && call.name === turn.tool);
    const call = candidates[0];
    if (candidates.length !== 1 || !call || call.done) { invalid.add(index); return; }
    call.done = true;
    ends[call.index] = Math.max(ends[call.index]!, index);
  });
  const groups = [];
  for (let start = 0; start < turns.length;) {
    let end = ends[start]!;
    let ambiguous = false;
    for (let index = start; index <= end; index++) {
      end = Math.max(end, ends[index]!);
      ambiguous ||= invalid.has(index);
    }
    groups.push({ start, end, ambiguous });
    start = end + 1;
  }
  return groups;
}

/** Keep a contiguous suffix of complete groups, with explicit clipping metadata. */
export function buildState(input: Pick<RouterInput, "system" | "turns">, limits: Limits): { [key: string]: Json } {
  const groups = interactionGroups(input.turns);
  const unusable = { conversation: [], unrepresentable: true };
  const render = (start: number, cap: number): { [key: string]: Json } => {
    let clipped = false;
    const clip = (text: string): string => {
      const result = truncate(text, cap);
      clipped ||= result !== text;
      return result;
    };
    const system = clip(input.system);
    const conversation = structuredClone(input.turns.slice(start));
    for (const turn of conversation) {
      for (const key of ["text", "content"]) if (typeof turn[key] === "string") turn[key] = clip(turn[key]);
      for (const call of Array.isArray(turn.tool_calls) ? turn.tool_calls : []) {
        if (record(call) && typeof call.arguments === "string") call.arguments = clip(call.arguments);
      }
    }
    return { ...(system ? { assistant_instructions: system } : {}),
      ...(start ? { earlier_turns_omitted: start } : {}), ...(clipped ? { clipped: true } : {}), conversation };
  };
  let kept: { [key: string]: Json } | undefined;
  // ponytail: exact suffix serialization is quadratic in retained turns; cache group sizes if profiling warrants it.
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group.ambiguous) return kept ?? unusable;
    const candidate = render(group.start, limits.maxMessageChars);
    if (JSON.stringify(candidate).length <= limits.maxStateChars) { kept = candidate; continue; }
    if (kept) break;
    let low = 0;
    let high = limits.maxMessageChars;
    let smallest = render(group.start, 0);
    if (JSON.stringify(smallest).length > limits.maxStateChars) return unusable;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const probe = render(group.start, middle);
      if (JSON.stringify(probe).length <= limits.maxStateChars) { smallest = probe; low = middle + 1; }
      else high = middle - 1;
    }
    return smallest;
  }
  return kept ?? unusable;
}

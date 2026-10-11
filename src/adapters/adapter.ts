import type { Decision } from "../decide.js";
import type { DirectCall, RouterInput } from "../types.js";

/** Metadata the gateway uses for logging. */
export interface RequestMetadata {
  model?: string;
  tools?: number;
}

/** Translates one client wire format to and from the router's neutral shapes. */
export interface Adapter<Req extends { model?: string; stream?: boolean }> {
  /** Binary formats decode the body themselves; absent means the router parses JSON. */
  parse?(bytes: Uint8Array, encoding?: string): Req | undefined;
  /** Re-serialize a rewritten request; absent means JSON.stringify. */
  encode?(req: Req): string | Uint8Array;
  /** What Jev should judge, or why this request isn't routable. */
  toInput(req: Req, maxMessageChars: number): RouterInput | { skip: string };
  /** Rewrite the request so the LLM only does the part of the work Jev left for it. */
  apply(req: Req, decision: Decision, argsModel?: string): Req;
  directJson(req: Req, call: DirectCall): object;
  /** The streamed form of the same answer: an SSE body, or a body with its own content type. */
  directStream(req: Req, call: DirectCall, url: URL): string | { body: string | Uint8Array<ArrayBuffer>; contentType: string };
  /** Extra request metadata hidden in a provider-specific envelope or path. */
  metadata?(req: Req | undefined, url: URL): RequestMetadata;
}

export const sse = (events: { event?: string; data: string }[]): string =>
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${data}\n\n`).join("");

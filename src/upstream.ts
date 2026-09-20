import type { Config } from "./config.js";
import type { Profile } from "./profiles.js";

// Hop-by-hop and length/encoding headers must not cross the proxy: fetch re-frames
// (and transparently decompresses) bodies, so the originals would be wrong.
const DROPPED_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "content-encoding", "transfer-encoding"]);

export interface ForwardOptions {
  /**
   * Body to send instead of streaming the incoming one: the original bytes (already consumed
   * for routing), or a rewritten JSON string — which is never compressed, whatever came in.
   */
  body?: string | Uint8Array;
  /** Headers added to the response so callers can see what the router did. */
  responseHeaders?: Record<string, string>;
  /** The tool this request came in under: its own upstream, and a path prefix to take off first. */
  profile?: Profile;
}

/**
 * A client that hangs up mid-stream aborts the upstream read, which surfaces as a stream error
 * and gets logged as one by the HTTP server. It isn't: Codex closes every SSE stream as soon as
 * it has `response.completed`. End the body quietly instead; real upstream errors still propagate.
 */
function quietOnClientAbort(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (!body) return body;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (signal.aborted) controller.close();
        else controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Proxy a gateway request (`/v1/...`) to the upstream API, streaming the response back. */
export async function forward(
  incoming: Request,
  config: Config,
  fetchImpl: typeof fetch,
  options: ForwardOptions = {},
): Promise<Response> {
  const url = new URL(incoming.url);
  // The upstream base already ends in its own `/v1`, so that one segment is dropped. Only that
  // segment: Gemini's `/v1beta/...` is a different prefix and goes upstream as it came.
  const { profile } = options;
  const path = profile && url.pathname.startsWith(`/${profile.name}/`) ? url.pathname.slice(profile.name.length + 1) : url.pathname;
  const target = (profile?.upstream ?? config.upstreamBaseUrl) + path.replace(/^\/v1(?=\/|$)/, "") + url.search;

  const headers = new Headers();
  incoming.headers.forEach((value, name) => {
    if (!DROPPED_REQUEST_HEADERS.has(name) && !name.startsWith("x-jev-")) headers.set(name, value);
  });
  if (config.upstreamApiKey) headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  if (typeof options.body === "string") headers.delete("content-encoding");

  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers, signal: incoming.signal };
  if (options.body !== undefined) {
    init.body = options.body as BodyInit;
  } else if (hasBody && incoming.body) {
    init.body = incoming.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { message: `jev-gateway could not reach upstream: ${message}`, type: "upstream_unreachable" } },
      { status: 502, headers: options.responseHeaders },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
  });
  for (const [name, value] of Object.entries(options.responseHeaders ?? {})) responseHeaders.set(name, value);
  return new Response(quietOnClientAbort(upstream.body, incoming.signal), { status: upstream.status, headers: responseHeaders });
}

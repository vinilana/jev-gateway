import { timingSafeEqual } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Hono, type Context } from "hono";
import type { Adapter } from "./adapters/adapter.js";
import { chatAdapter } from "./adapters/chat.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { KIRO_CHAT_TARGET, kiroAdapter } from "./adapters/kiro.js";
import { messagesAdapter } from "./adapters/messages.js";
import { responsesAdapter } from "./adapters/responses.js";
import type { Config } from "./config.js";
import { dashboardRoutes } from "./dashboard.js";
import { redactHeaders, summarizeResponse, type Dump } from "./debug.js";
import { decide, type AskJev, type Decision } from "./decide.js";
import { createEventLog, type EventLog } from "./events.js";
import { forward } from "./upstream.js";
import { readUsage } from "./usage.js";

export interface Deps {
  config: Config;
  askJev: AskJev;
  /** Upstream transport; defaults to global fetch. */
  fetch?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
  /** What the dashboard shows; defaults to an empty in-memory log. */
  events?: EventLog;
  /** Opt-in wire dumps (see debug.ts); off by default. */
  dump?: Dump;
}

type AnyRequest = { model?: string; stream?: boolean; tools?: unknown[] };

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const DECODERS: Record<string, (data: Uint8Array) => Buffer> = {
  zstd: zstdDecompressSync,
  gzip: gunzipSync,
  br: brotliDecompressSync,
  deflate: inflateSync,
};

/** Parse a JSON body, undoing request compression (Codex sends zstd). Undefined if unreadable. */
function parseBody<Req>(bytes: Uint8Array, encoding: string | undefined): Req | undefined {
  try {
    const decoder = encoding ? DECODERS[encoding.trim().toLowerCase()] : undefined;
    if (encoding && !decoder) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(decoder ? decoder(bytes) : bytes).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Req) : undefined;
  } catch {
    return undefined;
  }
}

function decisionHeaders(decision: Decision): Record<string, string> {
  const headers: Record<string, string> = { "x-jev-gateway-mode": decision.mode };
  if (decision.mode === "passthrough") headers["x-jev-gateway-reason"] = decision.reason.slice(0, 120);
  if (decision.mode === "forced" || decision.mode === "direct" || decision.mode === "hint") {
    headers["x-jev-gateway-tool"] = decision.tool;
  }
  if (decision.jev) {
    headers["x-jev-gateway-confidence"] = decision.jev.confidence.toFixed(3);
    headers["x-jev-gateway-latency-ms"] = String(decision.jev.latencyMs);
  }
  return headers;
}

export function createApp({ config, askJev, fetch: fetchImpl = fetch, log: writeLog = () => {}, events = createEventLog(), dump }: Deps) {
  const app = new Hono();

  /** One routed request: a line in the log, and a row on the dashboard. */
  const log = (entry: Record<string, unknown>) => {
    writeLog(entry);
    events.record(entry);
  };

  /**
   * Log a forwarded request once its reply has ended, because that is when the provider says what
   * it cost. The reply is read from a clone in the background, so the client is never delayed.
   */
  const logWhenDone = (entry: Record<string, unknown>, response: Response, startedAt: number) => {
    const copy = response.clone();
    void readUsage(copy).then((usage) =>
      log({ ...entry, status: response.status, durationMs: Math.round(performance.now() - startedAt), ...(usage ? { usage } : {}) }),
    );
  };

  // Routing can be switched off at runtime to measure a baseline: same clients, same traffic,
  // same token accounting, but Jev is never asked and nothing is rewritten.
  let routing = config.routing;

  /**
   * Error bodies are the only documentation an undocumented backend offers, and a finished
   * stream's usage is the only way to see what a rewrite did to the prompt cache: keep both.
   * Reads a clone in the background, so the client's stream is never delayed.
   */
  const dumpResponse = (kind: string, response: Response, extra: Record<string, unknown> = {}) => {
    if (!dump) return;
    const failed = response.status >= 400;
    const copy = response.clone();
    void (async () => {
      let text = "";
      try {
        // Codex hangs up the moment it has `response.completed`, which aborts the upstream read
        // mid-stream: whatever arrived until then is the response.
        for await (const chunk of copy.body?.pipeThrough(new TextDecoderStream()) ?? []) text += chunk;
      } catch {}
      dump(failed ? kind : "response", {
        status: response.status,
        ...extra,
        ...(failed ? { body: text.slice(0, 20_000) } : summarizeResponse(text)),
      });
    })();
  };

  /**
   * The decision, plus how many tools the adapter found — they aren't always in `req.tools`.
   * Adapters read the request as the shape its API documents, and a body can be valid JSON without
   * being that shape (`"messages": [null]`). Whatever that makes them throw is not a reason to
   * fail the request: upstream gets to answer it, with its own error when it deserves one.
   */
  const decideFor = async <Req extends AnyRequest>(adapter: Adapter<Req>, req: Req): Promise<{ decision: Decision; tools?: number }> => {
    let input: ReturnType<Adapter<Req>["toInput"]>;
    try {
      input = adapter.toInput(req, config.maxMessageChars);
    } catch {
      return { decision: { mode: "passthrough", reason: "unreadable_request" } };
    }
    if ("skip" in input) return { decision: { mode: "passthrough", reason: input.skip } };
    try {
      return { decision: await decide(input, config, askJev), tools: input.tools.length };
    } catch (error) {
      return { decision: { mode: "passthrough", reason: `router_error: ${error instanceof Error ? error.message : String(error)}` }, tools: input.tools.length };
    }
  };

  const route = <Req extends AnyRequest>(adapter: Adapter<Req>) => async (c: Context) => {
    const startedAt = performance.now();
    const time = new Date().toISOString();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    // Unreadable bodies are not ours to judge: upstream produces its own error for them.
    const req = parseBody<Req>(bytes, c.req.header("content-encoding"));
    dump?.("request", {
      method: c.req.method,
      path: c.req.path,
      headers: redactHeaders(c.req.raw.headers),
      body: req ?? `[unparseable, ${bytes.length} bytes]`,
    });

    let decision: Decision;
    let tools: number | undefined;
    if (!req) decision = { mode: "passthrough", reason: "unparseable_body" };
    else if (c.req.header("x-jev-gateway") === "off") decision = { mode: "passthrough", reason: "disabled_by_header" };
    else if (!routing) decision = { mode: "passthrough", reason: "routing_disabled" };
    else ({ decision, tools } = await decideFor(adapter, req));

    const url = new URL(c.req.url);
    const fromUrl = adapter.fromUrl?.(url) ?? {};
    const entry = { event: "route", time, path: c.req.path, model: req?.model ?? fromUrl.model, tools: tools ?? req?.tools?.length ?? 0 };
    // Building an answer or a rewrite is the gateway's own work. If it breaks, the original
    // request still goes upstream: the router must never be the reason a request fails.
    const giveUp = (error: unknown): Decision => ({
      mode: "passthrough",
      reason: `router_error: ${error instanceof Error ? error.message : String(error)}`,
      jev: decision.jev,
    });

    if (req && decision.mode === "direct") {
      try {
        const call = { tool: decision.tool, args: decision.args, inputTokens: decision.jev?.inputTokens ?? 0 };
        const headers = decisionHeaders(decision);
        const streamed = (fromUrl.stream ?? req.stream) ? adapter.directStream(req, call, url) : undefined;
        const json = streamed === undefined ? adapter.directJson(req, call) : undefined;
        log({ ...entry, ...decision });
        if (streamed === undefined) return c.json(json, 200, headers);
        if (typeof streamed !== "string") return c.body(streamed.body, 200, { ...headers, "content-type": streamed.contentType });
        return c.body(streamed, 200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
      } catch (error) {
        decision = giveUp(error);
      }
    }

    let rewritten: Req | undefined;
    if (req && decision.mode !== "passthrough") {
      try {
        rewritten = adapter.apply(req, decision, config.argsModel);
      } catch (error) {
        decision = giveUp(error);
      }
    }

    if (rewritten && decision.mode !== "passthrough") {
      const body = JSON.stringify(rewritten);
      const response = await forward(c.req.raw, config, fetchImpl, { body, responseHeaders: decisionHeaders(decision) });
      const sent = { mode: decision.mode, model: rewritten.model, tool_choice: (rewritten as { tool_choice?: unknown }).tool_choice };
      dumpResponse("rejected", response, { sent });
      if (response.status !== 400 && response.status !== 422) {
        logWhenDone({ ...entry, ...decision }, response, startedAt);
        return response;
      }
      // The upstream refused the rewritten request (some backends only accept tool_choice
      // "auto"): the router must never be the reason a request fails, so replay the original.
      await response.body?.cancel();
      decision = { mode: "passthrough", reason: `upstream_rejected_${decision.mode}`, jev: decision.jev };
    }

    const response = await forward(c.req.raw, config, fetchImpl, {
      body: bytes,
      responseHeaders: decisionHeaders(decision),
    });
    logWhenDone({ ...entry, ...decision }, response, startedAt);
    dumpResponse("upstream-error", response);
    return response;
  };

  // Answers before the key is checked, so that a launcher can find its gateway. A gateway that
  // has a key is one somebody else may reach: it says that it is up, and nothing about itself.
  app.get("/health", (c) =>
    c.json(config.routerApiKey ? { status: "ok" } : { status: "ok", pid: process.pid, upstream: config.upstreamBaseUrl, jev: config.jevProvider }),
  );

  app.use("*", async (c, next) => {
    if (!config.routerApiKey) return next();
    // A browser can't attach a header to a page it navigates to, so the dashboard — and only the
    // dashboard — may carry the key as `?key=`.
    const inQuery = c.req.path.startsWith("/dashboard") ? c.req.query("key") : undefined;
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? inQuery ?? "";
    if (safeEqual(presented, config.routerApiKey)) return next();
    return c.json({ error: { message: "Invalid jev-gateway API key", type: "invalid_api_key" } }, 401);
  });

  /**
   * Dry run: what would the router do with this body? Calls Jev, never upstream.
   * Accepts any routed wire format; `?format=chat|responses|messages` overrides the guess.
   */
  app.post("/router/decide", async (c) => {
    const req = parseBody<Record<string, unknown>>(new Uint8Array(await c.req.arrayBuffer()), undefined);
    if (!req) return c.json({ error: { message: "Body must be a JSON object", type: "invalid_request_error" } }, 400);
    const adapters = { chat: chatAdapter, responses: responsesAdapter, messages: messagesAdapter, gemini: geminiAdapter, kiro: kiroAdapter };
    // Chat Completions and Anthropic Messages both use `messages`; only Anthropic has a top-level
    const tools = Array.isArray(req.tools) ? (req.tools as Record<string, unknown>[]) : [];
    const guess = "conversationState" in req
      ? "kiro"
      : "contents" in req
        ? "gemini"
        : !("messages" in req)
          ? "responses"
          : "system" in req || tools.some((tool) => "input_schema" in tool)
            ? "messages"
            : "chat";
    const format = (c.req.query("format") ?? guess) as keyof typeof adapters;
    const adapter = (adapters[format] ?? adapters[guess]) as Adapter<AnyRequest>;
    return c.json((await decideFor(adapter, req)).decision);
  });

  app.route(
    "/dashboard",
    dashboardRoutes(config, events, { get: () => routing, set: (enabled) => void (routing = enabled) }),
  );

  app.post("/v1/chat/completions", route(chatAdapter));
  app.post("/v1/responses", route(responsesAdapter));
  app.post("/v1/messages", route(messagesAdapter));
  app.post("/v1beta/models/*", route(geminiAdapter));

  // Everything else (models, embeddings, …) is proxied untouched.
  const proxy = async (c: Context) => {
    const response = await forward(c.req.raw, config, fetchImpl);
    dump?.("other", { method: c.req.method, path: c.req.path, headers: redactHeaders(c.req.raw.headers), status: response.status });
    return response;
  };
  app.all("/v1/*", proxy);
  app.all("/v1beta/*", proxy);

  const kiroChat = route(kiroAdapter);
  app.post("/", async (c) => {
    const target = c.req.header("x-amz-target");
    if (!target) return c.notFound();
    return target === KIRO_CHAT_TARGET ? kiroChat(c) : proxy(c);
  });

  return app;
}

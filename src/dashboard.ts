import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Config } from "./config.js";
import type { EventLog } from "./events.js";
import type { Profile } from "./profiles.js";

// A real .html file rather than a string in a module, so it stays editable as HTML; `pnpm build`
// copies it next to the compiled output.
const page = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

/**
 * jev-codex and jev-claude each run their own router, and one page should show both: a dashboard
 * served by one router polls the others. Only a page that itself came from this machine may read
 * across ports — any other origin gets no CORS header, so the browser withholds the response.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface RoutingSwitch {
  get(): boolean;
  set(enabled: boolean): void;
}

export function dashboardRoutes(config: Config, events: EventLog, routing: RoutingSwitch, profiles: Profile[] = []) {
  const startedAt = new Date().toISOString();
  const routes = new Hono();

  routes.get("/", (c) => c.html(page));

  routes.get("/events", (c) => {
    const origin = c.req.header("origin");
    if (origin && LOCAL_ORIGIN.test(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "origin");
    }
    c.header("cache-control", "no-store");
    const since = Number(c.req.query("since") ?? 0);
    return c.json({
      router: {
        client: config.client,
        upstream: config.upstreamBaseUrl,
        jevModel: config.jevModel,
        jevProvider: config.jevProvider,
        tools: profiles.map((profile) => ({ name: profile.name, upstream: profile.upstream })),
        minConfidence: config.minConfidence,
        routing: routing.get(),
        // Sequence numbers restart with the process: a page that sees this change starts over.
        startedAt,
        now: new Date().toISOString(),
        recorded: events.last,
      },
      events: events.since(Number.isFinite(since) ? since : 0),
    });
  });

  /**
   * Turn Jev routing on or off without a restart, to compare token use with and without it. A
   * bodyless POST needs no CORS preflight, so the origin is checked here instead: browsers always
   * name the origin of a cross-site POST, and only this machine's own pages may flip the switch.
   */
  routes.post("/routing", (c) => {
    const origin = c.req.header("origin");
    if (origin && !LOCAL_ORIGIN.test(origin)) return c.json({ error: "local pages only" }, 403);
    if (origin) c.header("access-control-allow-origin", origin);
    const enabled = c.req.query("enabled");
    if (enabled !== "true" && enabled !== "false") return c.json({ error: "enabled must be true or false" }, 400);
    routing.set(enabled === "true");
    return c.json({ routing: routing.get() });
  });

  return routes;
}

// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
// so a benchmark drives an agent exactly the way `jev-codex`, `jev-claude`, and `jev-opencode` do.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex talks to a different backend depending on how the user logged in. */
function codexUpstream() {
  if (process.env.JEV_CODEX_UPSTREAM_BASE_URL) return process.env.JEV_CODEX_UPSTREAM_BASE_URL;
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (auth.auth_mode === "chatgpt" || (auth.tokens && !auth.OPENAI_API_KEY)) {
      return "https://chatgpt.com/backend-api/codex";
    }
  } catch {
    // No readable login: assume API-key usage.
  }
  return "https://api.openai.com/v1";
}

const codexProvider = (origin) => ({
  name: `"jev-gateway"`,
  base_url: `"${origin}/v1"`,
  wire_api: `"responses"`,
  // Reuse whatever login Codex already has; the gateway forwards it upstream untouched.
  requires_openai_auth: "true",
});

export const codex = {
  name: "jev-codex",
  client: "codex",
  portEnv: "JEV_CODEX_PORT",
  defaultPort: 8790,
  upstream: codexUpstream,
  upstreamHelp:
    "JEV_CODEX_UPSTREAM_BASE_URL   where Codex traffic goes; default follows your Codex login:\n" +
    "                                ChatGPT login → https://chatgpt.com/backend-api/codex\n" +
    "                                API key       → https://api.openai.com/v1",
  args: (origin) => [
    "-c",
    `model_provider="jev-gateway"`,
    ...Object.entries(codexProvider(origin)).flatMap(([key, value]) => ["-c", `model_providers.jev-gateway.${key}=${value}`]),
  ],
  configHelp: (origin) =>
    `# Save as ~/.codex/jev.config.toml, keep the gateway running (jev-codex --start),\n` +
    `# then use: codex --profile jev\n` +
    `model_provider = "jev-gateway"\n\n[model_providers.jev-gateway]\n` +
    Object.entries(codexProvider(origin))
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n"),
};

export const claude = {
  name: "jev-claude",
  client: "claude",
  portEnv: "JEV_CLAUDE_PORT",
  defaultPort: 8789,
  upstream: () => process.env.JEV_CLAUDE_UPSTREAM_BASE_URL ?? "https://api.anthropic.com/v1",
  upstreamHelp: "JEV_CLAUDE_UPSTREAM_BASE_URL   where Claude traffic goes (default https://api.anthropic.com/v1)",
  // Only the base URL is set. With no gateway credential alongside it, Claude Code keeps using its
  // saved claude.ai login, so a Pro/Max subscription (or an existing API key) keeps working as is.
  env: (origin) => ({ ANTHROPIC_BASE_URL: origin }),
  configHelp: (origin) =>
    `# Keep the gateway running (jev-claude --start), then either:\n` +
    `#   ANTHROPIC_BASE_URL=${origin} claude\n` +
    `# or add to ~/.claude/settings.json:\n` +
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin } }, null, 2),
};

const OPENCODE_PROVIDER = "jev-gateway";
const OPENCODE_UPSTREAMS = { opencode: "https://opencode.ai/zen/v1", "opencode-go": "https://opencode.ai/zen/go/v1" };

const isLocalHost = (hostname) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.") || host.startsWith("::ffff:127.") || host === "::ffff:7f00:1";
};

/** A local gateway cannot be an upstream, including one started for another client. */
function isGatewayAddress(url, env) {
  const ports = [8787, 8788, 8789, 8790, 8791, ...Object.entries(env).filter(([name]) => /^JEV_[A-Z]+_PORT$/.test(name)).map(([, value]) => Number(value))];
  return isLocalHost(url.hostname) && ports.includes(Number(url.port));
}

/** Follow only ordinary API roots: resolved tokens in a URL path or query must never reach /health or logs. */
function safeUpstream(value, env) {
  if (typeof value !== "string" || value.includes("{")) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    const builtIn = Object.values(OPENCODE_UPSTREAMS).some((upstream) => value === upstream || value === `${upstream}/`);
    if (!builtIn && !["/", "/v1", "/v1/", "/api/v1", "/api/v1/"].includes(url.pathname)) return undefined;
    if (isGatewayAddress(url, env)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** The user's resolved OpenCode config comes from OpenCode itself, before gateway settings are injected. */
export function detectOpencode(resolved, env = process.env) {
  const override = env.JEV_OPENCODE_UPSTREAM_BASE_URL;
  if (override && !safeUpstream(override, env)) {
    throw new Error("JEV_OPENCODE_UPSTREAM_BASE_URL must be a /v1 API root outside Jev (value omitted because URLs may contain secrets)");
  }
  const openai = { upstream: override ?? "https://api.openai.com/v1", model: env.JEV_OPENCODE_MODEL ?? "gpt-5" };
  if (env.JEV_OPENCODE_MODEL) return openai;
  const id = providerOf(resolved?.model);
  if (id && Object.hasOwn(OPENCODE_UPSTREAMS, id)) return { upstream: override ?? OPENCODE_UPSTREAMS[id], rebind: id };
  const provider = id && id !== OPENCODE_PROVIDER && isObject(resolved?.provider) ? resolved.provider[id] : undefined;
  const baseURL = provider?.npm === "@ai-sdk/openai-compatible" ? safeUpstream(provider.options?.baseURL, env) : undefined;
  if (baseURL) return { upstream: override ?? baseURL, rebind: id };
  if (!env.OPENAI_API_KEY && env.OPENCODE_API_KEY) return { upstream: override ?? OPENCODE_UPSTREAMS.opencode, rebind: "opencode" };
  return openai;
}

/** An unknown local port may also be another Jev gateway. */
async function checkLocalUpstream(upstream, fetchImpl = fetch) {
  const url = new URL(upstream);
  if (!isLocalHost(url.hostname)) return;
  try {
    const response = await fetchImpl(new URL("/health", url), { signal: AbortSignal.timeout(500) });
    if (!response.ok) return;
    const health = await response.json();
    if (health?.status === "ok" && typeof health.upstream === "string" && typeof health.jev === "string") {
      throw new Error("OpenCode upstream is another Jev gateway; use the original provider URL");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OpenCode upstream is another Jev gateway")) throw error;
  }
}

// Direct spec calls keep the original OpenAI default; the launcher passes OpenCode's resolved setup.
const directOpencodeSetup = () => detectOpencode(undefined, { JEV_OPENCODE_MODEL: process.env.JEV_OPENCODE_MODEL });

/**
 * Stable custom-provider config for the launched OpenCode process. Injected through
 * OPENCODE_CONFIG_CONTENT — inline config merges over the user's global/project files, which
 * are never written. `@ai-sdk/openai-compatible` speaks `/v1/chat/completions` off
 * `${origin}/v1`, an endpoint the gateway already routes. `{env:OPENAI_API_KEY}` reuses the
 * user's own OpenAI credential untouched (resolving to empty when unset, like OpenCode's own
 * local-provider examples). The launcher-spawned gateway forwards that client credential
 * untouched: launcher.mjs strips UPSTREAM_API_KEY/ROUTER_API_KEY by design, so no gateway
 * key swap applies here. TYPESAFE_API_KEY is separate — it only authorizes the Jev
 * tool-selection call and is never sent as the LLM upstream credential.
 */
function opencodeInlineConfig(origin, setup = directOpencodeSetup()) {
  if (setup.rebind) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: { [setup.rebind]: { options: { baseURL: `${origin}/v1` } } },
    };
  }
  const model = setup.model;
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${model}`,
    small_model: `${OPENCODE_PROVIDER}/${model}`,
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Jev Gateway",
        options: { baseURL: `${origin}/v1`, apiKey: "{env:OPENAI_API_KEY}" },
        models: { [model]: { name: `Jev Gateway (${model})` } },
      },
    },
  };
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Each matches a whole string first, so that `//` in a URL and a comma inside quotes are kept.
const JSONC_COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const JSONC_TRAILING_COMMA = /"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g;
const keepStrings = (match) => (match.startsWith('"') ? match : "");

/**
 * OpenCode reads its inline config as JSONC, comments and trailing commas included, so plain
 * `JSON.parse` would throw away content OpenCode accepts. Undefined when it does not parse.
 */
export function parseJsonc(text) {
  try {
    return JSON.parse(text.replace(JSONC_COMMENT, keepStrings).replace(JSONC_TRAILING_COMMA, keepStrings));
  } catch {
    return undefined;
  }
}

/**
 * OPENCODE_CONFIG_CONTENT is one variable, and the user may already be using it. Theirs is kept
 * and the gateway's is laid over it: the default models and the `jev-gateway` provider are the
 * launcher's to set, everything else (agents, permissions, other providers) stays as they wrote
 * it. Content that is not a JSON object cannot be merged, so it is dropped, and the notices say so.
 */
export function opencodeConfigContent(origin, inherited, setup = directOpencodeSetup()) {
  const ours = opencodeInlineConfig(origin, setup);
  const theirs = inherited?.trim() ? parseJsonc(inherited) : undefined;
  if (!isObject(theirs)) return JSON.stringify(ours);
  const provider = { ...(isObject(theirs.provider) ? theirs.provider : {}) };
  for (const [id, change] of Object.entries(ours.provider)) {
    const previous = isObject(provider[id]) ? provider[id] : {};
    provider[id] = { ...previous, ...change, options: { ...(isObject(previous.options) ? previous.options : {}), ...change.options } };
  }
  return JSON.stringify({ ...theirs, ...ours, provider });
}

const providerOf = (model) => (typeof model === "string" && model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined);

/** The value of `-m` / `--model` among the arguments meant for OpenCode, if there is one. */
function modelFlag(argv) {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") return undefined;
    if (arg === "-m" || arg === "--model") return argv[index + 1];
    if (arg.startsWith("--model=")) return arg.slice("--model=".length);
    if (/^-m./.test(arg)) return arg.slice(2).replace(/^=/, "");
  }
  return undefined;
}

/**
 * What in this OpenCode session will not go through the gateway, as lines for the user.
 *
 * The launcher sets the *default* model to one served by the gateway. OpenCode lets an agent name
 * a model of its own (`agent.<name>.model`, or `model:` in an agent's markdown file), and `-m`
 * outranks everything: either one selects another provider, whose traffic goes straight to that
 * provider. Those are the user's choices and are left alone, but a session that quietly skips Jev
 * looks exactly like one where Jev had nothing to decide, so they are said out loud.
 *
 * `resolved` comes from OpenCode's own v1 config command or v2 local API. A provider counts as covered by
 * where it sends requests, not by its name, so one the user pointed at the gateway (`origin`)
 * themselves is not reported.
 */
export function opencodeOutsideGateway(resolved, argv = [], origin) {
  const providers = isObject(resolved) && isObject(resolved.provider) ? resolved.provider : {};
  const covered = (model) => {
    const id = providerOf(model);
    if (id === OPENCODE_PROVIDER) return true;
    const baseURL = id === undefined ? undefined : providers[id]?.options?.baseURL;
    return origin !== undefined && typeof baseURL === "string" && (baseURL === origin || baseURL.startsWith(`${origin}/`));
  };
  const outside = [];
  const flag = modelFlag(argv);
  if (flag !== undefined && !covered(flag)) outside.push(`this session (--model ${flag})`);
  if (isObject(resolved)) {
    if (!covered(resolved.model)) outside.push(`the default model (${resolved.model ?? "none"})`);
    for (const [name, agent] of Object.entries(isObject(resolved.agent) ? resolved.agent : {})) {
      if (!isObject(agent) || agent.disable === true || typeof agent.model !== "string") continue;
      if (!covered(agent.model)) outside.push(`agent "${name}" (${agent.model})`);
    }
  }
  if (outside.length === 0) return [];
  return [
    "these go straight to their provider, not through the gateway, because they name a model of their own:",
    ...outside.map((line) => `  - ${line}`),
    `Jev sees requests sent to ${origin ?? "the gateway"}. Agents without a model of their own use the default.`,
  ];
}

/** Run a local OpenCode inspection command. None of its output is logged: provider settings may contain keys. */
function opencodeJson(args, env) {
  return new Promise((resolve) => {
    execFile("opencode", args, { env, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const start = stdout.search(/^[{[]/m);
      if (start < 0) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** V1 prints a resolved object; V2 exposes the selected model and provider through its local API. */
async function opencodeResolvedConfig(env) {
  const old = await opencodeJson(["debug", "config"], env);
  if (isObject(old) && typeof old.model === "string") return old;
  const [model, providers, agents] = await Promise.all([
    opencodeJson(["api", "--standalone", "model.default"], env),
    opencodeJson(["api", "--standalone", "provider.list"], env),
    opencodeJson(["api", "--standalone", "agent.list"], env),
  ]);
  const selected = model?.data;
  if (typeof selected?.providerID !== "string" || typeof selected?.modelID !== "string") return undefined;
  const provider = Array.isArray(providers?.data) ? providers.data.find((entry) => entry?.id === selected.providerID) : undefined;
  const agent = Object.fromEntries((Array.isArray(agents?.data) ? agents.data : []).flatMap((entry) =>
    typeof entry?.name === "string" && typeof entry?.model?.providerID === "string" && typeof entry?.model?.modelID === "string"
      ? [[entry.name, { model: `${entry.model.providerID}/${entry.model.modelID}` }]] : []));
  return {
    model: `${selected.providerID}/${selected.modelID}`,
    provider: { [selected.providerID]: { npm: provider?.package, options: { baseURL: provider?.settings?.baseURL } } },
    agent,
  };
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  detect: async (inherited = process.env, fetchImpl = fetch) => {
    const setup = detectOpencode(await opencodeResolvedConfig(inherited), inherited);
    await checkLocalUpstream(setup.upstream, fetchImpl);
    return setup;
  },
  upstream: (setup = detectOpencode(undefined, process.env)) => setup.upstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default follows its selected provider)\n" +
    "  JEV_OPENCODE_MODEL               use jev-gateway/<model> on OpenAI instead of following the config\n" +
    "  JEV_OPENCODE_CHECK               off skips listing the agents that bypass the gateway (saves about a second)",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag forwards untouched.
  // The two experimental flags stay off for the launched process only (environment, never a user
  // file): the stable AI SDK provider path above is the supported one.
  env: (origin, inherited = process.env, setup = directOpencodeSetup()) => ({
    OPENCODE_CONFIG_CONTENT: opencodeConfigContent(origin, inherited.OPENCODE_CONFIG_CONTENT, setup),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
  // Asking OpenCode costs about a second, which is OpenCode loading its configuration.
  // JEV_OPENCODE_CHECK=off skips that part; an inline config that had to be dropped is always said.
  notices: async (origin, argv, inherited = process.env, setup = detectOpencode(undefined, inherited)) => {
    const content = inherited.OPENCODE_CONFIG_CONTENT;
    const dropped = content?.trim() && !isObject(parseJsonc(content))
      ? ["OPENCODE_CONFIG_CONTENT in your environment is not a JSON object, so this session gets only the gateway's settings from it."]
      : [];
    if (inherited.JEV_OPENCODE_CHECK === "off") return dropped;
    const resolved = await opencodeResolvedConfig({ ...inherited, ...opencode.env(origin, inherited, setup) });
    const outside = opencodeOutsideGateway(resolved, argv, origin);
    // The launcher prefixes only the first line with its name; a second notice needs its own.
    return dropped.length && outside.length ? [...dropped, `${opencode.name}: ${outside[0]}`, ...outside.slice(1)] : [...dropped, ...outside];
  },
  configHelp: (origin, setup = directOpencodeSetup()) => {
    // No OPENCODE_CONFIG_CONTENT one-liner here: single-quoting raw JSON breaks when a custom
    // model ID contains an apostrophe. The opencode.json file workflow below needs no shell
    // quoting and matches what `jev-opencode --print-config` documents.
    const config = opencodeInlineConfig(origin, setup);
    const manual = JSON.stringify(setup.rebind ? { provider: config.provider } : { model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    const start = setup.rebind && !Object.hasOwn(OPENCODE_UPSTREAMS, setup.rebind)
      ? `# Start with: JEV_OPENCODE_UPSTREAM_BASE_URL=${setup.upstream} jev-opencode --start\n`
      : "";
    return (
      start +
      `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
      `# (project root or ~/.config/opencode/opencode.json):\n` +
      `${manual}\n` +
      (setup.rebind ? "# Keep your selected model; only this provider's baseURL moves." : `# then select it with: opencode --model ${config.model}`)
    );
  },
};
export const gemini = {
  name: "jev-gemini",
  client: "gemini",
  portEnv: "JEV_GEMINI_PORT",
  defaultPort: 8788,
  upstream: () => process.env.JEV_GEMINI_UPSTREAM_BASE_URL ?? "https://generativelanguage.googleapis.com",
  upstreamHelp: "JEV_GEMINI_UPSTREAM_BASE_URL   where Gemini traffic goes (default https://generativelanguage.googleapis.com)",
  env: (origin) => ({
    GEMINI_API_BASE: origin,
    GOOGLE_GEMINI_BASE_URL: origin,
  }),
  configHelp: (origin) =>
    `# Point your Gemini client or SDK at:\n` +
    `#   GEMINI_API_BASE=${origin}\n` +
    `#   or endpoint: ${origin}/v1beta\n`,
};

// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
// so a benchmark drives an agent exactly the way `jev-codex`, `jev-claude`, and `jev-opencode` do.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as clients from "./clients.mjs";

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
  return host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::ffff:7f00:1"
    || host.startsWith("127.") || host.startsWith("::ffff:127.");
};

/** The plain gateway's own default `PORT` (src/config.ts). */
const GATEWAY_PORT = 8787;

/**
 * A local gateway cannot be an upstream, including one started for another client: Jev would be asked
 * twice. Every launcher in this module counts, so a new one is covered without being listed here.
 */
function isGatewayAddress(url, env) {
  const launchers = Object.values(clients).flatMap((spec) => (typeof spec?.defaultPort === "number" ? [spec.defaultPort] : []));
  const moved = Object.entries(env).filter(([name]) => /^JEV_[A-Z]+_PORT$/.test(name)).map(([, value]) => Number(value));
  return isLocalHost(url.hostname) && [GATEWAY_PORT, ...launchers, ...moved].includes(Number(url.port));
}

// Variables that hold credentials by name. Values shorter than 8 characters would match ordinary path words.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;
const SECRET_MIN_LENGTH = 8;

/**
 * A selected provider's address becomes the upstream, which /health, --status, the dashboard and the
 * log all show. OpenCode fills `{env:...}` in from any variable, so a token can arrive anywhere in it,
 * the path included; such an address is not followed.
 */
function followableAddress(value, env) {
  if (typeof value !== "string" || value.includes("{")) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    if (isGatewayAddress(url, env)) return undefined;
    const holdsSecret = Object.entries(env).some(([name, secret]) =>
      SECRET_NAME.test(name) && typeof secret === "string" && secret.length >= SECRET_MIN_LENGTH && value.includes(secret));
    return holdsSecret ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Where the gateway forwards, from the config OpenCode resolved before the launcher's is laid over it.
 * An explicit model or upstream is the user's own choice and is taken as given.
 */
export function detectOpencode(resolved, env = process.env) {
  const override = env.JEV_OPENCODE_UPSTREAM_BASE_URL;
  const openai = { upstream: override ?? "https://api.openai.com/v1", model: env.JEV_OPENCODE_MODEL ?? "gpt-5" };
  if (env.JEV_OPENCODE_MODEL) return openai;
  // Zen's or Go's own address names its provider, which is the way to route them where OpenCode cannot say.
  const named = Object.keys(OPENCODE_UPSTREAMS).find((id) => override?.replace(/\/+$/, "") === OPENCODE_UPSTREAMS[id]);
  if (named) return { upstream: override, rebind: named };
  if (override) return openai;
  const fallback = !env.OPENAI_API_KEY && env.OPENCODE_API_KEY ? { upstream: OPENCODE_UPSTREAMS.opencode, rebind: "opencode" } : openai;
  const id = providerOf(resolved?.model);
  if (id && Object.hasOwn(OPENCODE_UPSTREAMS, id)) return { upstream: OPENCODE_UPSTREAMS[id], rebind: id };
  const provider = id && id !== OPENCODE_PROVIDER && isObject(resolved?.provider) ? resolved.provider[id] : undefined;
  if (provider?.npm !== "@ai-sdk/openai-compatible") return fallback;
  const baseURL = followableAddress(provider.options?.baseURL, env);
  return baseURL ? { upstream: baseURL, rebind: id } : { ...fallback, unfollowed: id };
}

/** A local address on a port no launcher uses may still be another Jev gateway; its /health says so. */
async function isJevGateway(upstream, fetchImpl) {
  try {
    const url = new URL(upstream);
    if (!isLocalHost(url.hostname)) return false;
    const response = await fetchImpl(new URL("/health", url), { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.status === "ok" && typeof health.upstream === "string" && typeof health.jev === "string";
  } catch {
    return false;
  }
}

/** Throws only to stop the launcher with a one-line message: the user's own upstream cannot be used. */
async function checkOverride(override, env, fetchImpl) {
  let url;
  try {
    url = new URL(override);
  } catch {
    return;
  }
  if (isGatewayAddress(url, env) || (await isJevGateway(override, fetchImpl))) {
    throw new Error(`JEV_OPENCODE_UPSTREAM_BASE_URL points at a Jev gateway (${url.origin}); set it to the provider's own API root.`);
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
 * OpenCode and Kilo inline config each use one variable that the user may already set. Theirs is kept
 * and the gateway's is laid over it: the default models and the fields the launcher sets on a
 * provider are the launcher's, everything else (that provider's other options, agents, permissions,
 * other providers) stays as they wrote it. Content that is not a JSON object cannot be merged, so it
 * is dropped, and the notices say so.
 */
function inlineConfigContent(ours, inherited) {
  const theirs = inherited?.trim() ? parseJsonc(inherited) : undefined;
  if (!isObject(theirs)) return JSON.stringify(ours);
  const provider = { ...(isObject(theirs.provider) ? theirs.provider : {}) };
  for (const [id, change] of Object.entries(ours.provider)) {
    const previous = isObject(provider[id]) ? provider[id] : {};
    provider[id] = { ...previous, ...change, options: { ...(isObject(previous.options) ? previous.options : {}), ...change.options } };
  }
  return JSON.stringify({ ...theirs, ...ours, provider });
}

export function opencodeConfigContent(origin, inherited, setup = directOpencodeSetup()) {
  return inlineConfigContent(opencodeInlineConfig(origin, setup), inherited);
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

/**
 * Run a local OpenCode inspection command. None of its output is logged: provider settings may contain keys.
 * `answered` is false when OpenCode failed or printed no JSON, `timedOut` when it did not finish.
 */
function opencodeJson(args, env) {
  return new Promise((resolve) => {
    execFile("opencode", args, { env, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve({ timedOut: error.killed === true });
      // Log lines may come first, and may hold braces or brackets of their own: the JSON starts on a line of its own.
      const start = stdout.search(/^\{/m);
      if (start < 0) return resolve({});
      try {
        resolve({ json: JSON.parse(stdout.slice(start)) });
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * V1 prints a resolved object; V2 has no `debug config` and exposes the selected model and provider
 * through its local API instead. An OpenCode that hangs is asked nothing more, so it costs one timeout.
 */
async function opencodeResolvedConfig(env) {
  const old = await opencodeJson(["debug", "config"], env);
  if (isObject(old.json)) return old.json;
  if (old.timedOut) return undefined;
  const [{ json: model }, { json: providers }, { json: agents }] = await Promise.all([
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

/** A selected provider that is not followed falls back, and the user is told so in one line. */
function withWarning(setup) {
  if (setup.unfollowed === undefined) return setup;
  const warning = `the default model's provider "${setup.unfollowed}" has no address the launcher can follow ` +
    `(see "Where OpenCode traffic goes" in the README), so the gateway forwards to ${setup.upstream}.`;
  return { ...setup, warning };
}

/** What OpenCode resolves for this session, with the launcher's config in it. Undefined when it is not to be asked or cannot say. */
async function sessionConfig(origin, inherited, setup) {
  if (inherited.JEV_OPENCODE_CHECK === "off") return undefined;
  if (!Object.hasOwn(setup, "resolved")) return opencodeResolvedConfig({ ...inherited, ...opencode.env(origin, inherited, setup) });
  return isObject(setup.resolved) ? JSON.parse(opencodeConfigContent(origin, JSON.stringify(setup.resolved), setup)) : undefined;
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  // Run only where the upstream is chosen. `resolved` is kept so the notices need not ask again.
  detect: async (inherited = process.env, fetchImpl = fetch) => {
    const override = inherited.JEV_OPENCODE_UPSTREAM_BASE_URL;
    if (override) await checkOverride(override, inherited, fetchImpl);
    if (override || inherited.JEV_OPENCODE_MODEL || inherited.JEV_OPENCODE_CHECK === "off") return detectOpencode(undefined, inherited);
    const resolved = await opencodeResolvedConfig(inherited);
    const setup = detectOpencode(resolved, inherited);
    const custom = setup.rebind !== undefined && !Object.hasOwn(OPENCODE_UPSTREAMS, setup.rebind);
    if (custom && (await isJevGateway(setup.upstream, fetchImpl))) {
      return withWarning({ ...detectOpencode(undefined, inherited), unfollowed: setup.rebind, resolved });
    }
    return withWarning({ ...setup, resolved });
  },
  upstream: (setup = detectOpencode(undefined, process.env)) => setup.upstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default follows its selected provider)\n" +
    "  JEV_OPENCODE_MODEL               use jev-gateway/<model> on OpenAI instead of following the config\n" +
    "  JEV_OPENCODE_CHECK               off asks OpenCode nothing: no provider to follow, no list of agents that bypass the gateway",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag forwards untouched.
  // The two experimental flags stay off for the launched process only (environment, never a user
  // file): the stable AI SDK provider path above is the supported one.
  env: (origin, inherited = process.env, setup = directOpencodeSetup()) => ({
    OPENCODE_CONFIG_CONTENT: opencodeConfigContent(origin, inherited.OPENCODE_CONFIG_CONTENT, setup),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
  // Asking OpenCode costs about a second, which is OpenCode loading its configuration. When detection
  // already asked, its answer is reused with the launcher's config laid over it the same way the
  // session gets it. JEV_OPENCODE_CHECK=off skips that part; an inline config that had to be dropped
  // is always said.
  notices: async (origin, argv, inherited = process.env, setup = detectOpencode(undefined, inherited)) => {
    const content = inherited.OPENCODE_CONFIG_CONTENT;
    const dropped = content?.trim() && !isObject(parseJsonc(content))
      ? ["OPENCODE_CONFIG_CONTENT in your environment is not a JSON object, so this session gets only the gateway's settings from it."]
      : [];
    const resolved = await sessionConfig(origin, inherited, setup);
    const outside = resolved === undefined ? [] : opencodeOutsideGateway(resolved, argv, origin);
    // The launcher prefixes only the first line with its name; every later notice needs its own.
    return [dropped, outside].filter((lines) => lines.length > 0)
      .flatMap((lines, index) => (index === 0 ? lines : [`${opencode.name}: ${lines[0]}`, ...lines.slice(1)]));
  },
  configHelp: (origin) => {
    // No OPENCODE_CONFIG_CONTENT one-liner here: single-quoting raw JSON breaks when a custom
    // model ID contains an apostrophe. The opencode.json file workflow below needs no shell
    // quoting and matches what `jev-opencode --print-config` documents.
    const config = opencodeInlineConfig(origin);
    const manual = JSON.stringify({ model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    return (
      `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
      `# (project root or ~/.config/opencode/opencode.json):\n` +
      `${manual}\n` +
      `# then select it with: opencode --model ${config.model}\n` +
      `# To keep your own provider instead, set its options.baseURL to ${origin}/v1 and start the gateway\n` +
      `# with JEV_OPENCODE_UPSTREAM_BASE_URL set to the address it had.`
    );
  },
};
export const devin = {
  name: "jev-devin",
  client: "devin",
  portEnv: "JEV_DEVIN_PORT",
  defaultPort: 8792,
  upstream: () => process.env.JEV_DEVIN_UPSTREAM_BASE_URL ?? "https://server.codeium.com",
  upstreamHelp: "JEV_DEVIN_UPSTREAM_BASE_URL   where Devin traffic goes (default https://server.codeium.com)",
  // The variable's name is a leftover compiled into the devin binary itself; it is the only
  // knob that redirects the exa protocol. DEVIN_API_URL points at api.devin.ai instead.
  env: (origin) => ({ WINDSURF_API_SERVER_URL: origin }),
  configHelp: (origin) =>
    `# Keep the gateway running (jev-devin --start), then:\n` +
    `#   WINDSURF_API_SERVER_URL=${origin} devin\n`,
};

function kiloUpstream() {
  return process.env.JEV_KILO_UPSTREAM_BASE_URL ?? "https://api.kilo.ai/api/openrouter";
}

function kiloModel() {
  return process.env.JEV_KILO_MODEL ?? "kilo-auto/free";
}

// Kilo's built-in `kilo` provider cannot be reused: it appends `/openrouter/` to any base URL, which
// misses the routed endpoint. So Kilo gets a provider of its own, and the user's key reaches it
// through `{env:KILO_API_KEY}`, which Kilo expands itself, so the key never enters the config.
function kiloInlineConfig(origin) {
  const model = kiloModel();
  return {
    $schema: "https://kilo.ai/config.json",
    model: `${OPENCODE_PROVIDER}/${model}`,
    small_model: `${OPENCODE_PROVIDER}/${model}`,
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Jev Gateway",
        options: { baseURL: `${origin}/v1`, apiKey: "{env:KILO_API_KEY}" },
        models: { [model]: { name: `Jev Gateway (${model})` } },
      },
    },
  };
}

export const kilo = {
  name: "jev-kilo",
  client: "kilo",
  portEnv: "JEV_KILO_PORT",
  defaultPort: 8793,
  upstream: kiloUpstream,
  upstreamHelp:
    "JEV_KILO_UPSTREAM_BASE_URL   where Kilo traffic goes (default https://api.kilo.ai/api/openrouter)\n" +
    "JEV_KILO_MODEL               model selected as jev-gateway/<model> (default kilo-auto/free)\n" +
    "KILO_API_KEY                 your Kilo key, forwarded untouched; unset means free models only",
  env: (origin, inherited = process.env) => ({
    KILO_CONFIG_CONTENT: inlineConfigContent(kiloInlineConfig(origin), inherited.KILO_CONFIG_CONTENT),
  }),
  notices: (_origin, _argv, inherited = process.env) => {
    const content = inherited.KILO_CONFIG_CONTENT;
    return content?.trim() && !isObject(parseJsonc(content))
      ? ["KILO_CONFIG_CONTENT in your environment is not a JSON object, so this session gets only the gateway's settings from it."]
      : [];
  },
  configHelp: (origin) => {
    const config = kiloInlineConfig(origin);
    const manual = JSON.stringify({ model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    return (
      `# Keep the gateway running (jev-kilo --start), then add to kilo.jsonc\n` +
      `# (project root or ~/.config/kilo/kilo.jsonc):\n` +
      `${manual}\n` +
      `# then select it with: kilo --model ${config.model}`
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

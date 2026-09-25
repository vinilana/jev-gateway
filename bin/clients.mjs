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

/** Where OpenCode traffic goes by default; override with JEV_OPENCODE_UPSTREAM_BASE_URL. */
function opencodeUpstream() {
  return process.env.JEV_OPENCODE_UPSTREAM_BASE_URL ?? "https://api.openai.com/v1";
}

/** Model id selected as `jev-gateway/<model>`; override with JEV_OPENCODE_MODEL. */
function opencodeModel() {
  return process.env.JEV_OPENCODE_MODEL ?? "gpt-5";
}

const OPENCODE_PROVIDER = "jev-gateway";

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
function opencodeInlineConfig(origin) {
  const model = opencodeModel();
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
export function opencodeConfigContent(origin, inherited) {
  const ours = opencodeInlineConfig(origin);
  const theirs = inherited?.trim() ? parseJsonc(inherited) : undefined;
  if (!isObject(theirs)) return JSON.stringify(ours);
  const provider = { ...(isObject(theirs.provider) ? theirs.provider : {}), ...ours.provider };
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
 * `resolved` is what `opencode debug config` prints: OpenCode's own merge of every config source,
 * which is the only reliable way to know what an agent will use. A provider counts as covered by
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
    `Jev only sees requests to ${OPENCODE_PROVIDER}/* models. Agents without a model of their own use the default and are covered.`,
  ];
}

/** Ask OpenCode how it resolves its configuration with ours laid over it. Undefined when it cannot say. */
function opencodeResolvedConfig(env) {
  return new Promise((resolve) => {
    execFile("opencode", ["debug", "config"], { env, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      // Log lines may come first, and may hold braces of their own: the JSON starts on a line of its own.
      const start = stdout.search(/^\{/m);
      if (start < 0) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch {
        resolve(undefined);
      }
    });
  });
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  upstream: opencodeUpstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default https://api.openai.com/v1)\n" +
    "  JEV_OPENCODE_MODEL               model selected as jev-gateway/<model> (default gpt-5)\n" +
    "  JEV_OPENCODE_CHECK               off skips listing the agents that bypass the gateway (saves about a second)",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag forwards untouched.
  // The two experimental flags stay off for the launched process only (environment, never a user
  // file): the stable AI SDK provider path above is the supported one.
  env: (origin, inherited = process.env) => ({
    OPENCODE_CONFIG_CONTENT: opencodeConfigContent(origin, inherited.OPENCODE_CONFIG_CONTENT),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
  // Asking OpenCode costs about a second, which is OpenCode loading its configuration.
  // JEV_OPENCODE_CHECK=off skips that part; an inline config that had to be dropped is always said.
  notices: async (origin, argv, inherited = process.env) => {
    const content = inherited.OPENCODE_CONFIG_CONTENT;
    const dropped = content?.trim() && !isObject(parseJsonc(content))
      ? ["OPENCODE_CONFIG_CONTENT in your environment is not a JSON object, so this session gets only the gateway's settings from it."]
      : [];
    if (inherited.JEV_OPENCODE_CHECK === "off") return dropped;
    const resolved = await opencodeResolvedConfig({ ...inherited, ...opencode.env(origin, inherited) });
    const outside = opencodeOutsideGateway(resolved, argv, origin);
    // The launcher prefixes only the first line with its name; a second notice needs its own.
    return dropped.length && outside.length ? [...dropped, `${opencode.name}: ${outside[0]}`, ...outside.slice(1)] : [...dropped, ...outside];
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
      `# then select it with: opencode --model ${config.model}`
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

function kiloUpstream() {
  return process.env.JEV_KILO_UPSTREAM_BASE_URL ?? "https://api.kilo.ai/api/openrouter";
}

function kiloModel() {
  return process.env.JEV_KILO_MODEL ?? "kilo-auto/free";
}

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
        models: {
          [model]: {
            name: `Jev Gateway (${model})`,
            limit: { context: 200000, output: 65536 },
            tool_call: true,
          },
        },
      },
    },
  };
}

export const kilo = {
  name: "jev-kilo",
  client: "kilo",
  portEnv: "JEV_KILO_PORT",
  defaultPort: 8785,
  upstream: kiloUpstream,
  upstreamHelp:
    "JEV_KILO_UPSTREAM_BASE_URL   where Kilo traffic goes (default https://api.kilo.ai/api/openrouter)\n" +
    "  JEV_KILO_MODEL               model selected as jev-gateway/<model> (default kilo-auto/free)\n" +
    "  KILO_API_KEY                 your Kilo key, forwarded untouched; unset means free models only",
  env: (origin) => ({
    KILO_CONFIG_CONTENT: JSON.stringify(kiloInlineConfig(origin)),
    PWD: process.cwd(),
  }),
  configHelp: (origin) => {
    const config = kiloInlineConfig(origin);
    const manual = JSON.stringify({ model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    return (
      `# Keep the gateway running (jev-kilo --start), then add to kilo.json\n` +
      `# (project root or ~/.config/kilo/kilo.json):\n` +
      `${manual}\n` +
      `# then select it with: kilo --model ${config.model}`
    );
  },
};

function qwenUpstream() {
  return process.env.JEV_QWEN_UPSTREAM_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
}

function qwenModel() {
  return process.env.JEV_QWEN_MODEL ?? "qwen-plus";
}

export const qwen = {
  name: "jev-qwen",
  client: "qwen",
  portEnv: "JEV_QWEN_PORT",
  defaultPort: 8787,
  upstream: qwenUpstream,
  upstreamHelp:
    "JEV_QWEN_UPSTREAM_BASE_URL   where Qwen Code traffic goes (default https://dashscope-intl.aliyuncs.com/compatible-mode/v1)\n" +
    "  JEV_QWEN_MODEL               model selected (default qwen-plus)",
  args: (origin) => [
    "--auth-type",
    "openai",
    "--openai-base-url",
    `${origin}/v1`,
    "--openai-api-key",
    process.env.OPENAI_API_KEY || "local-no-key",
    "-m",
    qwenModel(),
  ],
  configHelp: (origin) =>
    `# Keep the gateway running (jev-qwen --start), then run:\n` +
    `qwen --auth-type openai --openai-base-url ${origin}/v1 --openai-api-key local-no-key -m ${qwenModel()}`,
};



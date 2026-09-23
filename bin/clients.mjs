// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
// so a benchmark drives an agent exactly the way `jev-codex`, `jev-claude`, and `jev-opencode` do.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureCodexDesktopApp, restartCodexDesktopApp } from "./codex-app.mjs";
import { configureOpenCodeDesktopApp, restartOpenCodeDesktopApp } from "./opencode-app.mjs";

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

const codexProviderConfig = (origin) =>
  `model_provider = "jev-gateway"\n\n[model_providers.jev-gateway]\n` +
  Object.entries(codexProvider(origin))
    .map(([key, value]) => `${key} = ${value}`)
    .join("\n");

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
  setupApp: configureCodexDesktopApp,
  restartApp: restartCodexDesktopApp,
  args: (origin) => [
    "-c",
    `model_provider="jev-gateway"`,
    ...Object.entries(codexProvider(origin)).flatMap(([key, value]) => ["-c", `model_providers.jev-gateway.${key}=${value}`]),
  ],
  configHelp: (origin) =>
    `# Codex CLI profile: save as ~/.codex/jev.config.toml, keep the gateway running\n` +
    `# with jev-codex --start, then use: codex --profile jev\n` +
    `${codexProviderConfig(origin)}\n\n` +
    `# Codex desktop app and the default Codex CLI: merge these settings into\n` +
    `# ~/.codex/config.toml, keep the gateway running with jev-codex --start,\n` +
    `# and restart the app. The user-level provider setting applies to both.\n` +
    `${codexProviderConfig(origin)}`,
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

/** Read the provider credentials OpenCode saved under its XDG data directory. */
export function readOpenCodeAuth() {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  try {
    const value = JSON.parse(readFileSync(join(dataHome, "opencode", "auth.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function apiCredential(auth, providerId) {
  const entry = auth?.[providerId];
  return entry?.type === "api" && typeof entry.key === "string" && entry.key.trim() ? entry.key : undefined;
}

function modelIdFor(providerId, requested) {
  const model = requested?.trim() || "gpt-5";
  if (providerId === "openrouter") return model.includes("/") ? model : `openai/${model}`;
  return providerId === "openai" ? model.replace(/^openai\//, "") : model;
}

/**
 * Resolve supported API credentials without returning or logging secret values. OpenAI OAuth
 * cannot be used here: OpenCode's OAuth plugin sends those requests to ChatGPT directly,
 * bypassing a configured baseURL.
 */
export function resolveOpenCodeRoute({ env = process.env, auth = readOpenCodeAuth() } = {}) {
  const requested = env.JEV_OPENCODE_MODEL?.trim() || "gpt-5";
  const upstreamOverride = env.JEV_OPENCODE_UPSTREAM_BASE_URL?.trim();
  let providerId;
  let credentialSource;
  let apiKeyEnv;

  if (env.OPENAI_API_KEY?.trim()) {
    providerId = OPENCODE_PROVIDER;
    credentialSource = "environment";
    apiKeyEnv = "OPENAI_API_KEY";
  } else if (apiCredential(auth, "openai")) {
    providerId = "openai";
    credentialSource = "opencode-auth-store";
  } else if (apiCredential(auth, "openrouter")) {
    providerId = "openrouter";
    credentialSource = "opencode-auth-store";
  } else {
    return undefined;
  }

  const modelId = modelIdFor(providerId, requested);
  const upstream = upstreamOverride || (providerId === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
  return { providerId, modelId, model: `${providerId}/${modelId}`, upstream, credentialSource, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

function legacyOpenCodeRoute(env = process.env) {
  const modelId = env.JEV_OPENCODE_MODEL?.trim() || "gpt-5";
  return {
    providerId: OPENCODE_PROVIDER,
    modelId,
    model: `${OPENCODE_PROVIDER}/${modelId}`,
    upstream: env.JEV_OPENCODE_UPSTREAM_BASE_URL || "https://api.openai.com/v1",
    credentialSource: "environment",
    apiKeyEnv: "OPENAI_API_KEY",
  };
}

function opencodeUpstream() {
  return resolveOpenCodeRoute()?.upstream ?? process.env.JEV_OPENCODE_UPSTREAM_BASE_URL ?? "https://api.openai.com/v1";
}

function opencodeInlineConfig(origin, environment = process.env, auth = readOpenCodeAuth()) {
  const route = resolveOpenCodeRoute({ env: environment, auth }) ?? legacyOpenCodeRoute(environment);
  const providerConfig = route.providerId === OPENCODE_PROVIDER
    ? {
        npm: "@ai-sdk/openai-compatible",
        name: "Jev Gateway",
        options: { baseURL: `${origin}/v1`, apiKey: `{env:${route.apiKeyEnv}}` },
        models: { [route.modelId]: { name: `Jev Gateway (${route.modelId})` } },
      }
    : { options: { baseURL: `${origin}/v1` } };
  return {
    $schema: "https://opencode.ai/config.json",
    model: route.model,
    small_model: route.model,
    provider: { [route.providerId]: providerConfig },
  };
}

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  appLabel: "OpenCode Desktop app",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  upstream: opencodeUpstream,
  setupAppPreflight: () => {
    const route = resolveOpenCodeRoute();
    if (!route) throw new Error("No supported OpenAI or OpenRouter API credential was found in OpenCode's auth store or OPENAI_API_KEY. Sign in with an API key for one of those providers, then retry");
    return route;
  },
  setupApp: (origin, route) => configureOpenCodeDesktopApp(origin, route),
  restartApp: restartOpenCodeDesktopApp,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default follows its saved OpenAI/OpenRouter API credential)\n" +
    "JEV_OPENCODE_MODEL               model selected through the chosen provider (default gpt-5)",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag forwards untouched.
  // The two experimental flags stay off for the launched process only (environment, never a user
  // file): the stable AI SDK provider path above is the supported one.
  env: (origin, environment = process.env, auth = readOpenCodeAuth()) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(origin, environment, auth)),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
  configHelp: (origin, environment = process.env, auth = readOpenCodeAuth()) => {
    // No OPENCODE_CONFIG_CONTENT one-liner here: single-quoting raw JSON breaks when a custom
    // model ID contains an apostrophe. The opencode.json file workflow below needs no shell
    // quoting and matches what `jev-opencode --print-config` documents.
    const config = opencodeInlineConfig(origin, environment, auth);
    const manual = JSON.stringify({ model: config.model, small_model: config.small_model, provider: config.provider }, null, 2);
    return (
      `# Keep the gateway running (jev-opencode --start), then add to opencode.json\n` +
      `# (project root or ~/.config/opencode/opencode.json):\n` +
      `${manual}\n` +
      `# then select it with: opencode --model ${config.model}`
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


// How each coding agent is pointed at a gateway. Shared by the launchers and the benchmark runner,
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

export const opencode = {
  name: "jev-opencode",
  client: "opencode",
  portEnv: "JEV_OPENCODE_PORT",
  defaultPort: 8791,
  upstream: opencodeUpstream,
  upstreamHelp:
    "JEV_OPENCODE_UPSTREAM_BASE_URL   where OpenCode traffic goes (default https://api.openai.com/v1)\n" +
    "JEV_OPENCODE_MODEL               model selected as jev-gateway/<model> (default gpt-5)",
  // No `args`: the model default comes from the injected config below, so a user `-m provider/model`
  // keeps its documented top priority and every other `opencode` flag forwards untouched.
  // The two experimental flags stay off for the launched process only (environment, never a user
  // file): the stable AI SDK provider path above is the supported one.
  env: (origin) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeInlineConfig(origin)),
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
    OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
  }),
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

function kiroRegion() {
  return process.env.JEV_KIRO_REGION ?? "us-east-1";
}

function kiroUpstream() {
  return process.env.JEV_KIRO_UPSTREAM_BASE_URL ?? `https://q.${kiroRegion()}.amazonaws.com`;
}

const isPresent = (path) => {
  try {
    return Boolean(lstatSync(path));
  } catch {
    return false;
  }
};

const ignoreRace = (error) => {
  if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
};

function mirror(from, to, skip) {
  mkdirSync(to, { recursive: true });
  let names = [];
  try {
    names = readdirSync(from).filter((name) => !skip.includes(name));
  } catch {}
  const shadowing = [];
  for (const name of readdirSync(to)) {
    if (skip.includes(name)) continue;
    const path = join(to, name);
    try {
      if (!lstatSync(path).isSymbolicLink()) shadowing.push(path);
      else if (!names.includes(name)) rmSync(path);
    } catch (error) {
      ignoreRace(error);
    }
  }
  for (const name of names) {
    if (isPresent(join(to, name))) continue;
    try {
      symlinkSync(join(from, name), join(to, name));
    } catch (error) {
      ignoreRace(error);
    }
  }
  return shadowing;
}

const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

function writeAtomic(file, content) {
  writeFileSync(`${file}.${process.pid}`, content);
  renameSync(`${file}.${process.pid}`, file);
}

function kiroHome(origin) {
  const real = homedir();
  const home = join(real, ".jev-gateway", "kiro-home");
  const shadowing = [
    ...mirror(real, home, [".kiro", ".jev-gateway"]),
    ...mirror(join(real, ".kiro"), join(home, ".kiro"), ["settings"]),
    ...mirror(join(real, ".kiro", "settings"), join(home, ".kiro", "settings"), ["cli.json"]),
  ];
  if (shadowing.length) {
    console.error(
      `jev-kiro: these were written inside Kiro's own home, and Kiro sees them instead of yours:\n` +
        shadowing.map((path) => `  ${path}`).join("\n") +
        `\n  Move them to your home folder, or remove them, to see yours again.`,
    );
  }
  let cli = {};
  try {
    cli = JSON.parse(readFileSync(join(real, ".kiro", "settings", "cli.json"), "utf8"));
  } catch {}
  cli["api.codewhisperer.service"] = { endpoint: origin, region: kiroRegion() };
  writeAtomic(join(home, ".kiro", "settings", "cli.json"), JSON.stringify(cli, null, 2));
  return home;
}

function kiroBashEnv() {
  const real = homedir();
  const file = join(real, ".jev-gateway", "kiro-bash-env.sh");
  const previous = process.env.BASH_ENV;
  const chained = previous && previous !== file ? `. ${shellQuote(previous)}\n` : "";
  writeAtomic(file, `export HOME=${shellQuote(real)}\n${chained}`);
  return file;
}

export const kiro = {
  name: "jev-kiro",
  client: "kiro-cli",
  portEnv: "JEV_KIRO_PORT",
  defaultPort: 8793,
  upstream: kiroUpstream,
  upstreamHelp:
    "JEV_KIRO_REGION              region of your Kiro profile (default us-east-1)\n" +
    "JEV_KIRO_UPSTREAM_BASE_URL   where Kiro traffic goes (default https://q.<region>.amazonaws.com)",
  env: (origin) => ({ HOME: kiroHome(origin), BASH_ENV: kiroBashEnv() }),
  configHelp: (origin) =>
    `# Keep the gateway running (jev-kiro --start), then add to ~/.kiro/settings/cli.json:\n` +
    JSON.stringify({ "api.codewhisperer.service": { endpoint: origin, region: kiroRegion() } }, null, 2) +
    `\n# Plain kiro-cli then always goes through the gateway; remove the entry to stop.`,
};

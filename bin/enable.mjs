// Turning the gateway on inside each tool's own configuration, and off again. Every editor here
// is a pure function from the file's text to the new text, so it can be tested without touching
// anyone's home directory, and `disable` undoes exactly what `enable` did.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { upsertEnv } from "./setup.mjs";

const BEGIN = "# >>> jev-gateway >>> managed block, remove with `jev-gateway disable`";
const END = "# <<< jev-gateway <<<";
const WAS = "# jev-gateway:was ";

const block = (lines) => [BEGIN, ...lines, END].join("\n");
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Codex: ~/.codex/config.toml -------------------------------------------------------------
// TOML wants top-level keys before the first table, so the provider choice goes at the very top
// and the provider's own table at the very end. A `model_provider` the user already had would be
// a duplicate key, so it is parked in a comment and put back by `disable`.

export function enableCodex(text, baseUrl) {
  const clean = disableCodex(text);
  if (/^\s*\[model_providers\.jev-gateway\]/m.test(clean)) {
    throw new Error("config.toml already defines [model_providers.jev-gateway] outside the managed block; remove it first.");
  }
  const lines = clean.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const topLevelEnd = firstTable < 0 ? lines.length : firstTable;
  for (let i = 0; i < topLevelEnd; i++) if (/^\s*model_provider\s*=/.test(lines[i])) lines[i] = WAS + lines[i];
  const body = lines.join("\n");
  const head = block([`model_provider = "jev-gateway"`]);
  const tail = block([
    "[model_providers.jev-gateway]",
    `name = "jev-gateway"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    // Codex keeps using whatever login it already has; the gateway forwards it untouched.
    "requires_openai_auth = true",
  ]);
  return `${head}\n${body}${body === "" || body.endsWith("\n") ? "" : "\n"}\n${tail}\n`;
}

export function disableCodex(text) {
  const withoutHead = text.startsWith(BEGIN) ? text.slice(text.indexOf(END) + END.length + 1) : text;
  const tailAt = withoutHead.lastIndexOf(`\n${BEGIN}\n`);
  const withoutTail = tailAt >= 0 && withoutHead.trimEnd().endsWith(END) ? withoutHead.slice(0, tailAt) : withoutHead;
  return withoutTail
    .split("\n")
    .map((line) => (line.startsWith(WAS) ? line.slice(WAS.length) : line))
    .join("\n");
}

// --- JSON configs: set a few values, remember what was there ----------------------------------

const get = (object, path) => path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), object);
function set(object, path, value) {
  let node = object;
  for (const key of path.slice(0, -1)) node = node[key] && typeof node[key] === "object" ? node[key] : (node[key] = {});
  if (value === undefined) delete node[path.at(-1)];
  else node[path.at(-1)] = value;
}

/** Apply `values` (path → value) to a JSON document; returns the new text and what each path held before. */
export function applyJson(text, values) {
  const document = text.trim() === "" ? {} : JSON.parse(text);
  const previous = [];
  for (const [path, value] of values) {
    previous.push([path, get(document, path)]);
    set(document, path, value);
  }
  return { text: JSON.stringify(document, null, 2) + "\n", previous };
}

/** Put back what `applyJson` reported, leaving no empty objects behind. */
export function restoreJson(text, previous) {
  const document = JSON.parse(text);
  for (const [path, value] of [...previous].reverse()) {
    set(document, path, value ?? undefined);
    for (let depth = path.length - 1; depth > 0; depth--) {
      const parent = get(document, path.slice(0, depth));
      if (parent && typeof parent === "object" && Object.keys(parent).length === 0) set(document, path.slice(0, depth), undefined);
      else break;
    }
  }
  return JSON.stringify(document, null, 2) + "\n";
}

const removeEnvLine = (text, name) => text.split("\n").filter((line) => !new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line)).join("\n");

// --- The tools ----------------------------------------------------------------------------------

const home = (env) => env.HOME ?? homedir();
const opencodeModel = (env) => env.JEV_OPENCODE_MODEL ?? "gpt-5";

export const TOOLS = {
  codex: {
    label: "Codex",
    file: (env) => join(env.CODEX_HOME ?? join(home(env), ".codex"), "config.toml"),
    enable: (text, origin) => ({ text: enableCodex(text, `${origin}/codex/v1`) }),
    disable: (text) => disableCodex(text),
  },
  claude: {
    label: "Claude Code",
    file: (env) => join(env.CLAUDE_CONFIG_DIR ?? join(home(env), ".claude"), "settings.json"),
    // Only the base URL: with no gateway credential next to it, Claude Code keeps its saved login.
    enable: (text, origin) => applyJson(text, [[["env", "ANTHROPIC_BASE_URL"], `${origin}/claude`]]),
    disable: (text, previous) => restoreJson(text, previous),
  },
  opencode: {
    label: "OpenCode",
    file: (env) => join(env.XDG_CONFIG_HOME ?? join(home(env), ".config"), "opencode", "opencode.json"),
    enable: (text, origin, env) => {
      const model = opencodeModel(env);
      return applyJson(text, [
        [["provider", "jev-gateway"], {
          npm: "@ai-sdk/openai-compatible",
          name: "Jev Gateway",
          options: { baseURL: `${origin}/opencode/v1`, apiKey: "{env:OPENAI_API_KEY}" },
          models: { [model]: { name: `Jev Gateway (${model})` } },
        }],
        [["model"], `jev-gateway/${model}`],
        [["small_model"], `jev-gateway/${model}`],
      ]);
    },
    disable: (text, previous) => restoreJson(text, previous),
  },
  gemini: {
    label: "Gemini CLI",
    // The Gemini CLI has no setting for its endpoint, but it loads this file into its environment.
    file: (env) => join(home(env), ".gemini", ".env"),
    enable: (text, origin) => {
      const before = /^\s*(?:export\s+)?GOOGLE_GEMINI_BASE_URL\s*=\s*(.*)$/m.exec(text)?.[1];
      return { text: upsertEnv(text, { GOOGLE_GEMINI_BASE_URL: `${origin}/gemini` }), previous: before };
    },
    disable: (text, previous) => (previous === undefined || previous === null ? removeEnvLine(text, "GOOGLE_GEMINI_BASE_URL") : upsertEnv(text, { GOOGLE_GEMINI_BASE_URL: previous })),
  },
};

// --- Files and bookkeeping ----------------------------------------------------------------------

const stateFile = (env) => join(home(env), ".jev-gateway", "enabled.json");
export const readState = (env) => (existsSync(stateFile(env)) ? JSON.parse(readFileSync(stateFile(env), "utf8")) : {});
function writeState(env, state) {
  mkdirSync(dirname(stateFile(env)), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(env), JSON.stringify(state, null, 2) + "\n");
}

export function enable(name, origin, env = process.env) {
  const tool = TOOLS[name];
  const file = tool.file(env);
  const state = readState(env);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Re-enabling must not record our own values as "what was there before".
  const current = state[name] ? tool.disable(text, state[name].previous) : text;
  const backup = `${file}.before-jev-gateway`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  const result = tool.enable(current, origin, env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, result.text);
  state[name] = { file, origin, previous: result.previous ?? null, created: !existsSync(backup) };
  writeState(env, state);
  return { file, backup: existsSync(backup) ? backup : undefined };
}

export function disable(name, env = process.env) {
  const state = readState(env);
  const entry = state[name];
  if (!entry) return undefined;
  if (existsSync(entry.file)) writeFileSync(entry.file, TOOLS[name].disable(readFileSync(entry.file, "utf8"), entry.previous));
  delete state[name];
  writeState(env, state);
  return { file: entry.file };
}

// --- Starting the gateway with the shell ---------------------------------------------------------
// A tool pointed at the gateway fails when the gateway is not running, so something has to start
// it. A line in the shell's startup file is the one mechanism that works the same on Linux, macOS
// and WSL. It runs in a subshell in the background: no job notice, no slower prompt.

const RC_LINE = "( command -v jev-gateway >/dev/null 2>&1 && jev-gateway start >/dev/null 2>&1 & )";
export const enableAutostart = (text) => `${disableAutostart(text).replace(/\n*$/, "")}\n\n${block([RC_LINE])}\n`.replace(/^\n+/, "");
export const disableAutostart = (text) => text.replace(new RegExp(`\\n*${escape(BEGIN)}\\n[\\s\\S]*?${escape(END)}\\n?`, "g"), "\n").replace(/^\n+$/, "");
export const shellFiles = (env) => [".bashrc", ".zshrc"].map((name) => join(home(env), name)).filter(existsSync);

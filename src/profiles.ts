import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One gateway, several tools. Each tool talks to its own path prefix (`/codex/v1/...`,
 * `/claude/v1/...`), and the prefix says two things the request itself cannot: which provider the
 * traffic belongs to, and which tool to credit on the dashboard. Codex and OpenCode both speak
 * OpenAI's APIs but go to different backends, so the path is the only place that can tell them apart.
 */
export interface Profile {
  name: string;
  upstream: string;
}

type Env = Record<string, string | undefined>;

/** Codex talks to a different backend depending on how the user logged in. */
function codexUpstream(env: Env): string {
  try {
    const auth = JSON.parse(readFileSync(join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8"));
    if (auth.auth_mode === "chatgpt" || (auth.tokens && !auth.OPENAI_API_KEY)) return "https://chatgpt.com/backend-api/codex";
  } catch {
    // No readable login: assume API-key usage.
  }
  return "https://api.openai.com/v1";
}

const DEFAULTS: Record<string, (env: Env) => string> = {
  codex: codexUpstream,
  claude: () => "https://api.anthropic.com/v1",
  opencode: () => "https://api.openai.com/v1",
  gemini: () => "https://generativelanguage.googleapis.com",
};

/** Every known tool, with `JEV_<TOOL>_UPSTREAM_BASE_URL` overriding where its traffic goes. */
export function loadProfiles(env: Env = process.env): Profile[] {
  return Object.entries(DEFAULTS).map(([name, fallback]) => ({
    name,
    upstream: (env[`JEV_${name.toUpperCase()}_UPSTREAM_BASE_URL`]?.trim() || fallback(env)).replace(/\/+$/, ""),
  }));
}

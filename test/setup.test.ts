import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { configuredProvider, loadProviders, runSetup, saveEnv, upsertEnv, validateKey } from "../bin/setup.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const providers = loadProviders(ROOT);

/** A scripted user: answers are handed out in order, and everything printed is kept. */
function script(answers: string[]) {
  const printed: string[] = [];
  const next = async (prompt: string) => (printed.push(prompt), answers.shift() ?? "");
  return { printed, io: { print: (line: string) => void printed.push(line), ask: next, askSecret: next } };
}

describe("upsertEnv", () => {
  it("replaces what is there, appends what is not, and keeps the rest", () => {
    const before = "# mine\nJEV_MIN_CONFIDENCE=0.8\nTYPESAFE_API_KEY=old\nexport JEV_PROVIDER=typesafe\n";
    expect(upsertEnv(before, { JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "new" })).toBe(
      "# mine\nJEV_MIN_CONFIDENCE=0.8\nTYPESAFE_API_KEY=old\nJEV_PROVIDER=openrouter\nOPENROUTER_API_KEY=new\n",
    );
    expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
  });
});

describe("configuredProvider", () => {
  it.each(["clef", "clef-flash"])("does not skip setup when %s has a token but no account", (provider) => {
    const env = { JEV_PROVIDER: provider, CLOUDFLARE_API_TOKEN: "key" };
    expect(configuredProvider(env, providers)).toBeUndefined();
    expect(configuredProvider({ ...env, CLOUDFLARE_ACCOUNT_ID: "account" }, providers)).toBe(provider);
    expect(configuredProvider({ ...env, JEV_URL: "http://proxy.test/v1/systemone" }, providers)).toBe(provider);
  });
  it("counts a provider only when its own key is there", () => {
    expect(configuredProvider({}, providers)).toBeUndefined();
    expect(configuredProvider({ AI_GATEWAY_API_KEY: "k" }, providers)).toBe("vercel");
    expect(configuredProvider({ JEV_PROVIDER: "openrouter", TYPESAFE_API_KEY: "k" }, providers)).toBeUndefined();
    expect(configuredProvider({ TYPESAFE_API_KEY: "  " }, providers)).toBeUndefined();
    expect(configuredProvider({ JEV_PROVIDER: "local" }, providers)).toBe("local");
  });
});

describe("runSetup", () => {
  const envFile = "/nowhere/.env";

  it.each(["clef", "clef-flash"])("saves the %s token and account together without printing the token", async (provider) => {
    const user = script([provider, "cf-account", "cf-secret"]);
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: user.io, env: {}, save: () => {},
      validate: async (configured: { url: string; model: string }, key: string) => {
        expect(configured.url).toBe(`https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/cloudflare/${provider}`);
        expect(configured.model).toBe(provider);
        expect(key).toBe("cf-secret");
        return { ok: true, ms: 1 };
      },
    });
    expect(values).toEqual({ JEV_PROVIDER: provider, CLOUDFLARE_ACCOUNT_ID: "cf-account", CLOUDFLARE_API_TOKEN: "cf-secret" });
    expect(user.printed.join("\n")).not.toContain("cf-secret");
  });

  it("saves the local defaults after an unavailable model check only when the user accepts", async () => {
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: script(["local", "", "", "y"]).io, env: {}, save: () => {},
      validate: async () => ({ ok: false, reason: "connection refused" }),
    });
    expect(values).toEqual({ JEV_PROVIDER: "local", JEV_MODEL: "clef-flash", LOCAL_CLEF_URL: "http://127.0.0.1:11434/v1/systemone" });
  });

  it("validates an authenticated llama.cpp endpoint with the configured local key", async () => {
    const user = script(["local", "clef-flash", "http://localhost:8080/v1/systemone"]);
    const saved: unknown[] = [];
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: user.io, env: { LOCAL_CLEF_API_KEY: "local-secret" },
      save: (file: string, entries: unknown) => saved.push([file, entries]),
      validate: async (provider: { url: string }, key: string) => {
        expect(provider.url).toBe("http://localhost:8080/v1/systemone");
        expect(key).toBe("local-secret");
        return { ok: true, ms: 1 };
      },
    });
    expect(values).toMatchObject({ JEV_PROVIDER: "local", LOCAL_CLEF_API_KEY: "local-secret" });
    expect(saved).toEqual([[envFile, values]]);
    expect(user.printed.join("\n")).not.toContain("local-secret");
  });

  it("sets up a local model and endpoint without asking for a secret", async () => {
    const user = script(["local", "clef:27b", "http://localhost:8000/v1/systemone"]);
    user.io.askSecret = async () => expect.unreachable("local setup must not ask for an API key");
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: user.io, env: {}, save: () => {},
      validate: async (provider: { url: string; model: string }, key: unknown) => {
        expect(provider).toMatchObject({ url: "http://localhost:8000/v1/systemone", model: "clef:27b" });
        expect(key).toBeUndefined();
        return { ok: true, ms: 1 };
      },
    });
    expect(values).toEqual({ JEV_PROVIDER: "local", JEV_MODEL: "clef:27b", LOCAL_CLEF_URL: "http://localhost:8000/v1/systemone" });
  });

  it("does not save an unavailable local model unless the user chooses to", async () => {
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: script(["local", "", "", "n"]).io, env: {},
      validate: async () => ({ ok: false, reason: "connection refused" }),
      save: () => expect.unreachable("nothing should be saved"),
    });
    expect(values).toBeUndefined();
  });

  it("asks where and what, checks the key, and saves provider and key together", async () => {
    const user = script(["2", "  or-key  "]);
    const saved: unknown[] = [];
    const checked: unknown[] = [];
    const values = await runSetup({
      name: "jev-codex", providers, envFile, io: user.io,
      validate: async (provider: { label: string }, key: string) => (checked.push([provider.label, key]), { ok: true, ms: 12 }),
      save: (file: string, entries: unknown) => saved.push([file, entries]),
    });
    expect(values).toEqual({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key" });
    expect(checked).toEqual([["OpenRouter", "or-key"]]);
    expect(saved).toEqual([[envFile, values]]);
    expect(user.printed.join("\n")).toContain("https://openrouter.ai/settings/keys");
    // The key is never printed back.
    expect(user.printed.join("\n")).not.toContain("or-key");
  });

  it("defaults to TypeSafe and lets a refused key be retried", async () => {
    const user = script(["", "wrong", "right"]);
    const values = await runSetup({
      name: "jev-claude", providers, envFile, io: user.io, save: () => {},
      validate: async (_provider: unknown, key: string) => (key === "right" ? { ok: true, ms: 5 } : { ok: false, refused: true, reason: "401" }),
    });
    expect(values).toEqual({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "right" });
  });

  it("saves nothing when the user gives up, or declines an unchecked key", async () => {
    const save = () => expect.unreachable("nothing should be saved");
    expect(await runSetup({ name: "x", providers, envFile, io: script(["3", ""]).io, save })).toBeUndefined();
    const offline = async () => ({ ok: false, refused: false, reason: "fetch failed" });
    expect(await runSetup({ name: "x", providers, envFile, io: script(["1", "key", "n"]).io, validate: offline, save })).toBeUndefined();
  });

  it("keeps a key it could not check when the user says so", async () => {
    const offline = async () => ({ ok: false, refused: false, reason: "fetch failed" });
    const values = await runSetup({ name: "x", providers, envFile, io: script(["1", "key", "y"]).io, validate: offline, save: () => {} });
    expect(values).toEqual({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "key" });
  });

  it("asks before a paid key check and keeps the free model if declined", async () => {
    const yes = script(["4", "key", "y"]);
    const checked: string[] = [];
    const validate = async (provider: { model: string }) => {
      checked.push(provider.model);
      yes.printed.push(`checked ${provider.model}`);
      return provider.model === "jev-1.13-free"
        ? { ok: false, freeUnavailable: true, refused: false, reason: "404 free model unavailable" }
        : { ok: true, ms: 9 };
    };
    expect(await runSetup({ name: "x", providers, envFile, io: yes.io, validate, save: () => {} })).toEqual({
      JEV_PROVIDER: "opencode", OPENCODE_API_KEY: "key", JEV_MODEL: "jev-1.13",
    });
    expect(checked).toEqual(["jev-1.13-free", "jev-1.13"]);
    expect(yes.printed.findIndex((line) => line.includes("key check may be billed"))).toBeLessThan(yes.printed.indexOf("checked jev-1.13"));

    const no = script(["4", "key", "n", "y"]);
    const freeOnly = async (provider: { model: string }) => {
      expect(provider.model).toBe("jev-1.13-free");
      return { ok: false, freeUnavailable: true, refused: false, reason: "404 free model unavailable" };
    };
    expect(await runSetup({ name: "x", providers, envFile, io: no.io, validate: freeOnly, save: () => {} })).toEqual({
      JEV_PROVIDER: "opencode", OPENCODE_API_KEY: "key", JEV_MODEL: "jev-1.13-free",
    });
    expect(no.printed.join("\n")).toContain("pass requests to the LLM");
  });
});

describe("validateKey", () => {
  it("asks one real question and tells a refused key from a provider that could not be reached", async () => {
    const seen: { url: string; body: any; auth: string | null }[] = [];
    const reply = (status: number) =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
    expect(await validateKey(providers.vercel, "k", reply(200))).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({ url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", auth: "Bearer k", body: { model: "typesafe-ai/jev" } });
    expect(await validateKey(providers.typesafe, "k", reply(403))).toMatchObject({ ok: false, refused: true });
    expect(await validateKey(providers.typesafe, "k", reply(503))).toMatchObject({ ok: false, refused: false });
    const down = (async () => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch;
    expect(await validateKey(providers.openrouter, "k", down)).toMatchObject({ ok: false, refused: false, reason: "fetch failed" });
  });

  it("reports a missing free model without calling the paid one", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body.model);
      return body.model === "jev-1.13-free" ? new Response("model not found", { status: 404 }) : Response.json({ answers: {} });
    }) as unknown as typeof fetch;
    expect(await validateKey(providers.opencode, "k", fetchImpl)).toMatchObject({ ok: false, freeUnavailable: true });
    expect(seen).toEqual(["jev-1.13-free"]);
    expect(await validateKey({ ...providers.opencode, model: "jev-1.13", paidModel: undefined }, "k", fetchImpl)).toMatchObject({ ok: true });
    expect(seen).toEqual(["jev-1.13-free", "jev-1.13"]);

    const refused = (async (_url: string, init: RequestInit) => {
      seen.length = 0;
      seen.push(JSON.parse(String(init.body)).model);
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await validateKey(providers.opencode, "k", refused)).toMatchObject({ ok: false, refused: true });
    expect(seen).toEqual(["jev-1.13-free"]);

    for (const status of [429, 500, 503]) {
      const unavailable = (async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(String(init.body)).model);
        return new Response("unavailable", { status });
      }) as unknown as typeof fetch;
      seen.length = 0;
      expect(await validateKey(providers.opencode, "k", unavailable)).toMatchObject({ ok: false });
      expect(seen).toEqual(["jev-1.13-free"]);
    }
  });
});

describe("saving and launching", () => {
  it("writes the key to a file only its owner can read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jev-setup-")), "nested", ".env");
    saveEnv(file, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "secret" });
    saveEnv(file, { TYPESAFE_API_KEY: "rotated" });
    expect(readFileSync(file, "utf8")).toBe("JEV_PROVIDER=typesafe\nTYPESAFE_API_KEY=rotated\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("without a terminal, a launcher names what is missing instead of hanging on a question", () => {
    const home = mkdtempSync(join(tmpdir(), "jev-home-"));
    const env = { PATH: process.env.PATH, HOME: home, JEV_CODEX_PORT: "8999", JEV_SKIP_PROJECT_ENV: "1" };
    let output = "";
    try {
      execFileSync(process.execPath, [join(ROOT, "bin/jev-codex.mjs"), "--start"], { env, cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch (error) {
      output = String((error as { stderr?: string }).stderr);
    }
    expect(output).toContain("no API key for Jev");
    expect(output).toContain("--setup");
    expect(output).toContain("OPENROUTER_API_KEY");
  });
});

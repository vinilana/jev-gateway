import type { Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createAskJev } from "../src/jev.js";

describe("Cloudflare Clef", () => {
  it.each(["clef", "clef-flash"])("selects %s with its account endpoint, bearer token and model", async (provider) => {
    const config = loadConfig({ JEV_PROVIDER: provider, CLOUDFLARE_API_TOKEN: "cf-key", CLOUDFLARE_ACCOUNT_ID: "account", JEV_MODEL: "jev-latest" });
    expect(config.jevModel).toBe(provider);
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/cloudflare/${provider}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cf-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(provider);
      expect(body.state).toBe("Read README.md");
      return Response.json({ success: true, result: { model: provider, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, {
        type: "choice", choice: "read_file", probabilities: { read_file: 0.9, send_email: 0.1 },
      }])), usage: { input_tokens: 32, output_tokens: 0 } } });
    };
    const result = await createAskJev(config, fetchImpl)({ model: config.jevModel, state: "Read README.md", questions: {
      tool: { type: "choice", instructions: "Which tool?", criteria: { read_file: null, send_email: null } },
    } });
    expect(result.answers.tool).toMatchObject({ choice: "read_file", confidence: 0.9 });
    expect(result.usage).toEqual({ input_tokens: 32, output_tokens: 0 });
  });

  it("requires an account unless the entire endpoint is overridden", () => {
    expect(() => loadConfig({ JEV_PROVIDER: "clef", CLOUDFLARE_API_TOKEN: "k" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(loadConfig({ JEV_PROVIDER: "clef", JEV_URL: "http://proxy.test/v1/systemone" }).jevUrl).toBe("http://proxy.test/v1/systemone");
    expect(loadConfig({ CLOUDFLARE_API_TOKEN: "k", CLOUDFLARE_ACCOUNT_ID: "account" }).jevProvider).toBe("clef");
  });

  it("maps internal question IDs to Cloudflare's alphabet without collisions and restores answers", async () => {
    const config = loadConfig({ JEV_PROVIDER: "clef", CLOUDFLARE_API_TOKEN: "k", CLOUDFLARE_ACCOUNT_ID: "account" });
    const ids = ["arg:0:room", "arg_0_room", "stated:0:room", "shard:0", "x".repeat(128)];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const sentIds = Object.keys(body.questions);
      expect(sentIds).toHaveLength(ids.length);
      for (const id of sentIds) expect(id).toMatch(/^[a-zA-Z0-9_.-]{1,100}$/);
      return Response.json({ success: true, result: { model: "clef", answers: Object.fromEntries(sentIds.map((id, i) => [id, { type: "noul", noul: i / 10 }])), usage: { input_tokens: 10, output_tokens: 0 } } });
    };
    const questions: Questions = Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: "Is this stated?" }]));
    const result = await createAskJev(config, fetchImpl)({ model: config.jevModel, state: "state", questions });
    expect(Object.keys(result.answers)).toEqual(ids);
    ids.forEach((id, i) => expect(result.answers[id]).toEqual({ type: "noul", noul: i / 10 }));
  });

  it("batches more than 64 questions and adds usage without losing answers", async () => {
    const config = loadConfig({ JEV_PROVIDER: "clef-flash", CLOUDFLARE_API_TOKEN: "k", CLOUDFLARE_ACCOUNT_ID: "account" });
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const ids = Object.keys(body.questions);
      expect(ids.length).toBeLessThanOrEqual(64);
      return Response.json({ success: true, result: { model: "clef-flash", answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.99 }])), usage: { input_tokens: 10, output_tokens: 2 } } });
    };
    const questions: Questions = Object.fromEntries(Array.from({ length: 96 }, (_, i) => [`arg:0:p${i}`, { type: "noul", instructions: "Is it true?" }]));
    const result = await createAskJev(config, fetchImpl)({ model: config.jevModel, state: "state", questions });
    expect(calls).toBe(2);
    expect(Object.keys(result.answers)).toEqual(Object.keys(questions));
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
  });
});

import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { decide } from "../src/decide.js";
import { createAskJev } from "../src/jev.js";
import { buildQuestions, NONE_OF_THESE, NO_TOOL } from "../src/questions.js";
import type { RouterInput } from "../src/types.js";

const config = loadConfig({ JEV_PROVIDER: "local" });

describe("local Clef", () => {
  it.each([undefined, "local-token"])("uses a llama.cpp System One endpoint with optional authentication (%s)", async (key) => {
    const local = loadConfig({ JEV_PROVIDER: "local", JEV_MODEL: "clef-flash", LOCAL_CLEF_URL: "http://127.0.0.1:8080/v1/systemone", LOCAL_CLEF_API_KEY: key });
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe(key ? `Bearer ${key}` : null);
      expect(JSON.parse(String(init?.body))).toEqual({ model: "clef-flash", state: "Read README.md", questions: { q: { type: "noul", instructions: "Does this request ask to read a file?" } } });
      return Response.json({ model: "clef-flash", answers: { q: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 32, output_tokens: 0 } });
    };
    const result = await createAskJev(local, fetchImpl)({ model: local.jevModel, state: "Read README.md", questions: { q: { type: "noul", instructions: "Does this request ask to read a file?" } } });
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.98 });
    expect(result.usage).toEqual({ input_tokens: 32, output_tokens: 0 });
  });

  it("runs without credentials and keeps local URLs and model tags separate from hosted settings", () => {
    expect(config).toMatchObject({ jevModel: "clef-flash", jevUrl: "http://127.0.0.1:11434/v1/systemone", jevTimeoutMs: 120_000 });
    expect(config.jevApiKey).toBeUndefined();
    expect(loadConfig({ JEV_PROVIDER: "local", JEV_MODEL: "clef:27b", LOCAL_CLEF_URL: "http://localhost:8000/v1/systemone" }))
      .toMatchObject({ jevModel: "clef:27b", jevUrl: "http://localhost:8000/v1/systemone" });
    expect(loadConfig({ TYPESAFE_API_KEY: "k", LOCAL_CLEF_URL: "http://localhost:8000/v1/systemone" }).jevUrl).toContain("api.typesafe.ai");
  });

  it.each([[90, "short"], [10, "é".repeat(5000)]])("batches %i questions within Ollama's count and UTF-8 byte limits", async (count, instructions) => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const body = String(init?.body);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65_536);
      const request = JSON.parse(body) as SystemOneRequest<Questions>;
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(64);
      return Response.json({ model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 10, output_tokens: 2 } });
    };
    const questions: Questions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { type: "noul", instructions }]));
    const result = await createAskJev(config, fetchImpl)({ model: config.jevModel, state: "state", questions });
    expect(calls).toBeGreaterThan(1);
    expect(Object.keys(result.answers)).toHaveLength(count);
    expect(result.usage).toEqual({ input_tokens: calls * 10, output_tokens: calls * 2 });
  });

  it("rejects an oversized single question before making a network call", async () => {
    const fetchImpl = async () => { throw new Error("must not fetch"); };
    await expect(createAskJev(config, fetchImpl)({ model: "clef", state: "é".repeat(40_000), questions: { q: { type: "noul" } } }))
      .rejects.toThrow(/64 KiB/);
  });

  it("reduces a 280-tool roster over multiple rounds without dropping the winner", async () => {
    const input: RouterInput = {
      system: "", turns: [{ role: "user", content: "Use tool279" }], toolChoice: "auto",
      tools: Array.from({ length: 280 }, (_, i) => ({ name: `tool${i}`, kind: "function", parameters: { type: "object", properties: { mode: { enum: Array.from({ length: 27 }, (_, j) => j) } } } })),
    };
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as SystemOneRequest<Questions>;
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
        if (q.type === "noul") return [id, { type: "noul", noul: 0.99 }];
        if (q.type !== "choice") throw new Error("unexpected question");
        const names = Object.keys(q.criteria);
        expect(names.length).toBeLessThanOrEqual(26);
        expect(names.length).toBeGreaterThanOrEqual(2);
        const candidates = names.filter((name) => name !== NO_TOOL && name !== NONE_OF_THESE);
        const choice = candidates.includes("tool279") ? "tool279" : candidates[0];
        return [id, { type: "choice", choice, confidence: 0.99, probabilities: Object.fromEntries(names.map((name) => [name, name === choice ? 0.99 : 0.0001])) }];
      }));
      return Response.json({ model: request.model, answers, usage: { input_tokens: 10, output_tokens: 0 } });
    };
    const result = await decide(input, config, createAskJev(config, fetchImpl));
    expect(calls).toBe(3);
    expect(result).toMatchObject({ mode: "forced", tool: "tool279", jev: { inputTokens: 30 } });
    const built = buildQuestions([input.tools[0]!], { allowNone: false, withArgs: true, maxOptions: 26 });
    expect(built.questions.tool).toMatchObject({ criteria: { tool0: expect.anything(), [NONE_OF_THESE]: expect.any(String) } });
    expect(built.plans[0]!.closedParams).toBeUndefined();
  });
});

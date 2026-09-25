import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createAskJev, resolveModel, resolveProvider } from "../src/jev.js";

const request = { model: "m", state: "s", questions: { tool: { type: "choice" as const, instructions: "?", criteria: { a: null, b: null } } } };

function capture(reply: () => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("choosing a provider", () => {
  it("follows whichever key is present, TypeSafe's own first, unless JEV_PROVIDER says otherwise", () => {
    expect(resolveProvider({})).toBe("typesafe");
    expect(resolveProvider({ OPENROUTER_API_KEY: "k" })).toBe("openrouter");
    expect(resolveProvider({ AI_GATEWAY_API_KEY: "k" })).toBe("vercel");
    expect(resolveProvider({ OPENCODE_API_KEY: "k" })).toBe("opencode");
    expect(resolveProvider({ OPENCODE_API_KEY: "k", TYPESAFE_API_KEY: "k" })).toBe("typesafe");
    expect(resolveProvider({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "k" })).toBe("typesafe");
    expect(resolveProvider({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "k", JEV_PROVIDER: "OpenRouter" })).toBe("openrouter");
    expect(() => resolveProvider({ JEV_PROVIDER: "acme" })).toThrow(/JEV_PROVIDER/);
  });

  it("never sends one provider's model id to another", () => {
    expect(resolveModel("typesafe", undefined)).toBe("jev-latest");
    expect(resolveModel("typesafe", "jev-1.13.0")).toBe("jev-1.13.0");
    expect(resolveModel("openrouter", "jev-latest")).toBe("typesafe/jev-1.13");
    expect(resolveModel("openrouter", "typesafe/jev-1.13-20260917")).toBe("typesafe/jev-1.13-20260917");
    expect(resolveModel("typesafe", "typesafe-ai/jev")).toBe("jev-latest");
    expect(resolveModel("opencode", undefined)).toBe("jev-1.13-free");
    expect(resolveModel("opencode", "jev-1.13")).toBe("jev-1.13");
    expect(resolveModel("opencode", "jev-latest")).toBe("jev-1.13-free");
    expect(resolveModel("typesafe", "jev-1.13-free")).toBe("jev-latest");
    expect(resolveModel("opencode", "typesafe/jev-1.13")).toBe("jev-1.13-free");
  });

  it("takes a model id it has not heard of when it has the provider's shape", () => {
    expect(resolveModel("typesafe", "jev-1.14")).toBe("jev-1.14");
    expect(resolveModel("openrouter", "typesafe/jev-1.14-20261001")).toBe("typesafe/jev-1.14-20261001");
    expect(resolveModel("vercel", "typesafe-ai/jev-1.14")).toBe("typesafe-ai/jev-1.14");
    expect(resolveModel("opencode", "jev-1.14")).toBe("jev-1.13-free");
  });

  it("reads the matching key, endpoint and model into the config", () => {
    const config = loadConfig({ AI_GATEWAY_API_KEY: "vck", JEV_MODEL: "jev-latest" });
    expect(config).toMatchObject({ jevProvider: "vercel", jevApiKey: "vck", jevModel: "typesafe-ai/jev", jevUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone" });
    expect(loadConfig({ OPENROUTER_API_KEY: "ork" }).jevUrl).toBe("https://openrouter.ai/api/alpha/decisions");
    // The variable TypeSafe's SDK reads still points a local stand-in at the gateway.
    expect(loadConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:8799/" }).jevUrl).toBe("http://127.0.0.1:8799/v1/systemone");
  });

  it("uses OpenCode's free model unless the paid one is selected", () => {
    expect(loadConfig({ OPENCODE_API_KEY: "ock" })).toMatchObject({
      jevProvider: "opencode",
      jevApiKey: "ock",
      jevModel: "jev-1.13-free",
      jevUrl: "https://opencode.ai/zen/v1/systemone",
    });
    expect(loadConfig({ OPENCODE_API_KEY: "ock", JEV_MODEL: "jev-1.13" }).jevModel).toBe("jev-1.13");
    expect(loadConfig({ OPENCODE_API_KEY: "ock", JEV_MODEL: "jev-latest" }).jevModel).toBe("jev-1.13-free");
  });
});

describe("asking Jev", () => {
  const answer = { model: "m", answers: { tool: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, usage: { input_tokens: 10, output_tokens: 0 } };

  it("posts the same body to whichever provider, with its key as a bearer token", async () => {
    for (const env of [{ TYPESAFE_API_KEY: "k1" }, { OPENROUTER_API_KEY: "k2" }, { AI_GATEWAY_API_KEY: "k3" }]) {
      const config = loadConfig(env);
      const { calls, fetchImpl } = capture(() => Response.json(answer));
      const result = await createAskJev(config, fetchImpl)(request);
      expect(calls[0]!.url).toBe(config.jevUrl);
      expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${Object.values(env)[0]}`);
      expect(calls[0]!.body).toEqual(request);
      expect(result.answers.tool).toMatchObject({ choice: "a", confidence: 0.9 });
    }
  });

  it("stands the winning probability in for a missing confidence, and a missing usage for zero", async () => {
    const bare = { answers: { tool: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } } } };
    const { fetchImpl } = capture(() => Response.json(bare));
    const result = await createAskJev(loadConfig({ AI_GATEWAY_API_KEY: "k" }), fetchImpl)(request);
    expect(result.answers.tool).toMatchObject({ confidence: 0.8 });
    expect(result.usage.input_tokens).toBe(0);
  });

  it("retries an overloaded provider once and gives up at once on a refused key", async () => {
    let attempts = 0;
    const flaky = capture(() => (++attempts === 1 ? new Response("busy", { status: 529 }) : Response.json(answer)));
    await createAskJev(loadConfig({ TYPESAFE_API_KEY: "k" }), flaky.fetchImpl)(request);
    expect(flaky.calls).toHaveLength(2);

    const refused = capture(() => new Response("bad key", { status: 401 }));
    await expect(createAskJev(loadConfig({ TYPESAFE_API_KEY: "k" }), refused.fetchImpl)(request)).rejects.toThrow(/401 from TypeSafe/);
    expect(refused.calls).toHaveLength(1);
  });

  it("says which variable to set when there is no key", () => {
    expect(() => createAskJev(loadConfig({ JEV_PROVIDER: "openrouter" }))).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("OpenCode model availability", () => {
  const answer = { model: "m", answers: { tool: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, usage: { input_tokens: 10, output_tokens: 0 } };

  it.each([404, 410])("passes through when the free model returns %i without calling the paid model", async (status) => {
    const config = loadConfig({ OPENCODE_API_KEY: "ock" });
    const { calls, fetchImpl } = capture(() => new Response("model not found ".repeat(20), { status }));
    const ask = createAskJev(config, fetchImpl);
    const error = await ask({ ...request, model: config.jevModel }).catch((caught: Error) => caught);
    if (!(error instanceof Error)) throw new Error("Expected the free model call to fail");
    expect(error.message.slice(0, 100)).toContain("JEV_MODEL=jev-1.13");
    expect(calls.map((call) => call.body.model)).toEqual(["jev-1.13-free"]);
  });

  it("uses the paid model when explicitly selected", async () => {
    const config = loadConfig({ OPENCODE_API_KEY: "ock", JEV_MODEL: "jev-1.13" });
    const { calls, fetchImpl } = capture(() => Response.json(answer));
    await createAskJev(config, fetchImpl)({ ...request, model: config.jevModel });
    expect(calls.map((call) => call.body.model)).toEqual(["jev-1.13"]);
  });

  it.each([429, 500, 503])("stays on the free model when it answers %i, which says nothing about the model", async (status) => {
    const config = loadConfig({ OPENCODE_API_KEY: "ock" });
    const { calls, fetchImpl } = capture(() => new Response("busy", { status }));
    await expect(createAskJev(config, fetchImpl)({ ...request, model: config.jevModel })).rejects.toThrow(`${status} from OpenCode`);
    expect(calls.map((call) => call.body.model)).toEqual(["jev-1.13-free", "jev-1.13-free"]);
  });

  it("stays on the free model when it is only slow", async () => {
    const config = loadConfig({ OPENCODE_API_KEY: "ock" });
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(String(init.body)).model);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(createAskJev(config, fetchImpl)({ ...request, model: config.jevModel })).rejects.toThrow(/timeout/);
    expect(models).toEqual(["jev-1.13-free", "jev-1.13-free"]);
  });

  it("does not retry a refused key", async () => {
    const config = loadConfig({ OPENCODE_API_KEY: "ock" });
    const { calls, fetchImpl } = capture(() => new Response("bad key", { status: 401 }));
    await expect(createAskJev(config, fetchImpl)({ ...request, model: config.jevModel })).rejects.toThrow(/401 from OpenCode/);
    expect(calls).toHaveLength(1);
  });

});

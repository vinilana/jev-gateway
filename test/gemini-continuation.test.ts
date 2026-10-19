import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { NO_TOOL } from "../src/questions.js";
import type { AskJev } from "../src/decide.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const plans = {
  functionDeclarations: [{ name: "list_plans", description: "List saved plans.", parameters: { type: "object", properties: {} } }],
};
const fileTools = {
  functionDeclarations: [
    plans.functionDeclarations[0],
    {
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
};
const userTurn = { role: "user", parts: [{ text: "List plans, then read the newest plan." }] };
const geminiRequest = (contents: unknown[] = [userTurn], tools: unknown = fileTools) => ({ contents, tools: [tools] });
const wrappedRequest = (contents = [userTurn]) => ({
  project: "projects/test-project/locations/global",
  model: "gemini-3.8-flash-high",
  requestId: "req-signature",
  request: geminiRequest(contents, plans),
});
const callContent = (thoughtSignature: string, name = "list_plans") => ({
  role: "model",
  parts: [{ functionCall: { name, args: name === "read_file" ? { path: "latest.txt" } : {} }, thoughtSignature }],
});
const functionResult = (name: string, output: string) => ({
  role: "user",
  parts: [{ functionResponse: { name, response: { output } } }],
});
const candidate = (content: unknown) => ({ candidates: [{ content, finishReason: "STOP", index: 0 }] });
const answer = (choice: string) => ({ tool: { choice }, needs_tool: { noul: 0.95 } });

function bodyOf(init: RequestInit | undefined): Record<string, any> {
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "";
  return JSON.parse(text) as Record<string, any>;
}

function contentOf(body: Record<string, any>) {
  return body.response?.candidates?.[0]?.content ?? body.candidates?.[0]?.content;
}

describe("Gemini provider signatures", () => {
  it("gets a signed provider tool call for a closed-set Gemini 3 request", async () => {
    const signedContent = callContent("provider-signature-1");
    const reply = candidate(signedContent);
    const jev = fakeJev(answer("list_plans"));
    const upstream = fakeUpstream(reply);
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const response = await app.request("/v1beta/models/gemini-3:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(geminiRequest([userTurn], plans)),
    });

    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.body.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["list_plans"],
    });
    expect(await response.json()).toEqual(reply);
  });

  it("continues through two signed tool calls and returns the provider's final answer", async () => {
    const jevAnswers = [
      fakeJev(answer("list_plans")),
      fakeJev(answer("read_file")),
      fakeJev({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } }),
    ];
    let jevCall = 0;
    const askJev: AskJev = (request) => jevAnswers[Math.min(jevCall++, jevAnswers.length - 1)]!.askJev(request);
    const sent: Record<string, any>[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = bodyOf(init);
      sent.push(body);
      const modelCalls = (body.contents as Record<string, any>[]).filter(
        (content) => content.role === "model" && content.parts?.some((part: Record<string, any>) => part.functionCall),
      );
      const missingSignature = modelCalls.some((content) =>
        content.parts.some((part: Record<string, any>) => part.functionCall && !part.thoughtSignature),
      );
      if (missingSignature) return Response.json({ error: "missing thoughtSignature" }, { status: 400 });
      if (modelCalls.length === 0) return Response.json(candidate(callContent("provider-signature-1")));
      if (modelCalls.length === 1) return Response.json(candidate(callContent("provider-signature-2", "read_file")));
      return Response.json(candidate({ role: "model", parts: [{ text: "fixture: plan read successfully" }] }));
    }) as typeof fetch;
    const app = createApp({ config: testConfig(), askJev, fetch: fetchImpl });
    const post = (contents: unknown[]) =>
      app.request("/v1beta/models/gemini-3:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(geminiRequest(contents)),
      });

    const first = await post([userTurn]);
    const firstContent = contentOf(await first.json());
    const second = await post([userTurn, firstContent, functionResult("list_plans", "latest.txt")]);
    expect(second.status, "the provider rejects continuations whose tool call has no signature").toBe(200);
    const secondContent = contentOf(await second.json());
    const third = await post([
      userTurn,
      firstContent,
      functionResult("list_plans", "latest.txt"),
      secondContent,
      functionResult("read_file", "plan contents"),
    ]);
    const finalBody = await third.json() as Record<string, any>;

    expect(first.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(second.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(third.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(finalBody.candidates[0].content.parts[0].text).toBe("fixture: plan read successfully");
    expect(sent).toHaveLength(3);
    expect(sent[1]?.contents[1]).toEqual(callContent("provider-signature-1"));
    expect(sent[2]?.contents[1]).toEqual(callContent("provider-signature-1"));
    expect(sent[2]?.contents[3]).toEqual(callContent("provider-signature-2", "read_file"));
    expect(sent[2]?.toolConfig?.functionCallingConfig).toEqual({ mode: "NONE" });
  });

  it.each([
    ["JSON", "/v1internal:generateContent", "json"],
    ["SSE", "/v1internal:streamGenerateContent?alt=sse", "sse"],
    ["JSON-array", "/v1internal:streamGenerateContent", "array"],
  ] as const)("preserves a signature in a Cloud Code wrapped %s response", async (_label, path, format) => {
    const signedContent = callContent("cloudcode-provider-signature");
    const wrappedReply = { response: candidate(signedContent) };
    const sent: Record<string, any>[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(bodyOf(init));
      if (format === "sse") {
        return new Response(`data: ${JSON.stringify(wrappedReply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (format === "array") {
        return new Response(JSON.stringify([wrappedReply]), { headers: { "content-type": "application/json" } });
      }
      return Response.json(wrappedReply);
    }) as typeof fetch;
    const app = createApp({
      config: testConfig(),
      askJev: fakeJev(answer("list_plans")).askJev,
      fetch: fetchImpl,
    });
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wrappedRequest()),
    });
    const text = await response.text();
    let returned: Record<string, any>;
    if (format === "sse") {
      returned = JSON.parse(text.match(/^data: (.+)$/m)?.[1] ?? "null") as Record<string, any>;
    } else if (format === "array") {
      returned = (JSON.parse(text) as Record<string, any>[])[0]!;
    } else {
      returned = JSON.parse(text) as Record<string, any>;
    }

    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(response.headers.get("content-type")).toContain(format === "sse" ? "text/event-stream" : "application/json");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request?.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["list_plans"],
    });
    expect(returned.response.candidates[0].content.parts[0]).toEqual(signedContent.parts[0]);
  });

  it("keeps signed history in none and passthrough requests", async () => {
    const signedHistory = [userTurn, callContent("prior-provider-signature"), functionResult("list_plans", "latest.txt")];
    const original = geminiRequest(signedHistory, plans);
    const jev = fakeJev({ tool: { choice: NO_TOOL }, needs_tool: { noul: 0.05 } });
    const upstream = fakeUpstream({ candidates: [] });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const send = (headers: Record<string, string> = {}) =>
      app.request("/v1beta/models/gemini-3:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(original),
      });

    const none = await send();
    expect(none.headers.get("x-jev-gateway-mode")).toBe("none");
    expect(upstream.calls[0]?.body.toolConfig?.functionCallingConfig).toEqual({ mode: "NONE" });
    expect(upstream.calls[0]?.body.contents[1]).toEqual(callContent("prior-provider-signature"));

    const passthrough = await send({ "x-jev-gateway": "off" });
    expect(passthrough.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(upstream.calls[1]?.body).toEqual(original);
  });
});

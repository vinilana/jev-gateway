import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MULTIMODAL_SKIP } from "../src/multimodal.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

function chatApp() {
  const jev = fakeJev({ tool: { choice: "x" }, needs_tool: { noul: 0.9 } });
  const upstream = fakeUpstream({ id: "ok" });
  const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
  return { app, jev, upstream };
}

describe("latest-interaction multimodal passthrough", () => {
  const parameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  const functionTool = { type: "function", name: "x", parameters };
  it.each([
    ["Gemini signatures and application JSON", "/v1beta/models/gemini:generateContent", {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "x", args: { media: "print" } }, thoughtSignature: "signature" }] },
        { role: "user", parts: [{ functionResponse: { name: "x", response: { entries: [{ type: "blob", blob: "abc" }] } } }] },
        { role: "user", parts: [{ text: "continue" }] },
      ], tools: [{ functionDeclarations: [{ name: "x", parameters }] }],
    }],
    ["Responses hosted traces and refusals", "/v1/responses", {
      model: "m", input: [
        { type: "web_search_call", id: "w", status: "completed" },
        { type: "file_search_call", id: "f", status: "completed" },
        { type: "computer_call", id: "c", action: { type: "click", x: 1, y: 2 } },
        { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] },
        { role: "user", content: "continue" },
      ], tools: [functionTool],
    }],
    ["Messages web-search results", "/v1/messages", {
      model: "m", messages: [
        { role: "assistant", content: [{ type: "server_tool_use", id: "w", name: "web_search", input: { query: "x" } }] },
        { role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "w", content: [
          { type: "web_search_result", url: "https://example.test", title: "Example", encrypted_content: "citation" },
        ] }] },
        { role: "user", content: "continue" },
      ], tools: [{ name: "x", input_schema: parameters }],
    }],
    ["Responses code-interpreter logs", "/v1/responses", {
      model: "m", input: [
        { role: "user", content: "run this" },
        { type: "code_interpreter_call", id: "ci", status: "completed", outputs: [{ type: "logs", logs: "done" }] },
      ], tools: [functionTool],
    }],
    ["Responses image-generation trace without an image", "/v1/responses", {
      model: "m", input: [
        { role: "user", content: "draw this" },
        { type: "image_generation_call", id: "ig", status: "failed", result: null },
      ], tools: [functionTool],
    }],
    ["Responses older generated image", "/v1/responses", {
      model: "m", input: [
        { type: "image_generation_call", id: "ig", status: "completed", result: "aW1hZ2U=" },
        { role: "user", content: "continue" },
      ], tools: [functionTool],
    }],
    ["Messages code-execution text results", "/v1/messages", {
      model: "m", messages: [{ role: "user", content: [
        { type: "bash_code_execution_tool_result", tool_use_id: "c", content: {
          type: "bash_code_execution_result", stdout: "done", stderr: "", return_code: 0, content: [],
        } },
      ] }], tools: [{ name: "x", input_schema: parameters }],
    }],
  ])("still routes text-only %s", async (_name, path, body) => {
    const { app, jev, upstream } = chatApp();
    const before = structuredClone(body);
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(jev.requests).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
    expect(body).toEqual(before);
  });

  it.each<[string, Record<string, unknown>]>([
    ["/v1/responses", { model: "m", input: [{ type: "computer_call_output", call_id: "c", output: { type: "computer_screenshot", image_url: "https://example.test/image" } }], tools: [functionTool] }],
    ["/v1/responses", { model: "m", input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }], tools: [functionTool] }],
    ["/v1/chat/completions", { model: "m", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }] }], tools: [{ type: "function", function: { name: "x", parameters } }] }],
    ["/v1/messages", { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "document", source: { type: "url", url: "https://example.test/document" } }] }] }], tools: [{ name: "x", input_schema: parameters }] }],
    ["/v1/responses", { model: "m", input: [
      { role: "user", content: "plot this" },
      { type: "code_interpreter_call", id: "ci", status: "completed", outputs: [{ type: "image", url: "https://example.test/plot.png" }] },
    ], tools: [functionTool] }],
    ["/v1/responses", { model: "m", input: [
      { role: "user", content: "draw this" },
      { type: "image_generation_call", id: "ig", status: "completed", result: "aW1hZ2U=" },
    ], tools: [functionTool] }],
    ...["code_execution", "bash_code_execution", "text_editor_code_execution"].map<[string, Record<string, unknown>]>(type => ["/v1/messages", {
      model: "m", messages: [{ role: "user", content: [
        { type: `${type}_tool_result`, tool_use_id: "c", content: {
          type: `${type}_result`, content: [{ type: `${type}_output`, file_id: "file-generated" }],
        } },
      ] }], tools: [{ name: "x", input_schema: parameters }],
    }]),
  ])("forwards actual attachments unchanged on %s, including streaming", async (path, body) => {
    const { app, jev, upstream } = chatApp();
    const request = { ...body, stream: true };
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(request);
  });

  it("bypasses user screenshots without a Jev call, preserving body and model", async () => {
    const { app, jev, upstream } = chatApp();
    const body = {
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this screenshot?" },
            { type: "image_url", image_url: { url: "http://127.0.0.1/image.png" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: {} } } }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(upstream.calls[0]!.body.model).toBe("gpt-5");
  });

  it("bypasses MCP-returned screenshots and mixed text/image tool results", async () => {
    const { app, jev, upstream } = chatApp();
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "screenshot the viewport" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "viewport:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "shot", parameters: { type: "object", properties: {} } } }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls[0]!.body.messages[2].content).toHaveLength(2);
  });

  it("covers Responses, Messages, and Gemini image shapes", async () => {
    // Responses input_image
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "http://x/y.png" }] }],
          tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
    // Messages image block + nested tool-result image
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64" } }] }],
          tools: [{ name: "t", input_schema: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
    // Gemini inlineData
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] }],
          tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: {} } }] }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
  });

  it("bypasses nested blobs and opaque references without failing", async () => {
    // Gemini functionResponse carrying a nested screenshot part.
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const body = {
        contents: [
          {
            role: "user",
            parts: [{ functionResponse: { name: "shot", response: { ok: true }, parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }] } }],
          },
        ],
        tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: {} } }] }],
      };
      const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]!.body).toEqual(body);
    }
    // Responses opaque item reference (server-side content Jev cannot see).
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream();
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const body = {
        model: "m",
        input: [{ type: "item_reference", id: "msg_1" }],
        tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
      };
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
      expect(upstream.calls[0]!.body).toEqual(body);
    }
  });

  it("bypasses opaque file references and malformed content without failing", async () => {
    const { app, jev } = chatApp();
    const fileRef = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-123" } }] }],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(fileRef.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(jev.requests).toHaveLength(0);

    const malformed = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image_url" }] }],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(malformed.headers.get("x-jev-gateway-mode")).toBe("passthrough");
  });

  it("routes when the image is older than the latest text turn", async () => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: [{ type: "text", text: "old" }, { type: "image_url", image_url: { url: "http://x/old.png" } }] },
          { role: "assistant", content: "saw it" },
          { role: "user", content: "now pure text follow-up" },
        ],
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      }),
    });
    // The older screenshot keeps main's placeholder; only the latest turn decides the bypass.
    expect(res.headers.get("x-jev-gateway-mode")).toBe("direct");
    expect(jev.requests).toHaveLength(1);
  });

  it.each([
    ["Responses compaction", "/v1/responses", {
      model: "m",
      input: [
        { type: "compaction", status: "completed" },
        { role: "user", content: "continue after compaction" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Responses context compaction", "/v1/responses", {
      model: "m",
      input: [
        { type: "context_compaction", status: "completed" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Responses tool search output", "/v1/responses", {
      model: "m",
      input: [
        { type: "tool_search_output", call_id: "s", tools: [] },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Responses vendor text trace", "/v1/responses", {
      model: "m",
      input: [
        { type: "vendor_text_trace", role: "assistant", content: "delegated" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Responses MCP call", "/v1/responses", {
      model: "m",
      input: [
        { type: "mcp_call", call_id: "c", name: "shot", arguments: "{}" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Responses code interpreter call", "/v1/responses", {
      model: "m",
      input: [
        { type: "code_interpreter_call", call_id: "c", status: "completed" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Messages tool reference", "/v1/messages", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: [{ type: "tool_reference", tool_use_id: "w" }] }] },
        { role: "user", content: "continue" },
      ],
      tools: [{ name: "t", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Messages text-only web fetch result", "/v1/messages", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: [{ type: "web_fetch_tool_result", url: "https://example.test", content: "text" }] }] },
        { role: "user", content: "continue" },
      ],
      tools: [{ name: "t", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Messages unknown block", "/v1/messages", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "mcp_call", name: "shot" }] },
        { role: "user", content: "continue" },
      ],
      tools: [{ name: "t", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    }],
    ["Gemini unknown part", "/v1beta/models/gemini-2.0-flash:generateContent", {
      contents: [
        { role: "user", parts: [{ somethingNew: { blob: "abc" } }] },
        { role: "user", parts: [{ text: "continue" }] },
      ],
      tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }],
    }],
    ["chat unknown part", "/v1/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "custom_thing", custom_thing: { blob: "abc" } }] },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }],
    }],
  ])("routes unknown %s instead of bypassing", async (_name, path, body) => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(res.headers.get("x-jev-gateway-reason")).toBeNull();
    expect(jev.requests).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
  });

  it("bypasses opaque references even when newer text follows", async () => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: [
          { type: "item_reference", id: "msg_1" },
          { role: "user", content: "continue in text" },
        ],
        tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
      }),
    });
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
  });

  it.each([
    ["chat image without tools", "/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "http://x/y.png" } }] }],
    }, "no_tools"],
    ["chat image with a decided choice", "/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "http://x/y.png" } }] }],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "t" } },
    }, "tool_choice_already_decided"],
    ["Responses image without tools", "/v1/responses", {
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "http://x/y.png" }] }],
    }, "no_tools"],
    ["Gemini image without tools", "/v1beta/models/gemini-2.0-flash:generateContent", {
      contents: [{ role: "user", parts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] }],
    }, "no_tools"],
  ])("keeps %s precedence over the media bypass", async (_name, path, body, reason) => {
    const jev = fakeJev({});
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(reason);
    expect(jev.requests).toHaveLength(0);
  });

  it("bypasses a parallel tool batch when one sibling carries media", async () => {
    const jev = fakeJev({});
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "screenshot both viewports" },
        { role: "assistant", tool_calls: [
          { id: "c1", type: "function", function: { name: "shot", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "shot", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "first viewport: ok" },
        { role: "tool", tool_call_id: "c2", content: [
          { type: "text", text: "second viewport:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ] },
      ],
      tools: [{ type: "function", function: { name: "shot", parameters: { type: "object", properties: {} } } }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
  });

  it("ignores trailing bookkeeping around the latest interaction", async () => {
    // Text plus trailing reasoning still routes.
    {
      const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.99 } });
      const upstream = fakeUpstream({ id: "ok" });
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [
            { role: "user", content: "continue" },
            { type: "reasoning", id: "r", summary: [] },
          ],
          tools: [{ type: "function", name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
      expect(jev.requests).toHaveLength(1);
    }
    // A media batch stays a bypass even with bookkeeping after it.
    {
      const jev = fakeJev({});
      const upstream = fakeUpstream({ id: "ok" });
      const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [
            { type: "function_call", call_id: "c", name: "shot", arguments: "{}" },
            { type: "computer_call_output", call_id: "c", output: { type: "computer_screenshot", image_url: "https://example.test/image" } },
            { type: "reasoning", id: "r", summary: [] },
          ],
          tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
        }),
      });
      expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
      expect(jev.requests).toHaveLength(0);
    }
  });

  it("forwards a latest-media bypass byte for byte, model included", async () => {
    const jev = fakeJev({});
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = {
      model: "gpt-5",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "http://x/y.png" }] }],
      tools: [{ type: "function", name: "t", parameters: { type: "object", properties: {} } }],
    };
    const res = await app.request("/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toBe(MULTIMODAL_SKIP);
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toEqual(body);
    expect(upstream.calls[0]!.body.model).toBe("gpt-5");
    expect(upstream.calls[0]!.body.tools).toEqual(body.tools);
    expect(upstream.calls[0]!.body.stream).toBe(true);
  });

  it("routes older Gemini media with the newest text turn", async () => {
    const jev = fakeJev({ tool: { choice: "t" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream({ id: "ok" });
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "old" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] },
          { role: "user", parts: [{ text: "now pure text follow-up" }] },
        ],
        tools: [{ functionDeclarations: [{ name: "t", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }],
      }),
    });
    expect(res.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(jev.requests).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["t"] });
  });
});

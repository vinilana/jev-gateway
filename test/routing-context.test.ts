import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { loadConfig } from "../src/config.js";
import { buildState } from "../src/state.js";
import type { RouterInput, Turn } from "../src/types.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const call = (id: string): Turn => ({ role: "assistant", tool_calls: [{ tool: "read", call_id: id, arguments: "{}" }] });
const result = (id: string, content: string): Turn => ({ role: "tool_result", tool: "read", call_id: id, content });

describe("routing context", () => {
  it("preserves passthrough for chat requests containing only system and developer messages", async () => {
    const jev = fakeJev({ tool: { choice: "read" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", messages: [
      { role: "system", content: "Use tools" }, { role: "developer", content: "Read the file" },
    ], tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }] };
    const response = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(response.headers.get("x-jev-gateway-reason")).toBe("no_messages");
    expect(jev.requests).toHaveLength(0);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body.messages).toEqual(body.messages);
  });

  it.each(["[truncated] is literal output", "x".repeat(5000)])("still routes after an older tool output is clipped or contains marker text", async (content) => {
    const jev = fakeJev({ tool: { choice: "read" }, needs_tool: { noul: 0.99 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", messages: [
      { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content }, { role: "user", content: "continue" },
    ], tools: [{ type: "function", function: { name: "read", parameters: { properties: { path: { type: "string" } } } } }] };
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(jev.requests).toHaveLength(1);
    expect(upstream.calls[0]!.body.messages).toEqual(body.messages);
  });

  it("retains parallel dependency spans in order and shrinks a large newest group without mutating input", () => {
    const ids = Array.from({ length: 20 }, (_, index) => String(index));
    const input = { system: "Be useful", turns: [...ids.map(call), ...ids.map((id) => result(id, "output ".repeat(600)))] };
    const before = structuredClone(input);
    const state = buildState(input, { maxStateChars: 6000, maxMessageChars: 4000 });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(6000);
    expect(state.unrepresentable).toBeUndefined();
    expect(state.clipped).toBe(true);
    const turns = state.conversation as Turn[];
    expect(turns).toHaveLength(40);
    expect(turns.slice(20).map((turn) => turn.call_id)).toEqual(ids);
    expect(turns.slice(20).every((turn) => typeof turn.content === "string" && turn.content.length > 0)).toBe(true);
    expect(input).toEqual(before);
  });

  it.each([64, 100, 500])("keeps useful escaped Unicode text within exactly %s units", (budget) => {
    const state = buildState({ system: "", turns: [{ role: "user", text: '\\"😀recent'.repeat(100) }] },
      { maxStateChars: budget, maxMessageChars: 4000 });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(budget);
    expect(state.unrepresentable).toBeUndefined();
    const text = (state.conversation as Turn[])[0]!.text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(state.clipped).toBe(true);
  });

  it("does not mistake a literal clipping marker for metadata", () => {
    const state = buildState({ system: "", turns: [call("a"), result("a", "[truncated]")] }, { maxStateChars: 500, maxMessageChars: 4000 });
    expect(state.clipped).toBeUndefined();
    expect(state.unrepresentable).toBeUndefined();
  });

  it("selects the complete suffix at the exact escaped JSON budget", () => {
    const turns: Turn[] = Array.from({ length: 30 }, (_, index) => ({
      role: "user", text: `${index}: ${'\\"😀'.repeat(8)}`,
    }));
    const input = { system: 'Keep "quotes" and 😀', turns };
    const originalText = turns[17]!.text;
    const expected = {
      assistant_instructions: input.system,
      earlier_turns_omitted: 17,
      conversation: turns.slice(17),
    };
    const budget = JSON.stringify(expected).length;
    const state = buildState(input, { maxStateChars: budget, maxMessageChars: 4000 });
    expect(state).toEqual(expected);
    expect(JSON.stringify(state).length).toBe(budget);
    expect(buildState(input, { maxStateChars: budget - 1, maxMessageChars: 4000 })).toEqual({
      ...expected, earlier_turns_omitted: 18, conversation: turns.slice(18),
    });
    (state.conversation as Turn[])[0]!.text = "changed output";
    expect(input.turns[17]!.text).toBe(originalText);
  });

  it("omits clipping metadata when only discarded turns were clipped", () => {
    const expected = { earlier_turns_omitted: 1, conversation: [{ role: "user", text: "continue" }] };
    const state = buildState({ system: "", turns: [
      { role: "user", text: "old ".repeat(100) }, { role: "user", text: "continue" },
    ] }, { maxStateChars: JSON.stringify(expected).length, maxMessageChars: 20 });
    expect(state).toEqual(expected);
  });

  it.each([
    [result("missing", "orphan")],
    [call("a"), call("a"), result("a", "ambiguous")],
    [call("a"), result("a", "first"), result("a", "duplicate")],
  ])("keeps orphaned and reused results routable: %j", (...turns) => {
    const state = buildState({ system: "", turns }, { maxStateChars: 500, maxMessageChars: 4000 });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(500);
    expect(state.unrepresentable).toBeUndefined();
    expect(state.conversation).toEqual(turns);
  });

  it("matches parallel id-less same-name calls FIFO despite client-generated result IDs", () => {
    const turns: Turn[] = [
      { role: "assistant", tool_calls: [{ tool: "read", arguments: "first" }] },
      { role: "assistant", tool_calls: [{ tool: "read", arguments: "second" }] },
      { role: "tool_result", tool: "read", call_id: "client-1", content: "A" },
      { role: "tool_result", tool: "read", call_id: "client-2", content: "B" },
    ];
    const state = buildState({ system: "", turns }, { maxStateChars: 2000, maxMessageChars: 4000 });
    expect(state.unrepresentable).toBeUndefined();
    expect(state.conversation).toEqual(turns);
  });

  it("matches reused IDs across exchanges without invalidating earlier groups", () => {
    const turns = [call("call_0"), result("call_0", "A"), call("call_0"), result("call_0", "B")];
    const state = buildState({ system: "", turns }, { maxStateChars: 2000, maxMessageChars: 4000 });
    expect(state.unrepresentable).toBeUndefined();
    expect(state.conversation).toEqual(turns);
  });

  it("does not let an exhausted result ID consume a later same-name call", () => {
    const turns = [call("a"), result("a", "A"), call("b"), result("a", "duplicate ".repeat(100)), result("b", "B")];
    const smallest = { earlier_turns_omitted: 2, clipped: true, conversation: [
      { ...call("b"), tool_calls: [{ tool: "read", call_id: "b", arguments: "" }] },
      result("a", ""), result("b", ""),
    ] };
    const budget = JSON.stringify(smallest).length + 30;
    const state = buildState({ system: "", turns }, { maxStateChars: budget, maxMessageChars: 4000 });
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(budget);
    expect(state.unrepresentable).toBeUndefined();
    expect(state.earlier_turns_omitted).toBe(2);
    const kept = state.conversation as Turn[];
    expect(kept).toHaveLength(3);
    expect(kept[0]!.tool_calls).toEqual([{ tool: "read", call_id: "b", arguments: "{}" }]);
    expect(kept[2]!.call_id).toBe("b");
    expect(kept[2]!.content).toBe("B");
  });

  it("keeps observed Gemini IDs without manufacturing absent IDs", () => {
    const input = geminiAdapter.toInput({ contents: [
      { role: "model", parts: [{ functionCall: { id: "g1", name: "read", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "g1", name: "read", response: { ok: true } } }] },
    ], tools: [{ functionDeclarations: [{ name: "read" }] }] }, 4000) as RouterInput;
    expect(input.turns[0]!.tool_calls).toEqual([{ tool: "read", call_id: "g1", arguments: "{}" }]);
    expect(input.turns[1]!.call_id).toBe("g1");
    expect(buildState(input, { maxStateChars: 500, maxMessageChars: 4000 }).unrepresentable).toBeUndefined();
  });

  it.each(["0", "63", "1.5", "-1"])("rejects invalid state budgets at startup: %s", (value) => {
    expect(() => loadConfig({ JEV_MAX_STATE_CHARS: value })).toThrow(`JEV_MAX_STATE_CHARS must be an integer of at least 64, got "${value}"`);
  });
});

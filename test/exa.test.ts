import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exaAdapter } from "../src/adapters/exa.js";
import { frame, peel } from "../src/proto/connect.js";
import { concat, field, readFields, text, utf8 } from "../src/proto/wire.js";
import { buildState } from "../src/state.js";

const userMsg = (body: string) => field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 1n), utf8(3, body)));
const toolDef = (name: string, schema = "{}") => field(10, 2, concat(utf8(1, name), utf8(2, `does ${name}`), utf8(3, schema)));
const request = (...parts: Uint8Array[]): Uint8Array => frame(concat(...parts));

const parse = (bytes: Uint8Array) => {
  const req = exaAdapter.parse!(bytes);
  if (!req) throw new Error("parse failed");
  return req;
};
const field3Texts = (req: ReturnType<typeof parse>) =>
  req.message
    .filter((f) => f.field === 3)
    .map((m) => text(readFields(m.bytes!).find((f) => f.field === 3)));

describe("exaAdapter.toInput", () => {
  it("extracts tools and the conversation for Jev", () => {
    const req = parse(request(userMsg("run echo hi"), toolDef("exec", '{"type":"object"}')));
    const input = exaAdapter.toInput(req, 4000);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.tools).toEqual([
      { kind: "function", name: "exec", description: "does exec", parameters: { type: "object" } },
    ]);
    expect(input.turns).toEqual([{ role: "user", text: "run echo hi" }]);
    expect(input.toolChoice).toBe("auto");
    expect(input.steer).toBe("hint");
  });

  it("produces no tools for requests without field 10, so decide passes them through", () => {
    const input = exaAdapter.toInput(parse(request(userMsg("hi"))), 4000);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.tools).toEqual([]); // decide() turns this into passthrough "no_tools"
  });

  it("reads assistant tool calls and resolves tool results by call id", () => {
    const assistant = field(
      3,
      2,
      concat(
        utf8(1, randomUUID()),
        field(2, 0, 2n),
        field(6, 2, concat(utf8(1, "call_abc#def"), utf8(2, "exec"), utf8(3, '{"command":"ls"}'))),
        utf8(11, "thinking about it"),
      ),
    );
    const toolResult = field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 4n), utf8(3, "file1 file2"), utf8(7, "call_abc#def")));
    const input = exaAdapter.toInput(parse(request(userMsg("list files"), assistant, toolResult, toolDef("exec"))), 4000);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.turns[1]).toEqual({
      role: "assistant",
      text: "thinking about it",
      tool_calls: [{ tool: "exec", call_id: "call_abc#def", arguments: '{"command":"ls"}' }],
    });
    expect(input.turns[2]).toEqual({ role: "tool_result", tool: "exec", call_id: "call_abc#def", content: "file1 file2" });
  });

  it("retains Devin dependency spans after a duplicate result without changing the wire request", () => {
    const call = (id: string) => field(3, 2, concat(
      field(2, 0, 2n), field(6, 2, concat(utf8(1, id), utf8(2, "exec"), utf8(3, "{}"))),
    ));
    const result = (id: string, content: string) => field(3, 2, concat(field(2, 0, 4n), utf8(3, content), utf8(7, id)));
    const bytes = request(call("a"), result("a", "A"), call("b"), result("a", "duplicate ".repeat(100)), result("b", "B"), toolDef("exec"));
    const req = parse(bytes);
    const input = exaAdapter.toInput(req, 4000);
    if ("skip" in input) throw new Error(input.skip);
    const smallest = { earlier_turns_omitted: 2, clipped: true, conversation: [
      { role: "assistant", tool_calls: [{ tool: "exec", call_id: "b", arguments: "" }] },
      { role: "tool_result", tool: "exec", call_id: "a", content: "" },
      { role: "tool_result", tool: "exec", call_id: "b", content: "" },
    ] };
    const budget = JSON.stringify(smallest).length + 30;
    const state = buildState(input, { maxMessageChars: 4000, maxStateChars: budget });
    expect(state.unrepresentable).toBeUndefined();
    expect(state.earlier_turns_omitted).toBe(2);
    expect(state.conversation).toEqual([
      { role: "assistant", tool_calls: [{ tool: "exec", call_id: "b", arguments: "{}" }] },
      expect.objectContaining({ role: "tool_result", call_id: "a" }),
      { role: "tool_result", tool: "exec", call_id: "b", content: "B" },
    ]);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(budget);
    expect(exaAdapter.encode!(req)).toEqual(bytes);
  });

  it("leaves thinking intact until state construction records clipping", () => {
    const assistant = field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 2n), utf8(11, "t".repeat(100))));
    const input = exaAdapter.toInput(parse(request(assistant, toolDef("exec"))), 30);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.turns[0]!.role).toBe("assistant");
    expect(input.turns[0]!.text).toBe("t".repeat(100));
    const state = buildState(input, { maxMessageChars: 30, maxStateChars: 2000 });
    expect(state.clipped).toBe(true);
    expect(JSON.stringify(state.conversation)).toContain("[truncated]");
  });

  it("records clipping of Exa text, arguments and results without changing the wire request", () => {
    const long = "x".repeat(100);
    const assistant = field(3, 2, concat(
      field(2, 0, 2n),
      field(6, 2, concat(utf8(1, "call-long"), utf8(2, "exec"), utf8(3, long))),
    ));
    const result = field(3, 2, concat(field(2, 0, 4n), utf8(3, long), utf8(7, "call-long")));
    const bytes = request(userMsg(long), assistant, result, toolDef("exec"));
    const req = parse(bytes);
    const input = exaAdapter.toInput(req, 30);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.turns[0]!.text).toBe(long);
    expect(input.turns[1]!.tool_calls).toEqual([{ tool: "exec", call_id: "call-long", arguments: long }]);
    expect(input.turns[2]!.content).toBe(long);
    const state = buildState(input, { maxMessageChars: 30, maxStateChars: 2000 });
    expect(state.clipped).toBe(true);
    expect(JSON.stringify(state.conversation).match(/\[truncated\]/g)).toHaveLength(3);
    expect(exaAdapter.encode!(req)).toEqual(bytes);
  });

  it("skips messages with roles it does not know", () => {
    const unknown = field(3, 2, concat(utf8(1, randomUUID()), field(2, 0, 99n), utf8(3, "hidden")));
    const input = exaAdapter.toInput(parse(request(userMsg("hi"), unknown, toolDef("exec"))), 4000);
    if ("skip" in input) throw new Error(input.skip);
    expect(input.turns).toEqual([{ role: "user", text: "hi" }]);
  });
});

describe("exaAdapter.apply", () => {
  it("appends the hint as a trailing role-1 message and keeps the rest byte-identical", () => {
    const req = parse(request(userMsg("run echo hi"), toolDef("exec")));
    const hinted = exaAdapter.apply(req, { mode: "hint", tool: "exec", confidence: 0.9 });
    const bytes = exaAdapter.encode!(hinted) as Uint8Array;
    const frames = peel(bytes);
    expect(frames).toHaveLength(1);
    const fields = readFields(frames[0]!.payload);
    const messages = fields.filter((f) => f.field === 3);
    expect(messages).toHaveLength(2);
    const last = readFields(messages[1]!.bytes!);
    expect(text(last.find((f) => f.field === 3))).toContain('"exec"');
    // The client's own message and tools are untouched.
    expect(field3Texts({ ...req, message: fields })[0]).toBe("run echo hi");
    expect(fields.filter((f) => f.field === 10)).toHaveLength(1);
  });
});

describe("exaAdapter.directStream", () => {
  it("emits a Connect stream the client can peel, ending in the JSON trailer", () => {
    const req = parse(request(userMsg("run echo hi"), toolDef("exec")));
    const out = exaAdapter.directStream(req, { tool: "exec", args: { command: "echo hi" }, inputTokens: 10 }, new URL("http://localhost/exa"));
    expect(typeof out).not.toBe("string");
    if (typeof out === "string") throw new Error("expected framed body");
    expect(out.contentType).toBe("application/connect+proto");
    const frames = peel(out.body as Uint8Array);
    expect(frames.at(-1)).toEqual({ flags: 2, payload: new TextEncoder().encode("{}") });
    const first = readFields(frames[0]!.payload);
    const call = readFields(first.find((f) => f.field === 6)!.bytes!);
    expect(text(call.find((f) => f.field === 2))).toBe("exec");
    const args = readFields(readFields(frames[1]!.payload).find((f) => f.field === 6)!.bytes!);
    expect(text(args.find((f) => f.field === 3))).toBe('{"command":"echo hi"}');
  });
});

describe("exaAdapter.parse", () => {
  it("returns undefined for garbage instead of throwing", () => {
    expect(exaAdapter.parse!(Uint8Array.of(1, 2, 3))).toBeUndefined();
    expect(exaAdapter.parse!(new Uint8Array())).toBeUndefined();
  });

  it("refuses compressed frames it cannot read", () => {
    expect(exaAdapter.parse!(frame(Uint8Array.of(1, 2, 3), 1))).toBeUndefined();
  });
});

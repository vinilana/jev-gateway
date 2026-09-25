import { randomBytes, randomUUID } from "node:crypto";
import type { Decision } from "../decide.js";
import { truncate } from "../state.js";
import type { DirectCall, JsonSchema, RouterInput, RouterTool, Turn } from "../types.js";
import { frame, peel, type Frame } from "../proto/connect.js";
import { concat, encodeVarint, field, readFields, text, utf8, type WireField } from "../proto/wire.js";
import type { Adapter } from "./adapter.js";

/** Devin CLI's exa protocol (`POST /exa.api_server_pb.ApiServerService/GetChatMessage`):
 *  Connect-enveloped protobuf to server.codeium.com. There is no tool_choice on the wire, so
 *  steering is `hint` — a message appended after the client's own — and `direct` is a
 *  synthesized Connect stream. */

export interface ExaRequest {
  model?: string; // absent: the model is assigned upstream, the request never names it
  stream?: boolean; // always true: Connect server-streaming
  frames: Frame[]; // the request envelope(s); frame 0 carries the proto message
  message: WireField[]; // decoded fields of frame 0's payload
  /** Debug dumps JSON.stringify the request; field 1 carries the session token, so it must
   *  never reach disk — dumps get a structural summary instead. */
  toJSON(): unknown;
}

const fieldsOf = (bytes: Uint8Array | undefined): WireField[] => {
  try {
    return bytes ? readFields(bytes) : [];
  } catch {
    return [];
  }
};
const byField = (fields: WireField[], no: number) => fields.filter((f) => f.field === no);
const first = (fields: WireField[], no: number) => fields.find((f) => f.field === no);
const varint = (f: WireField | undefined) => (f?.varint === undefined ? undefined : Number(f.varint));

function parse(bytes: Uint8Array, encoding?: string): ExaRequest | undefined {
  // A compressed body we can't read is not ours to rewrite: passthrough keeps it intact.
  if (encoding) return undefined;
  try {
    const frames = peel(bytes);
    const payload = frames[0]?.payload;
    // A compressed frame is not ours to judge: passthrough.
    if (!payload || (frames[0]!.flags & 1) !== 0) return undefined;
    const message = readFields(payload);
    return {
      stream: true,
      frames,
      message,
      toJSON: () => ({ stream: true, frames: frames.length, fields: message.map((f) => `${f.field}/w${f.wire}`) }),
    };
  } catch {
    return undefined;
  }
}

function toTools(tools: WireField[]): RouterTool[] {
  const out: RouterTool[] = [];
  for (const entry of tools) {
    const f = fieldsOf(entry.bytes);
    const name = text(first(f, 1));
    // A tool without a name is upstream's problem, not ours: refuse to judge the request.
    if (!name) return [];
    let parameters: JsonSchema | undefined;
    try {
      parameters = JSON.parse(text(first(f, 3))) as JsonSchema;
    } catch {
      parameters = undefined;
    }
    out.push({ kind: "function", name, description: text(first(f, 2)) || undefined, parameters });
  }
  return out;
}

function toInput(req: ExaRequest, maxMessageChars: number): RouterInput | { skip: string } {
  const rawTools = byField(req.message, 10);
  const tools = toTools(rawTools);
  if (tools.length === 0 && rawTools.length > 0) return { skip: "malformed_tools" };

  const toolNameByCallId = new Map<string, string>();
  const turns: Turn[] = [];
  for (const entry of byField(req.message, 3)) {
    const f = fieldsOf(entry.bytes);
    const role = varint(first(f, 2));
    const body = truncate(text(first(f, 3)), maxMessageChars);
    if (role === 1) {
      turns.push({ role: "user", text: body });
    } else if (role === 2) {
      const toolCalls = byField(f, 6).map((call) => {
        const cf = fieldsOf(call.bytes);
        const id = text(first(cf, 1));
        const name = text(first(cf, 2));
        if (id && name) toolNameByCallId.set(id, name);
        return { tool: name || "unknown", arguments: truncate(text(first(cf, 3)), maxMessageChars) };
      });
      const thinking = truncate(text(first(f, 11)), maxMessageChars);
      turns.push({
        role: "assistant",
        ...(body || thinking ? { text: [thinking, body].filter(Boolean).join("\n") } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === 4) {
      turns.push({
        role: "tool_result",
        tool: toolNameByCallId.get(text(first(f, 7))) ?? "unknown",
        content: body,
      });
    }
    // Other roles exist (system events, hidden nodes): not ours to judge, so not Jev's either.
  }
  return { system: "", turns, tools, toolChoice: "auto", steer: "hint" };
}

/** A hint rides as one more role-1 message: appended, so every byte the client sent stays put
 *  and any cached prefix survives. Same wording the Messages adapter uses. */
function apply(req: ExaRequest, decision: Decision): ExaRequest {
  if (decision.mode !== "hint") return req;
  const hint = concat(
    utf8(1, randomUUID()),
    field(2, 0, 1n),
    utf8(
      3,
      `<system-reminder>A tool-routing model suggests the "${decision.tool}" tool is the most relevant next step. ` +
        "Ignore this if it does not fit what the user actually asked for.</system-reminder>",
    ),
  );
  return { ...req, message: [...req.message, { field: 3, wire: 2, bytes: hint }] };
}

/** Re-serialize one decoded field with its own wire type, byte-for-byte where nothing changed. */
const fieldOf = (f: WireField): Uint8Array => {
  const tag = encodeVarint(BigInt(f.field * 8 + f.wire));
  if (f.wire === 0) return concat(tag, encodeVarint(f.varint ?? 0n));
  if (f.wire === 2) return concat(tag, encodeVarint((f.bytes ?? new Uint8Array()).length), f.bytes ?? new Uint8Array());
  return concat(tag, f.bytes ?? new Uint8Array()); // fixed32 / fixed64 carry no length
};

function encode(req: ExaRequest): Uint8Array {
  const [head, ...rest] = req.frames;
  const payload = concat(...req.message.map(fieldOf));
  return concat(frame(payload, head?.flags ?? 0), ...rest.map((f) => frame(f.payload, f.flags)));
}

const envelope = (payload: Uint8Array) => frame(payload, 0);

/** The Connect stream an upstream answer would have had: tool-call frame, args frame, trailer. */
function directStream(_req: ExaRequest, call: DirectCall): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const id = `bot-${randomUUID()}`;
  const callId = `call_${randomBytes(24).toString("hex")}#${randomBytes(24).toString("hex")}`;
  const body = concat(
    envelope(concat(utf8(1, id), field(6, 2, concat(utf8(1, callId), utf8(2, call.tool))))),
    envelope(field(6, 2, utf8(3, JSON.stringify(call.args)))),
    frame(new TextEncoder().encode("{}"), 0x2),
  );
  return { body, contentType: "application/connect+proto" };
}

// Connect is always streamed; the route only asks for JSON when `stream` is falsy, which never
// happens for an ExaRequest.
// Connect server-streaming has no unary form: reaching this is a bug, and throwing makes the
// request fail open to passthrough.
const directJson = (): never => {
  throw new Error("exa has no non-streaming reply");
};

export const exaAdapter: Adapter<ExaRequest> = { parse, encode, toInput, apply, directJson, directStream };

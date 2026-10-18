import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { chatAdapter } from "../src/adapters/chat.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { messagesAdapter } from "../src/adapters/messages.js";
import { responsesAdapter } from "../src/adapters/responses.js";
import { loadConfig } from "../src/config.js";
import { decide, type AskJev, type JevRequest } from "../src/decide.js";
import { createEventLog } from "../src/events.js";
import type { ChatRequest, RouterInput } from "../src/types.js";
import { fakeJev, fakeUpstream, settled, testConfig, tools } from "./helpers.js";

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), data.length + 8);
  return out;
};

/** A real black greyscale PNG, base64-encoded. */
function png(width: number, height: number, extra: Buffer[] = []): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const pixels = deflateSync(Buffer.alloc((width + 1) * height));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), ...extra, chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

/** The head of a JPEG: a metadata segment, then the frame header that holds the size. */
function jpeg(width: number, height: number, frame = 0xc0): string {
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof, Buffer.from([0xff, 0xd9])]).toString("base64");
}

const photo = png(640, 480);
// The helpers' set_lights takes only closed-set arguments, so Jev is asked about each of them too.
const weather = {
  tool: { choice: "get_weather" },
  needs_tool: { noul: 0.97 },
  "arg:1:room": { choice: "kitchen" },
  "arg:1:on": { noul: 0.9 },
  "arg:1:brightness": { choice: "50" },
  "stated:1:brightness": { noul: 0.1 },
};
const imageUrl = (data: string) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
const chatWith = (...messages: unknown[]) => ({ model: "m", tools, messages }) as ChatRequest;

async function ask(input: RouterInput | { skip: string }, config = testConfig(), askJev?: AskJev) {
  const jev = fakeJev(weather);
  const asked: JevRequest[] = [];
  const decision = await decide(input as RouterInput, config, async (request) => {
    asked.push(request);
    return (askJev ?? jev.askJev)(request);
  });
  return { decision, asked };
}

const stateText = (request: JevRequest) => JSON.stringify(request.state);

describe("images reach Jev", () => {
  it.each([
    [
      "Chat Completions",
      chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "text", text: "Weather where this was taken?" }, imageUrl(photo)] }), 4000),
    ],
    [
      "Responses",
      responsesAdapter.toInput(
        {
          model: "m",
          tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
          input: [{ role: "user", content: [{ type: "input_text", text: "Weather here?" }, { type: "input_image", image_url: `data:image/png;base64,${photo}` }] }],
        },
        4000,
      ),
    ],
    [
      "a Messages tool result",
      messagesAdapter.toInput(
        {
          model: "m",
          tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
          messages: [
            { role: "user", content: "Take a screenshot of the forecast page, then check the weather." },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: photo } }] }],
            },
          ],
        },
        4000,
      ),
    ],
    [
      "Gemini",
      geminiAdapter.toInput(
        {
          contents: [{ role: "user", parts: [{ text: "Weather here?" }, { inlineData: { mimeType: "image/png", data: photo } }] }],
          tools: [{ functionDeclarations: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }] }],
        },
        4000,
      ),
    ],
  ])("sends an inline image from %s under the reference written where it was", async (_format, input) => {
    const { decision, asked } = await ask(input);
    const [ref, ...others] = Object.keys(asked[0]!.assets ?? {});
    expect(others).toEqual([]);
    expect(asked[0]!.assets![ref!]).toEqual({ type: "image", data_base64: photo, format: "png" });
    expect(stateText(asked[0]!)).toContain(ref);
    expect(decision).toMatchObject({ mode: "forced", tool: "get_weather", jev: { images: 1 } });
  });

  it("reads the size of a JPEG past its metadata, whichever kind of frame it has", async () => {
    for (const frame of [0xc0, 0xc2]) {
      const image = jpeg(1024, 768, frame);
      const { asked } = await ask(chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }), 4000));
      expect(Object.values(asked[0]!.assets ?? {})).toEqual([{ type: "image", data_base64: image, format: "jpeg" }]);
    }
  });

  it("finds the size of a JPEG whose metadata runs past the bytes it reads first", async () => {
    const profile = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0xff, 0xe2, 0xff, 0xff]), Buffer.alloc(0xfffd)])));
    const head = Buffer.from(jpeg(1024, 768), "base64");
    const image = Buffer.concat([head.subarray(0, 2), profile, head.subarray(2)]).toString("base64");
    const { asked } = await ask(chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }), 4000));
    expect(Object.values(asked[0]!.assets ?? {})).toEqual([{ type: "image", data_base64: image, format: "jpeg" }]);
  });

  it("sends base64 written with line breaks, URL-safe letters or no padding in the standard form", async () => {
    const loose = photo.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/(.{76})/g, "$1\n");
    const { asked } = await ask(chatAdapter.toInput(chatWith({ role: "user", content: [imageUrl(loose)] }), 4000));
    expect(Object.values(asked[0]!.assets ?? {})).toEqual([{ type: "image", data_base64: photo, format: "png" }]);
  });

  it("sends an image once however often the conversation shows it", async () => {
    const { asked } = await ask(
      chatAdapter.toInput(chatWith({ role: "user", content: [imageUrl(photo)] }, { role: "assistant", content: "Nice." }, { role: "user", content: [imageUrl(photo)] }), 4000),
    );
    const refs = Object.keys(asked[0]!.assets ?? {});
    expect(refs).toHaveLength(1);
    expect(stateText(asked[0]!).split(refs[0]!)).toHaveLength(3);
  });

  it("sends the newest images, up to JEV_MAX_IMAGES, and leaves older ones as placeholders", async () => {
    const [oldest, middle, newest] = [png(300, 300), png(400, 400), png(500, 500)];
    const { asked } = await ask(
      chatAdapter.toInput(
        chatWith(
          { role: "user", content: [imageUrl(oldest!)] },
          { role: "assistant", content: "Got it." },
          { role: "user", content: [imageUrl(middle!), { type: "text", text: "and" }, imageUrl(newest!)] },
        ),
        4000,
      ),
    );
    expect(new Set(Object.values(asked[0]!.assets ?? {}).map((asset) => asset.data_base64))).toEqual(new Set([middle, newest]));
    expect(asked[0]!.state).toMatchObject({ conversation: [{ role: "user", text: "[image_url]" }, {}, {}] });
  });

  it("keeps every image a placeholder when JEV_MAX_IMAGES is 0", async () => {
    const config = testConfig({ maxImages: loadConfig({ JEV_MAX_IMAGES: "0" }).maxImages });
    const { decision, asked } = await ask(chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "text", text: "Look" }, imageUrl(photo)] }), 4000), config);
    expect(asked[0]!.assets).toBeUndefined();
    expect(asked[0]!.state).toMatchObject({ conversation: [{ role: "user", text: "Look\n[image_url]" }] });
    expect(decision.jev?.images).toBeUndefined();
  });

  it.each(["1.5", "-1", "two"])("refuses to start with JEV_MAX_IMAGES=%s", (value) => {
    expect(() => loadConfig({ JEV_MAX_IMAGES: value })).toThrow(/JEV_MAX_IMAGES must be/);
  });

  it.each([
    ["wider than 1568 pixels", `data:image/png;base64,${png(1600, 800)}`],
    ["narrower than 280 pixels", `data:image/png;base64,${png(279, 600)}`],
    ["animated", `data:image/png;base64,${png(640, 480, [chunk("acTL", Buffer.alloc(8))])}`],
    ["neither PNG nor JPEG", `data:image/gif;base64,${Buffer.from("GIF89a\x80\x02\xe0\x01").toString("base64")}`],
    ["not base64", "data:image/png;base64,%%%"],
    ["given by URL, which the gateway does not fetch", "https://example.com/forecast.png"],
  ])("keeps an image Jev would not take as a placeholder: %s", async (_why, url) => {
    const { asked } = await ask(chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url } }] }), 4000));
    expect(asked[0]!.assets).toBeUndefined();
    expect(asked[0]!.state).toEqual({ conversation: [{ role: "user", text: "Look\n[image_url]" }] });
  });

  it("makes room in the state for the images it sends", async () => {
    const input = chatAdapter.toInput(
      chatWith({ role: "user", content: "a".repeat(2000) }, { role: "assistant", content: "On it." }, { role: "user", content: [{ type: "text", text: "Look" }, imageUrl(photo)] }),
      4000,
    );
    // Text alone fits in 6000 characters; a 640×480 image takes the room of about 4500.
    const { asked } = await ask(input, testConfig({ maxStateChars: 6000 }));
    expect(Object.keys(asked[0]!.assets ?? {})).toHaveLength(1);
    expect(asked[0]!.state).toMatchObject({ earlier_turns_omitted: 1 });
  });

  it("routes on text when the newest turn no longer fits beside the images", async () => {
    const input = chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "text", text: "Look" }, imageUrl(photo)] }), 4000);
    const { decision, asked } = await ask(input, testConfig({ maxStateChars: 4000 }));
    expect(asked[0]!.assets).toBeUndefined();
    expect(asked[0]!.state).toEqual({ conversation: [{ role: "user", text: "Look\n[image_url]" }] });
    expect(decision).toMatchObject({ mode: "forced", tool: "get_weather" });
  });

  it("leaves out an image whose turn was dropped to fit the state budget", async () => {
    const input = chatAdapter.toInput(
      chatWith({ role: "user", content: [imageUrl(photo)] }, { role: "assistant", content: "x".repeat(200) }, { role: "user", content: "y".repeat(200) }),
      4000,
    );
    const { asked } = await ask(input, testConfig({ maxStateChars: 300 }));
    expect(asked[0]!.assets).toBeUndefined();
    expect(asked[0]!.state).toMatchObject({ earlier_turns_omitted: 2 });
  });
});

describe("a provider that refuses images", () => {
  const withPhoto = () => chatAdapter.toInput(chatWith({ role: "user", content: [{ type: "text", text: "Look" }, imageUrl(photo)] }), 4000);

  it.each([400, 413, 415, 422])("is asked again without them when it answers %i, and routing goes on", async (status) => {
    const jev = fakeJev(weather);
    const { decision, asked } = await ask(withPhoto(), testConfig(), async (request) => {
      if (request.assets) throw Object.assign(new Error(`${status} from OpenRouter: unknown field "assets"`), { status });
      return jev.askJev(request);
    });
    expect(asked).toHaveLength(2);
    expect(asked[1]!.assets).toBeUndefined();
    expect(asked[1]!.state).toEqual({ conversation: [{ role: "user", text: "Look\n[image_url]" }] });
    expect(decision).toMatchObject({ mode: "forced", tool: "get_weather", jev: { imagesRefused: expect.stringContaining(`${status} from OpenRouter`) } });
    expect(decision.jev?.images).toBeUndefined();
  });

  it("is not asked again when it failed for a reason that has nothing to do with them", async () => {
    const { decision, asked } = await ask(withPhoto(), testConfig(), async () => {
      throw Object.assign(new Error("529 from TypeSafe: overloaded"), { status: 529 });
    });
    expect(asked).toHaveLength(1);
    expect(decision).toMatchObject({ mode: "passthrough", reason: expect.stringContaining("jev_error: 529") });
  });

  it("is asked without them for the rest of the request once it refused them", async () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ type: "function", function: { name: `tool_${index}` } }));
    const input = chatAdapter.toInput({ model: "m", tools: many, messages: [{ role: "user", content: [imageUrl(photo)] }] } as ChatRequest, 4000);
    const jev = fakeJev({ "shard:0": { choice: "tool_1" }, "shard:1": { choice: "tool_70" }, tool: { choice: "tool_1" }, needs_tool: { noul: 0.97 } });
    const { decision, asked } = await ask(input, testConfig(), async (request) => {
      if (request.assets) throw Object.assign(new Error("400 from TypeSafe"), { status: 400 });
      return jev.askJev(request);
    });
    // The shortlist, refused with images and asked again without; then the decision, without.
    expect(asked.map((request) => Object.keys(request.questions)[0])).toEqual(["shard:0", "shard:0", "tool"]);
    expect(asked.map((request) => Boolean(request.assets))).toEqual([true, false, false]);
    expect(decision).toMatchObject({ tool: "tool_1" });
  });
});

describe("the dashboard", () => {
  it("counts the images Jev saw, and nothing of the images themselves", async () => {
    const jev = fakeJev(weather);
    const events = createEventLog();
    const app = createApp({ config: testConfig(), askJev: jev.askJev, fetch: fakeUpstream().fetchImpl, events });
    await app.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(chatWith({ role: "user", content: [{ type: "text", text: "Weather where this was taken?" }, imageUrl(photo)] })),
    });
    await settled();
    const [event] = events.since(0);
    expect(event?.jev?.images).toBe(1);
    expect(JSON.stringify(event)).not.toContain(photo.slice(0, 40));
  });
});

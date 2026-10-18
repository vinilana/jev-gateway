import { randomBytes } from "node:crypto";
import type { Json } from "./types.js";

/**
 * Jev reads images as an experiment TypeSafe opts a request into with a header. An image travels
 * in the request's `assets`, under a reference written into the state where the image was. Jev
 * rejects an image outside its limits rather than resizing it, and one rejected image fails the
 * whole call, so only images that fit are sent; every other one stays the placeholder Jev always
 * read in its place.
 */
export const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

/** An image as Jev's API takes it inline. */
export interface JevAsset {
  type: "image";
  data_base64: string;
  format: "png" | "jpeg";
}

interface Found {
  /** The image file bytes, base64-encoded, as the client sent them. */
  data: string;
  /** What the state says in its place when it is not sent. */
  placeholder: string;
}

/** The inline images of one request, each written into the state as a reference of its own. */
export interface Images {
  /** The reference to write in place of `part`, or undefined when `part` is not an inline image. */
  ref(part: unknown): string | undefined;
  readonly found: ReadonlyMap<string, Found>;
}

// TypeSafe's limits, inclusive. The pixel-count limits are these squared, so the sides suffice.
const MIN_SIDE = 280;
const MAX_SIDE = 1568;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** Base64 for all images of one call: the request body is capped at 32 MiB, state included. */
const MAX_TOTAL_BASE64 = 24 * 1024 * 1024;
/** Base64 enough for the header of nearly any PNG or JPEG, metadata included, and not the pixels. */
const HEAD_BASE64 = 512 * 1024;

/**
 * What an image costs in Jev's window. TypeSafe has not published a formula; this line runs through
 * two measurements against jev-1.14.0 on 2026-10-18 (640×480 cost about 1,140 tokens, 1568×1568
 * about 6,590) and rounds up.
 */
const imageTokens = ({ width, height }: Picture) => Math.ceil((width * height) / 385) + 340;

const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const DATA_URL = /^data:[^,]*;base64,/i;

/**
 * The base64 bytes of an inline image in any of the wire formats, or undefined. An image given by
 * URL stays a placeholder: fetching it would send the gateway to whatever address a conversation
 * names, and cost a round trip before Jev is even asked.
 */
function inlineData(part: unknown): string | undefined {
  const type = field(part, "type");
  // Chat Completions: { type: "image_url", image_url: { url } }. Responses: { type: "input_image", image_url }.
  const url = type === "image_url" || type === "input_image" ? field(part, "image_url") : undefined;
  const href = typeof url === "string" ? url : field(url, "url");
  if (typeof href === "string") return DATA_URL.test(href) ? string(href.slice(href.indexOf(",") + 1)) : undefined;
  // Anthropic Messages: { type: "image", source: { type: "base64", data } }.
  const source = type === "image" ? field(part, "source") : undefined;
  if (field(source, "type") === "base64") return string(field(source, "data"));
  // Gemini: { inlineData: { mimeType, data } }, which its REST API also accepts in snake case.
  const blob = field(part, "inlineData") ?? field(part, "inline_data");
  const mime = field(blob, "mimeType") ?? field(blob, "mime_type");
  return typeof mime === "string" && mime.startsWith("image/") ? string(field(blob, "data")) : undefined;
}

/**
 * References carry a random tag per request: a conversation can quote one (this repository's own
 * tests do), and a reference Jev finds in plain text is an image to it.
 */
export function collectImages(): Images {
  const tag = randomBytes(6).toString("hex");
  const found = new Map<string, Found>();
  const byData = new Map<string, string>();
  return {
    found,
    ref(part) {
      const data = inlineData(part);
      if (!data) return undefined;
      const known = byData.get(data);
      if (known) return known;
      const ref = `<image-${tag}-${found.size + 1}>`;
      byData.set(data, ref);
      found.set(ref, { data, placeholder: `[${string(field(part, "type")) ?? "image"}]` });
      return ref;
    },
  };
}

interface Picture {
  format: JevAsset["format"];
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(bytes: Buffer): Picture | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  // An animation control chunk ahead of the image data makes it an APNG, which Jev rejects.
  for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
    const chunk = bytes.toString("latin1", at + 4, at + 8);
    if (chunk === "acTL") return undefined;
    if (chunk === "IDAT") break;
  }
  return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpeg(bytes: Buffer): Picture | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 <= bytes.length; ) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // A start-of-frame segment: length, precision, then height and width.
      return { format: "jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    } else {
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

const sniff = (bytes: Buffer) => png(bytes) ?? jpeg(bytes);

/**
 * The image as Jev takes it and what it costs, or undefined when Jev would reject it. Only the
 * header is decoded: a long session can hold many screenshots, and each request looks at them again.
 */
function toAsset(data: string): { asset: JevAsset; tokens: number } | undefined {
  // Some clients wrap base64, write it URL-safe or leave off its padding; Jev wants it standard.
  const stripped = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const base64 = stripped.padEnd(Math.ceil(stripped.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const size = (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (size > MAX_IMAGE_BYTES) return undefined;
  const picture = sniff(Buffer.from(base64.slice(0, HEAD_BASE64), "base64")) ?? (base64.length > HEAD_BASE64 ? sniff(Buffer.from(base64, "base64")) : undefined);
  const fits = (side: number) => side >= MIN_SIDE && side <= MAX_SIDE;
  if (!picture || !fits(picture.width) || !fits(picture.height)) return undefined;
  return { asset: { type: "image", data_base64: base64, format: picture.format }, tokens: imageTokens(picture) };
}

export interface WithImages {
  state: { [key: string]: Json };
  /** The same state with every image a placeholder, for a provider that refuses images. */
  textOnly: { [key: string]: Json };
  assets?: Record<string, JevAsset>;
  /** Estimated tokens the images take in Jev's window, which the state budget does not count. */
  tokens: number;
}

/**
 * Attach the newest images the state still mentions, up to `max`. Older turns may have been
 * dropped to fit the state budget, and Jev refuses an asset the state does not mention, so the
 * state is what decides which images are left.
 */
export function attachImages(state: { [key: string]: Json }, images: Images | undefined, max: number): WithImages {
  if (!images?.found.size) return { state, textOnly: state, tokens: 0 };
  const json = JSON.stringify(state);
  const placeholders = (sent: Record<string, JevAsset>) => {
    let text = json;
    for (const [ref, { placeholder }] of images.found) if (!(ref in sent)) text = text.replaceAll(ref, placeholder);
    return JSON.parse(text) as { [key: string]: Json };
  };
  const newestFirst = [...images.found.keys()]
    .filter((ref) => json.includes(ref))
    .sort((a, b) => json.lastIndexOf(b) - json.lastIndexOf(a));
  const assets: Record<string, JevAsset> = {};
  let count = 0;
  let total = 0;
  let tokens = 0;
  for (const ref of newestFirst) {
    if (count >= max) break;
    const sent = toAsset(images.found.get(ref)!.data);
    if (!sent || total + sent.asset.data_base64.length > MAX_TOTAL_BASE64) continue;
    assets[ref] = sent.asset;
    count += 1;
    total += sent.asset.data_base64.length;
    tokens += sent.tokens;
  }
  const textOnly = placeholders({});
  return count ? { state: placeholders(assets), textOnly, assets, tokens } : { state: textOnly, textOnly, tokens: 0 };
}

import type { FrameBuffer, Layer } from "@pixelaition/pixel";
import { hexToRgba } from "@pixelaition/pixel";

export type AseFrame = { buffer: FrameBuffer; durationMs: number };

export type AseTag = {
  name: string;
  from: number;
  to: number;
  direction: "forward" | "reverse" | "pingpong";
  loop: boolean;
};

const MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;

const blendCode: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  "color-dodge": 6,
  "color-burn": 7,
  "hard-light": 8,
  "soft-light": 9,
  difference: 10,
  exclusion: 11,
  add: 16,
  subtract: 17,
};

class Writer {
  readonly bytes: number[] = [];
  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }
  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }
  i16(value: number): void {
    this.u16(value < 0 ? value + 0x10000 : value);
  }
  u32(value: number): void {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
  raw(values: Iterable<number>): void {
    for (const value of values) this.bytes.push(value & 0xff);
  }
  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u16(encoded.length);
    this.raw(encoded);
  }
  patchU32(offset: number, value: number): void {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >>> 8) & 0xff;
    this.bytes[offset + 2] = (value >>> 16) & 0xff;
    this.bytes[offset + 3] = (value >>> 24) & 0xff;
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function chunk(type: number, payload: Uint8Array): Uint8Array {
  const out = new Writer();
  out.u32(payload.length + 6);
  out.u16(type);
  out.raw(payload);
  return out.finish();
}

function layerChunk(buffer: FrameBuffer, layer: Layer): Uint8Array {
  const flags = 1 | (layer.locked ? 0 : 2);
  const body = new Writer();
  body.u16(flags);
  body.u16(0);
  body.u16(0);
  body.u16(buffer.width);
  body.u16(buffer.height);
  body.u16(blendCode[layer.blend ?? "normal"] ?? 0);
  body.u8(Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255));
  body.u8(0);
  body.u8(0);
  body.u8(0);
  body.string(layer.name);
  return chunk(CHUNK_LAYER, body.finish());
}

function paletteChunk(buffer: FrameBuffer): Uint8Array {
  const body = new Writer();
  body.u32(256);
  body.u32(0);
  body.u32(255);
  for (let index = 0; index < 8; index += 1) body.u8(0);
  for (let index = 0; index < 256; index += 1) {
    const [r, g, b, a] = hexToRgba(buffer.palette[index] ?? "#00000000");
    body.u16(0);
    body.u8(r);
    body.u8(g);
    body.u8(b);
    body.u8(a);
  }
  return chunk(CHUNK_PALETTE, body.finish());
}

function celChunk(buffer: FrameBuffer, layer: Layer, layerIndex: number): Uint8Array {
  const body = new Writer();
  body.u16(layerIndex);
  body.i16(0);
  body.i16(0);
  body.u8(255);
  body.u16(0);
  body.i16(layerIndex);
  for (let index = 0; index < 5; index += 1) body.u8(0);
  for (let index = 0; index < buffer.width * buffer.height; index += 1) {
    body.u8(layer.pixels[index] ?? 0);
  }
  return chunk(CHUNK_CEL, body.finish());
}

function tagsChunk(tags: AseTag[]): Uint8Array | undefined {
  if (tags.length === 0) return undefined;
  const body = new Writer();
  body.u16(tags.length);
  for (let index = 0; index < 8; index += 1) body.u8(0);
  for (const tag of tags) {
    body.u16(tag.from);
    body.u16(tag.to);
    body.u8(tag.direction === "reverse" ? 1 : tag.direction === "pingpong" ? 2 : 0);
    body.u16(tag.loop ? 0 : 1);
    for (let index = 0; index < 6; index += 1) body.u8(0);
    body.u8(0);
    body.u8(0);
    body.u8(0);
    body.u8(0);
    body.string(tag.name);
  }
  return chunk(CHUNK_TAGS, body.finish());
}

/**
 * Write an indexed .ase (Aseprite) document with one layer per frame layer,
 * raw cels, palette, frame delays and tags. Group layers and slices are not
 * representable in this first exporter; they stay in .pxl and the JSON atlas.
 */
export function framesToAse(frames: AseFrame[], tags: AseTag[] = []): Uint8Array {
  if (frames.length === 0) throw new Error("An Aseprite file needs at least one frame.");
  const first = frames[0];
  if (!first) throw new Error("An Aseprite file needs at least one frame.");
  const header = new Writer();
  header.u32(0);
  header.u16(MAGIC);
  header.u16(frames.length);
  header.u16(first.buffer.width);
  header.u16(first.buffer.height);
  header.u16(8);
  header.u32(3);
  header.u16(100);
  header.u32(0);
  header.u32(0);
  header.u8(0);
  header.u8(0);
  header.u8(0);
  header.u8(0);
  header.u16(256);
  header.u8(1);
  header.u8(1);
  header.i16(0);
  header.i16(0);
  header.u16(0);
  header.u16(0);
  for (let index = 0; index < 84; index += 1) header.u8(0);
  const output = new Writer();
  output.raw(header.finish());

  // Aseprite has one layer layout for the sprite. Merge frames by layer name,
  // keeping the first frame's order and appending layers only later frames have.
  const layerNames: string[] = [];
  const representatives = new Map<string, Layer>();
  for (const frame of frames) {
    for (const layer of frame.buffer.layers) {
      if (!representatives.has(layer.name)) {
        representatives.set(layer.name, layer);
        layerNames.push(layer.name);
      }
    }
  }
  frames.forEach((frame, frameIndex) => {
    const chunks: Uint8Array[] = [];
    if (frameIndex === 0) {
      chunks.push(paletteChunk(frame.buffer));
      for (const name of layerNames) {
        const representative = representatives.get(name);
        if (representative) chunks.push(layerChunk(frame.buffer, representative));
      }
    }
    layerNames.forEach((name, layerIndex) => {
      const layer = frame.buffer.layers.find((item) => item.name === name);
      if (layer) chunks.push(celChunk(frame.buffer, layer, layerIndex));
    });
    if (frameIndex === 0) {
      const tagChunk = tagsChunk(tags);
      if (tagChunk) chunks.push(tagChunk);
    }
    const frameBody = new Writer();
    frameBody.u32(0);
    frameBody.u16(FRAME_MAGIC);
    frameBody.u16(0);
    frameBody.u16(Math.max(1, Math.min(65535, Math.round(frame.durationMs))));
    frameBody.u16(0);
    frameBody.u32(chunks.length);
    for (const item of chunks) frameBody.raw(item);
    const bytes = frameBody.finish();
    const size = bytes.length;
    const frameOffset = output.bytes.length;
    output.raw(bytes);
    output.patchU32(frameOffset, size);
  });
  const result = output.finish();
  new DataView(result.buffer).setUint32(0, result.length, true);
  return result;
}

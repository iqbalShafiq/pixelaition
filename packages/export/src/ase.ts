import type { FrameBuffer, Layer, LayerGroup } from "@pixelaition/pixel";

export type AseFrame = { buffer: FrameBuffer; durationMs: number };

export type AseSlice = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nineSlice?: { left: number; right: number; top: number; bottom: number };
  pivot?: { x: number; y: number };
};

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
const CHUNK_SLICE = 0x2022;

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
  i32(value: number): void {
    this.u32(value < 0 ? value + 0x100000000 : value);
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

function layerChunk(buffer: FrameBuffer, layer: Layer, childLevel: number): Uint8Array {
  const flags = 1 | (layer.locked ? 0 : 2);
  const body = new Writer();
  body.u16(flags);
  body.u16(0);
  body.u16(childLevel);
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

function groupChunk(group: LayerGroup, childLevel: number): Uint8Array {
  const flags = 1 | 2 | 32;
  const body = new Writer();
  body.u16(flags);
  body.u16(1);
  body.u16(childLevel);
  body.u16(0);
  body.u16(0);
  body.u16(0);
  body.u8(Math.round(Math.max(0, Math.min(1, group.opacity ?? 1)) * 255));
  body.u8(0);
  body.u8(0);
  body.u8(0);
  body.string(group.name);
  return chunk(CHUNK_LAYER, body.finish());
}

function celChunk(layer: Layer, layerIndex: number, linkTo?: number): Uint8Array {
  const body = new Writer();
  body.u16(layerIndex);
  body.i16(0);
  body.i16(0);
  body.u8(255);
  body.u16(linkTo === undefined ? 0 : 1);
  body.i16(layerIndex);
  for (let index = 0; index < 5; index += 1) body.u8(0);
  if (linkTo !== undefined) {
    body.u16(linkTo);
  } else {
    for (const byte of layer.pixels) body.u8(byte);
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

function sliceChunk(slice: AseSlice): Uint8Array {
  const flags = (slice.nineSlice ? 1 : 0) | (slice.pivot ? 2 : 0);
  const body = new Writer();
  body.u32(1);
  body.u32(flags);
  body.u32(0);
  body.string(slice.name);
  body.u32(0);
  body.i32(slice.x);
  body.i32(slice.y);
  body.u32(slice.width);
  body.u32(slice.height);
  if (slice.nineSlice) {
    body.i32(slice.x + slice.nineSlice.left);
    body.i32(slice.y + slice.nineSlice.top);
    body.u32(Math.max(0, slice.width - slice.nineSlice.left - slice.nineSlice.right));
    body.u32(Math.max(0, slice.height - slice.nineSlice.top - slice.nineSlice.bottom));
  }
  if (slice.pivot) {
    body.i32(slice.pivot.x);
    body.i32(slice.pivot.y);
  }
  return chunk(CHUNK_SLICE, body.finish());
}

/**
 * Write an indexed .ase (Aseprite) document with one layer per frame layer,
 * raw cels, palette, groups, frame delays and tags. Slices stay in .pxl and
 * the JSON atlas.
 */
export function framesToAse(
  frames: AseFrame[],
  tags: AseTag[] = [],
  slices: AseSlice[] = [],
): Uint8Array {
  if (frames.length === 0) throw new Error("An Aseprite file needs at least one frame.");
  const first = frames[0];
  if (!first) throw new Error("An Aseprite file needs at least one frame.");
  for (const frame of frames) {
    if (
      frame.buffer.width !== first.buffer.width ||
      frame.buffer.height !== first.buffer.height
    ) {
      throw new Error(
        `An Aseprite sprite needs one canvas size; got ${first.buffer.width}×${first.buffer.height} and ${frame.buffer.width}×${frame.buffer.height}.`,
      );
    }
  }
  const header = new Writer();
  header.u32(0);
  header.u16(MAGIC);
  header.u16(frames.length);
  header.u16(first.buffer.width);
  header.u16(first.buffer.height);
  header.u16(32);
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

  // Aseprite has one layer layout for the sprite. Groups are emitted before
  // their first child; layers keep their paint order.
  const firstGroups = new Map(
    (first.buffer.groups ?? []).map((group) => [group.id, group]),
  );
  const entries: Array<
    | { kind: "group"; group: LayerGroup; depth: number }
    | { kind: "layer"; layer: Layer; depth: number }
  > = [];
  const emitted = new Set<string>();
  const chain = (layer: Layer): LayerGroup[] => {
    const groups: LayerGroup[] = [];
    let current = layer.parentGroupId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const group = firstGroups.get(current);
      if (!group) break;
      groups.unshift(group);
      current = group.parentGroupId;
    }
    return groups;
  };
  for (const layer of first.buffer.layers) {
    const groups = chain(layer);
    groups.forEach((group, depth) => {
      if (emitted.has(group.id)) return;
      emitted.add(group.id);
      entries.push({ kind: "group", group, depth });
    });
    entries.push({ kind: "layer", layer, depth: groups.length });
  }
  for (const group of first.buffer.groups ?? []) {
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    const depth = chain({
      id: "",
      name: group.name,
      visible: true,
      parentGroupId: group.parentGroupId,
      pixels: new Uint8Array(0),
    }).length;
    entries.push({ kind: "group", group, depth });
  }
  const layerIndexFor = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind === "layer") layerIndexFor.set(entry.layer.name, index);
  });
  frames.forEach((frame, frameIndex) => {
    const chunks: Uint8Array[] = [];
    if (frameIndex === 0) {
      for (const entry of entries) {
        if (entry.kind === "group") {
          chunks.push(groupChunk(entry.group, entry.depth));
        } else if (first.buffer.layers.some((layer) => layer.name === entry.layer.name)) {
          chunks.push(layerChunk(first.buffer, entry.layer, entry.depth));
        }
      }
    }
    for (const entry of entries) {
      if (entry.kind !== "layer") continue;
      const layer = frame.buffer.layers.find((item) => item.name === entry.layer.name);
      const layerIndex = layerIndexFor.get(entry.layer.name);
      if (!layer || layerIndex === undefined) continue;
      let linkTo: number | undefined;
      for (let earlier = 0; earlier < frameIndex; earlier += 1) {
        const candidate = frames[earlier]?.buffer.layers.find(
          (item) => item.name === entry.layer.name,
        );
        if (
          candidate &&
          candidate.pixels.length === layer.pixels.length &&
          candidate.pixels.every((value, index) => value === layer.pixels[index])
        ) {
          linkTo = earlier;
          break;
        }
      }
      chunks.push(celChunk(layer, layerIndex, linkTo));
    }
    if (frameIndex === 0) {
      const tagChunk = tagsChunk(tags);
      if (tagChunk) chunks.push(tagChunk);
      for (const slice of slices) chunks.push(sliceChunk(slice));
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

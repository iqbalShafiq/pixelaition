import { createId } from "./ids.js";
import {
  clonePixels,
  emptyPixels,
  encodePixels,
  isSizeAllowed,
  readCell,
  writeCell,
} from "./pixels.js";
import { hexToColor } from "./color.js";
import {
  MAX_COLORS,
  type Frame,
  type FrameBuffer,
  type Layer,
  type StyleGuide,
} from "./types.js";

export const defaultStyle = {
  defaultWidth: 32,
  defaultHeight: 32,
  outline: "#0b0906",
  shadowDirection: "down",
  notes: "",
} satisfies StyleGuide;

export const defaultPalette = ["#00000000", "#0b0906", "#f1efe9", "#d8a64e"];

export function cloneBuffer(buffer: FrameBuffer): FrameBuffer {
  return {
    width: buffer.width,
    height: buffer.height,
    palette: [...buffer.palette],
    layers: buffer.layers.map((layer) => ({
      ...layer,
      pixels: clonePixels(layer.pixels),
    })),
    ...(buffer.groups ? { groups: buffer.groups.map((group) => ({ ...group })) } : {}),
  };
}

export function createBuffer(input: {
  width: number;
  height: number;
  palette?: string[];
  layerName?: string;
}): FrameBuffer {
  if (!isSizeAllowed(input.width) || !isSizeAllowed(input.height)) {
    throw new Error("Canvas size must be an integer from 8 to 4096.");
  }
  const palette = input.palette ?? defaultPalette;
  return {
    width: input.width,
    height: input.height,
    palette: [...palette],
    layers: [
      {
        id: createId(),
        name: input.layerName ?? "pixels",
        visible: true,
        pixels: emptyPixels(input.width, input.height),
      },
    ],
  };
}

export function layerById(buffer: FrameBuffer, layerId: string): Layer | undefined {
  return buffer.layers.find((layer) => layer.id === layerId);
}

export function replaceLayer(
  buffer: FrameBuffer,
  layerId: string,
  pixels: Uint8Array,
): FrameBuffer {
  return {
    ...buffer,
    layers: buffer.layers.map((layer) =>
      layer.id === layerId ? { ...layer, pixels } : layer,
    ),
  };
}

export function composite(buffer: FrameBuffer): Uint8Array {
  const composited = emptyPixels(buffer.width, buffer.height);
  const cells = buffer.width * buffer.height;
  for (const layer of buffer.layers) {
    if (!layer.visible) continue;
    for (let index = 0; index < cells; index += 1) {
      const color = readCell(layer.pixels, index);
      if ((color & 0xff) !== 0) writeCell(composited, index, color);
    }
  }
  return composited;
}

export function frameToBuffer(
  frame: Frame,
  width: number,
  height: number,
  palette: string[],
  allowLegacy = true,
): FrameBuffer {
  const cells = width * height;
  const expected = cells * 4;
  return {
    width,
    height,
    palette: [...palette],
    ...(frame.groups ? { groups: frame.groups.map((group) => ({ ...group })) } : {}),
    layers: frame.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      ...(layer.text ? { text: { ...layer.text } } : {}),
      ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
      ...(layer.blend !== undefined ? { blend: layer.blend } : {}),
      ...(layer.locked !== undefined ? { locked: layer.locked } : {}),
      ...(layer.linkId !== undefined ? { linkId: layer.linkId } : {}),
      ...(layer.tilemap
        ? { tilemap: { ...layer.tilemap, data: [...layer.tilemap.data] } }
        : {}),
      ...(layer.parentGroupId !== undefined
        ? { parentGroupId: layer.parentGroupId }
        : {}),
      pixels: decodeLayerPixels(layer.pixels, cells, palette, expected, allowLegacy),
    })),
  };
}

/**
 * Stored layers may predate the RGBA format. A one-byte-per-cell buffer is
 * expanded through the asset palette on read, then saved as RGBA next write.
 */
function decodeLayerPixels(
  encoded: string,
  cells: number,
  palette: string[],
  expected: number,
  allowLegacy: boolean,
): Uint8Array {
  const binary = atob(encoded);
  if (binary.length === cells * 4) {
    const pixels = new Uint8Array(expected);
    for (let index = 0; index < binary.length; index += 1) {
      pixels[index] = binary.charCodeAt(index);
    }
    return pixels;
  }
  if (allowLegacy && binary.length === cells) {
    const pixels = new Uint8Array(expected);
    for (let cell = 0; cell < cells; cell += 1) {
      const color = hexToColor(palette[binary.charCodeAt(cell)] ?? "#00000000") ?? 0;
      writeCell(pixels, cell, color);
    }
    return pixels;
  }
  throw new Error(
    `Pixel buffer length ${binary.length} does not match ${expected} RGBA bytes or ${cells} indexed cells.`,
  );
}

export function bufferToFrame(
  buffer: FrameBuffer,
  frame: Pick<Frame, "id" | "name" | "index"> & {
    width?: number | null;
    height?: number | null;
    durationMs?: number;
  },
): Frame {
  return {
    id: frame.id,
    name: frame.name,
    index: frame.index,
    ...(frame.width !== undefined ? { width: frame.width } : {}),
    ...(frame.height !== undefined ? { height: frame.height } : {}),
    ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
    ...(buffer.groups ? { groups: buffer.groups.map((group) => ({ ...group })) } : {}),
    layers: buffer.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      ...(layer.text ? { text: { ...layer.text } } : {}),
      ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
      ...(layer.blend !== undefined ? { blend: layer.blend } : {}),
      ...(layer.locked !== undefined ? { locked: layer.locked } : {}),
      ...(layer.linkId !== undefined ? { linkId: layer.linkId } : {}),
      ...(layer.tilemap
        ? { tilemap: { ...layer.tilemap, data: [...layer.tilemap.data] } }
        : {}),
      ...(layer.parentGroupId !== undefined
        ? { parentGroupId: layer.parentGroupId }
        : {}),
      pixels: encodePixels(layer.pixels),
    })),
  };
}

export function usedColorCount(buffer: FrameBuffer): number {
  const seen = new Set<number>();
  const composited = composite(buffer);
  const cells = buffer.width * buffer.height;
  for (let cell = 0; cell < cells; cell += 1) {
    const color = readCell(composited, cell);
    if ((color & 0xff) !== 0) seen.add(color);
  }
  return seen.size;
}

export function paletteLimit(length: number): boolean {
  return length >= 2 && length <= MAX_COLORS + 1;
}

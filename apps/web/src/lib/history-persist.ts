import {
  createHistory,
  frameToBuffer,
  type FrameBuffer,
  type History,
  type Layer,
} from "@pixelaition/pixel";
import { bytesToBase64 } from "./types.js";

/**
 * The undo stack as JSON: one record per buffer, pixels base64. It rides on the
 * frame row with the pixels it belongs to, so reopening the asset on another
 * device restores the same past and future.
 */
export type StoredLayer = Omit<Layer, "pixels"> & { pixels?: string };
export type StoredBuffer = {
  layers: StoredLayer[];
  groups?: FrameBuffer["groups"];
};

export type StoredHistory = {
  past: StoredBuffer[];
  present: StoredBuffer;
  future: StoredBuffer[];
};

const MAX_STEPS = 40;

function sameBytes(left: Uint8Array, right: Uint8Array | undefined): boolean {
  if (!right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** A step stores only the layers that differ from the present; the rest are
 * borrowed on read. A one-layer stroke no longer repeats five full canvases. */
function encodeBuffer(buffer: FrameBuffer, reference?: FrameBuffer): StoredBuffer {
  return {
    layers: buffer.layers.map((layer, index) => {
      const unchanged = reference
        ? sameBytes(layer.pixels, reference.layers[index]?.pixels)
        : false;
      const { pixels, ...rest } = layer;
      return {
        ...rest,
        ...(unchanged ? {} : { pixels: bytesToBase64(pixels) }),
      };
    }),
    ...(buffer.groups ? { groups: buffer.groups } : {}),
  };
}

export function encodeHistory(history: History): StoredHistory {
  const trim = (buffers: FrameBuffer[]) =>
    buffers.slice(-MAX_STEPS).map((buffer) => encodeBuffer(buffer, history.present));
  return {
    past: trim(history.past),
    present: encodeBuffer(history.present),
    future: trim(history.future),
  };
}

export function decodeHistory(
  value: unknown,
  width: number,
  height: number,
  palette: string[],
): History | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<StoredHistory>;
  if (
    !Array.isArray(stored.past) ||
    !Array.isArray(stored.future) ||
    !stored.present ||
    typeof stored.present !== "object"
  ) {
    return null;
  }
  try {
    const presentStored = stored.present as StoredBuffer;
    const present = decodeBuffer(presentStored, presentStored, width, height, palette);
    const decode = (buffer: StoredBuffer) =>
      decodeBuffer(buffer, presentStored, width, height, palette);
    return {
      ...createHistory(present),
      past: stored.past.slice(-MAX_STEPS).map(decode),
      future: stored.future.slice(-MAX_STEPS).map(decode),
    };
  } catch {
    return null;
  }
}

function decodeBuffer(
  buffer: StoredBuffer,
  present: StoredBuffer,
  width: number,
  height: number,
  palette: string[],
): FrameBuffer {
  if (!Array.isArray(buffer.layers)) throw new Error("missing layers");
  return frameToBuffer(
    {
      id: "history",
      name: "history",
      index: 0,
      layers: buffer.layers.map((layer, index) => {
        const pixels = layer.pixels ?? present.layers[index]?.pixels;
        if (!pixels) throw new Error("missing pixels");
        return { ...layer, pixels };
      }),
      ...(buffer.groups ? { groups: buffer.groups } : {}),
    } as never,
    width,
    height,
    palette,
  );
}

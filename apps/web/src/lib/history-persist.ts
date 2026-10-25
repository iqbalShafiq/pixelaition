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
export type StoredBuffer = {
  layers: Array<Omit<Layer, "pixels"> & { pixels: string }>;
  groups?: FrameBuffer["groups"];
};

export type StoredHistory = {
  past: StoredBuffer[];
  present: StoredBuffer;
  future: StoredBuffer[];
};

const MAX_STEPS = 40;

function encodeBuffer(buffer: FrameBuffer): StoredBuffer {
  return {
    layers: buffer.layers.map((layer) => ({
      ...layer,
      pixels: bytesToBase64(layer.pixels),
    })),
    ...(buffer.groups ? { groups: buffer.groups } : {}),
  };
}

export function encodeHistory(history: History): StoredHistory {
  const trim = (buffers: FrameBuffer[]) => buffers.slice(-MAX_STEPS).map(encodeBuffer);
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
    const decode = (buffer: StoredBuffer): FrameBuffer => {
      if (!Array.isArray(buffer.layers)) throw new Error("missing layers");
      return frameToBuffer(
        {
          id: "history",
          name: "history",
          index: 0,
          layers: buffer.layers.map((layer) => ({ ...layer })),
          ...(buffer.groups ? { groups: buffer.groups } : {}),
        } as never,
        width,
        height,
        palette,
      );
    };
    const present = decode(stored.present);
    return {
      ...createHistory(present),
      past: stored.past.slice(-MAX_STEPS).map(decode),
      future: stored.future.slice(-MAX_STEPS).map(decode),
    };
  } catch {
    return null;
  }
}

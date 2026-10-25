import { renderFrame, type FrameBuffer } from "@pixelaition/pixel";
import UPNG from "upng-js";

export type ApngFrame = { buffer: FrameBuffer; durationMs: number };

function setPlayCount(bytes: Uint8Array, loop: number): void {
  const plays = loop === -1 ? 1 : loop === 0 ? 0 : loop + 1;
  for (let index = 0; index + 20 <= bytes.length; index += 1) {
    if (
      bytes[index + 4] === 0x61 &&
      bytes[index + 5] === 0x63 &&
      bytes[index + 6] === 0x54 &&
      bytes[index + 7] === 0x4c
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(index + 12, plays);
      const crc = UPNG.crc.crc(bytes, index + 4, 12);
      view.setUint32(index + 16, crc);
      return;
    }
  }
}

/** Encode lossless RGBA APNG frames at their real millisecond delays. */
export function framesToApng(
  frames: ApngFrame[],
  options: { loop?: number; scale?: number } = {},
): Uint8Array {
  if (frames.length === 0) throw new Error("An APNG needs at least one frame.");
  const first = frames[0];
  if (!first) throw new Error("An APNG needs at least one frame.");
  const scale = options.scale ?? 1;
  const images = frames.map((frame) => {
    const rendered = renderFrame(frame.buffer, { scale });
    return rendered.data.slice().buffer;
  });
  const encoded = UPNG.encode(
    images,
    Math.max(1, Math.round(first.buffer.width * scale)),
    Math.max(1, Math.round(first.buffer.height * scale)),
    0,
    frames.map((frame) => Math.max(10, Math.round(frame.durationMs))),
  );
  const bytes = new Uint8Array(encoded);
  setPlayCount(bytes, options.loop ?? 0);
  return bytes;
}

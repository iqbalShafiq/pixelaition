import { composite } from "./buffer.js";
import type { FrameBuffer } from "./types.js";

export type SeamReport = {
  width: number;
  height: number;
  leftRight: { mismatches: number; compared: number };
  topBottom: { mismatches: number; compared: number };
  seamless: boolean;
};

/**
 * Compare the pixels that meet when the frame tiles. This reads the composited
 * document, so a hidden layer or a layer above the seam cannot make a seam
 * look closed while the exported sprite still tears.
 */
export function seamReport(buffer: FrameBuffer): SeamReport {
  const pixels = composite(buffer);
  const at = (x: number, y: number) => pixels[y * buffer.width + x] ?? 0;
  let leftRight = 0;
  let topBottom = 0;
  for (let y = 0; y < buffer.height; y += 1) {
    if (at(0, y) !== at(buffer.width - 1, y)) leftRight += 1;
  }
  for (let x = 0; x < buffer.width; x += 1) {
    if (at(x, 0) !== at(x, buffer.height - 1)) topBottom += 1;
  }
  return {
    width: buffer.width,
    height: buffer.height,
    leftRight: { mismatches: leftRight, compared: buffer.height },
    topBottom: { mismatches: topBottom, compared: buffer.width },
    seamless: leftRight === 0 && topBottom === 0,
  };
}

import { composite } from "./buffer.js";
import type { FrameBuffer } from "./types.js";

export type TileCandidate = {
  size: number;
  mismatches: number;
  compared: number;
};

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

/**
 * Suggest a square tile size for a frame that is meant to repeat. The frame is
 * split into equal tiles and each tile's opposite edges are compared; the size
 * with the fewest mismatches wins, with larger tiles winning ties because they
 * preserve more detail.
 */
export function scanTileSizes(buffer: FrameBuffer, maxSize = 64): TileCandidate[] {
  const pixels = composite(buffer);
  const at = (x: number, y: number) => pixels[y * buffer.width + x] ?? 0;
  const limit = Math.min(maxSize, buffer.width, buffer.height);
  const candidates: TileCandidate[] = [];
  for (let size = 2; size <= limit; size += 1) {
    if (buffer.width % size !== 0 || buffer.height % size !== 0) continue;
    let mismatches = 0;
    let compared = 0;
    for (let tileY = 0; tileY < buffer.height; tileY += size) {
      for (let tileX = 0; tileX < buffer.width; tileX += size) {
        for (let offset = 0; offset < size; offset += 1) {
          if (at(tileX, tileY + offset) !== at(tileX + size - 1, tileY + offset)) {
            mismatches += 1;
          }
          if (at(tileX + offset, tileY) !== at(tileX + offset, tileY + size - 1)) {
            mismatches += 1;
          }
          compared += 2;
        }
      }
    }
    candidates.push({ size, mismatches, compared });
  }
  return candidates.sort(
    (left, right) =>
      left.mismatches / Math.max(1, left.compared) -
        right.mismatches / Math.max(1, right.compared) || right.size - left.size,
  );
}

/** The best square tile size, or undefined when the frame has no divisor. */
export function suggestedTileSize(
  buffer: FrameBuffer,
  maxSize = 64,
): TileCandidate | undefined {
  return scanTileSizes(buffer, maxSize)[0];
}

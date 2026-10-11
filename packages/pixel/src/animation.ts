import { composite } from "./buffer.js";
import type { FrameBuffer, Point } from "./types.js";

export type Rect = { x: number; y: number; width: number; height: number };

export type PairReport = {
  from: string;
  to: string;
  changedPixels: number;
  diffBox: Rect | null;
  centroidShift: number;
  silhouetteDrift: number;
};

export type FrameStats = {
  opaquePixels: number;
  centroid: Point | null;
  bounds: Rect | null;
};

export type AnimationReport = {
  pairs: PairReport[];
  loop: PairReport;
  flags: string[];
};

/** Where the opaque pixels are in one composited frame; null when none are. */
type Opaque = {
  count: number;
  sumX: number;
  sumY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function opaqueOf(pixels: Uint8Array, width: number, height: number): Opaque | null {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[y * width + x] === 0) continue;
      count += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return count === 0 ? null : { count, sumX, sumY, minX, maxX, minY, maxY };
}

function centroidOf(opaque: Opaque): Point {
  return { x: opaque.sumX / opaque.count, y: opaque.sumY / opaque.count };
}

/** The opaque centroid, pixel count, and bounds of one frame's composite. */
export function frameStats(buffer: FrameBuffer): FrameStats {
  const opaque = opaqueOf(composite(buffer), buffer.width, buffer.height);
  if (!opaque) return { opaquePixels: 0, centroid: null, bounds: null };
  return {
    opaquePixels: opaque.count,
    centroid: centroidOf(opaque),
    bounds: {
      x: opaque.minX,
      y: opaque.minY,
      width: opaque.maxX - opaque.minX + 1,
      height: opaque.maxY - opaque.minY + 1,
    },
  };
}

/**
 * One ordered pair of frames. A frame with no opaque pixels has no centroid
 * or silhouette, so a pair that involves one reports zero shift and lets the
 * per-frame stats and critique_frame's EMPTY issue carry that fact.
 */
function compareFrames(
  from: { id: string; buffer: FrameBuffer },
  to: { id: string; buffer: FrameBuffer },
): PairReport {
  const width = from.buffer.width;
  const height = from.buffer.height;
  if (width !== to.buffer.width || height !== to.buffer.height) {
    throw new Error(`Frames ${from.id} and ${to.id} have different sizes.`);
  }
  const left = composite(from.buffer);
  const right = composite(to.buffer);
  let changedPixels = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (left[index] === right[index]) continue;
      changedPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const diffBox =
    changedPixels === 0
      ? null
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const leftOpaque = opaqueOf(left, width, height);
  const rightOpaque = opaqueOf(right, width, height);
  let centroidShift = 0;
  let silhouetteDrift = 0;
  if (leftOpaque && rightOpaque) {
    const leftCentroid = centroidOf(leftOpaque);
    const rightCentroid = centroidOf(rightOpaque);
    centroidShift = Math.hypot(
      rightCentroid.x - leftCentroid.x,
      rightCentroid.y - leftCentroid.y,
    );
    silhouetteDrift = Math.max(
      Math.abs(rightOpaque.minX - leftOpaque.minX),
      Math.abs(rightOpaque.maxX - leftOpaque.maxX),
      Math.abs(rightOpaque.minY - leftOpaque.minY),
      Math.abs(rightOpaque.maxY - leftOpaque.maxY),
    );
  }
  return {
    from: from.id,
    to: to.id,
    changedPixels,
    diffBox,
    centroidShift,
    silhouetteDrift,
  };
}

/**
 * Deterministic continuity metrics for an animation: every consecutive pair
 * plus the loop from the last frame back to the first. Flags name identical
 * distinct frames, centroid moves over two pixels, and a loop that jumps
 * further than every internal pair.
 */
export function checkAnimation(
  frames: Array<{ id: string; buffer: FrameBuffer }>,
): AnimationReport {
  const first = frames[0];
  if (!first) throw new Error("checkAnimation needs at least one frame.");
  const pairs = frames
    .slice(0, -1)
    .map((frame, index) => compareFrames(frame, frames[index + 1]!));
  const last = frames[frames.length - 1]!;
  const loop = compareFrames(last, first);
  const flags: string[] = [];
  for (const pair of [...pairs, loop]) {
    if (pair.from !== pair.to && pair.changedPixels === 0) {
      flags.push(`${pair.from} → ${pair.to}: identical frames`);
    }
    if (pair.centroidShift > 2) {
      flags.push(
        `${pair.from} → ${pair.to}: centroid moves ${pair.centroidShift.toFixed(1)} px`,
      );
    }
  }
  const internalMax = pairs.reduce((max, pair) => Math.max(max, pair.centroidShift), 0);
  if (pairs.length > 0 && loop.from !== loop.to && loop.centroidShift > internalMax) {
    flags.push(
      `${loop.from} → ${loop.to}: the loop jumps ${loop.centroidShift.toFixed(1)} px, more than any internal pair`,
    );
  }
  return { pairs, loop, flags };
}

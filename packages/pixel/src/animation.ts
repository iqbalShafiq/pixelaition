import { composite } from "./buffer.js";
import { readCell } from "./pixels.js";
import type { FrameBuffer, Point } from "./types.js";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional 1-inside/0-outside mask, row-major inside the rectangle. */
  mask?: Uint8Array;
};

export type PairReport = {
  from: string;
  to: string;
  changedPixels: number;
  diffBox: Rect | null;
  /** The whole composite's centroid move. */
  centroidShift: number;
  /** How far the whole composite's bounds moved. */
  silhouetteDrift: number;
  /**
   * The bounds of the pixels that are opaque in *both* frames — the stand of a
   * spinning fan, a character's feet — and how far that shared mass moved.
   * Whole-composite drift cannot tell "the blades turned" from "the stand slid
   * sideways"; this can, because turning blades leave the shared mass in place.
   */
  staticBounds: Rect | null;
  staticDrift: {
    centroid: number;
    bounds: { left: number; right: number; top: number; bottom: number };
  } | null;
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
  /** Each frame against the reference: where the unchanged mass sits. */
  reference: Array<{ from: string; to: string; staticBounds: Rect | null }>;
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
      if ((readCell(pixels, y * width + x) & 0xff) === 0) continue;
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

function boundsOf(opaque: Opaque): Rect {
  return {
    x: opaque.minX,
    y: opaque.minY,
    width: opaque.maxX - opaque.minX + 1,
    height: opaque.maxY - opaque.minY + 1,
  };
}

/** The opaque centroid, pixel count, and bounds of one frame's composite. */
export function frameStats(buffer: FrameBuffer): FrameStats {
  const opaque = opaqueOf(composite(buffer), buffer.width, buffer.height);
  if (!opaque) return { opaquePixels: 0, centroid: null, bounds: null };
  return {
    opaquePixels: opaque.count,
    centroid: centroidOf(opaque),
    bounds: boundsOf(opaque),
  };
}

/**
 * The pixels opaque in both composites — a stand under turning blades, a
 * character's feet. Measured in each frame's own coordinates, this is the mass
 * a pair agrees on, and how far it sits from where it was.
 */
function sharedMass(
  left: Uint8Array,
  right: Uint8Array,
  width: number,
  height: number,
): { left: Opaque; right: Opaque } | null {
  const leftMass = emptyOpaque(width, height);
  const rightMass = emptyOpaque(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      // A pixel transparent in either frame is not shared mass.
      if ((readCell(left, index) & 0xff) === 0 || (readCell(right, index) & 0xff) === 0) {
        continue;
      }
      grow(leftMass, x, y);
      grow(rightMass, x, y);
    }
  }
  return leftMass.count > 0 ? { left: leftMass, right: rightMass } : null;
}

function emptyOpaque(width: number, height: number): Opaque {
  return { count: 0, sumX: 0, sumY: 0, minX: width, maxX: -1, minY: height, maxY: -1 };
}

function grow(mass: Opaque, x: number, y: number): void {
  mass.count += 1;
  mass.sumX += x;
  mass.sumY += y;
  if (x < mass.minX) mass.minX = x;
  if (x > mass.maxX) mass.maxX = x;
  if (y < mass.minY) mass.minY = y;
  if (y > mass.maxY) mass.maxY = y;
}

/**
 * One ordered pair of frames. A frame with no opaque pixels has no centroid
 * or silhouette, so a pair that involves one reports zero shift; the empty
 * frame itself is flagged by checkAnimation, and its stats carry the fact.
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
      if (readCell(left, index) === readCell(right, index)) continue;
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
  let staticBounds: Rect | null = null;
  let staticDrift: PairReport["staticDrift"] = null;
  const shared = sharedMass(left, right, width, height);
  if (shared) {
    staticBounds = boundsOf(shared.left);
    const leftCentroid = centroidOf(shared.left);
    const rightCentroid = centroidOf(shared.right);
    staticDrift = {
      centroid: Math.hypot(
        rightCentroid.x - leftCentroid.x,
        rightCentroid.y - leftCentroid.y,
      ),
      bounds: {
        left: shared.right.minX - shared.left.minX,
        right: shared.right.maxX - shared.left.maxX,
        top: shared.right.minY - shared.left.minY,
        bottom: shared.right.maxY - shared.left.maxY,
      },
    };
  }
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
    staticBounds,
    staticDrift,
  };
}

/**
 * Deterministic continuity metrics for an animation.
 *
 * Two questions, measured separately, because they fail differently:
 *
 * - **Consecutive motion** (`pairs`, `loop`): did a frame's changed region
 *   move the whole drawing? This is how a sliding sprite is caught. A moving
 *   part inside a still frame (flames, a flag, an arm) deliberately reports
 *   nothing.
 * - **Where the shared mass sits** (`reference`): every frame against one
 *   reference frame, named here. Everything the artist means to keep — a body,
 *   a stand, feet — is opaque in both frames, and if its edges move between
 *   the reference and a later frame, that part was redrawn instead of
 *   preserved. This catches the fault consecutive pairs hide: two frames that
 *   both drifted the same way still differ from the reference.
 *
 * A flag names the frame by the caller's label, so a fix order can name it.
 */
/** The bounds of the reference frame's own drawing, for the report's own row. */
function referenceFrameBounds(reference: { buffer: FrameBuffer }): Rect | null {
  const opaque = opaqueOf(
    composite(reference.buffer),
    reference.buffer.width,
    reference.buffer.height,
  );
  return opaque ? boundsOf(opaque) : null;
}

export function checkAnimation(
  frames: Array<{ id: string; buffer: FrameBuffer; name?: string }>,
  options: { referenceId?: string } = {},
): AnimationReport {
  const first = frames[0];
  if (!first) throw new Error("checkAnimation needs at least one frame.");
  const label = (frame: { id: string; name?: string }): string => frame.name ?? frame.id;
  const pairs = frames
    .slice(0, -1)
    .map((frame, index) => compareFrames(frame, frames[index + 1]!));
  const last = frames[frames.length - 1]!;
  const loop = compareFrames(last, first);
  const reference =
    options.referenceId === undefined
      ? undefined
      : (frames.find((frame) => frame.id === options.referenceId) ?? first);
  const flags: string[] = [];
  for (const frame of frames) {
    const opaque = opaqueOf(
      composite(frame.buffer),
      frame.buffer.width,
      frame.buffer.height,
    );
    if (!opaque) flags.push(`Frame ${frame.id} has no opaque pixels.`);
  }
  // A flag names something a fix can act on. The whole-composite shift counts
  // only when nothing stayed put to explain it; when a shared mass exists, a
  // move of that mass is the drift worth naming (turning blades leave it still,
  // a sliding stand does not).
  for (const pair of [...pairs, loop]) {
    if (pair.from !== pair.to && pair.changedPixels === 0) {
      flags.push(
        `${label(frames.find((f) => f.id === pair.from) ?? first)} → ${label(
          frames.find((f) => f.id === pair.to) ?? first,
        )}: identical frames`,
      );
    }
    // Whole-composite drift only when no shared mass explains the motion: a
    // moving flame changes the composite's centroid without moving anything.
    if (!pair.staticDrift && pair.centroidShift > 2) {
      flags.push(
        `${label(frames.find((f) => f.id === pair.from) ?? first)} → ${label(
          frames.find((f) => f.id === pair.to) ?? first,
        )}: the drawing slides ${pair.centroidShift.toFixed(1)} px`,
      );
    }
  }
  // The loop is flagged only when it jumps by a margin worth a fix.
  const LOOP_MARGIN_PX = 1;
  const internalMax = pairs.reduce((max, pair) => Math.max(max, pair.centroidShift), 0);
  if (
    pairs.length > 0 &&
    loop.from !== loop.to &&
    loop.centroidShift > internalMax + LOOP_MARGIN_PX
  ) {
    flags.push(
      `${label(last)} → ${label(first)}: the loop jumps ${loop.centroidShift.toFixed(1)} px, more than any internal step`,
    );
  }
  // Every frame against the reference: the same body must still be in the same
  // place. A reference frame can repeat forever; a frame with no shared mass
  // at all is simply not the same drawing, which is a finding of its own.
  const report: AnimationReport["reference"] = [];
  const referenceBounds =
    reference === undefined ? null : referenceFrameBounds(reference);
  if (reference !== undefined && referenceBounds !== null) {
    for (const frame of frames) {
      if (frame.id === reference.id) {
        report.push({ from: reference.id, to: frame.id, staticBounds: referenceBounds });
        continue;
      }
      const compared = compareFrames(reference, frame);
      const bounds = compared.staticBounds;
      report.push({ from: reference.id, to: frame.id, staticBounds: bounds });
      if (bounds === null) {
        flags.push(
          `${label(frame)} shares no opaque pixels with the reference frame ${label(reference)} — the drawing changed entirely`,
        );
        continue;
      }
      const shift = compared.staticDrift;
      const moved = shift
        ? Math.max(
            Math.abs(shift.bounds.left),
            Math.abs(shift.bounds.right),
            Math.abs(shift.bounds.top),
            Math.abs(shift.bounds.bottom),
            shift.centroid,
          )
        : 0;
      if (moved > 2) {
        flags.push(
          `${label(frame)}: the part it keeps from the reference frame ${label(reference)} sits ${moved.toFixed(1)} px away — it was redrawn instead of copied`,
        );
      }
    }
  }
  return { pairs, loop, flags, reference: report };
}

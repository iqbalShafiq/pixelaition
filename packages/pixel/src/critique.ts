import { composite } from "./buffer.js";
import { indexOf, normalizeHex } from "./pixels.js";
import type { CritiqueIssue, FrameBuffer, StyleGuide } from "./types.js";

/**
 * The eight neighboring cells, diagonals included. A pencil-thin smoke wisp or
 * a spark is placed with a diagonal step between cells; it reads as one stroke
 * to a person and as a stray pixel to an orthogonal-only check, so the check
 * asks "does this pixel touch the drawing at all" instead of "does it touch
 * it orthogonally".
 */
const around8 = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

/** The orthogonal neighbor offsets every placement check shares. */
const orthogonal = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function critiqueFrame(
  buffer: FrameBuffer,
  style: Pick<StyleGuide, "outline">,
): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];
  const composited = composite(buffer);
  const opaque = composited.some((color) => color !== 0);
  if (!opaque) {
    issues.push({ code: "EMPTY", message: "The frame has no painted pixels." });
  }
  for (const layer of buffer.layers) {
    for (const color of layer.pixels) {
      if (color >= buffer.palette.length) {
        issues.push({
          code: "PALETTE_INDEX",
          message: "A pixel uses an index outside the palette.",
        });
        return issues;
      }
    }
  }
  const outline = normalizeHex(style.outline);
  const outlineIndex = outline
    ? buffer.palette.findIndex((color) => color === outline)
    : -1;
  if (opaque && outline && outlineIndex <= 0) {
    issues.push({
      code: "OUTLINE_MISSING",
      message: "The style guide outline color is not in the palette.",
    });
  }
  if (opaque && outlineIndex > 0 && !composited.includes(outlineIndex)) {
    issues.push({
      code: "OUTLINE_UNUSED",
      message: "The frame does not use the style guide outline.",
    });
  }
  if (!opaque) return issues;

  const neighbors = (x: number, y: number): number[] =>
    orthogonal
      .filter((offset) => {
        const nextX = x + offset.x;
        const nextY = y + offset.y;
        return nextX >= 0 && nextY >= 0 && nextX < buffer.width && nextY < buffer.height;
      })
      .map(
        (offset) => composited[indexOf(buffer.width, x + offset.x, y + offset.y)] ?? 0,
      );

  let stray = 0;
  let interiorOutline = 0;
  let edge = 0;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const color = composited[indexOf(buffer.width, x, y)];
      if (color === 0) continue;
      const around = neighbors(x, y);
      const touches = around8.some(
        (offset) => composited[indexOf(buffer.width, x + offset.x, y + offset.y)] ?? 0,
      );
      if (!touches) stray += 1;
      if (
        color === outlineIndex &&
        outlineIndex > 0 &&
        !around.some((value) => value === 0)
      ) {
        interiorOutline += 1;
      }
      if (x === 0 || y === 0 || x === buffer.width - 1 || y === buffer.height - 1) {
        edge += 1;
      }
    }
  }
  if (stray > 0) {
    issues.push({
      code: "STRAY_PIXEL",
      message: `The frame has ${stray} stray pixel${stray === 1 ? "" : "s"} with no orthogonal opaque neighbor.`,
    });
  }
  if (interiorOutline > 0) {
    issues.push({
      code: "OUTLINE_INTERIOR",
      message: `The frame has ${interiorOutline} outline pixel${interiorOutline === 1 ? "" : "s"} not beside transparency.`,
    });
  }
  if (edge > 0) {
    issues.push({
      code: "TOUCHES_EDGE",
      message: `The artwork touches the canvas edge on ${edge} pixel${edge === 1 ? "" : "s"}; leave a transparent margin.`,
    });
  }
  return issues;
}

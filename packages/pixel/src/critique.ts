import { composite } from "./buffer.js";
import { colorToHex, hexToColor } from "./color.js";
import { indexOf, readCell } from "./pixels.js";
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
  const cells = buffer.width * buffer.height;
  let opaque = false;
  for (let cell = 0; cell < cells; cell += 1) {
    if ((readCell(composited, cell) & 0xff) !== 0) {
      opaque = true;
      break;
    }
  }
  if (!opaque) {
    issues.push({ code: "EMPTY", message: "The frame has no painted pixels." });
  }
  const outline = hexToColor(style.outline);
  let usesOutline = false;
  if (outline !== null) {
    for (let cell = 0; cell < cells; cell += 1) {
      if (readCell(composited, cell) === outline) {
        usesOutline = true;
        break;
      }
    }
  }
  if (opaque && outline !== null && !usesOutline) {
    issues.push({
      code: "OUTLINE_UNUSED",
      message: `The frame does not use the style guide outline ${colorToHex(outline)}.`,
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
      .map((offset) =>
        readCell(composited, indexOf(buffer.width, x + offset.x, y + offset.y)),
      );

  let stray = 0;
  let interiorOutline = 0;
  let edge = 0;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const color = readCell(composited, indexOf(buffer.width, x, y));
      if ((color & 0xff) === 0) continue;
      const around = neighbors(x, y);
      const touches = around8.some(
        (offset) =>
          (readCell(composited, indexOf(buffer.width, x + offset.x, y + offset.y)) &
            0xff) !==
          0,
      );
      if (!touches) stray += 1;
      if (
        outline !== null &&
        color === outline &&
        !around.some((value) => (value & 0xff) === 0)
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

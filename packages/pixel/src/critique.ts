import { composite, usedColorCount } from "./buffer.js";
import { normalizeHex } from "./pixels.js";
import type { CritiqueIssue, FrameBuffer, StyleGuide } from "./types.js";

export function critiqueFrame(
  buffer: FrameBuffer,
  style: Pick<StyleGuide, "maxColors" | "outline">,
): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];
  const composited = composite(buffer);
  const opaque = composited.some((color) => color !== 0);
  if (!opaque) {
    issues.push({ code: "EMPTY", message: "The frame has no painted pixels." });
  }
  const colors = usedColorCount(buffer);
  if (colors > style.maxColors) {
    issues.push({
      code: "TOO_MANY_COLORS",
      message: `The frame uses ${colors} colors and the style guide allows ${style.maxColors}.`,
    });
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
  return issues;
}

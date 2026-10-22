import { describe, expect, it } from "vitest";
import { drawText, textBounds } from "./text.js";
import type { TextElement } from "./types.js";

const element: TextElement = {
  id: "small",
  kind: "text",
  text: "Aa",
  face: "silkscreen",
  weight: 700,
  size: 8,
  color: 1,
  x: 4,
  y: 4,
  width: 24,
  align: "left",
};

describe("small pixel text", () => {
  it("rasterizes a below-atlas size instead of refusing it", () => {
    const pixels = new Uint8Array(32 * 32);
    drawText(pixels, 32, 32, element, 3);
    expect(pixels.some((value) => value === 1)).toBe(true);
    const bounds = textBounds(element);
    expect(bounds.width).toBeLessThan(24);
    expect(bounds.height).toBeLessThan(16);
  });

  it("renders arbitrary sizes above and below the atlas grid", () => {
    for (const size of [1, 7, 13, 200]) {
      const pixels = new Uint8Array(256 * 256);
      drawText(pixels, 256, 256, { ...element, size }, 3);
      expect(pixels.some((value) => value === 1)).toBe(true);
    }
  });

  it("rotates glyph pixels without adding new colours", () => {
    const pixels = new Uint8Array(32 * 32);
    drawText(pixels, 32, 32, { ...element, rotation: 45 }, 3);
    expect([...new Set(pixels)].every((value) => value === 0 || value === 1)).toBe(true);
    expect(pixels.some((value) => value === 1)).toBe(true);
    expect(textBounds({ ...element, rotation: 45 }).width).toBeGreaterThan(1);
  });
});

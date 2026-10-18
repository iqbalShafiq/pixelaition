import { composite, type FrameBuffer } from "@pixelaition/pixel";
import { hexToRgba } from "./color.js";

/** A rectangle in document pixels. */
export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * The box a frame's painted pixels occupy, in document pixels. Null when the
 * frame is empty: there is no artwork to fly, and the caller keeps the plain
 * page transition instead.
 */
export function paintedBounds(buffer: FrameBuffer): Bounds | null {
  const indexes = composite(buffer);
  let minX = buffer.width;
  let minY = buffer.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if ((indexes[y * buffer.width + x] ?? 0) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * A canvas holding only the artwork inside `bounds`, with every other pixel
 * left transparent — the asset itself, with no canvas, checker, grid, or panel
 * behind it. That transparency is what lets it shrink into the grid as a
 * floating sprite instead of dragging the editor's box along.
 */
export function spriteCanvas(
  buffer: FrameBuffer,
  bounds: Bounds,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const indexes = composite(buffer);
  const image = context.createImageData(bounds.width, bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const value = indexes[(bounds.y + y) * buffer.width + (bounds.x + x)] ?? 0;
      if (value === 0) continue;
      const [r, g, b, a] = hexToRgba(buffer.palette[value] ?? "#000000");
      const offset = (y * bounds.width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

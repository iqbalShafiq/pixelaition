import { renderFrameDocument, type FrameBuffer } from "@pixelaition/pixel";

/** A rectangle in document pixels. */
export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * The box a frame's painted pixels occupy, in document pixels. Null when the
 * frame is empty: there is no artwork to fly, and the caller keeps the plain
 * page transition instead.
 */
export function paintedBounds(buffer: FrameBuffer): Bounds | null {
  const rendered = renderFrameDocument(buffer);
  let minX = buffer.width;
  let minY = buffer.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if ((rendered.data[(y * buffer.width + x) * 4 + 3] ?? 0) === 0) continue;
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
  const rendered = renderFrameDocument(buffer);
  const image = context.createImageData(bounds.width, bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    const sourceOffset = ((bounds.y + y) * buffer.width + bounds.x) * 4;
    image.data.set(
      rendered.data.subarray(sourceOffset, sourceOffset + bounds.width * 4),
      y * bounds.width * 4,
    );
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

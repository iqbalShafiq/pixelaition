import { renderFrame, type FrameBuffer, type RgbaImage } from "@pixelaition/pixel";

export type { RgbaImage };

/**
 * Rasterize through the shared compositor. Keeping this thin wrapper means
 * every encoder — PNG, JPG, SVG, GIF, APNG, WebP and sprite sheets — sees the
 * same pixels, layer opacity, and blend mode.
 */
export function rasterize(
  buffer: FrameBuffer,
  scale: number,
  background?: string,
): RgbaImage {
  return renderFrame(buffer, {
    scale,
    ...(background !== undefined ? { background } : {}),
  });
}

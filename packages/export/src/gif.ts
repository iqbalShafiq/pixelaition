import {
  composite,
  hexToRgba,
  quantizeToPalette,
  renderFrame,
  renderFrameDocument,
  type FrameBuffer,
} from "@pixelaition/pixel";
import * as gifencNs from "gifenc";
import type { GifPalette } from "gifenc";

// The package ships an ESM default function and a CJS default namespace, and
// Node and the bundler pick different ones. Resolve both shapes once.
const encoderFactory = (() => {
  const module = gifencNs as unknown as {
    GIFEncoder?: unknown;
    default?: { GIFEncoder?: unknown; default?: unknown } | unknown;
  };
  const fallback =
    typeof module.default === "object" && module.default !== null
      ? (module.default as { GIFEncoder?: unknown; default?: unknown })
      : undefined;
  return (module.GIFEncoder ??
    fallback?.GIFEncoder ??
    fallback?.default ??
    module.default) as () => ReturnType<typeof import("gifenc").GIFEncoder>;
})();
const GIFEncoder = encoderFactory;

export type GifFrame = { buffer: FrameBuffer; durationMs: number };

function paletteFor(palette: string[]): GifPalette {
  return palette.map((hex) => {
    const [r, g, b] = hexToRgba(hex);
    return [r, g, b] as [number, number, number];
  });
}

function hasCompositing(buffer: FrameBuffer): boolean {
  return (
    (buffer.groups?.length ?? 0) > 0 ||
    buffer.layers.some(
      (layer) =>
        (layer.opacity ?? 1) < 1 ||
        (layer.blend !== undefined && layer.blend !== "normal") ||
        layer.parentGroupId !== undefined,
    )
  );
}

function indicesFor(buffer: FrameBuffer, scale: number): Uint8Array {
  if (scale === 1 && !hasCompositing(buffer)) return composite(buffer);
  return quantizeToPalette(
    scale === 1 ? renderFrameDocument(buffer) : renderFrame(buffer, { scale }),
    buffer.palette,
    { alphaThreshold: 128 },
  );
}

/**
 * Encode indexed frames with the asset's own palette. gifenc accepts a palette
 * per frame, so no second quantizer can reorder the artwork's colours.
 */
export function framesToGif(
  frames: GifFrame[],
  palette: string[],
  options: { loop?: number; scale?: number } = {},
): Uint8Array {
  if (frames.length === 0) throw new Error("A GIF needs at least one frame.");
  const gif = GIFEncoder();
  const gifPalette = paletteFor(palette);
  const scale = options.scale ?? 1;
  frames.forEach((frame, index) => {
    const width = Math.max(1, Math.round(frame.buffer.width * scale));
    const height = Math.max(1, Math.round(frame.buffer.height * scale));
    gif.writeFrame(indicesFor(frame.buffer, scale), width, height, {
      palette: index === 0 ? gifPalette : undefined,
      transparent: true,
      transparentIndex: 0,
      delay: Math.max(10, Math.round(frame.durationMs / 10) * 10),
      repeat: options.loop ?? 0,
      dispose: 2,
    });
  });
  gif.finish();
  return gif.bytes();
}

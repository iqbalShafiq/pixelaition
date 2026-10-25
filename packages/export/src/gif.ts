import {
  colorDistance,
  hexToRgba,
  renderFrame,
  type FrameBuffer,
} from "@pixelaition/pixel";
import * as gifencNs from "gifenc";
import type { GifPalette } from "gifenc";

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
    module.default) as () => ReturnType<typeof gifencNs.GIFEncoder>;
})();
const GIFEncoder = encoderFactory;

export type GifFrame = { buffer: FrameBuffer; durationMs: number };

/**
 * GIF is indexed by definition. Build one shared 255-colour table from the
 * asset swatches and the frames' actual RGBA pixels, then map every pixel to
 * its nearest entry; index 0 stays transparent.
 */
function sharedPalette(frames: GifFrame[], palette: string[]): GifPalette {
  const colors: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  const add = (rgb: [number, number, number]) => {
    if (colors.length >= 255) return;
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    colors.push(rgb);
  };
  for (const hex of palette.slice(1)) {
    const [r, g, b, a] = hexToRgba(hex);
    if (a > 0) add([r, g, b]);
  }
  for (const frame of frames) {
    const image = renderFrame(frame.buffer);
    for (
      let offset = 0;
      offset < image.data.length && colors.length < 255;
      offset += 16
    ) {
      if ((image.data[offset + 3] ?? 0) < 128) continue;
      add([
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ]);
    }
  }
  return [[0, 0, 0], ...colors];
}

function indicesFor(
  frame: GifFrame,
  palette: GifPalette,
  scale: number,
): { indices: Uint8Array; width: number; height: number } {
  const image = renderFrame(frame.buffer, { scale });
  const indices = new Uint8Array(image.width * image.height);
  const cache = new Map<number, number>();
  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const offset = pixel * 4;
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha < 128) {
      indices[pixel] = 0;
      continue;
    }
    const r = image.data[offset] ?? 0;
    const g = image.data[offset + 1] ?? 0;
    const b = image.data[offset + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) {
      indices[pixel] = cached;
      continue;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < palette.length; index += 1) {
      const candidate = palette[index];
      if (!candidate) continue;
      const distance = colorDistance(
        [r, g, b],
        [candidate[0] ?? 0, candidate[1] ?? 0, candidate[2] ?? 0],
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    cache.set(key, best);
    indices[pixel] = best;
  }
  return { indices, width: image.width, height: image.height };
}

export function framesToGif(
  frames: GifFrame[],
  palette: string[],
  options: { loop?: number; scale?: number } = {},
): Uint8Array {
  if (frames.length === 0) throw new Error("A GIF needs at least one frame.");
  const gifPalette = sharedPalette(frames, palette);
  const gif = GIFEncoder();
  const scale = options.scale ?? 1;
  frames.forEach((frame) => {
    const { indices, width, height } = indicesFor(frame, gifPalette, scale);
    gif.writeFrame(indices, width, height, {
      palette: gifPalette,
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

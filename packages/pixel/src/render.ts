import { composite } from "./buffer.js";
import { hexToRgba } from "./color.js";
import type { BlendMode, FrameBuffer, Layer } from "./types.js";

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type RenderOptions = {
  /** Nearest-neighbour output scale; fractional previews are allowed. */
  scale?: number;
  /** An opaque backdrop; without one, transparency survives. */
  background?: string;
};

const blendNormal = (_source: number, _backdrop: number): number => _source;

/**
 * Blend functions work on 0–255 channels. The compositor applies them in
 * straight-alpha space and only then mixes by coverage, which keeps a
 * multiply layer over transparency equal to the layer itself.
 */
const blendChannel: Record<BlendMode, (source: number, backdrop: number) => number> = {
  normal: blendNormal,
  multiply: (source, backdrop) => (source * backdrop) / 255,
  screen: (source, backdrop) => 255 - ((255 - source) * (255 - backdrop)) / 255,
  overlay: (source, backdrop) =>
    backdrop < 128
      ? (2 * source * backdrop) / 255
      : 255 - (2 * (255 - source) * (255 - backdrop)) / 255,
  add: (source, backdrop) => Math.min(255, source + backdrop),
  subtract: (source, backdrop) => Math.max(0, backdrop - source),
  darken: (source, backdrop) => Math.min(source, backdrop),
  lighten: (source, backdrop) => Math.max(source, backdrop),
  difference: (source, backdrop) => Math.abs(source - backdrop),
  exclusion: (source, backdrop) => source + backdrop - (2 * source * backdrop) / 255,
  "hard-light": (source, backdrop) =>
    source < 128
      ? (2 * source * backdrop) / 255
      : 255 - (2 * (255 - source) * (255 - backdrop)) / 255,
  "soft-light": (source, backdrop) => {
    const s = source / 255;
    const b = backdrop / 255;
    const result =
      s < 0.5
        ? b - (1 - 2 * s) * b * (1 - b)
        : b + (2 * s - 1) * (b < 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b) - b);
    return Math.max(0, Math.min(255, result * 255));
  },
  "color-dodge": (source, backdrop) =>
    source >= 255 ? 255 : Math.min(255, (backdrop * 255) / (255 - source)),
  "color-burn": (source, backdrop) =>
    source <= 0 ? 0 : Math.max(0, 255 - ((255 - backdrop) * 255) / source),
};

function groupOpacity(buffer: FrameBuffer, layer: Layer): number {
  let opacity = 1;
  let current = layer.parentGroupId;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const group = buffer.groups?.find((item) => item.id === current);
    if (!group) break;
    if (!group.visible) return 0;
    opacity *= Math.max(0, Math.min(1, group.opacity ?? 1));
    current = group.parentGroupId;
  }
  return opacity;
}

/**
 * Composite a frame to straight-alpha RGBA at its document size. This is the
 * only path the canvas, image encoders, SVG export and sheet packer use, so a
 * layer's opacity or blend mode cannot look different per format.
 */
export function renderFrameDocument(buffer: FrameBuffer): RgbaImage {
  const width = buffer.width;
  const height = buffer.height;
  const data = new Uint8Array(width * height * 4);

  for (const layer of buffer.layers) {
    if (!layer.visible) continue;
    const opacity =
      Math.max(0, Math.min(1, layer.opacity ?? 1)) * groupOpacity(buffer, layer);
    if (opacity <= 0) continue;
    const blend = blendChannel[layer.blend ?? "normal"];
    for (let index = 0; index < layer.pixels.length; index += 1) {
      const colorIndex = layer.pixels[index] ?? 0;
      if (colorIndex === 0) continue;
      const [r, g, b, a] = hexToRgba(buffer.palette[colorIndex] ?? "#000000");
      const sourceAlpha = (a / 255) * opacity;
      if (sourceAlpha <= 0) continue;
      const offset = index * 4;
      const destinationAlpha = (data[offset + 3] ?? 0) / 255;
      const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (outAlpha <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const source = channel === 0 ? r : channel === 1 ? g : b;
        const destination = data[offset + channel] ?? 0;
        // A blend mode needs a backdrop to blend with; over transparency the
        // layer itself is the result, not a black multiply.
        const blended = destinationAlpha === 0 ? source : blend(source, destination);
        const value =
          (blended * sourceAlpha + destination * destinationAlpha * (1 - sourceAlpha)) /
          outAlpha;
        data[offset + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
      data[offset + 3] = Math.round(outAlpha * 255);
    }
  }
  return { width, height, data };
}

function scaleNearest(image: RgbaImage, scale: number): RgbaImage {
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, Math.floor(y / scale)));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, Math.floor(x / scale)));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      data[targetOffset] = image.data[sourceOffset] ?? 0;
      data[targetOffset + 1] = image.data[sourceOffset + 1] ?? 0;
      data[targetOffset + 2] = image.data[sourceOffset + 2] ?? 0;
      data[targetOffset + 3] = image.data[sourceOffset + 3] ?? 0;
    }
  }
  return { width, height, data };
}

/**
 * Render one frame, optionally scaled. A background is applied after
 * compositing so semi-transparent palette entries still blend against it; the
 * result stays opaque when a backdrop was requested.
 */
export function renderFrame(buffer: FrameBuffer, options: RenderOptions = {}): RgbaImage {
  let image = renderFrameDocument(buffer);
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("Render scale must be a positive number.");
  }
  image = scaleNearest(image, scale);
  if (!options.background) return image;
  const backdrop = hexToRgba(options.background);
  const data = new Uint8Array(image.data);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = (data[index + 3] ?? 0) / 255;
    data[index] = Math.round((data[index] ?? 0) * alpha + backdrop[0] * (1 - alpha));
    data[index + 1] = Math.round(
      (data[index + 1] ?? 0) * alpha + backdrop[1] * (1 - alpha),
    );
    data[index + 2] = Math.round(
      (data[index + 2] ?? 0) * alpha + backdrop[2] * (1 - alpha),
    );
    data[index + 3] = 255;
  }
  return { ...image, data };
}

/** Palette indices for editing operations that must not see blended colours. */
export function compositeIndexed(buffer: FrameBuffer): Uint8Array {
  return composite(buffer);
}

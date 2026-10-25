import { drawText, textBounds, type TextElement } from "@pixelaition/artboard";
import { emptyPixels, type Layer, type TextLayerSpec } from "@pixelaition/pixel";

/** Atlas sizes the Silkscreen face ships; the UI never invents a size. */
export const TEXT_SIZES = [4, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 120] as const;

export function textElementOf(layer: Layer): TextElement | null {
  if (!layer.text) return null;
  return {
    ...layer.text,
    id: layer.id,
    kind: "text",
  };
}

export function renderTextSpec(
  spec: TextLayerSpec,
  width: number,
  height: number,
  paletteSize: number,
): Uint8Array {
  const pixels = emptyPixels(width, height);
  drawText(pixels, width, height, { ...spec, id: "text", kind: "text" }, paletteSize);
  return pixels;
}

export function textLayerBox(
  layer: Layer,
  width: number,
  height: number,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  baseWidth: number;
  baseHeight: number;
} | null {
  const element = textElementOf(layer);
  if (!element) return null;
  const base = textBounds({ ...element, rotation: 0 });
  const box = textBounds(element);
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.min(width - Math.max(0, box.x), box.width)),
    height: Math.max(1, Math.min(height - Math.max(0, box.y), box.height)),
    originX: element.x,
    originY: element.y,
    baseWidth: Math.max(1, base.width),
    baseHeight: Math.max(1, base.height),
  };
}

export function defaultTextSpec(
  width: number,
  height: number,
  color: number,
): TextLayerSpec {
  // A 32px sprite cannot carry a 16px headline; small canvases get a small
  // label-sized face, while native frames keep a readable display size.
  const preferred = height <= 64 ? Math.max(4, height * 0.25) : height * 0.06;
  const size = TEXT_SIZES.reduce((best, value) =>
    Math.abs(value - preferred) < Math.abs(best - preferred) ? value : best,
  );
  return {
    text: width <= 64 ? "Aa" : "Your words",
    face: "silkscreen",
    weight: 700,
    size,
    color,
    x: Math.round(width * 0.06),
    y: Math.round(height * 0.12),
    width: Math.round(width * 0.8),
    height: Math.round(size * 1.5),
    align: "left",
    maxLines: 3,
  };
}

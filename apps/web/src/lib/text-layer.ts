import {
  drawText,
  layoutText,
  textBounds,
  type TextElement,
} from "@pixelaition/artboard";
import { emptyPixels, type Layer, type TextLayerSpec } from "@pixelaition/pixel";

/** Atlas sizes the Silkscreen face ships; the UI never invents a size. */
export const TEXT_SIZES = [16, 24, 32, 48, 64, 96, 120] as const;

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
): { x: number; y: number; width: number; height: number } | null {
  const element = textElementOf(layer);
  if (!element) return null;
  const layout = layoutText(element);
  const box = textBounds(element);
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.min(width - Math.max(0, box.x), Math.max(1, box.width)),
    height: Math.min(
      height - Math.max(0, box.y),
      Math.max(1, layer.text?.height ?? layout.height),
    ),
  };
}

export function defaultTextSpec(
  width: number,
  height: number,
  color: number,
): TextLayerSpec {
  const preferred = height * 0.06;
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

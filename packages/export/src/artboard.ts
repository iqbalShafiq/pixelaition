import { toRgba, type PaletteImage } from "@pixelaition/artboard";
import { encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

export type ArtboardFormat = "png" | "jpg";

function flatten(image: PaletteImage, background?: string): Uint8Array {
  const rgba = toRgba(image);
  if (!background) return rgba;
  const backdrop = parseHex(background);
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = (rgba[index + 3] ?? 0) / 255;
    if (alpha >= 1) continue;
    rgba[index] = Math.round((rgba[index] ?? 0) * alpha + backdrop[0] * (1 - alpha));
    rgba[index + 1] = Math.round(
      (rgba[index + 1] ?? 0) * alpha + backdrop[1] * (1 - alpha),
    );
    rgba[index + 2] = Math.round(
      (rgba[index + 2] ?? 0) * alpha + backdrop[2] * (1 - alpha),
    );
    rgba[index + 3] = 255;
  }
  return rgba;
}

export function artboardToPng(image: PaletteImage): Uint8Array {
  const rgba = flatten(image);
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(rgba);
  return PNG.sync.write(png) as unknown as Uint8Array;
}

export function artboardToJpg(image: PaletteImage, background = "#0a0a09"): Uint8Array {
  const rgba = flatten(image, background);
  return encodeJpeg({ data: rgba, width: image.width, height: image.height }, 92)
    .data as unknown as Uint8Array;
}

export function encodeArtboard(
  image: PaletteImage,
  format: ArtboardFormat,
  background?: string,
): Uint8Array {
  return format === "jpg" ? artboardToJpg(image, background) : artboardToPng(image);
}

export function artboardBytes(image: PaletteImage, format: ArtboardFormat): number {
  return encodeArtboard(image, format).length;
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

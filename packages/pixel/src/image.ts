import { buildPaletteSync, utils, type PaletteQuantization } from "image-q";
import { hexToRgba, nearestPaletteIndex, rgbaToHex } from "./color.js";

export type RgbaImageData = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type SheetGrid = {
  columns: number;
  rows: number;
  cellWidth?: number;
  cellHeight?: number;
  margin?: number;
  spacing?: number;
  offsetX?: number;
  offsetY?: number;
};

export type QuantizeOptions = {
  /** Pixels below this alpha become index 0 (transparent). */
  alphaThreshold?: number;
  dither?: "none" | "bayer4" | "bayer8";
};

const bayer4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const bayer8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function crop(
  image: RgbaImageData,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImageData {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceX = x + column;
      const sourceY = y + row;
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= image.width ||
        sourceY >= image.height
      ) {
        continue;
      }
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (row * width + column) * 4;
      data[target] = image.data[source] ?? 0;
      data[target + 1] = image.data[source + 1] ?? 0;
      data[target + 2] = image.data[source + 2] ?? 0;
      data[target + 3] = image.data[source + 3] ?? 0;
    }
  }
  return { width, height, data };
}

/** Nearest-neighbour so pixel art never gains a blended edge on import. */
export function resizeRgbaNearest(
  image: RgbaImageData,
  width: number,
  height: number,
): RgbaImageData {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      data[target] = image.data[source] ?? 0;
      data[target + 1] = image.data[source + 1] ?? 0;
      data[target + 2] = image.data[source + 2] ?? 0;
      data[target + 3] = image.data[source + 3] ?? 0;
    }
  }
  return { width, height, data };
}

/**
 * Slice a sheet into cells. Sizes are explicit from the dialog; the defaults
 * fill the image evenly, which is the common 4×1 / 2×2 case.
 */
export function sliceSheet(image: RgbaImageData, grid: SheetGrid): RgbaImageData[] {
  const margin = grid.margin ?? 0;
  const spacing = grid.spacing ?? 0;
  const offsetX = grid.offsetX ?? margin;
  const offsetY = grid.offsetY ?? margin;
  const cellWidth =
    grid.cellWidth ??
    Math.floor((image.width - offsetX * 2 - spacing * (grid.columns - 1)) / grid.columns);
  const cellHeight =
    grid.cellHeight ??
    Math.floor((image.height - offsetY * 2 - spacing * (grid.rows - 1)) / grid.rows);
  if (cellWidth < 1 || cellHeight < 1) {
    throw new Error("The sheet grid produces an empty cell.");
  }
  const frames: RgbaImageData[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      frames.push(
        crop(
          image,
          offsetX + column * (cellWidth + spacing),
          offsetY + row * (cellHeight + spacing),
          cellWidth,
          cellHeight,
        ),
      );
    }
  }
  return frames;
}

/**
 * Map an RGBA image onto an existing palette. Bayer dithering adds a stable
 * threshold before the nearest-colour search; the alpha channel never invents
 * a palette entry.
 */
export function quantizeToPalette(
  image: RgbaImageData,
  palette: string[],
  options: QuantizeOptions = {},
): Uint8Array {
  const threshold = options.alphaThreshold ?? 128;
  const dither = options.dither ?? "none";
  const indices = new Uint8Array(image.width * image.height);
  const paletteRgb = palette.map((hex) => hexToRgba(hex));
  const matrix = dither === "bayer4" ? bayer4 : dither === "bayer8" ? bayer8 : null;
  const size = matrix?.length ?? 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] ?? 0;
      if (alpha < threshold) continue;
      let r = image.data[offset] ?? 0;
      let g = image.data[offset + 1] ?? 0;
      let b = image.data[offset + 2] ?? 0;
      if (matrix && size > 0) {
        const bias = (matrix[y % size]?.[x % size] ?? 0) / (size * size) - 0.5;
        // A small bias is enough to break bands without changing the subject.
        r = Math.max(0, Math.min(255, Math.round(r + bias * 28)));
        g = Math.max(0, Math.min(255, Math.round(g + bias * 28)));
        b = Math.max(0, Math.min(255, Math.round(b + bias * 28)));
      }
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < paletteRgb.length; index += 1) {
        const candidate = paletteRgb[index] ?? [0, 0, 0, 255];
        const dr = r - candidate[0];
        const dg = g - candidate[1];
        const db = b - candidate[2];
        const next = 0.2126 * dr * dr + 0.7152 * dg * dg + 0.0722 * db * db;
        if (next < distance) {
          distance = next;
          best = index;
        }
      }
      indices[y * image.width + x] = best;
    }
  }
  return indices;
}

/** A palette built from the opaque pixels of an imported image. */
export function paletteFromImage(
  image: RgbaImageData,
  colors = 32,
  quantizer: PaletteQuantization = "wuquant",
): string[] {
  const container = new utils.PointContainer();
  container.setWidth(image.width);
  container.setHeight(image.height);
  const points = container.getPointArray();
  for (let index = 0; index < image.width * image.height; index += 1) {
    const offset = index * 4;
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha === 0) continue;
    points.push(
      utils.Point.createByRGBA(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
        alpha,
      ),
    );
  }
  if (points.length === 0) return ["#00000000"];
  const built = buildPaletteSync([container], {
    colors: Math.max(2, Math.min(255, colors)),
    paletteQuantization: quantizer,
  }).getPointContainer();
  const hexes: string[] = ["#00000000"];
  const seen = new Set<string>(["#00000000"]);
  for (const point of built.getPointArray()) {
    const hex = rgbaToHex(point.r, point.g, point.b, 255);
    if (!seen.has(hex)) {
      seen.add(hex);
      hexes.push(hex);
    }
    if (hexes.length >= 256) break;
  }
  if (hexes.length < 2) {
    const sample = points[0];
    return ["#00000000", rgbaToHex(sample?.r ?? 0, sample?.g ?? 0, sample?.b ?? 0)];
  }
  return hexes;
}

/** A stable mapping from any source palette to a target palette. */
export function remapIndices(
  indices: Uint8Array,
  source: string[],
  target: string[],
): Uint8Array {
  const mapping = source.map((hex) => nearestPaletteIndex(hex, target));
  return indices.map((index) => mapping[index] ?? 0);
}

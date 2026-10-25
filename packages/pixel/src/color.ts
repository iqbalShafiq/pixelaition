import { normalizeHex } from "./pixels.js";

/** Straight-alpha RGBA, the shape every renderer and encoder agrees on. */
export type Rgba = [number, number, number, number];

/** One full-colour pixel packed as 0xRRGGBBAA. */
export type PackedRgba = number;

export function packRgba(r: number, g: number, b: number, a = 255): PackedRgba {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | channel(a)) >>> 0;
}

export function unpackRgba(color: PackedRgba): Rgba {
  return [
    (color >>> 24) & 0xff,
    (color >>> 16) & 0xff,
    (color >>> 8) & 0xff,
    color & 0xff,
  ];
}

export function hexToColor(hex: string): PackedRgba | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  return packRgba(...hexToRgba(normalized));
}

export function colorToHex(color: PackedRgba): string {
  return rgbaToHex(...unpackRgba(color));
}

/**
 * Palette entries are normalised hex, so a fixed-width parse is enough.
 * Anything unexpected is opaque black rather than silently transparent: a bad
 * colour must never erase a pixel.
 */
export function hexToRgba(hex: string): Rgba {
  const normalized = normalizeHex(hex) ?? hex;
  const value = normalized.replace("#", "");
  if (value.length === 8) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      Number.parseInt(value.slice(6, 8), 16),
    ];
  }
  if (value.length === 6) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      255,
    ];
  }
  return [0, 0, 0, 255];
}

export function rgbaToHex(r: number, g: number, b: number, a = 255): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}${a < 255 ? channel(a) : ""}`;
}

/** Perceptual enough for palette work, cheap enough for a 4096² import. */
export function colorDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const r = left[0] - right[0];
  const g = left[1] - right[1];
  const b = left[2] - right[2];
  // Rec. 709 weights keep two visually distinct blues from mapping together.
  return 0.2126 * r * r + 0.7152 * g * g + 0.0722 * b * b;
}

/** The closest palette entry for a colour; index 0 stays transparent. */
export function nearestPaletteIndex(hex: string, palette: string[]): number {
  const source = hexToRgba(hex);
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < palette.length; index += 1) {
    const candidate = hexToRgba(palette[index] ?? "#000000");
    const next = colorDistance(
      [source[0], source[1], source[2]],
      [candidate[0], candidate[1], candidate[2]],
    );
    if (next < distance) {
      distance = next;
      best = index;
    }
  }
  return best;
}

/**
 * Map every source index into a target palette. An exact hex wins; otherwise
 * the nearest RGB entry is used. Index 0 is transparent in every palette, so it
 * always maps to 0.
 */
export function paletteIndexMap(source: string[], target: string[]): number[] {
  const targetByHex = new Map<string, number>();
  for (let index = 1; index < target.length; index += 1) {
    const hex = normalizeHex(target[index] ?? "");
    if (hex) targetByHex.set(hex, index);
  }
  return source.map((hex, index) => {
    if (index === 0) return 0;
    const exact = targetByHex.get(normalizeHex(hex) ?? hex);
    if (exact !== undefined) return exact;
    return nearestPaletteIndex(hex, target);
  });
}

import atlas from "./fonts/atlas.json";
import type { TextFace, TextWeight } from "./types.js";

/**
 * The atlas is generated from the same OFL pixel faces the interface uses
 * (Silkscreen, Pixelify Sans, Departure Mono). Glyphs are 1-bit masks, so
 * exported text can never contain an anti-aliased colour that is outside the
 * artwork's palette.
 */
type Glyph = {
  advance: number;
  left: number;
  top: number;
  width: number;
  height: number;
  rows: string;
};

type SizeAtlas = {
  ascent: number;
  descent: number;
  glyphs: Record<string, Glyph>;
};

type WeightAtlas = { sizes: Record<string, SizeAtlas> };
type FaceAtlas = { weights: Record<string, WeightAtlas> };
type Atlas = { faces: Record<string, FaceAtlas> };

const typedAtlas = atlas as unknown as Atlas;

export type ResolvedFont = {
  face: TextFace;
  weight: TextWeight;
  /** The atlas size in pixels. */
  size: number;
  /** Whole-pixel growth applied to every glyph and metric. */
  scale: number;
  ascent: number;
  descent: number;
  glyphs: Record<string, Glyph>;
};

const decoded = new Map<string, Uint8Array>();

export function availableWeights(face: TextFace): TextWeight[] {
  const weights = Object.keys(typedAtlas.faces[face]?.weights ?? {}).map(Number);
  return weights.filter(isTextWeight).sort((a, b) => a - b);
}

export function availableSizes(face: TextFace, weight: TextWeight): number[] {
  const sizes = Object.keys(
    typedAtlas.faces[face]?.weights[String(weight)]?.sizes ?? {},
  ).map(Number);
  return sizes.filter((size) => Number.isInteger(size) && size > 0).sort((a, b) => a - b);
}

/** The closest size the atlas can actually render, for templates and pickers. */
export function nearestSize(face: TextFace, weight: TextWeight, desired: number): number {
  const sizes = availableSizes(face, weight);
  if (sizes.length === 0) throw new Error(`No atlas sizes for ${face} ${weight}.`);
  let best = sizes[0] ?? 16;
  let distance = Math.abs(best - desired);
  for (const size of sizes) {
    const next = Math.abs(size - desired);
    if (next < distance) {
      best = size;
      distance = next;
    }
  }
  return best;
}

export function resolveFont(
  face: TextFace,
  weight: TextWeight,
  size: number,
): ResolvedFont {
  const faceAtlas = typedAtlas.faces[face];
  if (!faceAtlas) throw new Error(`Unknown text face "${face}".`);
  const weights = Object.keys(faceAtlas.weights);
  const weightKey = weights.includes(String(weight))
    ? String(weight)
    : (weights[0] as string | undefined);
  if (!weightKey) throw new Error(`No weights for ${face}.`);
  const sizeAtlas = faceAtlas.weights[weightKey]?.sizes[String(size)];
  if (!sizeAtlas) {
    throw new Error(
      `Text face ${face} ${weightKey} has no ${size}px atlas. Available: ${availableSizes(
        face,
        Number(weightKey) as TextWeight,
      ).join(", ")}.`,
    );
  }
  return {
    face,
    weight: Number(weightKey) as TextWeight,
    size,
    scale: 1,
    ascent: sizeAtlas.ascent,
    descent: sizeAtlas.descent,
    glyphs: sizeAtlas.glyphs,
  };
}

/** The glyph bitmap, unpacked from the row-major bit string in the atlas. */
export function glyphBits(glyph: Glyph): Uint8Array {
  const key = `${glyph.width}x${glyph.height}:${glyph.rows}`;
  const cached = decoded.get(key);
  if (cached) return cached;
  const bytes = glyph.rows.length === 0 ? new Uint8Array(0) : base64Bytes(glyph.rows);
  const bits = new Uint8Array(glyph.width * glyph.height);
  for (let index = 0; index < bits.length; index += 1) {
    const byte = bytes[index >> 3] ?? 0;
    bits[index] = (byte >> (7 - (index & 7))) & 1;
  }
  decoded.set(key, bits);
  return bits;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isTextWeight(value: number): value is TextWeight {
  return value === 400 || value === 600 || value === 700;
}

export function glyphFor(font: ResolvedFont, char: string): Glyph | undefined {
  return font.glyphs[char];
}

export function missingGlyphs(font: ResolvedFont, text: string): string[] {
  const missing = new Set<string>();
  for (const char of text) {
    if (char === "\n") continue;
    if (!font.glyphs[char]) missing.add(char);
  }
  return [...missing];
}

/**
 * Turn a requested final size into an atlas face plus whole-pixel scale. The
 * smallest atlas size that is at least the request wins, so a minimum-size
 * rule never silently shrinks the copy; a request above the largest atlas grows
 * by whole pixels instead of resampling.
 */
export function snapTextSize(
  face: TextFace,
  weight: TextWeight,
  requested: number,
): { size: number; scale: number; effective: number } {
  const sizes = availableSizes(face, weight);
  if (sizes.length === 0) throw new Error(`No atlas sizes for ${face} ${weight}.`);
  const above = sizes.find((size) => size >= requested);
  if (above !== undefined) {
    return { size: above, scale: 1, effective: above };
  }
  const base = sizes[sizes.length - 1] ?? requested;
  const scale = Math.max(1, Math.ceil(requested / base));
  return { size: base, scale, effective: base * scale };
}

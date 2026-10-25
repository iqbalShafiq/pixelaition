import { MAX_SIZE, MIN_SIZE, TRANSPARENT } from "./types.js";

export function cellCount(width: number, height: number): number {
  return width * height;
}

export function inBounds(width: number, height: number, x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height
  );
}

export function indexOf(width: number, x: number, y: number): number {
  return y * width + x;
}

/**
 * Pixel bytes are straight RGBA, four bytes per cell; the editing commands
 * still speak one packed 0xRRGGBBAA number per cell.
 */
export function readCell(pixels: Uint8Array, index: number): number {
  const offset = index * 4;
  const r = pixels[offset] ?? 0;
  const g = pixels[offset + 1] ?? 0;
  const b = pixels[offset + 2] ?? 0;
  const a = pixels[offset + 3] ?? 0;
  if (r === 0 && g === 0 && b === 0 && a === 0) return TRANSPARENT;
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function writeCell(pixels: Uint8Array, index: number, color: number): void {
  const offset = index * 4;
  pixels[offset] = (color >>> 24) & 0xff;
  pixels[offset + 1] = (color >>> 16) & 0xff;
  pixels[offset + 2] = (color >>> 8) & 0xff;
  pixels[offset + 3] = color & 0xff;
}

export function encodePixels(pixels: Uint8Array): string {
  let binary = "";
  for (const byte of pixels) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePixels(encoded: string, expectedLength: number): Uint8Array {
  const binary = atob(encoded);
  if (binary.length !== expectedLength) {
    throw new Error(
      `Pixel buffer length ${binary.length} does not match ${expectedLength}.`,
    );
  }
  const pixels = new Uint8Array(expectedLength);
  for (let index = 0; index < binary.length; index += 1) {
    pixels[index] = binary.charCodeAt(index);
  }
  return pixels;
}

export function emptyPixels(width: number, height: number): Uint8Array {
  return new Uint8Array(cellCount(width, height) * 4);
}

/** Bytes a frame of this size needs in the RGBA document format. */
export function pixelBytes(width: number, height: number): number {
  return cellCount(width, height) * 4;
}

export function clonePixels(pixels: Uint8Array): Uint8Array {
  return pixels.slice();
}

export function isSizeAllowed(size: number): boolean {
  return Number.isInteger(size) && size >= MIN_SIZE && size <= MAX_SIZE;
}

export function normalizeHex(value: string): string | null {
  const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
  if (!match?.[1]) return null;
  return `#${match[1].toLowerCase()}`;
}

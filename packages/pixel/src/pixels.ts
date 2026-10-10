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

export function readCell(pixels: Uint8Array, index: number): number {
  return pixels[index] ?? TRANSPARENT;
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
  return new Uint8Array(cellCount(width, height));
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

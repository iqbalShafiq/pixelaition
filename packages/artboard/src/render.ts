import {
  colorToHex,
  composite,
  hexToRgba as pixelHexToRgba,
  normalizeHex,
  readCell,
  writeCell,
  type FrameBuffer,
} from "@pixelaition/pixel";
import { drawTextRgba, textBounds } from "./text.js";
import { upgradeScene } from "./scene.js";
import type {
  Element,
  PaletteImage,
  Rect,
  RenderInput,
  RenderResult,
  SpriteElement,
  SpriteSource,
} from "./types.js";
import { frameKey } from "./types.js";

export function renderScene(input: RenderInput): RenderResult {
  const { scene: rawScene, preset, palette } = input;
  const scene = upgradeScene(rawScene, palette);
  const { width, height } = preset;
  const target = new Uint8Array(width * height * 4);
  paintBackground(target, width, height, scene.background);
  const used = new Set<number>();
  if (scene.background.kind !== "transparent") {
    if (scene.background.kind === "solid") used.add(scene.background.color);
    if (scene.background.kind === "pattern") {
      used.add(scene.background.colorA);
      used.add(scene.background.colorB);
    }
  }
  for (const element of scene.elements) {
    if (element.visible === false) continue;
    paintElement(target, width, height, element, input.sprites);
    if ("color" in element) used.add(element.color);
    if (element.kind === "pattern") {
      used.add(element.colorA);
      used.add(element.colorB);
    }
  }
  const usedColors = [...used].filter((color) => (color & 0xff) !== 0);
  const indices = indicesFor(target, width, height, palette);
  return {
    image: {
      width,
      height,
      palette: [...palette],
      indices,
      rgba: target,
    },
    usedColors,
  };
}

export function paintBackground(
  target: Uint8Array,
  width: number,
  height: number,
  background: RenderInput["scene"]["background"],
): void {
  if (background.kind === "transparent") return;
  if (background.kind === "solid") {
    fillAll(target, background.color);
    return;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      writeCell(
        target,
        y * width + x,
        patternAt(
          x,
          y,
          background.unit,
          background.mode,
          background.colorA,
          background.colorB,
        ),
      );
    }
  }
}

function paintElement(
  target: Uint8Array,
  width: number,
  height: number,
  element: Element,
  sprites: Map<string, SpriteSource> | undefined,
): void {
  switch (element.kind) {
    case "rect":
      fillRect(target, width, height, element, element.color);
      return;
    case "pattern":
      for (
        let y = Math.max(0, element.y);
        y < Math.min(height, element.y + element.height);
        y += 1
      ) {
        for (
          let x = Math.max(0, element.x);
          x < Math.min(width, element.x + element.width);
          x += 1
        ) {
          writeCell(
            target,
            y * width + x,
            patternAt(
              x - element.x,
              y - element.y,
              element.unit,
              element.mode,
              element.colorA,
              element.colorB,
            ),
          );
        }
      }
      return;
    case "frame":
      paintFrame(target, width, height, element);
      return;
    case "text":
      drawTextRgba(target, width, height, element);
      return;
    case "sprite":
      paintSprite(target, width, height, element, sprites);
      return;
  }
}

function fillAll(target: Uint8Array, color: number): void {
  for (let cell = 0; cell < target.length / 4; cell += 1) {
    writeCell(target, cell, color);
  }
}

function fillRect(
  target: Uint8Array,
  width: number,
  height: number,
  rect: Rect,
  color: number,
): void {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      writeCell(target, y * width + x, color);
    }
  }
}

function paintFrame(
  target: Uint8Array,
  width: number,
  height: number,
  element: Extract<Element, { kind: "frame" }>,
): void {
  const t = element.thickness;
  fillRect(
    target,
    width,
    height,
    { x: element.x, y: element.y, width: element.width, height: t },
    element.color,
  );
  fillRect(
    target,
    width,
    height,
    { x: element.x, y: element.y + element.height - t, width: element.width, height: t },
    element.color,
  );
  fillRect(
    target,
    width,
    height,
    { x: element.x, y: element.y, width: t, height: element.height },
    element.color,
  );
  fillRect(
    target,
    width,
    height,
    { x: element.x + element.width - t, y: element.y, width: t, height: element.height },
    element.color,
  );
}

function patternAt(
  x: number,
  y: number,
  unit: number,
  mode: "checker" | "50",
  colorA: number,
  colorB: number,
): number {
  const cellX = Math.floor(x / unit);
  const cellY = Math.floor(y / unit);
  if (mode === "checker") {
    return (cellX + cellY) % 2 === 0 ? colorA : colorB;
  }
  const bayer = BAYER4[(y % 4) * 4 + (x % 4)] ?? 0;
  return bayer < 8 ? colorA : colorB;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function paintSprite(
  target: Uint8Array,
  width: number,
  height: number,
  element: SpriteElement,
  sprites: Map<string, SpriteSource> | undefined,
): void {
  const source =
    sprites?.get(frameKey(element.assetId, element.frameId ?? "")) ??
    findSprite(sprites, element.assetId, element.frameId);
  if (!source) {
    throw new Error(
      `No sprite source for asset ${element.assetId}${element.frameId ? ` frame ${element.frameId}` : ""}.`,
    );
  }
  const compositePixels = composite(source.buffer);
  const box = spriteBox(element, source.buffer);
  const scale = element.scale;
  for (let y = 0; y < source.buffer.height; y += 1) {
    for (let x = 0; x < source.buffer.width; x += 1) {
      const color = readCell(compositePixels, y * source.buffer.width + x);
      if ((color & 0xff) === 0) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = box.x + x * scale + dx;
          const py = box.y + y * scale + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const cell = py * width + px;
          writeCell(target, cell, over(readCell(target, cell), color));
        }
      }
    }
  }
}

/** Source-over for straight RGBA packed colours. */
function over(dst: number, src: number): number {
  const sa = src & 0xff;
  if (sa === 255) return src;
  if (sa === 0) return dst;
  const da = dst & 0xff;
  const outA = sa + (da * (255 - sa)) / 255;
  if (outA === 0) return 0;
  const mix = (shift: number) => {
    const d = (dst >>> shift) & 0xff;
    const s = (src >>> shift) & 0xff;
    return Math.round((s * sa + d * da * (1 - sa / 255)) / outA);
  };
  return ((mix(24) << 24) | (mix(16) << 16) | (mix(8) << 8) | Math.round(outA)) >>> 0;
}

function indicesFor(
  target: Uint8Array,
  width: number,
  height: number,
  palette: string[],
): Uint8Array {
  const indices = new Uint8Array(width * height);
  const exact = new Map<string, number>();
  palette.forEach((hex, index) => exact.set(normalizeHex(hex) ?? "", index));
  const colors = palette.map((hex) => hexToRgba(hex));
  for (let cell = 0; cell < indices.length; cell += 1) {
    const color = readCell(target, cell);
    if ((color & 0xff) === 0) continue;
    const found = exact.get(colorToHex(color));
    if (found !== undefined) {
      indices[cell] = found;
      continue;
    }
    let best = 1;
    let distance = Number.POSITIVE_INFINITY;
    const [r, g, b] = colorToRgba(color);
    for (let index = 1; index < colors.length; index += 1) {
      const candidate = colors[index]!;
      const next =
        (candidate[0] - r) ** 2 + (candidate[1] - g) ** 2 + (candidate[2] - b) ** 2;
      if (next < distance) {
        distance = next;
        best = index;
      }
    }
    indices[cell] = best;
  }
  return indices;
}

function colorToRgba(color: number): [number, number, number] {
  return [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff];
}

function findSprite(
  sprites: Map<string, SpriteSource> | undefined,
  assetId: string,
  frameId: string | undefined,
): SpriteSource | undefined {
  if (!sprites) return undefined;
  for (const source of sprites.values()) {
    if (source.assetId !== assetId) continue;
    if (frameId === undefined || source.frameId === frameId) return source;
  }
  return undefined;
}

export function spriteBox(element: SpriteElement, source: FrameBuffer): Rect {
  const width = source.width * element.scale;
  const height = source.height * element.scale;
  let x = element.x;
  let y = element.y;
  if (element.anchor.endsWith("center")) x -= Math.round(width / 2);
  if (element.anchor.startsWith("center")) y -= Math.round(height / 2);
  if (element.anchor.endsWith("right")) x -= width;
  if (element.anchor.startsWith("bottom")) y -= height;
  return { x, y, width, height };
}

/** Bounds for every element, used by the safe-zone and overlap checks. */
export function elementBounds(
  element: Element,
  sprites?: Map<string, SpriteSource>,
): Rect {
  switch (element.kind) {
    case "rect":
    case "pattern":
    case "frame":
      return {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      };
    case "text":
      return textBounds(element);
    case "sprite": {
      const source =
        sprites?.get(frameKey(element.assetId, element.frameId ?? "")) ??
        findSprite(sprites, element.assetId, element.frameId);
      if (!source) {
        return {
          x: element.x,
          y: element.y,
          width: element.scale,
          height: element.scale,
        };
      }
      return spriteBox(element, source.buffer);
    }
  }
}

export function elementLabel(element: Element): string {
  switch (element.kind) {
    case "text":
      return element.text.slice(0, 32) || "text";
    case "sprite":
      return "sprite";
    case "rect":
      return "block";
    case "pattern":
      return "pattern";
    case "frame":
      return "frame";
  }
}

export function toRgba(image: PaletteImage): Uint8Array {
  return new Uint8Array(image.rgba);
}

export function indicesToRgba(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: string[],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const colors = palette.map((hex) => hexToRgba(hex));
  for (let index = 0; index < indices.length; index += 1) {
    const color = indices[index] ?? 0;
    const rgba = colors[color] ?? [0, 0, 0, 0];
    const offset = index * 4;
    data[offset] = rgba[0];
    data[offset + 1] = rgba[1];
    data[offset + 2] = rgba[2];
    data[offset + 3] = color === 0 ? 0 : rgba[3];
  }
  return data;
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new Error(`Invalid palette colour "${hex}".`);
  return pixelHexToRgba(normalized);
}

import {
  composite,
  hexToRgba as pixelHexToRgba,
  normalizeHex,
  type FrameBuffer,
} from "@pixelaition/pixel";
import { drawText, textBounds } from "./text.js";
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
  const { scene, preset, palette } = input;
  const { width, height } = preset;
  const target = new Uint8Array(width * height);
  paintBackground(target, width, height, scene.background, palette.length);
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
    paintElement(target, width, height, element, palette, input.sprites);
    if ("color" in element) used.add(element.color);
    if (element.kind === "pattern") {
      used.add(element.colorA);
      used.add(element.colorB);
    }
  }
  const usedColors = [...used].filter((color) => color > 0 && color < palette.length);
  return {
    image: {
      width,
      height,
      palette: [...palette],
      indices: target,
      rgba: indicesToRgba(target, width, height, palette),
    },
    usedColors,
  };
}

export function paintBackground(
  target: Uint8Array,
  width: number,
  height: number,
  background: RenderInput["scene"]["background"],
  paletteSize: number,
): void {
  if (background.kind === "transparent") return;
  if (background.kind === "solid") {
    assertColor(background.color, paletteSize, "background");
    target.fill(background.color);
    return;
  }
  assertColor(background.colorA, paletteSize, "background color A");
  assertColor(background.colorB, paletteSize, "background color B");
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      target[y * width + x] = patternAt(
        x,
        y,
        background.unit,
        background.mode,
        background.colorA,
        background.colorB,
      );
    }
  }
}

function paintElement(
  target: Uint8Array,
  width: number,
  height: number,
  element: Element,
  palette: string[],
  sprites: Map<string, SpriteSource> | undefined,
): void {
  switch (element.kind) {
    case "rect":
      assertColor(element.color, palette.length, "rect");
      fillRect(target, width, height, element, element.color);
      return;
    case "pattern":
      assertColor(element.colorA, palette.length, "pattern color A");
      assertColor(element.colorB, palette.length, "pattern color B");
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
          target[y * width + x] = patternAt(
            x - element.x,
            y - element.y,
            element.unit,
            element.mode,
            element.colorA,
            element.colorB,
          );
        }
      }
      return;
    case "frame":
      assertColor(element.color, palette.length, "frame");
      paintFrame(target, width, height, element);
      return;
    case "text":
      assertColor(element.color, palette.length, "text");
      drawText(target, width, height, element, palette.length);
      return;
    case "sprite":
      paintSprite(target, width, height, element, palette, sprites);
      return;
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
    target.fill(color, y * width + left, y * width + Math.max(left, right));
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
  // A 50% ordered dither: the pattern is stable and reads as texture, not noise.
  const bayer = BAYER4[(y % 4) * 4 + (x % 4)] ?? 0;
  return bayer < 8 ? colorA : colorB;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function paintSprite(
  target: Uint8Array,
  width: number,
  height: number,
  element: SpriteElement,
  palette: string[],
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
  const mapping = spriteMapping(source.buffer.palette, palette);
  const box = spriteBox(element, source.buffer);
  const scale = element.scale;
  for (let y = 0; y < source.buffer.height; y += 1) {
    for (let x = 0; x < source.buffer.width; x += 1) {
      const color = compositePixels[y * source.buffer.width + x] ?? 0;
      if (color === 0) continue;
      const mapped = mapping[color];
      if (mapped === undefined) {
        throw new Error(
          `Sprite colour ${source.buffer.palette[color] ?? color} is not in the artboard palette.`,
        );
      }
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = box.x + x * scale + dx;
          const py = box.y + y * scale + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          target[py * width + px] = mapped;
        }
      }
    }
  }
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

function spriteMapping(source: string[], target: string[]): number[] {
  const targetIndex = new Map<string, number>();
  for (let index = 1; index < target.length; index += 1) {
    const hex = normalizeHex(target[index] ?? "");
    if (hex) targetIndex.set(hex, index);
  }
  const mapping = new Array<number>(source.length).fill(0);
  for (let index = 1; index < source.length; index += 1) {
    const hex = normalizeHex(source[index] ?? "");
    const found = hex ? targetIndex.get(hex) : undefined;
    if (found !== undefined) mapping[index] = found;
  }
  return mapping;
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
  if (image.rgba.length === image.width * image.height * 4) {
    return new Uint8Array(image.rgba);
  }
  return indicesToRgba(image.indices, image.width, image.height, image.palette);
}

/** Resolve one indexed image into straight RGBA bytes. */
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

function assertColor(color: number, paletteSize: number, label: string): void {
  if (!Number.isInteger(color) || color < 0 || color >= paletteSize) {
    throw new Error(
      `The ${label} uses palette index ${color}, outside the ${paletteSize}-colour palette.`,
    );
  }
}

import {
  checkScene,
  getPreset,
  renderScene,
  type Artboard,
  type ArtboardCheck,
  type ArtboardScene,
  type CopyDeck,
  type FormatPreset,
  type PaletteImage,
  type SpriteSource,
} from "@pixelaition/artboard";
import { frameToBuffer } from "@pixelaition/pixel";
import type { AssetDto } from "./types.js";

/** A frame's palette indices, ready for the shared artboard renderer. */
export function spritesForAsset(asset: AssetDto): Map<string, SpriteSource> {
  const sprites = new Map<string, SpriteSource>();
  for (const frame of asset.frames) {
    if (frame.kind === "social") continue;
    const width = frame.width ?? asset.width;
    const height = frame.height ?? asset.height;
    sprites.set(`${asset.id}:${frame.id}`, {
      assetId: asset.id,
      assetName: asset.name,
      frameId: frame.id,
      frameName: frame.name,
      buffer: frameToBuffer(frame, width, height, asset.palette),
    });
  }
  return sprites;
}

export function renderArtboard(
  artboard: Artboard,
  preset: FormatPreset,
  asset: AssetDto,
  sprites: Map<string, SpriteSource>,
): PaletteImage {
  return renderScene({
    scene: artboard.scene,
    preset,
    palette: asset.palette,
    sprites,
  }).image;
}

export function checkArtboard(
  artboard: Artboard,
  preset: FormatPreset,
  asset: AssetDto,
  sprites: Map<string, SpriteSource>,
): ArtboardCheck[] {
  return checkScene({
    scene: artboard.scene,
    preset,
    palette: asset.palette,
    sprites,
  });
}

export function drawPaletteImage(canvas: HTMLCanvasElement, image: PaletteImage): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  const colors = image.palette.map(hexToRgba);
  for (let index = 0; index < image.indices.length; index += 1) {
    const color = image.indices[index] ?? 0;
    const rgba = colors[color] ?? [0, 0, 0, 0];
    const offset = index * 4;
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = color === 0 ? 0 : rgba[3];
  }
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
}

export function downsamplePalette(image: PaletteImage, maxEdge: number): PaletteImage {
  const ratio = Math.max(image.width, image.height) / maxEdge;
  if (ratio <= 1) return image;
  const factor = Math.ceil(ratio);
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const counts = new Map<number, number>();
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= image.width || sy >= image.height) continue;
          const color = image.indices[sy * image.width + sx] ?? 0;
          counts.set(color, (counts.get(color) ?? 0) + 1);
        }
      }
      let best = 0;
      let bestCount = -1;
      for (const [color, count] of counts) {
        if (count > bestCount) {
          best = color;
          bestCount = count;
        }
      }
      indices[y * width + x] = best;
    }
  }
  return { ...image, width, height, indices };
}

export function copyWith(copy: CopyDeck, key: keyof CopyDeck, value: string): CopyDeck {
  return { ...copy, [key]: value };
}

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) : 255,
  ];
}

/** The shared artboard engine's view of one social frame. */
export function artboardForFrame(
  asset: AssetDto,
  frame: AssetDto["frames"][number],
): Artboard | null {
  if (frame.kind !== "social" || !frame.presetId || !frame.scene) return null;
  return {
    id: frame.id,
    setId: asset.id,
    presetId: frame.presetId,
    name: frame.name,
    width: frame.width ?? getPreset(frame.presetId).width,
    height: frame.height ?? getPreset(frame.presetId).height,
    pixelUnit: getPreset(frame.presetId).pixelUnit,
    scene: frame.scene,
    copyOverride: frame.copyOverride ?? {},
    status:
      frame.status === "ready" || frame.status === "needs-fix" ? frame.status : "draft",
    version: frame.version ?? 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export type ProjectResourceAsset = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: Array<{
    id: string;
    name: string;
    index: number;
    kind: "sprite" | "social";
    width: number | null;
    height: number | null;
    presetId: string | null;
    layers: Array<{ id: string; name: string; visible: boolean; pixels: string }>;
  }>;
};

/** Every sprite frame in a project, keyed for the shared artboard renderer. */
export function spritesForResources(
  assets: ProjectResourceAsset[],
): Map<string, SpriteSource> {
  const sprites = new Map<string, SpriteSource>();
  for (const asset of assets) {
    for (const frame of asset.frames) {
      if (frame.kind !== "sprite") continue;
      sprites.set(`${asset.id}:${frame.id}`, {
        assetId: asset.id,
        assetName: asset.name,
        frameId: frame.id,
        frameName: frame.name,
        buffer: frameToBuffer(
          { ...frame, layers: frame.layers },
          frame.width ?? asset.width,
          frame.height ?? asset.height,
          asset.palette,
        ),
      });
    }
  }
  return sprites;
}

/** A scene can render only when every sprite it names is in the project map. */
export function sceneSpritesReady(
  scene: ArtboardScene,
  sprites: Map<string, SpriteSource>,
): boolean {
  return scene.elements.every((element) => {
    if (element.kind !== "sprite") return true;
    if (element.frameId) return sprites.has(`${element.assetId}:${element.frameId}`);
    return [...sprites.values()].some((source) => source.assetId === element.assetId);
  });
}

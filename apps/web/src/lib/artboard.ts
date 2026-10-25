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
  const pixels = new Uint8ClampedArray(image.rgba);
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
}

export function downsamplePalette(image: PaletteImage, maxEdge: number): PaletteImage {
  const ratio = Math.max(image.width, image.height) / maxEdge;
  if (ratio <= 1) return image;
  const factor = Math.ceil(ratio);
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const indices = new Uint8Array(width * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, x * factor + Math.floor(factor / 2));
      const sy = Math.min(image.height - 1, y * factor + Math.floor(factor / 2));
      const source = sy * image.width + sx;
      const target = y * width + x;
      indices[target] = image.indices[source] ?? 0;
      rgba.set(image.rgba.subarray(source * 4, source * 4 + 4), target * 4);
    }
  }
  return { ...image, width, height, indices, rgba };
}

export function copyWith(copy: CopyDeck, key: keyof CopyDeck, value: string): CopyDeck {
  return { ...copy, [key]: value };
}

export function emptyScene(): ArtboardScene {
  return { version: 1, background: { kind: "transparent" }, elements: [] };
}

/**
 * Every frame can carry scene content. A pixel-backed frame uses a synthetic
 * preset at its own canvas size; a native-size frame uses its named preset.
 */
export function presetForFrame(
  asset: AssetDto,
  frame: AssetDto["frames"][number],
): FormatPreset {
  if (frame.presetId) {
    try {
      return getPreset(frame.presetId);
    } catch {
      // A removed preset must not make an old frame unopenable.
    }
  }
  const width = frame.width ?? asset.width;
  const height = frame.height ?? asset.height;
  return {
    id: `frame-${frame.id}`,
    platform: "Pixelaition",
    group: "post",
    label: "Frame",
    width,
    height,
    pixelUnit: 1,
    minTextSize: 4,
    maxBytes: null,
    shape: "rect",
    safeZones: [],
    crops: [],
    exclusions: [],
    defaultTemplate: "blank",
    notes: [],
    source: "Frame canvas",
    verifiedAt: "",
    official: false,
  };
}

/** The shared artboard engine's view of any frame. */
export function artboardForFrame(
  asset: AssetDto,
  frame: AssetDto["frames"][number],
): Artboard {
  const preset = presetForFrame(asset, frame);
  return {
    id: frame.id,
    setId: asset.id,
    presetId: frame.presetId ?? preset.id,
    name: frame.name,
    width: frame.width ?? asset.width,
    height: frame.height ?? asset.height,
    pixelUnit: preset.pixelUnit,
    scene: frame.scene ?? emptyScene(),
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

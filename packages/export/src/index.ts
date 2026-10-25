/* eslint-disable @typescript-eslint/triple-slash-reference -- ambient declarations for untyped encoders */
/// <reference path="./gifenc.d.ts" />
/// <reference path="./upng-js.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */
import {
  pixelProjectSchema,
  type FrameBuffer,
  type PixelProject,
} from "@pixelaition/pixel";
import { zipSync, strToU8 } from "fflate";
import { encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { rasterize } from "./raster.js";

export const exportScales = [1, 2, 4, 8, 10] as const;
export type ExportScale = (typeof exportScales)[number];

export function serializeProject(project: PixelProject): string {
  return `${JSON.stringify(pixelProjectSchema.parse(project), null, 2)}\n`;
}

export function parseProject(source: string): PixelProject {
  return pixelProjectSchema.parse(JSON.parse(source));
}

export function frameToPng(buffer: FrameBuffer, scale: number): Uint8Array {
  const image = rasterize(buffer, scale);
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png) as unknown as Uint8Array;
}

export function frameToJpg(
  buffer: FrameBuffer,
  scale: number,
  background = "#0a0a09",
): Uint8Array {
  const image = rasterize(buffer, scale, background);
  return encodeJpeg({ data: image.data, width: image.width, height: image.height }, 90)
    .data as unknown as Uint8Array;
}

export function frameToSvg(buffer: FrameBuffer, scale: ExportScale): string {
  const image = rasterize(buffer, 1);
  const rects: string[] = [];
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const offset = (y * buffer.width + x) * 4;
      const alpha = image.data[offset + 3] ?? 0;
      if (alpha === 0) continue;
      const r = image.data[offset] ?? 0;
      const g = image.data[offset + 1] ?? 0;
      const b = image.data[offset + 2] ?? 0;
      rects.push(
        `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="rgb(${r} ${g} ${b})"/>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${buffer.width * scale}" height="${buffer.height * scale}" shape-rendering="crispEdges" viewBox="0 0 ${buffer.width * scale} ${buffer.height * scale}">${rects.join("")}</svg>\n`;
}

export function zipFiles(files: Record<string, Uint8Array | string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, contents] of Object.entries(files)) {
    entries[name] = typeof contents === "string" ? strToU8(contents) : contents;
  }
  return zipSync(entries);
}

export {
  artboardToPng,
  artboardToJpg,
  encodeArtboard,
  artboardBytes,
  type ArtboardFormat,
} from "./artboard.js";

export { framesToGif, type GifFrame } from "./gif.js";
export { framesToApng, type ApngFrame } from "./apng.js";
export {
  framesToSheet,
  type AtlasFrame,
  type SheetAtlas,
  type SheetFrame,
  type SheetOptions,
  type SheetResult,
} from "./sheet.js";

export { sheetToAsepriteJson, type AsepriteJson, type AsepriteTag } from "./aseprite.js";

export { atlasForEngine, atlasPresets, type AtlasPreset } from "./atlas-presets.js";

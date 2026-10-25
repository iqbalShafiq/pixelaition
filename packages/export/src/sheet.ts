import {
  hexToRgba,
  renderFrame,
  type FrameBuffer,
  type FrameTag,
  type Slice,
} from "@pixelaition/pixel";
import { PNG } from "pngjs";

export type SheetFrame = {
  name: string;
  buffer: FrameBuffer;
  durationMs?: number;
};

export type SheetOptions = {
  columns?: number;
  padding?: number;
  margin?: number;
  scale?: number;
  background?: string;
  imageName?: string;
  slices?: Slice[];
};

export type AtlasFrame = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  durationMs: number;
};

export type SheetAtlas = {
  format: "pixelaition-atlas";
  version: 1;
  image: string;
  width: number;
  height: number;
  scale: number;
  frames: AtlasFrame[];
  tags: FrameTag[];
  slices: Slice[];
};

export type SheetResult = {
  png: Uint8Array;
  atlas: SheetAtlas;
  columns: number;
  rows: number;
};

/**
 * Compose frames into a grid and return both the PNG and an atlas whose rects
 * are the exact source of the pixels. The grid is intentionally simple; a
 * packed layout can be layered on later without changing the atlas contract.
 */
export function framesToSheet(
  frames: SheetFrame[],
  tags: FrameTag[] = [],
  options: SheetOptions = {},
): SheetResult {
  if (frames.length === 0) throw new Error("A sprite sheet needs at least one frame.");
  const scale = options.scale ?? 1;
  const padding = Math.max(0, Math.round(options.padding ?? 0));
  const margin = Math.max(0, Math.round(options.margin ?? 0));
  const rendered = frames.map((frame) => ({
    ...frame,
    image: renderFrame(frame.buffer, { scale }),
  }));
  const cellWidth = Math.max(...rendered.map((frame) => frame.image.width));
  const cellHeight = Math.max(...rendered.map((frame) => frame.image.height));
  const columns = Math.max(
    1,
    Math.min(
      frames.length,
      Math.round(options.columns ?? Math.ceil(Math.sqrt(frames.length))),
    ),
  );
  const rows = Math.ceil(frames.length / columns);
  const width = margin * 2 + columns * cellWidth + Math.max(0, columns - 1) * padding;
  const height = margin * 2 + rows * cellHeight + Math.max(0, rows - 1) * padding;
  const image = new PNG({ width, height });
  if (options.background) {
    const [r, g, b, a] = hexToRgba(options.background);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  }
  const atlasFrames: AtlasFrame[] = [];
  rendered.forEach((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cellWidth + padding);
    const y = margin + row * (cellHeight + padding);
    for (let sourceY = 0; sourceY < frame.image.height; sourceY += 1) {
      for (let sourceX = 0; sourceX < frame.image.width; sourceX += 1) {
        const source = (sourceY * frame.image.width + sourceX) * 4;
        const target = ((y + sourceY) * width + x + sourceX) * 4;
        image.data[target] = frame.image.data[source] ?? 0;
        image.data[target + 1] = frame.image.data[source + 1] ?? 0;
        image.data[target + 2] = frame.image.data[source + 2] ?? 0;
        image.data[target + 3] = frame.image.data[source + 3] ?? 0;
      }
    }
    atlasFrames.push({
      name: frame.name,
      x,
      y,
      width: frame.image.width,
      height: frame.image.height,
      sourceWidth: frame.buffer.width,
      sourceHeight: frame.buffer.height,
      durationMs: Math.max(10, Math.round(frame.durationMs ?? 100)),
    });
  });
  return {
    png: PNG.sync.write(image) as unknown as Uint8Array,
    atlas: {
      format: "pixelaition-atlas",
      version: 1,
      image: options.imageName ?? "sheet.png",
      width,
      height,
      scale,
      frames: atlasFrames,
      tags,
      slices: options.slices ?? [],
    },
    columns,
    rows,
  };
}

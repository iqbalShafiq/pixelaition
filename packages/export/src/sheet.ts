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
  /** Shelf-pack non-uniform frames instead of a fixed grid. */
  packed?: boolean;
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
  layout: "grid" | "packed";
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
  const packed = options.packed ?? false;
  const placements: Array<{ x: number; y: number }> = [];
  let width = 0;
  let height = 0;
  let columns = 0;
  let rows = 0;
  if (packed) {
    const area = rendered.reduce(
      (sum, frame) => sum + frame.image.width * frame.image.height,
      0,
    );
    const shelfWidth = Math.max(cellWidth, Math.ceil(Math.sqrt(area)) + padding * 2);
    let x = margin;
    let y = margin;
    let shelfHeight = 0;
    let right = margin;
    for (const frame of rendered) {
      const frameWidth = frame.image.width;
      if (x > margin && x + frameWidth > shelfWidth + margin) {
        y += shelfHeight + padding;
        x = margin;
        shelfHeight = 0;
      }
      placements.push({ x, y });
      x += frameWidth + padding;
      shelfHeight = Math.max(shelfHeight, frame.image.height);
      right = Math.max(right, x - padding);
    }
    width = right + margin;
    height = y + shelfHeight + margin;
  } else {
    columns = Math.max(
      1,
      Math.min(
        frames.length,
        Math.round(options.columns ?? Math.ceil(Math.sqrt(frames.length))),
      ),
    );
    rows = Math.ceil(frames.length / columns);
    width = margin * 2 + columns * cellWidth + Math.max(0, columns - 1) * padding;
    height = margin * 2 + rows * cellHeight + Math.max(0, rows - 1) * padding;
  }
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
    const placement = placements[index];
    const column = index % Math.max(1, columns);
    const row = Math.floor(index / Math.max(1, columns));
    const x = placement?.x ?? margin + column * (cellWidth + padding);
    const y = placement?.y ?? margin + row * (cellHeight + padding);
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
      layout: packed ? "packed" : "grid",
    },
    columns,
    rows,
  };
}

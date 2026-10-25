import type { FrameBuffer, Slice } from "@pixelaition/pixel";

export type TilemapJson = {
  version: 1;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tileset: Array<{
    index: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  layers: Array<{
    name: string;
    data: number[];
  }>;
};

/**
 * Recover a tile-index map from baked pixels. A cell is -1 when no slice
 * matches it exactly, so a map never silently claims a tile it cannot identify.
 */
export function frameToTilemapJson(buffer: FrameBuffer, slices: Slice[]): TilemapJson {
  const first = slices[0];
  if (!first || first.width < 1 || first.height < 1) {
    throw new Error("A tilemap export needs at least one slice.");
  }
  const tileWidth = first.width;
  const tileHeight = first.height;
  if (buffer.width % tileWidth !== 0 || buffer.height % tileHeight !== 0) {
    throw new Error(
      `The canvas is ${buffer.width}×${buffer.height}; a ${tileWidth}×${tileHeight} tile does not divide it.`,
    );
  }
  const candidates = slices.filter(
    (slice) =>
      slice.width === tileWidth &&
      slice.height === tileHeight &&
      slice.x + slice.width <= buffer.width &&
      slice.y + slice.height <= buffer.height,
  );
  const columns = buffer.width / tileWidth;
  const rows = buffer.height / tileHeight;
  const cell = (layer: { pixels: Uint8Array }, x: number, y: number) => {
    const pixels: number[] = [];
    for (let row = 0; row < tileHeight; row += 1) {
      for (let column = 0; column < tileWidth; column += 1) {
        pixels.push(layer.pixels[(y + row) * buffer.width + x + column] ?? 0);
      }
    }
    for (const [index, slice] of candidates.entries()) {
      let matches = true;
      for (let row = 0; row < tileHeight && matches; row += 1) {
        for (let column = 0; column < tileWidth; column += 1) {
          if (
            (layer.pixels[(slice.y + row) * buffer.width + slice.x + column] ?? 0) !==
            pixels[row * tileWidth + column]
          ) {
            matches = false;
            break;
          }
        }
      }
      if (matches) return index;
    }
    return -1;
  };
  return {
    version: 1,
    width: columns,
    height: rows,
    tileWidth,
    tileHeight,
    tileset: candidates.map((slice, index) => ({
      index,
      name: slice.name,
      x: slice.x,
      y: slice.y,
      width: slice.width,
      height: slice.height,
    })),
    layers: buffer.layers.map((layer) => {
      const data: number[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          data.push(cell(layer, column * tileWidth, row * tileHeight));
        }
      }
      return { name: layer.name, data };
    }),
  };
}

import { readCell, writeCell, type FrameBuffer, type Slice } from "@pixelaition/pixel";

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
        pixels.push(readCell(layer.pixels, (y + row) * buffer.width + x + column));
      }
    }
    for (const [index, slice] of candidates.entries()) {
      let matches = true;
      for (let row = 0; row < tileHeight && matches; row += 1) {
        for (let column = 0; column < tileWidth; column += 1) {
          if (
            readCell(layer.pixels, (slice.y + row) * buffer.width + slice.x + column) !==
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
      if (
        layer.tilemap &&
        layer.tilemap.tileWidth === tileWidth &&
        layer.tilemap.tileHeight === tileHeight &&
        layer.tilemap.data.length === columns * rows
      ) {
        return { name: layer.name, data: [...layer.tilemap.data] };
      }
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

/**
 * Paint a tile-index map back into a frame using the tileset rectangles that
 * frameToTilemapJson recorded. A -1 cell clears its cell; a missing layer or
 * out-of-range tile is an error rather than a guessed tile.
 */
export function applyTilemap(buffer: FrameBuffer, map: TilemapJson): FrameBuffer {
  if (
    map.width * map.tileWidth !== buffer.width ||
    map.height * map.tileHeight !== buffer.height
  ) {
    throw new Error(
      `The tilemap is ${map.width}×${map.height} cells of ${map.tileWidth}×${map.tileHeight}; that does not match ${buffer.width}×${buffer.height}.`,
    );
  }
  const layers = new Map(buffer.layers.map((layer) => [layer.name, layer]));
  for (const target of map.layers) {
    const layer = layers.get(target.name);
    if (!layer) throw new Error(`The tilemap names a missing layer: ${target.name}.`);
    if (target.data.length !== map.width * map.height) {
      throw new Error(`Layer ${target.name} does not have one tile per cell.`);
    }
    const source = layer.pixels.slice();
    for (let cell = 0; cell < target.data.length; cell += 1) {
      const tileIndex = target.data[cell] ?? -1;
      const cellX = (cell % map.width) * map.tileWidth;
      const cellY = Math.floor(cell / map.width) * map.tileHeight;
      if (tileIndex === -1) {
        for (let row = 0; row < map.tileHeight; row += 1) {
          for (let column = 0; column < map.tileWidth; column += 1) {
            writeCell(layer.pixels, (cellY + row) * buffer.width + cellX + column, 0);
          }
        }
        continue;
      }
      const tile = map.tileset[tileIndex];
      if (!tile) throw new Error(`Tile index ${tileIndex} is outside the tileset.`);
      if (
        tile.width !== map.tileWidth ||
        tile.height !== map.tileHeight ||
        tile.x + tile.width > buffer.width ||
        tile.y + tile.height > buffer.height
      ) {
        throw new Error(`Tile ${tile.name} does not fit the map cell.`);
      }
      for (let row = 0; row < map.tileHeight; row += 1) {
        for (let column = 0; column < map.tileWidth; column += 1) {
          writeCell(
            layer.pixels,
            (cellY + row) * buffer.width + cellX + column,
            readCell(source, (tile.y + row) * buffer.width + tile.x + column),
          );
        }
      }
    }
  }
  return { ...buffer, layers: [...buffer.layers] };
}

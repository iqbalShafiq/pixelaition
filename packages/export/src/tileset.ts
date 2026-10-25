import { renderFrame, type FrameBuffer } from "@pixelaition/pixel";
import { PNG } from "pngjs";

export type TilesetTile = {
  name: string;
  index: number;
  column: number;
  row: number;
  width: number;
  height: number;
};

export type TilesetResult = {
  tiles: Record<string, Uint8Array>;
  meta: {
    format: "pixelaition-tileset";
    version: 1;
    tileWidth: number;
    tileHeight: number;
    columns: number;
    rows: number;
    tiles: TilesetTile[];
  };
};

/**
 * Cut one frame into same-size tiles. This is the packaging half of a tileset;
 * the map format stays a separate concern.
 */
export function frameToTileset(
  buffer: FrameBuffer,
  tileWidth: number,
  tileHeight: number,
  name = "tile",
): TilesetResult {
  if (tileWidth < 1 || tileHeight < 1) throw new Error("A tile needs a positive size.");
  if (buffer.width % tileWidth !== 0 || buffer.height % tileHeight !== 0) {
    throw new Error(
      `A ${buffer.width}×${buffer.height} frame does not divide into ${tileWidth}×${tileHeight} tiles.`,
    );
  }
  const image = renderFrame(buffer);
  const columns = buffer.width / tileWidth;
  const rows = buffer.height / tileHeight;
  const tiles: Record<string, Uint8Array> = {};
  const metaTiles: TilesetTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const tile = new PNG({ width: tileWidth, height: tileHeight });
      for (let y = 0; y < tileHeight; y += 1) {
        for (let x = 0; x < tileWidth; x += 1) {
          const source =
            ((row * tileHeight + y) * image.width + column * tileWidth + x) * 4;
          const target = (y * tileWidth + x) * 4;
          tile.data[target] = image.data[source] ?? 0;
          tile.data[target + 1] = image.data[source + 1] ?? 0;
          tile.data[target + 2] = image.data[source + 2] ?? 0;
          tile.data[target + 3] = image.data[source + 3] ?? 0;
        }
      }
      const tileName = `${name}-${column}-${row}.png`;
      tiles[tileName] = PNG.sync.write(tile) as unknown as Uint8Array;
      metaTiles.push({
        name: tileName,
        index: row * columns + column,
        column,
        row,
        width: tileWidth,
        height: tileHeight,
      });
    }
  }
  return {
    tiles,
    meta: {
      format: "pixelaition-tileset",
      version: 1,
      tileWidth,
      tileHeight,
      columns,
      rows,
      tiles: metaTiles,
    },
  };
}

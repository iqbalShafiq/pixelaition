import { colorToHex, hexToColor, readCell } from "@pixelaition/pixel";

/**
 * One RLE string per row: `<#rrggbbaa>x<count>` runs joined by spaces.
 * Accepts either raw RGBA bytes or one packed colour per cell.
 */
export function encodeRowsRle(
  pixels: Uint8Array | Uint32Array | number[],
  width: number,
  height: number,
): string[] {
  const raw = pixels instanceof Uint8Array;
  const bytesPerCell = raw && pixels.length === width * height * 4;
  const colorAt = (cell: number) =>
    bytesPerCell ? readCell(pixels as Uint8Array, cell) : (pixels[cell] ?? 0);
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const runs: string[] = [];
    let color = "";
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const token = colorToHex(colorAt(y * width + x));
      if (token === color) {
        count += 1;
        continue;
      }
      if (count > 0) runs.push(`${color}x${count}`);
      color = token;
      count = 1;
    }
    if (count > 0) runs.push(`${color}x${count}`);
    rows.push(runs.join(" "));
  }
  return rows;
}

/** Decode RLE hex runs back into one packed RGBA value per cell. */
export function decodeRowsRle(
  rows: string[],
  width: number,
  height: number,
): Uint32Array {
  if (rows.length !== height) {
    throw new Error(
      `The rows hold ${rows.length} lines but the region is ${height} tall.`,
    );
  }
  const pixels = new Uint32Array(width * height);
  rows.forEach((row, y) => {
    let x = 0;
    for (const run of row
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)) {
      const [colorText, countText] = run.split("x");
      const count = Number(countText);
      const color = colorText?.startsWith("#")
        ? hexToColor(colorText)
        : Number(colorText);
      if (
        color === null ||
        !Number.isInteger(color) ||
        !Number.isInteger(count) ||
        count < 1
      ) {
        throw new Error(`Row ${y} has a run "${run}" that is not <colour>x<count>.`);
      }
      if (x + count > width) {
        throw new Error(`Row ${y} is longer than the region's width ${width}.`);
      }
      pixels.fill(color, y * width + x, y * width + x + count);
      x += count;
    }
    if (x !== width) {
      throw new Error(`Row ${y} covers ${x} pixels but the region is ${width} wide.`);
    }
  });
  return pixels;
}

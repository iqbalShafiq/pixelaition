/** One RLE string per row: `<color>x<count>` runs joined by spaces. */
export function encodeRowsRle(
  pixels: Uint8Array,
  width: number,
  height: number,
): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const runs: string[] = [];
    let color = -1;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x] ?? 0;
      if (value === color) {
        count += 1;
        continue;
      }
      if (count > 0) runs.push(`${color}x${count}`);
      color = value;
      count = 1;
    }
    if (count > 0) runs.push(`${color}x${count}`);
    rows.push(runs.join(" "));
  }
  return rows;
}

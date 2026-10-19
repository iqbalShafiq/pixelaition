/** Palette entries are normalised hex, so a fixed-width parse is enough. */
export function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace("#", "");
  if (value.length === 8) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      Number.parseInt(value.slice(6, 8), 16),
    ];
  }
  if (value.length === 6) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      255,
    ];
  }
  return [0, 0, 0, 255];
}

export function readableOn(hex: string): "#0b0906" | "#f1efe9" {
  const [r, g, b] = hexToRgba(hex);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.35 ? "#0b0906" : "#f1efe9";
}

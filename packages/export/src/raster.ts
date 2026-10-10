import { composite, type FrameBuffer } from "@pixelaition/pixel";

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.slice(1);
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const a = value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

export function rasterize(
  buffer: FrameBuffer,
  scale: number,
  background?: string,
): RgbaImage {
  const indices = composite(buffer);
  const width = buffer.width * scale;
  const height = buffer.height * scale;
  const data = new Uint8Array(width * height * 4);
  const backdrop = background ? hexToRgba(background) : null;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const colorIndex = indices[y * buffer.width + x] ?? 0;
      const source = buffer.palette[colorIndex] ?? "#00000000";
      let [r, g, b, a] = hexToRgba(colorIndex === 0 ? "#00000000" : source);
      if (backdrop && a < 255) {
        const alpha = a / 255;
        r = Math.round(r * alpha + backdrop[0] * (1 - alpha));
        g = Math.round(g * alpha + backdrop[1] * (1 - alpha));
        b = Math.round(b * alpha + backdrop[2] * (1 - alpha));
        a = 255;
      }
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = ((y * scale + dy) * width + (x * scale + dx)) * 4;
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = a;
        }
      }
    }
  }
  return { width, height, data };
}

import { describe, expect, it } from "vitest";
import type { FrameBuffer } from "@pixelaition/pixel";
import { paintedBounds } from "./sprite-flight.js";

function buffer(width: number, height: number, pixels: number[]): FrameBuffer {
  const layer = new Uint8Array(width * height);
  for (const [index, value] of pixels.entries()) {
    layer[index] = value;
  }
  return {
    width,
    height,
    palette: ["#00000000", "#a7f070", "#ef7d57"],
    layers: [{ id: "l", name: "pixels", visible: true, pixels: layer }],
  };
}

describe("paintedBounds", () => {
  it("returns the tight box around the painted pixels", () => {
    const doc = buffer(4, 4, [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0]);
    expect(paintedBounds(doc)).toEqual({ x: 1, y: 1, width: 2, height: 3 });
  });

  it("is null for an empty frame", () => {
    expect(paintedBounds(buffer(3, 3, Array(9).fill(0)))).toBeNull();
  });

  it("ignores hidden layers", () => {
    const doc = buffer(2, 2, [0, 0, 0, 2]);
    doc.layers[0]!.visible = false;
    expect(paintedBounds(doc)).toBeNull();
  });
});

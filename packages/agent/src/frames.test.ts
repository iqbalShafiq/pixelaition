import { describe, expect, it } from "vitest";
import { createBuffer, createId } from "@pixelaition/pixel";
import {
  copyLayers,
  layerOf,
  paletteMapping,
  readRegion,
  stampRegion,
  toFrameBuffer,
} from "./frames.js";
import type { FrameView } from "./frames.js";

function view(
  palette: string[],
  layers: Array<{ name: string; pixels: Array<[number, number, number]> }>,
): FrameView {
  const width = 8;
  const height = 8;
  return {
    assetId: "asset-1",
    assetName: "slime",
    frameId: "frame-1",
    frameName: "idle",
    width,
    height,
    palette,
    layers: layers.map((layer) => {
      const pixels = new Uint8Array(width * height);
      for (const [x, y, color] of layer.pixels) pixels[y * width + x] = color;
      return { id: createId(), name: layer.name, visible: true, pixels };
    }),
  };
}

const PALETTE = ["#00000000", "#1a1c2c", "#f4efe4"];

describe("palette mapping", () => {
  it("passes indices through when the palettes match", () => {
    const mapping = paletteMapping(PALETTE, PALETTE);
    expect(mapping.ok && [0, 1, 2].map(mapping.indexOf)).toEqual([0, 1, 2]);
  });

  it("maps by hex when the target orders colours differently", () => {
    const mapping = paletteMapping(PALETTE, ["#00000000", "#f4efe4", "#1a1c2c"]);
    expect(mapping.ok && [1, 2].map(mapping.indexOf)).toEqual([2, 1]);
  });

  it("names every colour the target palette cannot hold, with a suggested map", () => {
    const mapping = paletteMapping(PALETTE, ["#00000000", "#ff0000"]);
    expect(mapping.ok).toBe(false);
    if (mapping.ok) return;
    expect(mapping.unmapped).toEqual(["#1a1c2c", "#f4efe4"]);
    expect(mapping.suggestion.map((entry) => entry.hex)).toEqual(["#1a1c2c", "#f4efe4"]);
  });

  it("takes an explicit map, and refuses an index that is not in the palette", () => {
    const mapping = paletteMapping(
      PALETTE,
      ["#00000000", "#ff0000"],
      [
        { hex: "#1a1c2c", to: 1 },
        { hex: "#f4efe4", to: 9 },
      ],
    );
    expect(mapping.ok).toBe(false);
    if (mapping.ok) return;
    expect(mapping.unmapped[0]).toContain("not an index");
  });
});

describe("region transfer", () => {
  it("reads a rectangle out of a layer and stamps it into another frame", () => {
    const source = view(PALETTE, [
      {
        name: "body",
        pixels: [
          [1, 1, 1],
          [2, 1, 2],
          [1, 2, 1],
          [2, 2, 2],
        ],
      },
    ]);
    const copied = readRegion(source, { x: 1, y: 1, width: 2, height: 2 }, "body");
    expect([...copied.pixels]).toEqual([1, 2, 1, 2]);

    const target = createBuffer({ width: 8, height: 8, palette: PALETTE });
    const layerId = target.layers[0]?.id ?? "";
    const stamped = stampRegion(target, {
      layerId,
      x: 4,
      y: 4,
      width: 2,
      height: 2,
      pixels: copied.pixels,
      mapping: paletteMapping(source.palette, target.palette),
    });
    expect(stamped.ok).toBe(true);
    const pixels = stamped.ok ? stamped.buffer.layers[0]!.pixels : new Uint8Array();
    expect([pixels[4 * 8 + 4], pixels[4 * 8 + 5]]).toEqual([1, 2]);
  });

  it("refuses a region outside the frame with the frame's size named", () => {
    const source = view(PALETTE, [{ name: "body", pixels: [] }]);
    expect(() => readRegion(source, { x: 6, y: 6, width: 4, height: 1 })).toThrow(
      /outside idle \(8×8\)/,
    );
  });

  it("refuses a copy across palettes that differ instead of remapping silently", () => {
    const target = createBuffer({
      width: 8,
      height: 8,
      palette: ["#00000000", "#ff0000"],
    });
    const layerId = target.layers[0]?.id ?? "";
    expect(() =>
      stampRegion(target, {
        layerId,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        pixels: new Uint8Array([1]),
        mapping: paletteMapping(PALETTE, target.palette),
      }),
    ).toThrow(/not in this asset's palette/);
  });

  it("copies a whole layer into a frame, keeping an existing layer by name", () => {
    const source = view(PALETTE, [
      {
        name: "body",
        pixels: [
          [0, 0, 1],
          [1, 0, 2],
        ],
      },
    ]);
    const target = createBuffer({ width: 8, height: 8, palette: PALETTE });
    const copied = copyLayers(target, source, [{ name: "body" }]);
    expect(copied.layers.map((layer) => layer.name)).toEqual(["pixels", "body"]);
    const body = copied.layers.find((layer) => layer.name === "body");
    expect([body?.pixels[0], body?.pixels[1]]).toEqual([1, 2]);
  });

  it("reads a layer by name and the composite when no layer is named", () => {
    const source = view(PALETTE, [{ name: "body", pixels: [[0, 0, 2]] }]);
    expect(layerOf(source, "body")?.layerName).toBe("body");
    expect(layerOf(source)?.layerName).toBe("(composite)");
    expect(toFrameBuffer(source).width).toBe(8);
    expect(layerOf(source, undefined)?.pixels[0]).toBe(2);
  });
});

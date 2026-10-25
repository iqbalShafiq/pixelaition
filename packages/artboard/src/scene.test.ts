import { describe, expect, it } from "vitest";
import { checkScene } from "./checks.js";
import { renderScene } from "./render.js";
import { upgradeScene } from "./scene.js";
import type { ArtboardScene, FormatPreset } from "./types.js";

const palette = ["#00000000", "#101010ff", "#d8a64eff"];

const preset: FormatPreset = {
  id: "test",
  platform: "Test",
  group: "post",
  label: "Test",
  width: 2,
  height: 2,
  pixelUnit: 1,
  minTextSize: 4,
  maxBytes: null,
  shape: "rect",
  safeZones: [],
  crops: [],
  exclusions: [],
  defaultTemplate: "blank",
  notes: [],
  source: "test",
  verifiedAt: "2026-01-01",
  official: false,
};

function scene(color: number): ArtboardScene {
  return {
    version: 2,
    background: { kind: "transparent" },
    elements: [{ id: "block", kind: "rect", x: 0, y: 0, width: 2, height: 2, color }],
  };
}

describe("RGBA artboard scenes", () => {
  it("renders a colour that is not in the palette exactly", () => {
    const result = renderScene({ scene: scene(0x12345678), preset, palette });
    expect([...result.image.rgba.subarray(0, 4)]).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(checkScene({ scene: scene(0x12345678), preset, palette })).toEqual([]);
  });

  it("upgrades a version-1 palette index through the asset palette", () => {
    const upgraded = upgradeScene(
      {
        ...scene(0),
        version: 1,
        elements: [{ ...scene(0).elements[0]!, color: 2 } as never],
      },
      palette,
    );
    expect(upgraded.version).toBe(2);
    expect(upgraded.elements[0]).toMatchObject({ color: 0xd8a64eff });
  });
});

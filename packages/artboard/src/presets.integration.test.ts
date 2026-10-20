import { describe, expect, it } from "vitest";
import { createBuffer } from "@pixelaition/pixel";
import {
  buildTemplateScene,
  checkScene,
  formatPresets,
  getPreset,
  summarizeChecks,
  type SpriteSource,
} from "./index.js";

function sprite(): SpriteSource {
  const buffer = createBuffer({ width: 32, height: 32 });
  for (let y = 4; y < 28; y += 1) {
    for (let x = 4; x < 28; x += 1) {
      buffer.layers[0]!.pixels[y * 32 + x] = 2;
    }
  }
  return {
    assetId: "asset",
    assetName: "mark",
    frameId: "frame",
    frameName: "idle",
    buffer,
  };
}

describe("format presets and default templates", () => {
  it("builds every preset inside its safe area with realistic copy", () => {
    const source = sprite();
    const palette = source.buffer.palette;
    const copy = {
      eyebrow: "PIXELAITION",
      headline: "Ship your pixel world",
      subhead: "One mark, every feed.",
      cta: "Make yours",
      handle: "@pixelaition",
    };
    const failures: string[] = [];
    for (const preset of formatPresets) {
      const scene = buildTemplateScene({
        preset,
        template: preset.defaultTemplate,
        copy,
        palette,
        sprite: source,
      });
      const checks = checkScene({
        scene,
        preset,
        palette,
        sprites: new Map([["asset:frame", source]]),
      });
      const summary = summarizeChecks(checks);
      if (summary.errors > 0) {
        failures.push(
          `${preset.id} (${preset.defaultTemplate}): ${checks
            .filter((check) => check.severity === "error")
            .map((check) => `${check.code} ${check.message}`)
            .join(" | ")}`,
        );
      }
    }
    console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });

  it("keeps every preset dimension present and positive", () => {
    for (const preset of formatPresets) {
      expect(getPreset(preset.id)).toBe(preset);
      expect(preset.width).toBeGreaterThan(0);
      expect(preset.height).toBeGreaterThan(0);
      expect(preset.pixelUnit).toBeGreaterThan(0);
    }
  });
});

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

describe("shared copy refit", () => {
  it("shrinks a cover headline instead of growing into the subhead", async () => {
    const { buildTemplateScene, syncCopyScene, layoutText } = await import("./index.js");
    const preset = getPreset("facebook-cover");
    const scene = buildTemplateScene({
      preset,
      template: "split-copy",
      copy: { headline: "Orbit", subhead: "One mark, every feed.", cta: "Make yours" },
      palette: ["#00000000", "#0b0906", "#f1efe9", "#d8a64e"],
    });
    const before = scene.elements.find(
      (element) => element.kind === "text" && element.id === "headline",
    );
    if (!before || before.kind !== "text") throw new Error("no headline");
    const synced = syncCopyScene(scene, {
      headline: "Orbit, everywhere your crew already is",
      subhead: "One mark, every feed.",
      cta: "Make yours",
    });
    const after = synced.elements.find(
      (element) => element.kind === "text" && element.id === "headline",
    );
    if (!after || after.kind !== "text") throw new Error("no synced headline");
    expect(after.size).toBeLessThanOrEqual(before.size);
    const subhead = synced.elements.find(
      (element) => element.kind === "text" && element.id === "subhead",
    );
    if (!subhead || subhead.kind !== "text") throw new Error("no subhead");
    expect(after.y + layoutText(after).height).toBeLessThanOrEqual(subhead.y);
  });
});

describe("long shared copy", () => {
  it("does not overflow a text box on any default format after a copy update", async () => {
    const { syncCopyScene, checkScene } = await import("./index.js");
    const source = sprite();
    const palette = source.buffer.palette;
    const failures: string[] = [];
    for (const preset of formatPresets) {
      const scene = buildTemplateScene({
        preset,
        template: preset.defaultTemplate,
        copy: {
          eyebrow: "PIXELAITION",
          headline: "Orbit",
          subhead: "One mark, every feed.",
          cta: "Make yours",
          handle: "@pixelaition",
        },
        palette,
        sprite: source,
      });
      const synced = syncCopyScene(scene, {
        eyebrow: "PIXELAITION LAUNCH",
        headline: "Orbit, everywhere your crew already is",
        subhead: "One pixel mark for every feed, cover, thumbnail and story.",
        cta: "Start the launch",
        handle: "@pixelaition",
      });
      const checks = checkScene({
        scene: synced,
        preset,
        palette,
        sprites: new Map([["asset:frame", source]]),
      });
      const errors = checks.filter((check) => check.severity === "error");
      if (errors.length > 0) {
        failures.push(
          `${preset.id}: ${errors.map((check) => `${check.code} ${check.message}`).join(" | ")}`,
        );
      }
    }
    console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });

  it("builds every default template directly with long copy and no errors", async () => {
    const { checkScene } = await import("./index.js");
    const source = sprite();
    const palette = source.buffer.palette;
    const failures: string[] = [];
    for (const preset of formatPresets) {
      const scene = buildTemplateScene({
        preset,
        template: preset.defaultTemplate,
        copy: {
          eyebrow: "PIXELAITION LAUNCH",
          headline: "Orbit, everywhere your crew already is",
          subhead: "One pixel mark for every feed, cover, thumbnail and story.",
          cta: "Start the launch",
          handle: "@pixelaition",
        },
        palette,
        sprite: source,
      });
      const errors = checkScene({
        scene,
        preset,
        palette,
        sprites: new Map([["asset:frame", source]]),
      }).filter((check) => check.severity === "error");
      if (errors.length > 0) {
        failures.push(
          `${preset.id}: ${errors.map((check) => `${check.code} ${check.message}`).join(" | ")}`,
        );
      }
    }
    console.log(failures.join("\n"));
    expect(failures).toEqual([]);
  });
});

describe("registry integrity", () => {
  it("has unique ids and a valid default template", async () => {
    const { getPreset } = await import("./index.js");
    const ids = formatPresets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of formatPresets) {
      expect(getPreset(preset.id).id).toBe(preset.id);
      expect(preset.safeZones.length).toBeGreaterThan(0);
      expect(preset.width).toBeGreaterThan(0);
      expect(preset.height).toBeGreaterThan(0);
    }
  });
});

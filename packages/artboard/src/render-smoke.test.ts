import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createBuffer } from "@pixelaition/pixel";
import { PNG } from "pngjs";
import {
  buildTemplateScene,
  checkScene,
  getPreset,
  renderScene,
  toRgba,
  type SpriteSource,
} from "./index.js";

function sprite(): SpriteSource {
  const buffer = createBuffer({ width: 32, height: 32 });
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      buffer.layers[0]!.pixels[y * 32 + x] = 3;
    }
  }
  for (let y = 12; y < 20; y += 1) {
    for (let x = 12; x < 20; x += 1) {
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

describe("artboard render smoke", () => {
  it("renders a templated post with copy and a mark", () => {
    const preset = getPreset("instagram-post");
    const source = sprite();
    const scene = buildTemplateScene({
      preset,
      template: "split-copy",
      copy: {
        eyebrow: "PIXELAITION",
        headline: "Ship your pixel world",
        subhead: "One mark, every feed.",
        cta: "Try it",
        handle: "@pixelaition",
      },
      palette: source.buffer.palette,
      sprite: source,
    });
    const result = renderScene({
      scene,
      preset,
      palette: source.buffer.palette,
      sprites: new Map([["asset:frame", source]]),
    });
    const checks = checkScene({
      scene,
      preset,
      palette: source.buffer.palette,
      sprites: new Map([["asset:frame", source]]),
    });
    expect(result.image.width).toBe(1080);
    console.log(JSON.stringify(checks, null, 2));
    const png = new PNG({ width: result.image.width, height: result.image.height });
    png.data.set(toRgba(result.image));
    const encoded = PNG.sync.write(png);
    writeFileSync("/tmp/artboard-post.png", encoded);
    expect(encoded.length).toBeGreaterThan(0);
  });
});

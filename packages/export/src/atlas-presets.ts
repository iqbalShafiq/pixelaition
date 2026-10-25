import type { SheetResult } from "./sheet.js";

export const atlasPresets = ["native", "unity", "godot", "phaser"] as const;
export type AtlasPreset = (typeof atlasPresets)[number];

function tagsFor(sheet: SheetResult) {
  return sheet.atlas.tags.map((tag) => ({
    name: tag.name,
    from: tag.fromFrameId,
    to: tag.toFrameId,
    direction: tag.direction,
    loop: tag.loop,
  }));
}

/**
 * Engine-specific wrappers around the same rectangles. The image and the
 * frame positions never change; only the metadata dialect changes.
 */
export function atlasForEngine(sheet: SheetResult, preset: AtlasPreset): unknown {
  if (preset === "native") return sheet.atlas;
  const frames = sheet.atlas.frames;
  if (preset === "unity") {
    return {
      frames: frames.map((frame) => ({
        filename: frame.name,
        name: frame.name,
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
        sourceSize: { w: frame.sourceWidth, h: frame.sourceHeight },
        duration: frame.durationMs,
      })),
      meta: {
        app: "Pixelaition",
        version: "1.0",
        image: sheet.atlas.image,
        format: "RGBA8888",
        size: { w: sheet.atlas.width, h: sheet.atlas.height },
        scale: String(sheet.atlas.scale),
        frameTags: tagsFor(sheet),
        slices: sheet.atlas.slices,
      },
    };
  }
  if (preset === "godot") {
    return {
      frames: Object.fromEntries(
        frames.map((frame) => [
          frame.name,
          {
            frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
            duration: frame.durationMs,
          },
        ]),
      ),
      meta: {
        image: sheet.atlas.image,
        size: { w: sheet.atlas.width, h: sheet.atlas.height },
        scale: String(sheet.atlas.scale),
        tags: tagsFor(sheet),
        slices: sheet.atlas.slices,
      },
    };
  }
  return {
    textures: [
      {
        image: sheet.atlas.image,
        frames: frames.map((frame) => ({
          filename: frame.name,
          frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
          sourceSize: { w: frame.sourceWidth, h: frame.sourceHeight },
          duration: frame.durationMs,
        })),
      },
    ],
    meta: {
      app: "Pixelaition",
      version: "1.0",
      size: { w: sheet.atlas.width, h: sheet.atlas.height },
      scale: String(sheet.atlas.scale),
      tags: tagsFor(sheet),
      slices: sheet.atlas.slices,
    },
  };
}

import type { SheetResult } from "./sheet.js";

export type AsepriteTag = {
  name: string;
  from: number;
  to: number;
  direction: "forward" | "reverse" | "pingpong";
};

export type AsepriteJson = {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: false;
      trimmed: false;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
      duration: number;
    }
  >;
  meta: {
    app: string;
    version: string;
    image: string;
    format: "RGBA8888";
    size: { w: number; h: number };
    scale: string;
    frameTags: Array<{ name: string; from: number; to: number; direction: string }>;
  };
};

/**
 * Aseprite's JSON spritesheet dialect. This is the interchange file Aseprite
 * itself exports and engines import; it is not the binary .ase format.
 */
export function sheetToAsepriteJson(
  sheet: SheetResult,
  tags: AsepriteTag[],
  imageName: string,
): AsepriteJson {
  const frames: AsepriteJson["frames"] = {};
  const used = new Map<string, number>();
  sheet.atlas.frames.forEach((frame) => {
    const count = used.get(frame.name) ?? 0;
    used.set(frame.name, count + 1);
    const key = count === 0 ? frame.name : `${frame.name} ${count}`;
    frames[key] = {
      frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
      sourceSize: { w: frame.sourceWidth, h: frame.sourceHeight },
      duration: frame.durationMs,
    };
  });
  return {
    frames,
    meta: {
      app: "https://pixelaition.local",
      version: "1.0",
      image: imageName,
      format: "RGBA8888",
      size: { w: sheet.atlas.width, h: sheet.atlas.height },
      scale: String(sheet.atlas.scale),
      frameTags: tags.map((tag) => ({
        name: tag.name,
        from: tag.from,
        to: tag.to,
        direction: tag.direction,
      })),
    },
  };
}

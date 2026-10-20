import { availableSizes, nearestSize } from "./font.js";
import { layoutText } from "./text.js";
import type {
  ArtboardScene,
  CopyDeck,
  FormatPreset,
  Rect,
  SpriteElement,
  SpriteSource,
  TemplateId,
  TextElement,
  TextFace,
  TextWeight,
} from "./types.js";
import { hexToRgba } from "./render.js";

export type TemplateInput = {
  preset: FormatPreset;
  template: TemplateId;
  copy: CopyDeck;
  palette: string[];
  sprite?: SpriteSource;
  spriteAssetId?: string;
  spriteFrameId?: string;
};

/**
 * Templates are slot layouts, not generated art. Code owns the geometry, so
 * an agent chooses a composition and fills copy instead of inventing a grid
 * that clips on one platform and not another.
 */
export function buildTemplateScene(input: TemplateInput): ArtboardScene {
  const { preset, template, palette } = input;
  const colors = paletteRoles(palette);
  const safe = preset.safeZones[0] ?? {
    id: "safe",
    label: "Safe area",
    x: Math.round(preset.width * 0.05),
    y: Math.round(preset.height * 0.05),
    width: Math.round(preset.width * 0.9),
    height: Math.round(preset.height * 0.9),
  };
  const background = { kind: "solid" as const, color: colors.background };
  if (template === "blank") return { version: 1, background, elements: [] };
  if (template === "profile-mark") {
    return profileTemplate(input, safe, colors);
  }
  if (template === "centered-mark") {
    return centeredMarkTemplate(input, safe, colors);
  }
  if (template === "thumbnail") {
    return thumbnailTemplate(input, safe, colors);
  }
  if (template === "split-copy") {
    return splitTemplate(input, safe, colors);
  }
  if (template === "stack-copy") {
    return stackTemplate(input, safe, colors);
  }
  if (template === "banner-copy") {
    return bannerTemplate(input, safe, colors);
  }
  return centeredCopyTemplate(input, safe, colors);
}

function profileTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  // A square mark inside a circle: the box is inscribed, not merely inset, or
  // the circle crop clips its corners.
  const side = Math.round(Math.min(safe.width, safe.height) * 0.7);
  const sprite = input.sprite
    ? makeSprite({
        input,
        box: {
          x: Math.round((input.preset.width - side) / 2),
          y: Math.round((input.preset.height - side) / 2),
          width: side,
          height: side,
        },
        anchor: "center",
        id: "mark",
      })
    : undefined;
  if (sprite) elements.push(sprite);
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function centeredMarkTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const headline = input.copy.headline ?? input.copy.eyebrow;
  const textHeight = headline ? Math.round(safe.height * 0.22) : 0;
  const spriteBox = {
    x: safe.x,
    y: safe.y,
    width: safe.width,
    height: Math.max(1, safe.height - textHeight),
  };
  const sprite = input.sprite
    ? makeSprite({ input, box: spriteBox, anchor: "center", id: "mark" })
    : undefined;
  if (sprite) elements.push(sprite);
  if (headline) {
    elements.push(
      makeText({
        id: "headline",
        text: headline,
        face: "silkscreen",
        weight: 700,
        color: colors.ink,
        box: {
          x: safe.x,
          y: safe.y + safe.height - textHeight,
          width: safe.width,
          height: textHeight,
        },
        align: "center",
        size: pickSize("silkscreen", 700, Math.round(safe.width * 0.08)),
        maxLines: 2,
      }),
    );
  }
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function centeredCopyTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const hasSprite = input.sprite !== undefined && input.preset.group !== "banner";
  const spriteHeight = hasSprite ? Math.round(safe.height * 0.34) : 0;
  if (hasSprite && input.sprite) {
    elements.push(
      makeSprite({
        input,
        box: {
          x: safe.x,
          y: safe.y + safe.height - spriteHeight,
          width: safe.width,
          height: spriteHeight,
        },
        anchor: "center",
        id: "mark",
      }),
    );
  }
  const copyHeight = safe.height - spriteHeight;
  const stack = copyStack(
    input,
    {
      x: safe.x,
      y: safe.y,
      width: safe.width,
      height: copyHeight,
    },
    colors,
    "center",
    Math.round(safe.width * 0.09),
  );
  elements.push(...stack);
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function splitTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const spriteShare = input.sprite ? 0.44 : 0;
  const copyWidth = Math.round(safe.width * (1 - spriteShare - 0.04));
  const copyRect = { x: safe.x, y: safe.y, width: copyWidth, height: safe.height };
  if (input.sprite) {
    elements.push(
      makeSprite({
        input,
        box: {
          x: safe.x + copyWidth + Math.round(safe.width * 0.04),
          y: safe.y,
          width: safe.width - copyWidth - Math.round(safe.width * 0.08),
          height: safe.height,
        },
        anchor: "center",
        id: "mark",
      }),
    );
  }
  const stack = copyStack(
    input,
    copyRect,
    colors,
    "left",
    Math.min(Math.round(safe.height * 0.22), Math.round(copyWidth * 0.13)),
  );
  elements.push(...stack);
  if (stack.length > 0) {
    elements.push({
      id: "accent-rule",
      kind: "rect",
      x: safe.x,
      y: safe.y - Math.round(safe.height * 0.05),
      width: Math.round(copyWidth * 0.2),
      height: Math.max(2, Math.round(safe.height * 0.018)),
      color: colors.accent,
      safe: false,
    });
  }
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function stackTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const headline = input.copy.headline ?? input.copy.eyebrow;
  const subhead = input.copy.subhead;
  const headlineHeight = headline ? Math.round(safe.height * 0.26) : 0;
  if (headline) {
    elements.push(
      makeText({
        id: "headline",
        text: headline,
        face: "silkscreen",
        weight: 700,
        color: colors.ink,
        box: { x: safe.x, y: safe.y, width: safe.width, height: headlineHeight },
        align: "left",
        size: pickSize("silkscreen", 700, Math.round(safe.width * 0.11)),
        maxLines: 3,
      }),
    );
  }
  const bottomHeight = Math.round(safe.height * 0.32);
  const spriteTop = safe.y + headlineHeight + Math.round(safe.height * 0.03);
  const spriteBottom =
    safe.y + safe.height - bottomHeight - Math.round(safe.height * 0.03);
  if (input.sprite) {
    elements.push(
      makeSprite({
        input,
        box: {
          x: safe.x,
          y: spriteTop,
          width: safe.width,
          height: Math.max(1, spriteBottom - spriteTop),
        },
        anchor: "center",
        id: "mark",
      }),
    );
  }
  if (subhead || input.copy.cta || input.copy.handle) {
    const bottomBox = {
      x: safe.x,
      y: safe.y + safe.height - bottomHeight,
      width: safe.width,
      height: bottomHeight,
    };
    elements.push(
      ...copyStack(
        { ...input, copy: { ...input.copy, headline: undefined, eyebrow: undefined } },
        bottomBox,
        colors,
        "left",
        Math.round(bottomHeight * 0.45),
      ),
    );
  }
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function thumbnailTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const spriteShare = input.sprite ? 0.46 : 0;
  const copyWidth = Math.round(safe.width * (1 - spriteShare - 0.03));
  if (input.sprite) {
    elements.push(
      makeSprite({
        input,
        box: {
          x: safe.x + copyWidth + Math.round(safe.width * 0.03),
          y: safe.y,
          width: safe.width - copyWidth - Math.round(safe.width * 0.03),
          height: safe.height,
        },
        anchor: "center",
        id: "mark",
      }),
    );
  }
  elements.push(
    ...copyStack(
      input,
      { x: safe.x, y: safe.y, width: copyWidth, height: safe.height },
      colors,
      "left",
      Math.round(safe.height * 0.28),
    ),
  );
  elements.push({
    id: "accent-bar",
    kind: "rect",
    x: safe.x,
    y: safe.y,
    width: Math.max(4, Math.round(safe.width * 0.012)),
    height: safe.height,
    color: colors.accent,
    safe: false,
  });
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function bannerTemplate(
  input: TemplateInput,
  safe: Rect,
  colors: PaletteRoles,
): ArtboardScene {
  const elements: ArtboardScene["elements"] = [];
  const spriteShare = input.sprite ? 0.3 : 0;
  const copyWidth = Math.round(safe.width * (1 - spriteShare - 0.05));
  if (input.sprite) {
    elements.push(
      makeSprite({
        input,
        box: {
          x: safe.x + copyWidth + Math.round(safe.width * 0.05),
          y: safe.y,
          width: safe.width - copyWidth - Math.round(safe.width * 0.05),
          height: safe.height,
        },
        anchor: "center",
        id: "mark",
      }),
    );
  }
  elements.push(
    ...copyStack(
      input,
      { x: safe.x, y: safe.y, width: copyWidth, height: safe.height },
      colors,
      "left",
      Math.round(safe.height * 0.34),
    ),
  );
  return {
    version: 1,
    background: { kind: "solid", color: colors.background },
    elements,
  };
}

function copyStack(
  input: TemplateInput,
  box: Rect,
  colors: PaletteRoles,
  align: "left" | "center",
  headlineSize: number,
): ArtboardScene["elements"] {
  const elements: ArtboardScene["elements"] = [];
  const { copy } = input;
  const parts: Array<{
    id: string;
    text: string | undefined;
    face: TextFace;
    weight: TextWeight;
    color: number;
    share: number;
    maxLines: number;
  }> = [
    {
      id: "eyebrow",
      text: copy.eyebrow,
      face: "mono",
      weight: 400,
      color: colors.accent,
      share: 0.08,
      maxLines: 1,
    },
    {
      id: "headline",
      text: copy.headline,
      face: "silkscreen",
      weight: 700,
      color: colors.ink,
      share: 0.3,
      maxLines: 3,
    },
    {
      id: "subhead",
      text: copy.subhead,
      face: "pixelify",
      weight: 400,
      color: colors.muted,
      share: 0.28,
      maxLines: 3,
    },
    {
      id: "cta",
      text: copy.cta,
      face: "pixelify",
      weight: 600,
      color: colors.accent,
      share: 0.16,
      maxLines: 1,
    },
    {
      id: "handle",
      text: copy.handle,
      face: "mono",
      weight: 400,
      color: colors.muted,
      share: 0.18,
      maxLines: 1,
    },
  ];
  const visible = parts.filter((part) => (part.text ?? "").trim().length > 0);
  if (visible.length === 0) return elements;
  const weightTotal = visible.reduce((sum, part) => sum + part.share, 0);
  let y = box.y;
  for (const part of visible) {
    const height = Math.max(
      8,
      Math.floor((box.height * part.share) / Math.max(weightTotal, 0.001)),
    );
    const desired =
      part.id === "headline"
        ? headlineSize
        : part.id === "subhead"
          ? Math.max(24, Math.round(headlineSize * 0.5))
          : Math.max(22, Math.round(headlineSize * 0.55));
    const element = makeFittedText({
      id: part.id,
      text: part.text ?? "",
      face: part.face,
      weight: part.weight,
      color: part.color,
      box: { x: box.x, y, width: box.width, height },
      align,
      desired,
      maxLines: part.maxLines,
    });
    elements.push(element);
    y += height;
  }
  return elements;
}

/** Choose the largest atlas size that actually fits the slot. */
function makeFittedText(input: {
  id: string;
  text: string;
  face: TextFace;
  weight: TextWeight;
  color: number;
  box: Rect;
  align: "left" | "center" | "right";
  desired: number;
  maxLines: number;
}): TextElement {
  const sizes = availableSizes(input.face, input.weight)
    .filter((size) => size <= Math.max(8, input.desired))
    .sort((a, b) => b - a);
  const candidates: Array<{ size: number; scale: number; effective: number }> = [];
  for (const size of sizes) {
    const maxScale = Math.max(
      1,
      Math.min(8, Math.ceil(Math.max(8, input.desired) / Math.max(1, size))),
    );
    for (let scale = 1; scale <= maxScale; scale += 1) {
      candidates.push({ size, scale, effective: size * scale });
    }
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.effective - input.desired) - Math.abs(b.effective - input.desired) ||
      b.effective - a.effective,
  );
  let smallest: TextElement | undefined;
  for (const candidate of candidates) {
    const element = makeText({
      id: input.id,
      text: input.text,
      face: input.face,
      weight: input.weight,
      color: input.color,
      box: input.box,
      align: input.align,
      size: candidate.size,
      scale: candidate.scale,
      maxLines: input.maxLines,
      lineHeight: Math.round(
        candidate.size *
          (input.id === "headline" ? 1.15 : input.id === "subhead" ? 1.2 : 1.1),
      ),
    });
    const layout = layoutText(element);
    if (
      !smallest ||
      element.size * (element.scale ?? 1) < smallest.size * (smallest.scale ?? 1)
    ) {
      smallest = element;
    }
    if (
      layout.height <= input.box.height &&
      (input.maxLines === undefined || layout.lines.length <= input.maxLines)
    ) {
      return element;
    }
  }
  return (
    smallest ??
    makeText({ ...input, size: Math.max(8, input.box.height), maxLines: input.maxLines })
  );
}

function makeText(input: {
  id: string;
  text: string;
  face: TextFace;
  weight: TextWeight;
  color: number;
  box: Rect;
  align: "left" | "center" | "right";
  size: number;
  scale?: number;
  maxLines: number;
  lineHeight?: number;
}): TextElement {
  const spec = fontSpec(input.face, input.weight, input.size);
  const size = spec.size;
  const scale = input.scale ?? spec.scale;
  return {
    id: input.id,
    kind: "text",
    text: input.text.trim(),
    face: input.face,
    weight: input.weight,
    size,
    ...(scale > 1 ? { scale } : {}),
    color: input.color,
    x: input.box.x,
    y: input.box.y,
    width: input.box.width,
    height: input.box.height,
    align: input.align,
    lineHeight: input.lineHeight ?? Math.round(size * scale * 1.22),
    maxLines: input.maxLines,
  };
}

function makeSprite(input: {
  input: TemplateInput;
  box: Rect;
  anchor: SpriteElement["anchor"];
  id: string;
}): SpriteElement {
  const source = input.input.sprite;
  if (!source) throw new Error("A sprite element needs a sprite source.");
  const scale = Math.max(
    1,
    Math.min(
      64,
      Math.floor(
        Math.min(
          input.box.width / source.buffer.width,
          input.box.height / source.buffer.height,
        ),
      ),
    ),
  );
  const width = source.buffer.width * scale;
  const height = source.buffer.height * scale;
  const x =
    input.anchor === "center"
      ? input.box.x + Math.round((input.box.width - width) / 2)
      : input.box.x;
  const y =
    input.anchor === "center"
      ? input.box.y + Math.round((input.box.height - height) / 2)
      : input.box.y;
  return {
    id: input.id,
    kind: "sprite",
    assetId: input.input.spriteAssetId ?? source.assetId,
    ...((input.input.spriteFrameId ?? source.frameId)
      ? { frameId: input.input.spriteFrameId ?? source.frameId }
      : {}),
    x,
    y,
    scale,
    anchor: "top-left",
  };
}

function pickSize(face: TextFace, weight: TextWeight, desired: number): number {
  return fontSpec(face, weight, desired).size;
}

/**
 * A text size beyond the atlas is grown by whole pixels, never resampled. The
 * 4K thumbnail therefore uses the 128px atlas at 4×, keeping every glyph edge
 * on the same hard grid as the artwork.
 */
function fontSpec(
  face: TextFace,
  weight: TextWeight,
  desired: number,
): { size: number; scale: number } {
  const base = nearestSize(face, weight, desired);
  const scale = Math.max(1, Math.min(8, Math.round(desired / base)));
  return { size: base, scale };
}

type PaletteRoles = {
  background: number;
  ink: number;
  muted: number;
  accent: number;
};

/** Pick readable roles from the project's own palette, never a new colour. */
export function paletteRoles(palette: string[]): PaletteRoles {
  const candidates = palette
    .map((hex, index) => ({ hex, index, luminance: luminanceOf(hex) }))
    .filter((item) => item.index > 0 && item.luminance !== null);
  const darkest = [...candidates].sort(
    (a, b) => (a.luminance ?? 0) - (b.luminance ?? 0),
  )[0];
  const brightest = [...candidates].sort(
    (a, b) => (b.luminance ?? 0) - (a.luminance ?? 0),
  )[0];
  const background = darkest?.index ?? 1;
  const ink = brightest?.index ?? Math.min(2, Math.max(1, palette.length - 1));
  const accent =
    palette.findIndex((hex) => {
      const rgba = safeRgba(hex);
      return rgba !== null && rgba[0] > 180 && rgba[1] > 120 && rgba[2] < 110;
    }) || ink;
  const muted =
    candidates
      .filter((item) => item.index !== background && item.index !== ink)
      .sort(
        (a, b) =>
          Math.abs((a.luminance ?? 0) - 0.35) - Math.abs((b.luminance ?? 0) - 0.35),
      )[0]?.index ?? accent;
  return {
    background,
    ink: ink === background ? (accent === background ? 1 : accent) : ink,
    muted: muted === background ? accent : muted,
    accent: accent === background ? ink : accent,
  };
}

function luminanceOf(hex: string): number | null {
  const rgba = safeRgba(hex);
  if (!rgba || rgba[3] === 0) return null;
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2])
  );
}

function safeRgba(hex: string): [number, number, number, number] | null {
  try {
    return hexToRgba(hex);
  } catch {
    return null;
  }
}

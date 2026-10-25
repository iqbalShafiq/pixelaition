import { z } from "zod";
import type { FrameBuffer } from "@pixelaition/pixel";

/**
 * Social formats are composed at their native output size. A `color` is
 * always an index into the artboard's palette — the same palette the sprite
 * was drawn with — so a rendered artboard can never invent a hue, and pixel
 * text keeps the same binary, un-antialiased edge as the artwork.
 */
export type Rect = { x: number; y: number; width: number; height: number };

export type Zone = Rect & { id: string; label: string };

export type Crop = Rect & { id: string; label: string };

export type FormatPreset = {
  id: string;
  platform: string;
  group: "profile" | "cover" | "post" | "vertical" | "video" | "banner";
  label: string;
  width: number;
  height: number;
  /** Geometry is snapped to this many output pixels. */
  pixelUnit: number;
  /** The smallest text size this format can carry legibly. */
  minTextSize: number;
  /** Null means the platform accepts any size. */
  maxBytes: number | null;
  /** A format that is displayed through a circular crop. */
  shape: "rect" | "circle";
  safeZones: Zone[];
  crops: Crop[];
  exclusions: Zone[];
  defaultTemplate: TemplateId;
  notes: string[];
  source: string;
  verifiedAt: string;
  official: boolean;
};

export type Background =
  | { kind: "transparent" }
  | { kind: "solid"; color: number }
  | {
      kind: "pattern";
      colorA: number;
      colorB: number;
      unit: number;
      mode: "checker" | "50";
    };

export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type TextFace = "silkscreen" | "pixelify" | "mono";
export type TextWeight = 400 | 600 | 700;
export type TextAlign = "left" | "center" | "right";

export type SpriteElement = {
  id: string;
  kind: "sprite";
  assetId: string;
  frameId?: string;
  x: number;
  y: number;
  /** Integer only: a sprite never resamples to a fraction of a pixel. */
  scale: number;
  anchor: Anchor;
  /** Essential content must stay inside the format's safe area. */
  safe?: boolean;
  visible?: boolean;
};

export type TextElement = {
  id: string;
  kind: "text";
  text: string;
  face: TextFace;
  weight: TextWeight;
  /** A size from the face's atlas; `scale` grows it by whole pixels. */
  size: number;
  scale?: number;
  color: number;
  x: number;
  y: number;
  width: number;
  /** The slot height the template reserved; copy edits refit inside it. */
  height?: number;
  align: TextAlign;
  lineHeight?: number;
  maxLines?: number;
  letterSpacing?: number;
  /** Clockwise degrees around the text box centre. */
  rotation?: number;
  safe?: boolean;
  visible?: boolean;
};

export type RectElement = {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
  safe?: boolean;
  visible?: boolean;
};

export type PatternElement = {
  id: string;
  kind: "pattern";
  x: number;
  y: number;
  width: number;
  height: number;
  colorA: number;
  colorB: number;
  unit: number;
  mode: "checker" | "50";
  safe?: boolean;
  visible?: boolean;
};

export type FrameElement = {
  id: string;
  kind: "frame";
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  color: number;
  safe?: boolean;
  visible?: boolean;
};

export type Element =
  SpriteElement | TextElement | RectElement | PatternElement | FrameElement;

export type ElementKind = Element["kind"];

export type CopyDeck = {
  eyebrow?: string;
  headline?: string;
  subhead?: string;
  cta?: string;
  handle?: string;
  caption?: string;
  legal?: string;
};

export type CopyOverride = Partial<CopyDeck>;

export type ArtboardScene = {
  version: 1;
  background: Background;
  elements: Element[];
};

export type ArtboardStatus = "draft" | "ready" | "needs-fix";

export type Artboard = {
  id: string;
  setId: string;
  presetId: string;
  name: string;
  width: number;
  height: number;
  pixelUnit: number;
  scene: ArtboardScene;
  copyOverride: CopyOverride;
  status: ArtboardStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ArtboardSet = {
  id: string;
  projectId: string;
  assetId: string;
  name: string;
  copy: CopyDeck;
  createdAt: string;
  updatedAt: string;
};

export type SetWithArtboards = ArtboardSet & { artboards: Artboard[] };

export type PaletteImage = {
  width: number;
  height: number;
  /** Swatches used by `indices`; retained for old scene comparisons. */
  palette: string[];
  /** One palette index per pixel; index 0 is transparent. */
  indices: Uint8Array;
  /** The same image as straight RGBA bytes, four per pixel. */
  rgba: Uint8Array;
};

export type SpriteSource = {
  assetId: string;
  assetName: string;
  frameId: string;
  frameName: string;
  buffer: FrameBuffer;
};

export type RenderInput = {
  scene: ArtboardScene;
  preset: Pick<FormatPreset, "width" | "height">;
  palette: string[];
  sprites?: Map<string, SpriteSource>;
};

export type RenderResult = {
  image: PaletteImage;
  usedColors: number[];
};

export type CheckSeverity = "error" | "warning";

export type ArtboardCheck = {
  code:
    | "DIMENSION"
    | "EMPTY"
    | "SAFE_ZONE"
    | "CROP"
    | "EXCLUSION"
    | "TEXT_OVERFLOW"
    | "TEXT_TOO_SMALL"
    | "TEXT_SIZE"
    | "TEXT_GLYPH"
    | "CONTRAST"
    | "PALETTE"
    | "SPRITE_SCALE"
    | "SPRITE_MISSING"
    | "FILE_SIZE"
    | "COPY"
    | "VERSION";
  severity: CheckSeverity;
  message: string;
  elementId?: string;
};

export type TemplateId =
  | "blank"
  | "centered-mark"
  | "centered-copy"
  | "split-copy"
  | "stack-copy"
  | "thumbnail"
  | "banner-copy"
  | "profile-mark";

export const templateIds = [
  "blank",
  "centered-mark",
  "centered-copy",
  "split-copy",
  "stack-copy",
  "thumbnail",
  "banner-copy",
  "profile-mark",
] as const satisfies ReadonlyArray<TemplateId>;

export const anchors = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const satisfies ReadonlyArray<Anchor>;

export const textFaces = ["silkscreen", "pixelify", "mono"] as const;
export const textWeights = [400, 600, 700] as const;
export const textAligns = ["left", "center", "right"] as const;
export const backgroundModes = ["checker", "50"] as const;

const backgroundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transparent") }),
  z.object({ kind: z.literal("solid"), color: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("pattern"),
    colorA: z.number().int().nonnegative(),
    colorB: z.number().int().nonnegative(),
    unit: z.number().int().min(1).max(64),
    mode: z.enum(backgroundModes),
  }),
]);

const elementBase = {
  id: z.string().min(1).max(80),
  safe: z.boolean().optional(),
  visible: z.boolean().optional(),
};

const spriteElementSchema = z.object({
  ...elementBase,
  kind: z.literal("sprite"),
  assetId: z.string().min(1),
  frameId: z.string().min(1).optional(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  scale: z.number().int().min(1).max(64),
  anchor: z.enum(anchors),
});

const textElementSchema = z.object({
  ...elementBase,
  kind: z.literal("text"),
  text: z.string().min(1).max(2000),
  face: z.enum(textFaces),
  weight: z.union([z.literal(400), z.literal(600), z.literal(700)]),
  size: z.number().int().min(8).max(192),
  scale: z.number().int().min(1).max(8).optional(),
  color: z.number().int().nonnegative(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1).optional(),
  align: z.enum(textAligns),
  lineHeight: z.number().int().min(1).optional(),
  maxLines: z.number().int().min(1).max(50).optional(),
  letterSpacing: z.number().int().min(0).max(64).optional(),
});

const rectElementSchema = z.object({
  ...elementBase,
  kind: z.literal("rect"),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  color: z.number().int().nonnegative(),
});

const patternElementSchema = z.object({
  ...elementBase,
  kind: z.literal("pattern"),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  colorA: z.number().int().nonnegative(),
  colorB: z.number().int().nonnegative(),
  unit: z.number().int().min(1).max(64),
  mode: z.enum(backgroundModes),
});

const frameElementSchema = z.object({
  ...elementBase,
  kind: z.literal("frame"),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  thickness: z.number().int().min(1).max(64),
  color: z.number().int().nonnegative(),
});

export const sceneSchema = z.object({
  version: z.literal(1),
  background: backgroundSchema,
  elements: z.array(
    z.discriminatedUnion("kind", [
      spriteElementSchema,
      textElementSchema,
      rectElementSchema,
      patternElementSchema,
      frameElementSchema,
    ]),
  ),
});

export const copyDeckSchema = z.object({
  eyebrow: z.string().max(200).optional(),
  headline: z.string().max(400).optional(),
  subhead: z.string().max(600).optional(),
  cta: z.string().max(120).optional(),
  handle: z.string().max(120).optional(),
  caption: z.string().max(4000).optional(),
  legal: z.string().max(600).optional(),
});

export const copyOverrideSchema = copyDeckSchema.partial();

export const artboardInputSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  template: z.enum(templateIds).optional(),
  copy: copyDeckSchema.optional(),
});

export const artboardPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  scene: sceneSchema.optional(),
  copyOverride: copyOverrideSchema.optional(),
  status: z.enum(["draft", "ready", "needs-fix"]).optional(),
  version: z.number().int().min(1),
});

export const setPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  copy: copyDeckSchema.optional(),
});

export function frameKey(assetId: string, frameId: string): string {
  return `${assetId}:${frameId}`;
}

export function emptyScene(background: Background): ArtboardScene {
  return { version: 1, background, elements: [] };
}

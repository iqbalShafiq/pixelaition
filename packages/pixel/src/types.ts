export const MIN_SIZE = 8;
export const MAX_SIZE = 4096;
export const MAX_COLORS = 255;
export const TRANSPARENT = 0;
export const MAX_HISTORY = 100;

export const shadowDirections = ["up", "down", "left", "right"] as const;
export type ShadowDirection = (typeof shadowDirections)[number];

/**
 * The blend modes a layer can name. The renderer owns the maths; the document
 * only carries the name so an unknown mode never silently becomes "normal".
 */
export const blendModes = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "add",
  "subtract",
  "darken",
  "lighten",
  "difference",
  "exclusion",
  "hard-light",
  "soft-light",
  "color-dodge",
  "color-burn",
] as const;
export type BlendMode = (typeof blendModes)[number];

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === "string" && (blendModes as readonly string[]).includes(value);
}

export type StyleGuide = {
  defaultWidth: number;
  defaultHeight: number;
  outline: string;
  shadowDirection: ShadowDirection;
  notes: string;
};

export type TextLayerSpec = {
  text: string;
  face: "silkscreen" | "pixelify" | "mono";
  weight: 400 | 700;
  size: number;
  color: number;
  x: number;
  y: number;
  width: number;
  align: "left" | "center" | "right";
  lineHeight?: number;
  maxLines?: number;
  letterSpacing?: number;
  scale?: number;
  height?: number;
  /** Clockwise degrees around the text box centre. */
  rotation?: number;
};

export type LayerGroup = {
  id: string;
  name: string;
  visible: boolean;
  /** 0–1; 1 means the group does not change its children's alpha. */
  opacity?: number;
  parentGroupId?: string;
};

export type TilemapMetadata = {
  tileWidth: number;
  tileHeight: number;
  /** One slice index per cell; -1 means empty. */
  data: number[];
};

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  pixels: Uint8Array;
  /** A text layer stays editable: this is the spec its pixels were painted from. */
  text?: TextLayerSpec;
  /** 0–1; omitted means fully opaque. */
  opacity?: number;
  /** Omitted means "normal". */
  blend?: BlendMode;
  /** A locked layer refuses human and agent writes; the pixels remain readable. */
  locked?: boolean;
  /** Shared layers carry the same link id across frames. */
  linkId?: string;
  /** A tile-index layer keeps its map even though pixels are baked for render. */
  tilemap?: TilemapMetadata;
  parentGroupId?: string;
};

export type FrameBuffer = {
  width: number;
  height: number;
  palette: string[];
  layers: Layer[];
  groups?: LayerGroup[];
};

export const colorModes = ["indexed", "grayscale", "monochrome"] as const;
export type ColorMode = (typeof colorModes)[number];

export const tagDirections = ["forward", "reverse", "pingpong"] as const;
export type TagDirection = (typeof tagDirections)[number];

export type FrameTag = {
  id: string;
  name: string;
  fromFrameId: string;
  toFrameId: string;
  direction: TagDirection;
  loop: boolean;
  color?: string;
};

/** A named rectangle used for export metadata; the nine-slice borders and pivot are optional. */
export type Slice = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nineSlice?: { left: number; right: number; top: number; bottom: number };
  pivot?: { x: number; y: number };
};

export type Frame = {
  id: string;
  name: string;
  index: number;
  /** Native-size frames carry their own canvas; absent means the asset size. */
  width?: number | null;
  height?: number | null;
  layers: Array<Omit<Layer, "pixels"> & { pixels: string }>;
  groups?: LayerGroup[];
  /** Animation delay in milliseconds; native-size frames ignore it. */
  durationMs?: number;
};

export type Asset = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: Frame[];
  colorMode?: ColorMode;
  /** When true, the project style guide is not changed for this asset. */
  styleLocked?: boolean;
  tags?: FrameTag[];
  slices?: Slice[];
};

export type PixelProject = {
  format: "pixelaition";
  version: 1 | 2;
  project: {
    name: string;
    description: string;
    style: StyleGuide;
  };
  assets: Asset[];
};

export type Point = { x: number; y: number };

export type PaintPoint = Point & { color: number };

export type DitherPattern = "checker" | "50";

export type Command =
  | { type: "paint"; layerId: string; points: PaintPoint[] }
  | { type: "erase"; layerId: string; points: Point[] }
  | { type: "fill"; layerId: string; x: number; y: number; color: number }
  | {
      type: "line";
      layerId: string;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      color: number;
    }
  | {
      type: "rect";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color: number;
      filled: boolean;
    }
  | {
      type: "region";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color: number;
      mode: "fill" | "clear" | "flood";
    }
  | {
      type: "tileFill";
      layerId: string;
      tileX: number;
      tileY: number;
      tileWidth: number;
      tileHeight: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      type: "moveMask";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      mask: number[];
      dx: number;
      dy: number;
    }
  | {
      type: "transformMask";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      /** 1 inside the selection, 0 outside; row-major in the bounding box. */
      mask: number[];
      transform: "flipHorizontal" | "flipVertical" | "rotateCW" | "rotateCCW";
    }
  | {
      type: "fillMask";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      /** 1 inside the selection, 0 outside; row-major in the bounding box. */
      mask: number[];
      color: number;
    }
  | { type: "replaceColor"; layerId?: string; from: number; to: number }
  | { type: "outline"; layerId: string; color: number }
  | {
      type: "ellipse";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      color: number;
      filled: boolean;
    }
  | {
      type: "rotateRegion";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      /** Clockwise quarter turns: 1 = 90° clockwise, -1 = 90° anticlockwise. */
      turns: 1 | -1;
    }
  | {
      type: "moveRegion";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      dx: number;
      dy: number;
      /** Clear the source rectangle before stamping the destination. */
      eraseSource: boolean;
    }
  | {
      type: "removeBackground";
      layerId: string;
      /** Palette index to remove; omitted samples the top-left border pixel. */
      color?: number;
      /** 0 keeps only exact matches; higher values remove near colours. */
      tolerance?: number;
      /** When true only the connected border region is removed. */
      edgesOnly?: boolean;
    }
  | {
      type: "dither";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      colorA: number;
      colorB: number;
      pattern: DitherPattern;
    }
  | { type: "setPalette"; palette: string[] }
  /**
   * Replace the palette *and* rewrite every pixel through a colour mapping,
   * because the new palette orders colours differently (a worker returning
   * to the project palette, a fix merging a stray colour back in). Without
   * the remap the pixels would keep indices that now mean other colours.
   */
  | { type: "reindexPalette"; palette: string[]; mapping: Record<string, number> }
  | { type: "resize"; width: number; height: number }
  | { type: "addLayer"; id: string; name: string }
  | {
      type: "replaceLayer";
      layerId: string;
      pixels: Uint8Array;
      text?: TextLayerSpec | null;
    }
  | { type: "renameLayer"; layerId: string; name: string }
  | { type: "setLayerVisible"; layerId: string; visible: boolean }
  | { type: "setLayerOpacity"; layerId: string; opacity: number }
  | { type: "setLayerBlend"; layerId: string; blend: BlendMode }
  | { type: "setLayerLocked"; layerId: string; locked: boolean }
  | { type: "setLayerLink"; layerId: string; linkId?: string }
  | { type: "setTilemap"; layerId: string; tilemap?: TilemapMetadata }
  | { type: "duplicateLayer"; layerId: string; id: string; name: string }
  | {
      type: "addLayerGroup";
      id: string;
      name: string;
      parentGroupId?: string;
    }
  | { type: "renameLayerGroup"; groupId: string; name: string }
  | { type: "setLayerGroupVisible"; groupId: string; visible: boolean }
  | { type: "setLayerGroupOpacity"; groupId: string; opacity: number }
  | { type: "removeLayerGroup"; groupId: string }
  | { type: "moveLayerToGroup"; layerId: string; groupId: string | null }
  | { type: "removeLayer"; layerId: string }
  | { type: "mirror" }
  /**
   * Stamp an already-resolved block of palette indices at `x`,`y`. The caller
   * (an agent tool) owns reading the source — another frame, another asset,
   * the same frame — and mapping its indices into this buffer's palette; the
   * command only guarantees geometry and palette bounds, so a copy is one
   * commit instead of a per-pixel round trip.
   */
  | {
      type: "stamp";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      pixels: readonly number[];
      /** When present, update the persisted tile-index map for this stamp. */
      tilemapData?: readonly number[];
    }
  /** Flip a rectangle inside its own bounds, leaving the rest of the layer alone. */
  | {
      type: "mirrorRegion";
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      axis: "horizontal" | "vertical";
    };

export type CommandFailure = { ok: false; code: string; message: string };
export type CommandSuccess = { ok: true; buffer: FrameBuffer };
export type CommandResult = CommandSuccess | CommandFailure;

export type CritiqueIssue = { code: string; message: string };

export type Camera = { x: number; y: number; zoom: number };

export const zoomSteps = [
  0.1, 0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32,
] as const;

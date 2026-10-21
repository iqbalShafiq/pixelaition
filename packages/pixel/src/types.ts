export const MIN_SIZE = 8;
export const MAX_SIZE = 128;
export const MAX_COLORS = 255;
export const TRANSPARENT = 0;
export const MAX_HISTORY = 100;

export const shadowDirections = ["up", "down", "left", "right"] as const;
export type ShadowDirection = (typeof shadowDirections)[number];

export type StyleGuide = {
  defaultWidth: number;
  defaultHeight: number;
  outline: string;
  shadowDirection: ShadowDirection;
  notes: string;
};

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  pixels: Uint8Array;
};

export type FrameBuffer = {
  width: number;
  height: number;
  palette: string[];
  layers: Layer[];
};

export type Frame = {
  id: string;
  name: string;
  index: number;
  /** Native-size frames carry their own canvas; absent means the asset size. */
  width?: number | null;
  height?: number | null;
  layers: Array<Omit<Layer, "pixels"> & { pixels: string }>;
};

export type Asset = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: Frame[];
};

export type PixelProject = {
  format: "pixelaition";
  version: 1;
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
  | { type: "replaceColor"; layerId?: string; from: number; to: number }
  | { type: "outline"; layerId: string; color: number }
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
  | { type: "renameLayer"; layerId: string; name: string }
  | { type: "setLayerVisible"; layerId: string; visible: boolean }
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

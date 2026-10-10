export const MIN_SIZE = 8;
export const MAX_SIZE = 128;
export const MAX_LAYERS = 4;
export const MAX_COLORS = 32;
export const TRANSPARENT = 0;
export const MAX_HISTORY = 100;

export const shadowDirections = ["up", "down", "left", "right"] as const;
export type ShadowDirection = (typeof shadowDirections)[number];

export type StyleGuide = {
  defaultWidth: number;
  defaultHeight: number;
  maxColors: number;
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
  | { type: "setPalette"; palette: string[] }
  | { type: "resize"; width: number; height: number }
  | { type: "addLayer"; id: string; name: string }
  | { type: "renameLayer"; layerId: string; name: string }
  | { type: "setLayerVisible"; layerId: string; visible: boolean }
  | { type: "removeLayer"; layerId: string }
  | { type: "mirror" };

export type CommandFailure = { ok: false; code: string; message: string };
export type CommandSuccess = { ok: true; buffer: FrameBuffer };
export type CommandResult = CommandSuccess | CommandFailure;

export type CritiqueIssue = { code: string; message: string };

export type Camera = { x: number; y: number; zoom: number };

export const zoomSteps = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;

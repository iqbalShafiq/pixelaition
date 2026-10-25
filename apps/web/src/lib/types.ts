import type {
  BlendMode,
  ColorMode,
  FrameTag,
  LayerGroup,
  Slice,
  TextLayerSpec,
} from "@pixelaition/pixel";

export type LayerDto = {
  id: string;
  name: string;
  visible: boolean;
  pixels: string;
  text?: TextLayerSpec;
  opacity?: number;
  blend?: BlendMode;
  locked?: boolean;
  linkId?: string;
  tilemap?: { tileWidth: number; tileHeight: number; data: number[] };
  parentGroupId?: string;
};

import type { ArtboardScene, CopyOverride, CopyDeck } from "@pixelaition/artboard";

export type FrameDto = {
  id: string;
  name: string;
  index: number;
  layers: LayerDto[];
  /** Present on the summary asset: layers arrive from the frame route. */
  layerCount?: number;
  linkIds?: string[];
  kind?: "sprite" | "social";
  width?: number | null;
  height?: number | null;
  presetId?: string | null;
  scene?: ArtboardScene | null;
  copyOverride?: CopyOverride;
  status?: string;
  version?: number;
  updatedAt?: string;
  durationMs?: number;
  groups?: LayerGroup[];
  undoHistory?: unknown;
};

export type AssetDto = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  paletteLocked: boolean;
  colorMode?: ColorMode;
  styleLocked?: boolean;
  tags?: FrameTag[];
  slices?: Slice[];
  copy: CopyDeck;
  frames: FrameDto[];
  projectId: string;
  projectName: string;
  style: {
    defaultWidth: number;
    defaultHeight: number;
    outline: string;
    shadowDirection: string;
    notes: string;
  };
};

export type ProjectDto = {
  id: string;
  name: string;
  description: string;
  assets: Array<{ id: string; name: string }>;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

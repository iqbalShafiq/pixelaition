import {
  applyCommand,
  composite,
  createId,
  normalizeHex,
  type CommandResult,
  type FrameBuffer,
} from "@pixelaition/pixel";
import type { BoundRunBinding, FrameRef, ProjectAsset } from "./runs.js";
import { paletteLegend } from "./tasks/worker-prompt.js";

/**
 * Reading frames and moving pixels between them.
 *
 * A copy carries palette indices, and two assets rarely share an index order,
 * so every transfer crosses an explicit mapping: identity when the palettes
 * match exactly, and a hex→index map from the model when they do not — a
 * source colour with no answer is reported with the target legend and a
 * suggested map, never guessed. Frames of sibling assets are decoded through
 * the binding (a read-only view); only frames of the run's own asset are ever
 * written.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** One frame a tool can read, named by its asset and frame. */
export type FrameView = {
  assetId: string;
  assetName: string;
  frameId: string;
  frameName: string;
  index?: number;
  summary?: string;
  width: number;
  height: number;
  palette: string[];
  layers: Array<{
    id: string;
    name: string;
    visible: boolean;
    text?: NonNullable<FrameBuffer["layers"][number]["text"]>;
    pixels: Uint8Array;
  }>;
};

/** `{ hex, to }`: a source colour and the target palette index that replaces it. */
export type PaletteMap = ReadonlyArray<{ hex: string; to: number }>;

export type MappingResult =
  | { ok: true; indexOf: (sourceIndex: number) => number }
  | { ok: false; unmapped: string[]; suggestion: PaletteMap };

function normalize(hex: string): string {
  return normalizeHex(hex) ?? hex.trim().toLowerCase();
}

export function toFrameBuffer(frame: FrameView): FrameBuffer {
  return {
    width: frame.width,
    height: frame.height,
    palette: [...frame.palette],
    layers: frame.layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })),
  };
}

export function viewOfAsset(asset: ProjectAsset, frameId: string): FrameView | undefined {
  const frame = asset.frames.find((candidate) => candidate.id === frameId);
  if (!frame) return undefined;
  return {
    assetId: asset.id,
    assetName: asset.name,
    frameId: frame.id,
    frameName: frame.name,
    index: frame.index,
    summary: frame.summary,
    // Native-size frames share the asset palette but not its canvas size.
    width: frame.buffer.width,
    height: frame.buffer.height,
    palette: asset.palette,
    layers: frame.buffer.layers,
  };
}

export function viewOfRunFrame(
  run: BoundRunBinding,
  frameId: string,
): FrameView | undefined {
  const frame = run.frames.get(frameId);
  if (!frame) return undefined;
  return {
    assetId: run.assetId,
    assetName: run.assetName,
    frameId,
    frameName: frame.name,
    index: frame.index,
    summary: frame.summary ?? "",
    width: frame.buffer.width,
    height: frame.buffer.height,
    palette: frame.buffer.palette,
    layers: frame.buffer.layers,
  };
}

/**
 * Resolve a frame reference for reading: `assetId` absent means the run's own
 * asset; `frameId` absent means the run's current frame. Refs accept an id or
 * the frame's name. A sibling asset is loaded through the binding the first
 * time it is asked for, and cached for the rest of the run.
 */
export async function resolveReadFrame(
  run: BoundRunBinding,
  ref: FrameRef = {},
): Promise<FrameView> {
  const assetId = ref.assetId ?? run.assetId;
  if (assetId === run.assetId) {
    const id =
      ref.frameId === undefined ? run.currentFrameId : resolveName(run, ref.frameId);
    const view = id === undefined ? undefined : viewOfRunFrame(run, id);
    if (!view) {
      throw unknownFrame(
        ref.frameId,
        [...run.frames.values()].map((frame) => frame.name),
        run.assetName,
      );
    }
    return view;
  }
  const asset = await loadProjectAsset(run, assetId);
  const frame =
    asset.frames.find((candidate) => candidate.id === ref.frameId) ??
    asset.frames.find(
      (candidate) =>
        (ref.frameId === undefined ? asset.frames[0]?.name : ref.frameId.trim()) ===
        candidate.name.trim(),
    );
  const view = frame ? viewOfAsset(asset, frame.id) : undefined;
  if (!view) {
    throw unknownFrame(
      ref.frameId,
      asset.frames.map((candidate) => candidate.name),
      asset.name,
    );
  }
  return view;
}

function resolveName(run: BoundRunBinding, frameRef: string): string | undefined {
  if (run.frames.has(frameRef)) return frameRef;
  const wanted = frameRef.trim().toLowerCase();
  const matches = [...run.frames.entries()].filter(
    ([, frame]) => frame.name.trim().toLowerCase() === wanted,
  );
  return matches.length === 1 ? matches[0]?.[0] : undefined;
}

function unknownFrame(
  ref: string | undefined,
  names: string[],
  assetName: string,
): Error {
  return new Error(
    `No frame named or identified by "${ref ?? "(none)"}" on asset "${assetName}". Frames: ${
      names.length > 0 ? names.join(", ") : "(none)"
    }.`,
  );
}

async function loadProjectAsset(
  run: BoundRunBinding,
  assetId: string,
): Promise<ProjectAsset> {
  const known = run.projectAssets?.find((asset) => asset.id === assetId);
  if (known) return known;
  const loaded = await run.onLoadProjectAsset?.(assetId);
  if (!loaded) {
    throw new Error(
      `Asset ${assetId} is not an asset of this run's project (${run.projectName ?? "unknown project"}); only project assets can be read.`,
    );
  }
  run.projectAssets = [...(run.projectAssets ?? []), loaded];
  return loaded;
}

/** Every frame of every asset in the run's project, for a listing a role reads. */
export async function projectListing(run: BoundRunBinding): Promise<
  Array<{
    assetId: string;
    name: string;
    width: number;
    height: number;
    palette: string[];
    frames: Array<{
      id: string;
      name: string;
      summary: string;
      index: number;
      width: number;
      height: number;
      layers: Array<{
        id: string;
        name: string;
        visible: boolean;
        text?: NonNullable<FrameBuffer["layers"][number]["text"]>;
      }>;
    }>;
  }>
> {
  const current: ProjectAsset = {
    id: run.assetId,
    name: run.assetName,
    summary: "",
    width: run.width,
    height: run.height,
    palette: run.palette,
    frames: [...run.frames.entries()].map(([id, frame]) => ({
      id,
      name: frame.name,
      summary: frame.summary ?? "",
      index: frame.index,
      buffer: frame.buffer,
    })),
  };
  const others = (run.projectAssets ?? []).filter((asset) => asset.id !== run.assetId);
  return [current, ...others].map((asset) => ({
    assetId: asset.id,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    palette: asset.palette,
    frames: [...asset.frames]
      .sort((left, right) => left.index - right.index)
      .map((frame) => ({
        id: frame.id,
        name: frame.name,
        summary: frame.summary,
        index: frame.index,
        width: frame.buffer.width,
        height: frame.buffer.height,
        layers: frame.buffer.layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          ...(layer.text ? { text: layer.text } : {}),
        })),
      })),
  }));
}

/** The layer a ref names; `undefined` ref means the composite of visible layers. */
export function layerOf(
  frame: FrameView,
  layerRef?: string,
): { pixels: Uint8Array; layerId: string; layerName: string } | undefined {
  if (layerRef === undefined || layerRef.length === 0) {
    return {
      pixels: composite(toFrameBuffer(frame)),
      layerId: "",
      layerName: "(composite)",
    };
  }
  const wanted = layerRef.trim().toLowerCase();
  const layer =
    frame.layers.find((candidate) => candidate.id === layerRef) ??
    frame.layers.find((candidate) => candidate.name.trim().toLowerCase() === wanted);
  return layer
    ? { pixels: layer.pixels, layerId: layer.id, layerName: layer.name }
    : undefined;
}

/** Copy one rectangle out of a frame as palette indices. */
export function readRegion(
  frame: FrameView,
  rect: Rect,
  layerRef?: string,
): { pixels: Uint8Array; layerId: string; layerName: string } {
  if (rect.width < 1 || rect.height < 1) {
    throw new Error("A copied region needs a positive width and height.");
  }
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > frame.width ||
    rect.y + rect.height > frame.height
  ) {
    throw new Error(
      `That region (${rect.x},${rect.y} ${rect.width}×${rect.height}) is outside ${frame.frameName} (${frame.width}×${frame.height}).`,
    );
  }
  const source = layerOf(frame, layerRef);
  if (!source) {
    throw new Error(
      `No layer named or identified by "${layerRef}" on ${frame.frameName}. Layers: ${frame.layers
        .map((layer) => layer.name)
        .join(", ")}.`,
    );
  }
  const copy = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row += 1) {
    const start = (rect.y + row) * frame.width + rect.x;
    copy.set(source.pixels.subarray(start, start + rect.width), row * rect.width);
  }
  return { pixels: copy, layerId: source.layerId, layerName: source.layerName };
}

/** Resolve a source palette into a target palette. */
export function paletteMapping(
  source: readonly string[],
  target: readonly string[],
  map?: PaletteMap,
): MappingResult {
  const targetHex = target.map(normalize);
  const identity =
    source.length === target.length &&
    source.every((hex, index) => normalize(hex) === targetHex[index]);
  if (identity) return { ok: true, indexOf: (index) => index };

  const targetIndex = new Map<string, number>();
  targetHex.forEach((hex, index) => {
    if (!targetIndex.has(hex)) targetIndex.set(hex, index);
  });
  const explicit = new Map<string, number>();
  for (const entry of map ?? []) explicit.set(normalize(entry.hex), entry.to);

  const resolved = new Map<number, number>();
  const unmapped: string[] = [];
  source.forEach((hex, index) => {
    const key = normalize(hex);
    const chosen = explicit.get(key);
    if (chosen !== undefined) {
      if (!Number.isInteger(chosen) || chosen < 0 || chosen >= target.length) {
        unmapped.push(`${hex} → ${chosen} (not an index in the target palette)`);
        return;
      }
      resolved.set(index, chosen);
      return;
    }
    if (index === 0) {
      resolved.set(0, 0);
      return;
    }
    const same = targetIndex.get(key);
    if (same !== undefined) {
      resolved.set(index, same);
      return;
    }
    unmapped.push(hex);
  });
  if (unmapped.length > 0) {
    const suggestion: Array<{ hex: string; to: number }> = source.flatMap((hex) => {
      if (normalize(hex) === "#00000000") return [];
      const same = targetIndex.get(normalize(hex));
      if (same !== undefined) return [{ hex, to: same }];
      const nearest = nearestColor(hex, targetHex);
      return nearest === undefined ? [] : [{ hex, to: nearest }];
    });
    return { ok: false, unmapped, suggestion };
  }
  return { ok: true, indexOf: (index: number) => resolved.get(index) ?? 0 };
}

/** Closest opaque target colour by RGB distance — a starting point, never applied. */
function nearestColor(hex: string, targetHex: readonly string[]): number | undefined {
  const rgb = (value: string): [number, number, number] | undefined => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(value.slice(0, 7));
    return match && match[1] && match[2] && match[3]
      ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
      : undefined;
  };
  const from = rgb(hex);
  if (!from) return undefined;
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  targetHex.forEach((candidate, index) => {
    if (index === 0) return;
    const to = rgb(candidate);
    if (!to) return;
    const distance =
      (from[0] - to[0]) ** 2 + (from[1] - to[1]) ** 2 + (from[2] - to[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Translate a copied block into the target palette and write it in one commit. */
export function stampRegion(
  buffer: FrameBuffer,
  input: {
    layerId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: Uint8Array;
    mapping: MappingResult;
  },
): CommandResult {
  if (!input.mapping.ok) {
    throw new Error(
      `These source colours are not in this asset's palette: ${input.mapping.unmapped.join(", ")}. ` +
        `Target palette: ${paletteLegend(buffer.palette)}. Call again with a map for each source colour, for example ${JSON.stringify(
          input.mapping.suggestion,
        )}.`,
    );
  }
  const indexOf = input.mapping.indexOf;
  return applyCommand(buffer, {
    type: "stamp",
    layerId: input.layerId,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    pixels: Array.from(input.pixels, (value) => indexOf(value)),
  });
}

export type LayerCopy = { name: string; map?: PaletteMap };

/**
 * Copy whole layers from one frame into another: "make this frame's body
 * identical to that frame's body" without redrawing it. A target layer with
 * the same name receives the pixels in place; otherwise a new layer is added.
 */
export function copyLayers(
  target: FrameBuffer,
  source: FrameView,
  layers: readonly LayerCopy[],
): FrameBuffer {
  let next = target;
  for (const entry of layers) {
    const wanted = entry.name.trim().toLowerCase();
    const from =
      source.layers.find((layer) => layer.id === entry.name) ??
      source.layers.find((layer) => layer.name.trim().toLowerCase() === wanted);
    if (!from) {
      throw new Error(
        `Frame ${source.frameName} has no layer "${entry.name}". Its layers: ${source.layers
          .map((layer) => layer.name)
          .join(", ")}.`,
      );
    }
    const existing = next.layers.find(
      (layer) => layer.name.trim().toLowerCase() === wanted,
    );
    const layerId = existing?.id ?? createId();
    if (!existing) {
      const added = applyCommand(next, {
        type: "addLayer",
        id: layerId,
        name: from.name,
      });
      if (!added.ok) throw new Error(added.message);
      next = added.buffer;
    }
    const stamped = stampRegion(next, {
      layerId,
      x: 0,
      y: 0,
      width: source.width,
      height: source.height,
      pixels: from.pixels,
      mapping: paletteMapping(source.palette, next.palette, entry.map),
    });
    if (!stamped.ok) throw new Error(stamped.message);
    next = stamped.buffer;
  }
  return next;
}

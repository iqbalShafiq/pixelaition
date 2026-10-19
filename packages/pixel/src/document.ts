import { bufferToFrame, createBuffer, defaultStyle, frameToBuffer } from "./buffer.js";
import { createId } from "./ids.js";
import { applyCommand } from "./commands.js";
import { isSizeAllowed } from "./pixels.js";
import type { Asset, FrameBuffer, PixelProject, StyleGuide } from "./types.js";

export function createProject(
  name: string,
  style: StyleGuide = defaultStyle,
): PixelProject {
  return {
    format: "pixelaition",
    version: 1,
    project: { name, description: "", style },
    assets: [],
  };
}

export function createAsset(input: {
  name: string;
  width: number;
  height: number;
  palette?: string[];
}): Asset {
  if (!isSizeAllowed(input.width) || !isSizeAllowed(input.height)) {
    throw new Error("Canvas size must be an integer from 8 to 128.");
  }
  const buffer = createBuffer({
    width: input.width,
    height: input.height,
    palette: input.palette,
  });
  const frame = bufferToFrame(buffer, { id: createId(), name: "idle", index: 0 });
  return {
    id: createId(),
    name: input.name.trim() || "Untitled",
    width: input.width,
    height: input.height,
    palette: [...buffer.palette],
    frames: [frame],
  };
}

export function assetFrameBuffer(asset: Asset, frameId: string): FrameBuffer | undefined {
  const frame = asset.frames.find((item) => item.id === frameId);
  if (!frame) return undefined;
  return frameToBuffer(frame, asset.width, asset.height, asset.palette);
}

export function writeFrame(asset: Asset, frameId: string, buffer: FrameBuffer): Asset {
  const frames = asset.frames.map((frame) => {
    if (frame.id === frameId) return bufferToFrame(buffer, frame);
    if (
      asset.width === buffer.width &&
      asset.height === buffer.height &&
      samePalette(asset.palette, buffer.palette)
    ) {
      return frame;
    }
    const current = frameToBuffer(frame, asset.width, asset.height, asset.palette);
    const resized = applyCommand(current, {
      type: "resize",
      width: buffer.width,
      height: buffer.height,
    });
    if (!resized.ok) return frame;
    return bufferToFrame({ ...resized.buffer, palette: [...buffer.palette] }, frame);
  });
  return {
    ...asset,
    width: buffer.width,
    height: buffer.height,
    palette: [...buffer.palette],
    frames,
  };
}

function samePalette(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((color, index) => color === right[index])
  );
}

export function addFrame(asset: Asset, name: string): Asset {
  const width = asset.width;
  const height = asset.height;
  const blank = createBuffer({
    width,
    height,
    palette: asset.palette,
    layerName: "pixels",
  });
  const frame = bufferToFrame(blank, {
    id: createId(),
    name: name.trim() || `frame-${asset.frames.length + 1}`,
    index: nextIndex(asset),
  });
  if (asset.frames.length === 0) return { ...asset, frames: [frame] };
  return { ...asset, frames: [...asset.frames, frame] };
}

function nextIndex(asset: Asset): number {
  return asset.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
}

export function duplicateFrame(
  asset: Asset,
  frameId: string,
  name: string,
): Asset | undefined {
  const source = asset.frames.find((frame) => frame.id === frameId);
  if (!source) return undefined;
  const copy = bufferToFrame(
    frameToBuffer(source, asset.width, asset.height, asset.palette),
    {
      id: createId(),
      name: name.trim() || `${source.name} copy`,
      index: nextIndex(asset),
    },
  );
  copy.layers = copy.layers.map((layer) => ({ ...layer, id: createId() }));
  return { ...asset, frames: [...asset.frames, copy] };
}

export function mirrorFrame(asset: Asset, frameId: string): Asset | undefined {
  const buffer = assetFrameBuffer(asset, frameId);
  if (!buffer) return undefined;
  const mirrored = applyCommand(buffer, { type: "mirror" });
  if (!mirrored.ok) return undefined;
  return writeFrame(asset, frameId, mirrored.buffer);
}

/**
 * Reorders a frame by moving it to a slot in the list. Indexes are the order
 * of record, so the whole list is renumbered as a dense 0..n-1 sequence.
 */
export function moveFrame(
  asset: Asset,
  frameId: string,
  toIndex: number,
): Asset | undefined {
  const from = asset.frames.findIndex((frame) => frame.id === frameId);
  if (from === -1) return undefined;
  const frames = [...asset.frames];
  const [moved] = frames.splice(from, 1);
  if (!moved) return undefined;
  const to = Math.max(0, Math.min(toIndex, frames.length));
  frames.splice(to, 0, moved);
  return { ...asset, frames: frames.map((frame, index) => ({ ...frame, index })) };
}

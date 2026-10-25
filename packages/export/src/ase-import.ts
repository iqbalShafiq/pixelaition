import { inflateSync } from "node:zlib";
import {
  bufferToFrame,
  createBuffer,
  type Asset,
  type FrameTag,
  type Slice,
} from "@pixelaition/pixel";

export type AseImport = {
  width: number;
  height: number;
  palette: string[];
  frames: Asset["frames"];
  tags: FrameTag[];
  slices: Slice[];
};

type LayerDef = {
  kind: "layer" | "group";
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  width: number;
  height: number;
  depth: number;
  parentGroupId?: string;
  chunkIndex: number;
  imageIndex?: number;
};

const blendNames: Record<number, string> = {
  0: "normal",
  1: "multiply",
  2: "screen",
  3: "overlay",
  4: "darken",
  5: "lighten",
  6: "color-dodge",
  7: "color-burn",
  8: "hard-light",
  9: "soft-light",
  10: "difference",
  11: "exclusion",
  16: "add",
  17: "subtract",
};

function hex(r: number, g: number, b: number, a: number): string {
  return `#${[r, g, b, a].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Read the indexed subset of the .ase format: layer layout, palette, raw or
 * zlib-compressed cels, delays, tags and slices. RGB/grayscale sprites and
 * linked cels are named rather than guessed.
 */
export function parseAse(bytes: Uint8Array): AseImport {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 128 || view.getUint16(4, true) !== 0xa5e0) {
    throw new Error("That file is not an Aseprite document.");
  }
  const fileSize = view.getUint32(0, true);
  if (fileSize > bytes.length) throw new Error("The Aseprite file is truncated.");
  const frameCount = view.getUint16(6, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const depth = view.getUint16(12, true);
  if (depth !== 8) {
    throw new Error(
      `Only indexed (8-bit) Aseprite files are supported, not ${depth}-bit.`,
    );
  }
  const palette = Array.from({ length: 256 }, () => "#00000000");
  const layerDefs: LayerDef[] = [];
  const groupStack: string[] = [];
  const frameCels: Array<
    Array<{ layer: number; x: number; y: number; pixels: Uint8Array }>
  > = [];
  const linkedCels: Array<{ frame: number; layer: number; target: number }> = [];
  const durations: number[] = [];
  const rawTags: Array<{
    from: number;
    to: number;
    direction: number;
    loop: boolean;
    name: string;
  }> = [];
  const slices: Array<{
    name: string;
    flags: number;
    keys: Array<{
      frame: number;
      x: number;
      y: number;
      width: number;
      height: number;
      center?: { x: number; y: number; width: number; height: number };
      pivot?: { x: number; y: number };
    }>;
  }> = [];
  let offset = 128;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if (offset + 16 > bytes.length)
      throw new Error("The Aseprite frame header is truncated.");
    const frameSize = view.getUint32(offset, true);
    if (view.getUint16(offset + 4, true) !== 0xf1fa) {
      throw new Error("An Aseprite frame is missing its magic.");
    }
    durations.push(view.getUint16(offset + 8, true));
    const count = view.getUint32(offset + 12, true);
    let cursor = offset + 16;
    const cels: Array<{ layer: number; x: number; y: number; pixels: Uint8Array }> = [];
    for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
      if (cursor + 6 > bytes.length) throw new Error("An Aseprite chunk is truncated.");
      const length = view.getUint32(cursor, true);
      const type = view.getUint16(cursor + 4, true);
      const data = cursor + 6;
      const end = cursor + length;
      if (end > bytes.length || length < 6)
        throw new Error("An Aseprite chunk is malformed.");
      if (type === 0x2004) {
        const flags = view.getUint16(data, true);
        const layerType = view.getUint16(data + 2, true);
        const childLevel = view.getUint16(data + 4, true);
        if (layerType === 2) {
          throw new Error("Tilemap layers are not supported in .ase import yet.");
        }
        const layerWidth = view.getUint16(data + 6, true);
        const layerHeight = view.getUint16(data + 8, true);
        const blend = view.getUint16(data + 10, true);
        const opacity = view.getUint8(data + 12) / 255;
        const nameLength = view.getUint16(data + 16, true);
        const name = new TextDecoder().decode(
          bytes.subarray(data + 18, data + 18 + nameLength),
        );
        const id = `ase-layer-${layerDefs.length + 1}`;
        const parentGroupId = childLevel > 0 ? groupStack[childLevel - 1] : undefined;
        if (layerType === 1) {
          groupStack[childLevel] = id;
          groupStack.length = childLevel + 1;
          layerDefs.push({
            kind: "group",
            id,
            name: name || `group-${layerDefs.length + 1}`,
            visible: (flags & 1) !== 0,
            opacity,
            blend: "normal",
            width: layerWidth,
            height: layerHeight,
            depth: childLevel,
            ...(parentGroupId ? { parentGroupId } : {}),
            chunkIndex: layerDefs.length,
          });
        } else {
          groupStack.length = childLevel;
          const imageIndex = layerDefs.filter((def) => def.kind === "layer").length;
          layerDefs.push({
            kind: "layer",
            id,
            name: name || `layer-${layerDefs.length + 1}`,
            visible: (flags & 1) !== 0,
            opacity,
            blend: blendNames[blend] ?? "normal",
            width: layerWidth || width,
            height: layerHeight || height,
            depth: childLevel,
            ...(parentGroupId ? { parentGroupId } : {}),
            chunkIndex: layerDefs.length,
            imageIndex,
          });
        }
      } else if (type === 0x2019) {
        const first = view.getUint32(data + 4, true);
        const last = view.getUint32(data + 8, true);
        let entry = data + 20;
        for (let index = first; index <= last; index += 1) {
          const flags = view.getUint16(entry, true);
          const r = view.getUint8(entry + 2);
          const g = view.getUint8(entry + 3);
          const b = view.getUint8(entry + 4);
          const a = view.getUint8(entry + 5);
          if (index < palette.length) palette[index] = hex(r, g, b, a);
          entry += 6;
          if ((flags & 1) !== 0) {
            const nameLength = view.getUint16(entry, true);
            entry += 2 + nameLength;
          }
        }
      } else if (type === 0x2005) {
        const layerIndex = view.getUint16(data, true);
        const x = view.getInt16(data + 2, true);
        const y = view.getInt16(data + 4, true);
        const celType = view.getUint16(data + 7, true);
        if (celType === 1) {
          const target = view.getUint16(data + 16, true);
          linkedCels.push({ frame: frameIndex, layer: layerIndex, target });
          cursor = end;
          continue;
        }
        if (celType === 3) {
          throw new Error(
            "Compressed tilemap cels are not supported in .ase import yet.",
          );
        }
        const layer = layerDefs.find(
          (def) => def.kind === "layer" && def.chunkIndex === layerIndex,
        );
        if (!layer) throw new Error("An Aseprite cel names a missing image layer.");
        const expected = layer.width * layer.height;
        let pixels = bytes.subarray(data + 16, end);
        if (celType === 2) {
          pixels = new Uint8Array(inflateSync(pixels));
        }
        if (pixels.length < expected) {
          throw new Error("An Aseprite cel is shorter than its layer.");
        }
        cels.push({
          layer: layerIndex,
          x,
          y,
          pixels: pixels.slice(0, expected),
        });
      } else if (type === 0x2018) {
        const countTags = view.getUint16(data, true);
        let tagCursor = data + 10;
        for (let index = 0; index < countTags; index += 1) {
          const from = view.getUint16(tagCursor, true);
          const to = view.getUint16(tagCursor + 2, true);
          const direction = view.getUint8(tagCursor + 4);
          const repeat = view.getUint16(tagCursor + 5, true);
          const nameLength = view.getUint16(tagCursor + 17, true);
          const name = new TextDecoder().decode(
            bytes.subarray(tagCursor + 19, tagCursor + 19 + nameLength),
          );
          rawTags.push({
            from,
            to,
            direction,
            loop: repeat === 0,
            name: name || `tag-${index + 1}`,
          });
          tagCursor += 19 + nameLength;
        }
      } else if (type === 0x2022) {
        const keys = view.getUint32(data, true);
        const flags = view.getUint32(data + 4, true);
        const nameLength = view.getUint16(data + 12, true);
        const name = new TextDecoder().decode(
          bytes.subarray(data + 14, data + 14 + nameLength),
        );
        let keyCursor = data + 14 + nameLength;
        const parsedKeys: Array<{
          frame: number;
          x: number;
          y: number;
          width: number;
          height: number;
          center?: { x: number; y: number; width: number; height: number };
          pivot?: { x: number; y: number };
        }> = [];
        for (let index = 0; index < keys; index += 1) {
          const frame = view.getUint32(keyCursor, true);
          const x = view.getInt32(keyCursor + 4, true);
          const y = view.getInt32(keyCursor + 8, true);
          const sliceWidth = view.getUint32(keyCursor + 12, true);
          const sliceHeight = view.getUint32(keyCursor + 16, true);
          keyCursor += 20;
          let center: { x: number; y: number; width: number; height: number } | undefined;
          let pivot: { x: number; y: number } | undefined;
          if ((flags & 1) !== 0) {
            center = {
              x: view.getInt32(keyCursor, true),
              y: view.getInt32(keyCursor + 4, true),
              width: view.getUint32(keyCursor + 8, true),
              height: view.getUint32(keyCursor + 12, true),
            };
            keyCursor += 16;
          }
          if ((flags & 2) !== 0) {
            pivot = {
              x: view.getInt32(keyCursor, true),
              y: view.getInt32(keyCursor + 4, true),
            };
            keyCursor += 8;
          }
          parsedKeys.push({
            frame,
            x,
            y,
            width: sliceWidth,
            height: sliceHeight,
            ...(center ? { center } : {}),
            ...(pivot ? { pivot } : {}),
          });
        }
        slices.push({
          name: name || `slice-${slices.length + 1}`,
          flags,
          keys: parsedKeys,
        });
      }
      cursor = end;
    }
    frameCels.push(cels);
    offset += frameSize;
  }
  for (const link of linkedCels) {
    const source = frameCels[link.target]?.find((cel) => cel.layer === link.layer);
    if (!source) {
      throw new Error("An Aseprite linked cel points at a missing frame or layer.");
    }
    frameCels[link.frame]?.push({ ...source });
  }
  if (layerDefs.every((def) => def.kind !== "layer")) {
    layerDefs.push({
      kind: "layer",
      id: "ase-layer-1",
      name: "pixels",
      visible: true,
      opacity: 1,
      blend: "normal",
      width,
      height,
      depth: 0,
      chunkIndex: layerDefs.length,
      imageIndex: 0,
    });
  }
  const frames = frameCels.map((cels, frameIndex) => {
    const buffer = createBuffer({ width, height, palette });
    buffer.groups = layerDefs
      .filter((layer) => layer.kind === "group")
      .map((group) => ({
        id: group.id,
        name: group.name,
        visible: group.visible,
        ...(group.opacity < 1 ? { opacity: group.opacity } : {}),
        ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {}),
      }));
    buffer.layers = layerDefs
      .filter((layer) => layer.kind === "layer")
      .map((layer) => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        ...(layer.opacity < 1 ? { opacity: layer.opacity } : {}),
        ...(layer.blend !== "normal" ? { blend: layer.blend as never } : {}),
        ...(layer.parentGroupId ? { parentGroupId: layer.parentGroupId } : {}),
        pixels: new Uint8Array(width * height),
      }));
    for (const cel of cels) {
      const layerDef = layerDefs.find(
        (def) => def.kind === "layer" && def.chunkIndex === cel.layer,
      );
      if (!layerDef || layerDef.imageIndex === undefined) continue;
      const layer = buffer.layers[layerDef.imageIndex];
      if (!layer) continue;
      for (let row = 0; row < layerDef.height; row += 1) {
        for (let column = 0; column < layerDef.width; column += 1) {
          const targetX = cel.x + column;
          const targetY = cel.y + row;
          if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height)
            continue;
          layer.pixels[targetY * width + targetX] =
            cel.pixels[row * layerDef.width + column] ?? 0;
        }
      }
    }
    return bufferToFrame(buffer, {
      id: crypto.randomUUID(),
      name: `frame-${frameIndex + 1}`,
      index: frameIndex,
      durationMs: Math.max(10, durations[frameIndex] ?? 100),
    });
  });
  const frameIds = frames.map((frame) => frame.id);
  return {
    width,
    height,
    palette: palette.slice(0, Math.max(2, palette.length)),
    frames,
    tags: rawTags.flatMap((tag) => {
      const from = frameIds[tag.from];
      const to = frameIds[tag.to];
      if (!from || !to) return [];
      return [
        {
          id: crypto.randomUUID(),
          name: tag.name,
          fromFrameId: from,
          toFrameId: to,
          direction:
            tag.direction === 1
              ? "reverse"
              : tag.direction === 2
                ? "pingpong"
                : "forward",
          loop: tag.loop,
        } satisfies FrameTag,
      ];
    }),
    slices: slices.flatMap((slice) => {
      const first = slice.keys[0];
      if (!first || first.width < 1 || first.height < 1) return [];
      return [
        {
          id: crypto.randomUUID(),
          name: slice.name,
          x: Math.max(0, first.x),
          y: Math.max(0, first.y),
          width: first.width,
          height: first.height,
          ...(first.center
            ? {
                nineSlice: {
                  left: first.center.x - first.x,
                  right: first.x + first.width - (first.center.x + first.center.width),
                  top: first.center.y - first.y,
                  bottom: first.y + first.height - (first.center.y + first.center.height),
                },
              }
            : {}),
          ...(first.pivot ? { pivot: first.pivot } : {}),
        } satisfies Slice,
      ];
    }),
  };
}

import { randomUUID } from "node:crypto";
import { assets, frames, type Database } from "@pixelaition/db";
import {
  MAX_COLORS,
  MAX_SIZE,
  MIN_SIZE,
  bufferToFrame,
  encodePixels,
  hexToColor,
  normalizeHex,
  writeCell,
  type Frame,
  type Layer,
  type LayerGroup,
} from "@pixelaition/pixel";
import { and, eq } from "drizzle-orm";
import {
  getAssetRecord,
  recordAssetVersion,
  recordFrameVersion,
  type StoreFailure,
} from "./store.js";

export type ImportedLayer = {
  name?: string;
  /** Base64 RGBA bytes (four per pixel); legacy one-byte palettes are accepted. */
  pixels: string;
};

export type ImportedFrame = {
  name?: string;
  width: number;
  height: number;
  layers: ImportedLayer[];
  groups?: LayerGroup[];
};

export type ImportRequest = {
  /** Swatches for the asset; no longer used to index incoming RGBA pixels. */
  palette: string[];
  mode: "frames" | "layers";
  targetFrameId?: string;
  frames: ImportedFrame[];
};

const MAX_IMPORT_FRAMES = 256;
const MAX_IMPORT_PIXELS = MAX_SIZE * MAX_SIZE * 8;

function fail(code: string, message: string): { failure: StoreFailure } {
  return { failure: { code, message } };
}

function cleanPalette(input: string[]): string[] | undefined {
  if (input.length < 2 || input.length > MAX_COLORS + 1) return undefined;
  const palette = input.map((color) => normalizeHex(color));
  if (palette.some((color) => color === null)) return undefined;
  if (palette[0] !== "#00000000") return undefined;
  return palette as string[];
}

function uniqueName(
  existing: Set<string>,
  requested: string | undefined,
  index: number,
): string {
  const base = requested?.trim() || `imported-${index + 1}`;
  let name = base.slice(0, 80);
  let suffix = 1;
  while (existing.has(name.toLowerCase())) {
    const tail = ` (${suffix})`;
    name = `${base.slice(0, Math.max(1, 80 - tail.length))}${tail}`;
    suffix += 1;
  }
  existing.add(name.toLowerCase());
  return name;
}

/** RGBA bytes from the browser; a one-byte-per-cell payload is a legacy import. */
function decodeImportedPixels(
  encoded: string,
  cells: number,
  palette: string[],
): Uint8Array {
  const binary = atob(encoded);
  if (binary.length === cells * 4) {
    const pixels = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      pixels[index] = binary.charCodeAt(index);
    }
    return pixels;
  }
  if (binary.length === cells) {
    const pixels = new Uint8Array(cells * 4);
    for (let cell = 0; cell < cells; cell += 1) {
      const color = hexToColor(palette[binary.charCodeAt(cell)] ?? "#00000000") ?? 0;
      writeCell(pixels, cell, color);
    }
    return pixels;
  }
  throw new Error(
    `An imported layer holds ${binary.length} bytes; expected ${cells * 4} RGBA bytes or ${cells} legacy indices.`,
  );
}

/**
 * Import already-indexed frames. The browser owns decoding and quantization;
 * the server owns palette mapping, bounds, transactionality and persistence, so
 * no client can store a buffer that later reads as a different canvas size.
 */
export async function importFrames(
  db: Database,
  userId: string,
  assetId: string,
  input: ImportRequest,
): Promise<{
  asset?: Awaited<ReturnType<typeof getAssetRecord>>;
  failure?: StoreFailure;
}> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return fail("NOT_FOUND", "That asset is not available.");
  const sourcePalette = cleanPalette(input.palette);
  if (!sourcePalette) {
    return fail("INVALID_PALETTE", "Import needs between 1 and 256 valid hex swatches.");
  }
  if (input.frames.length === 0) return fail("NO_FRAMES", "There is nothing to import.");
  if (input.frames.length > MAX_IMPORT_FRAMES) {
    return fail(
      "TOO_MANY_FRAMES",
      `An import can add at most ${MAX_IMPORT_FRAMES} frames at once.`,
    );
  }
  let totalPixels = 0;
  for (const frame of input.frames) {
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < MIN_SIZE ||
      frame.height < MIN_SIZE ||
      frame.width > MAX_SIZE ||
      frame.height > MAX_SIZE
    ) {
      return fail(
        "INVALID_SIZE",
        `Each imported frame must be between ${MIN_SIZE} and ${MAX_SIZE} pixels.`,
      );
    }
    if (frame.layers.length === 0) {
      return fail("NO_LAYERS", "Each imported frame needs at least one layer.");
    }
    totalPixels += frame.width * frame.height;
  }
  if (totalPixels > MAX_IMPORT_PIXELS) {
    return fail("IMPORT_TOO_LARGE", "That import is too large to decode at once.");
  }

  const assetPalette = record.palette as string[];
  const nextPalette = assetPalette;

  const versions: Array<{
    frameId: string;
    name: string;
    layers: Frame["layers"];
  }> = [];
  try {
    await db.transaction(async (tx) => {
      if (input.mode === "layers") {
        const frameId = input.targetFrameId;
        if (!frameId) throw new Error("Choose the frame that receives the layers.");
        const target = record.frames.find((frame) => frame.id === frameId);
        if (!target) throw new Error("That frame is not part of this asset.");
        if (target.kind === "social") {
          throw new Error("Native-size frames do not accept pixel layers.");
        }
        const width = target.width ?? record.width;
        const height = target.height ?? record.height;
        const source = input.frames[0];
        if (!source) throw new Error("There is nothing to import.");
        if (source.width !== width || source.height !== height) {
          throw new Error(`The imported image is not ${width} by ${height}.`);
        }
        const existing = target.layers as Frame["layers"];
        const names = new Set(existing.map((layer) => layer.name.toLowerCase()));
        const added = source.layers.map((layer, index) => {
          const pixels = decodeImportedPixels(
            layer.pixels,
            width * height,
            sourcePalette,
          );
          return {
            id: randomUUID(),
            name: uniqueName(names, layer.name, existing.length + index),
            visible: true,
            pixels: encodePixels(pixels),
          } satisfies Frame["layers"][number];
        });
        const layers = [...existing, ...added];
        await tx
          .update(frames)
          .set({ layers, updatedAt: new Date() })
          .where(and(eq(frames.id, target.id), eq(frames.assetId, assetId)));
        versions.push({ frameId: target.id, name: target.name, layers });
      } else {
        const existing = new Set(record.frames.map((frame) => frame.name.toLowerCase()));
        let nextIndex =
          record.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) +
          1;
        for (const [offset, source] of input.frames.entries()) {
          const id = randomUUID();
          const layers = source.layers.map((layer, layerIndex) => {
            const pixels = decodeImportedPixels(
              layer.pixels,
              source.width * source.height,
              sourcePalette,
            );
            const id = randomUUID();
            const next: Layer = {
              id,
              name: (layer.name?.trim() || `imported layer ${layerIndex + 1}`).slice(
                0,
                80,
              ),
              visible: true,
              pixels,
            };
            return next;
          });
          const buffer = {
            width: source.width,
            height: source.height,
            palette: nextPalette,
            layers,
            ...(source.groups ? { groups: source.groups } : {}),
          };
          const name = uniqueName(existing, source.name, offset);
          const frame = bufferToFrame(buffer, { id, name, index: nextIndex });
          await tx.insert(frames).values({
            id,
            assetId,
            name,
            index: nextIndex,
            layers: frame.layers,
            groups: frame.groups ?? [],
            width: source.width,
            height: source.height,
            kind: "sprite",
          });
          versions.push({ frameId: id, name, layers: frame.layers });
          nextIndex += 1;
        }
      }
    });
  } catch (reason) {
    return fail(
      "IMPORT_FAILED",
      reason instanceof Error ? reason.message : "The import could not be saved.",
    );
  }

  for (const version of versions) {
    await recordFrameVersion(
      db,
      assetId,
      version.frameId,
      "import",
      version.name,
      version.layers,
    );
  }
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  const next = await getAssetRecord(db, userId, assetId);
  if (!next) return fail("NOT_FOUND", "That asset is not available.");
  await recordAssetVersion(db, assetId, "import", next);
  return { asset: next };
}

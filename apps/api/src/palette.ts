import { assets, frames, type Database } from "@pixelaition/db";
import { mapSceneColors, sceneSchema } from "@pixelaition/artboard";
import { normalizeHex, paletteIndexMap } from "@pixelaition/pixel";
import { and, eq } from "drizzle-orm";
import { getAssetRecord, recordAssetVersion, type StoreFailure } from "./store.js";

export type PaletteAction =
  | { action: "edit"; index: number; color: string }
  | { action: "add"; color: string }
  | { action: "remove"; index: number; remapTo?: number }
  | { action: "reorder"; order: number[] }
  | { action: "replace"; palette: string[] }
  | { action: "import"; palette: string[]; mode: "merge" | "replace" }
  | { action: "lock"; locked: boolean };

type Assistant = { nextPalette: string[]; mapping?: number[]; locked?: boolean };

function fail(code: string, message: string): { failure: StoreFailure } {
  return { failure: { code, message } };
}

function normalizedPalette(palette: string[]): string[] | undefined {
  if (palette.length < 2 || palette.length > 256) return undefined;
  const next = palette.map((color) => normalizeHex(color));
  if (next.some((color) => color === null)) return undefined;
  if (next[0] !== "#00000000") return undefined;
  return next as string[];
}

/**
 * One palette mutation, with every pixel and social scene rewritten through the
 * same index map. Keeping the mapping explicit is what makes a delete or a
 * reorder safe; a colour-distance guess would silently change artwork.
 */
export async function mutatePalette(
  db: Database,
  userId: string,
  assetId: string,
  action: PaletteAction,
): Promise<{
  asset?: Awaited<ReturnType<typeof getAssetRecord>>;
  failure?: StoreFailure;
}> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return fail("NOT_FOUND", "That asset is not available.");
  const palette = record.palette as string[];
  if (record.paletteLocked && action.action !== "lock") {
    return fail("PALETTE_LOCKED", "The palette is locked for this asset.");
  }
  if (palette.length < 2) return fail("INVALID_PALETTE", "The palette is empty.");

  let prepared: Assistant | undefined;
  switch (action.action) {
    case "lock":
      prepared = {
        nextPalette: palette,
        locked: action.locked,
      };
      break;
    case "edit": {
      if (action.index <= 0 || action.index >= palette.length) {
        return fail("PALETTE_INDEX", "Index 0 is transparent; choose a visible colour.");
      }
      const color = normalizeHex(action.color);
      if (!color) return fail("PALETTE_COLOR", "That colour is not valid hex.");
      const nextPalette = [...palette];
      nextPalette[action.index] = color;
      prepared = { nextPalette };
      break;
    }
    case "add": {
      if (palette.length >= 256) {
        return fail("PALETTE_FULL", "The palette already holds the maximum 255 colours.");
      }
      const color = normalizeHex(action.color);
      if (!color || color === "#00000000") {
        return fail(
          "PALETTE_COLOR",
          "A palette needs an opaque or semi-transparent hex colour.",
        );
      }
      prepared = { nextPalette: [...palette, color] };
      break;
    }
    case "remove": {
      const { index } = action;
      if (index <= 0 || index >= palette.length) {
        return fail("PALETTE_INDEX", "Index 0 is transparent and cannot be removed.");
      }
      const remapTo = action.remapTo ?? 0;
      if (remapTo < 0 || remapTo >= palette.length) {
        return fail("PALETTE_INDEX", "The remap target is outside this palette.");
      }
      if (remapTo === index) {
        return fail(
          "PALETTE_INDEX",
          "Choose a different colour to keep, or clear to transparent.",
        );
      }
      const nextPalette = palette.filter((_, position) => position !== index);
      const mapping = palette.map((_, source) => {
        if (source === 0) return 0;
        if (source === index) return remapTo > index ? remapTo - 1 : remapTo;
        return source > index ? source - 1 : source;
      });
      prepared = { nextPalette, mapping };
      break;
    }
    case "reorder": {
      const order = action.order;
      if (
        order.length !== palette.length ||
        new Set(order).size !== palette.length ||
        order.some(
          (value) => !Number.isInteger(value) || value < 0 || value >= palette.length,
        ) ||
        order[0] !== 0
      ) {
        return fail(
          "PALETTE_ORDER",
          "The order must list every index once, starting at 0.",
        );
      }
      const nextPalette = order.map((source) => palette[source] ?? "#00000000");
      const mapping = new Array<number>(palette.length).fill(0);
      order.forEach((source, target) => {
        mapping[source] = target;
      });
      prepared = { nextPalette, mapping };
      break;
    }
    case "replace": {
      const nextPalette = normalizedPalette(action.palette);
      if (!nextPalette) {
        return fail(
          "INVALID_PALETTE",
          "A palette needs index 0 transparent and 2–256 colours.",
        );
      }
      prepared = { nextPalette, mapping: paletteIndexMap(palette, nextPalette) };
      break;
    }
    case "import": {
      const imported = normalizedPalette(action.palette);
      if (!imported) {
        return fail(
          "INVALID_PALETTE",
          "A palette needs index 0 transparent and 2–256 colours.",
        );
      }
      if (action.mode === "replace") {
        prepared = { nextPalette: imported, mapping: paletteIndexMap(palette, imported) };
      } else {
        const seen = new Set(palette.map((color) => color.toLowerCase()));
        const merged = [...palette];
        for (const color of imported.slice(1)) {
          if (merged.length >= 256) {
            return fail("PALETTE_FULL", "The merged palette would exceed 255 colours.");
          }
          if (!seen.has(color.toLowerCase())) {
            seen.add(color.toLowerCase());
            merged.push(color);
          }
        }
        prepared = { nextPalette: merged };
      }
      break;
    }
  }
  if (!prepared) return fail("INVALID", "That palette action is not supported.");

  try {
    await db.transaction(async (tx) => {
      if (prepared.mapping) {
        // Pixel layers hold full RGBA and are never rewritten by a swatch
        // reorder. Scenes map by colour so exact RGBA survives a reorder.
        for (const frame of record.frames) {
          if (!frame.scene) continue;
          const updates = {
            scene: mapSceneColors(
              sceneSchema.parse(frame.scene),
              record.palette as string[],
              prepared.nextPalette,
            ),
            version: frame.version + 1,
            updatedAt: new Date(),
          };
          await tx
            .update(frames)
            .set(updates)
            .where(and(eq(frames.id, frame.id), eq(frames.assetId, assetId)));
        }
      }
      await tx
        .update(assets)
        .set({
          palette: prepared.nextPalette,
          ...(prepared.locked !== undefined ? { paletteLocked: prepared.locked } : {}),
          updatedAt: new Date(),
        })
        .where(eq(assets.id, assetId));
    });
  } catch (reason) {
    return fail(
      "PALETTE_UPDATE",
      reason instanceof Error ? reason.message : "The palette could not be changed.",
    );
  }

  const next = await getAssetRecord(db, userId, assetId);
  if (!next) return fail("NOT_FOUND", "That asset is not available.");
  await recordAssetVersion(db, assetId, "palette", next);
  return { asset: next };
}

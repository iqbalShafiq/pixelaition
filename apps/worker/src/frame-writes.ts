import { getRun, type FrameChange, type Stroke } from "@pixelaition/agent";
import {
  assets,
  createVersion,
  frames,
  generationRuns,
  type Database,
} from "@pixelaition/db";
import { bufferToFrame, encodePixels, type FrameBuffer } from "@pixelaition/pixel";
import { and, eq, sql } from "drizzle-orm";

/** The metadata fields a version snapshot records for an asset. */
export type VersionedAsset = {
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: Array<{ id: string }>;
};

/** The collaborators frameWrites needs; the worker passes its live ones. */
export type FrameWritesDeps = {
  db: Database;
  publish: (runId: string, type: string, data: unknown) => void;
  loadAsset: (assetId: string) => Promise<VersionedAsset | undefined>;
};

/** Asset-scoped version snapshot: the metadata plus the frames that existed. */
function assetVersionSnapshot(asset: VersionedAsset) {
  return {
    name: asset.name,
    width: asset.width,
    height: asset.height,
    palette: asset.palette,
    frameIds: asset.frames.map((frame) => frame.id),
  };
}

/**
 * The persistence callbacks for one asset's frames, shared by asset runs and
 * workspace runs once they have bound an asset. `onStroke` streams the live
 * frame and writes the frame row; `onFrameChange` writes frame CRUD, canvas
 * resizes, and their version rows. Frame CRUD tools await onFrameChange before
 * committing their in-memory change, so a row exists before any later stroke
 * targets it; a failed save is logged and rethrown as a bounded cause, so the
 * tool call fails and the binding stays put instead of diverging from the
 * database.
 */
export function frameWrites(
  options: {
    durableRunId: string;
    publicRunId: string;
    assetId: string;
    frames: Array<{ id: string; name: string; index: number }>;
  },
  deps: FrameWritesDeps,
) {
  const { db, publish, loadAsset } = deps;
  const { durableRunId, publicRunId, assetId } = options;
  const framesById = new Map(
    options.frames.map((item) => [
      item.id,
      { id: item.id, name: item.name, index: item.index },
    ]),
  );

  /** Insert one frames row, exactly like store.ts's addFrameRecord does. */
  const insertFrameRow = async (frame: {
    id: string;
    name: string;
    index: number;
    buffer: FrameBuffer;
  }) => {
    await db.insert(frames).values({
      id: frame.id,
      assetId,
      name: frame.name,
      index: frame.index,
      layers: bufferToFrame(frame.buffer, frame).layers,
    });
    framesById.set(frame.id, { id: frame.id, name: frame.name, index: frame.index });
  };

  const onStroke = (stroke: Stroke, buffer: FrameBuffer, editedFrameId: string): void => {
    publish(publicRunId, "canvas-stroke", {
      assetId,
      frameId: editedFrameId,
      // The canvas size rides along: a resize stroke must resize the editor's
      // own view, or the pixels land on a canvas with the old stride and the
      // sprite reads as noise.
      width: buffer.width,
      height: buffer.height,
      // The palette rides along: a set_palette repaint must reach every open
      // editor, and the palette is the asset's, not this frame's.
      palette: [...buffer.palette],
      layers: buffer.layers.map((layer) => ({
        ...layer,
        pixels: encodePixels(layer.pixels),
      })),
      // Paint order for the editor's cursor. Empty for fills; the client then
      // walks the changed cells in scan order. Capped so a huge stroke stays
      // a frame event, not a transcript.
      ...(stroke.points.length > 0 && stroke.points.length <= 2048
        ? { points: stroke.points.map((point) => ({ x: point.x, y: point.y })) }
        : {}),
    });
    // A stroke always targets a frame the binding knows: a frame from the
    // loaded asset, or one a frame tool inserted and registered below.
    const edited = framesById.get(editedFrameId);
    if (!edited) {
      console.error(`[onStroke] no frame row for ${editedFrameId}`);
      return;
    }
    // Drizzle query promises are lazy: without awaiting or then-ing, the
    // update never executes. Persist explicitly and surface any failure.
    void (async () => {
      try {
        await db
          .update(frames)
          .set({ layers: bufferToFrame(buffer, edited).layers, updatedAt: new Date() })
          .where(eq(frames.id, editedFrameId));
      } catch (error) {
        console.error("[onStroke] frame persist failed", error);
      }
    })();
  };

  const onFrameChange = async (change: FrameChange): Promise<void> => {
    try {
      if (change.type === "add") {
        await insertFrameRow(change.frame);
        await createVersion(db, {
          assetId,
          frameId: change.frame.id,
          scope: "frame",
          kind: "frame-add",
          author: "agent",
          runId: publicRunId,
          snapshot: {
            name: change.frame.name,
            layers: bufferToFrame(change.frame.buffer, change.frame).layers,
          },
        });
      } else if (change.type === "delete") {
        await db
          .delete(frames)
          .where(and(eq(frames.id, change.frameId), eq(frames.assetId, assetId)));
        framesById.delete(change.frameId);
        // The tool replaced the last frame; the row must go before the
        // replacement takes the same (asset, index) slot.
        if (change.replacement) await insertFrameRow(change.replacement);
        // The run row's frame_id pins the asset for the API's active-run
        // guard. When the deleted frame was that pin, it must follow to a
        // frame that still exists — the replacement under the last-frame
        // rule, otherwise the first remaining frame — or the asset would
        // silently unlock mid-run. A pin on another frame is left alone.
        const remaining = [...framesById.values()].sort(
          (left, right) => left.index - right.index,
        );
        const nextPin = change.replacement?.id ?? remaining[0]?.id ?? null;
        await db
          .update(generationRuns)
          .set({ frameId: nextPin })
          .where(
            and(
              eq(generationRuns.id, publicRunId),
              eq(generationRuns.frameId, change.frameId),
            ),
          );
        const after = await loadAsset(assetId);
        if (!after)
          throw new Error("The asset could not be read after the frame change.");
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "frame-delete",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      } else if (change.type === "frame-pixels") {
        // A frame repainted without a stroke: a palette change rewrote its
        // pixels so the colours stay the ones its layers named. The asset row
        // was already updated by the palette change that follows.
        const known = framesById.get(change.frameId);
        if (!known) throw new Error(`Frame ${change.frameId} is not part of this asset.`);
        await db
          .update(frames)
          .set({
            layers: bufferToFrame(change.buffer, { ...known, id: change.frameId }).layers,
            updatedAt: new Date(),
          })
          .where(eq(frames.id, change.frameId));
      } else if (change.type === "palette") {
        // The palette belongs to the asset; persisting it here is what keeps
        // the run's painted pixels readable after the run (their indices
        // would otherwise point at a palette that no longer exists).
        await db
          .update(assets)
          .set({ palette: change.palette, updatedAt: new Date() })
          .where(eq(assets.id, assetId));
        const after = await loadAsset(assetId);
        if (!after) {
          throw new Error("The asset could not be read after the palette change.");
        }
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "palette",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      } else if (change.type === "resize") {
        // The frames were resized through onStroke; the asset row carries the
        // size a reload decodes them against, so it must follow in the same
        // step. Without this the frames were 48×48 while the asset row still
        // said 32×32, and the editor failed to load with "Pixel buffer length
        // 2304 does not match 1024".
        await db
          .update(assets)
          .set({ width: change.width, height: change.height, updatedAt: new Date() })
          .where(eq(assets.id, assetId));
        const after = await loadAsset(assetId);
        if (!after) {
          throw new Error("The asset could not be read after the resize.");
        }
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "resize",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      } else if (change.type === "rename") {
        const live = getRun(durableRunId)?.frames.get(change.frameId);
        if (!live) throw new Error("The frame change could not be saved.");
        await db
          .update(frames)
          .set({ name: change.name, updatedAt: new Date() })
          .where(and(eq(frames.id, change.frameId), eq(frames.assetId, assetId)));
        const row = framesById.get(change.frameId);
        if (row) row.name = change.name;
        await createVersion(db, {
          assetId,
          frameId: change.frameId,
          scope: "frame",
          kind: "rename",
          author: "agent",
          runId: publicRunId,
          snapshot: {
            name: change.name,
            layers: bufferToFrame(live.buffer, {
              id: change.frameId,
              name: change.name,
              index: live.index,
            }).layers,
          },
        });
      } else {
        await db.transaction(async (tx) => {
          // A unique index guards (asset, index), so a direct renumber might
          // collide with a row that has not moved yet. Park every frame far
          // above the final range first, then write the dense order — the
          // same rule store.ts uses for the editor's reorder.
          await tx
            .update(frames)
            .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
            .where(eq(frames.assetId, assetId));
          for (const item of change.order) {
            await tx
              .update(frames)
              .set({ index: item.index, updatedAt: new Date() })
              .where(and(eq(frames.id, item.id), eq(frames.assetId, assetId)));
          }
        });
        for (const item of change.order) {
          const row = framesById.get(item.id);
          if (row) row.index = item.index;
        }
        const after = await loadAsset(assetId);
        if (!after)
          throw new Error("The asset could not be read after the frame change.");
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "frame-move",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      }
      await db
        .update(assets)
        .set({ updatedAt: new Date() })
        .where(eq(assets.id, assetId));
    } catch (error) {
      console.error("[onFrameChange] frame persist failed", error);
      throw new Error("The frame change could not be saved.");
    }
  };

  return { onStroke, onFrameChange };
}

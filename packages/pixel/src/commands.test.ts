import { describe, expect, it } from "vitest";
import { createBuffer, defaultStyle } from "./buffer.js";
import { applyCommand } from "./commands.js";
import { critiqueFrame } from "./critique.js";
import { zoomAt } from "./camera.js";
import { createHistory, pushHistory, redoHistory, undoHistory } from "./history.js";
import {
  addFrame,
  assetFrameBuffer,
  createAsset,
  duplicateFrame,
  mirrorFrame,
  writeFrame,
} from "./document.js";
import { indexOf } from "./pixels.js";
import type { Asset } from "./types.js";

function paint(buffer = createBuffer({ width: 8, height: 8 })) {
  const layerId = buffer.layers[0]?.id ?? "";
  return { buffer, layerId };
}

describe("pixel commands", () => {
  it("paints, rejects coordinates outside the canvas, and undoes", () => {
    const { buffer, layerId } = paint();
    const painted = applyCommand(buffer, {
      type: "paint",
      layerId,
      points: [{ x: 1, y: 2, color: 1 }],
    });
    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    expect(painted.buffer.layers[0]?.pixels[indexOf(8, 1, 2)]).toBe(1);

    const rejected = applyCommand(buffer, {
      type: "paint",
      layerId,
      points: [{ x: 8, y: 0, color: 1 }],
    });
    expect(rejected).toMatchObject({ ok: false, code: "OUT_OF_BOUNDS" });

    const history = pushHistory(createHistory(buffer), painted.buffer);
    expect(undoHistory(history).present.layers[0]?.pixels[indexOf(8, 1, 2)]).toBe(0);
    expect(
      redoHistory(undoHistory(history)).present.layers[0]?.pixels[indexOf(8, 1, 2)],
    ).toBe(1);
  });

  it("fills a connected region and mirrors a frame horizontally", () => {
    const { buffer, layerId } = paint();
    const filled = applyCommand(buffer, { type: "fill", layerId, x: 0, y: 0, color: 2 });
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.buffer.layers[0]?.pixels.every((color) => color === 2)).toBe(true);

    const asset = createAsset({ name: "knight", width: 8, height: 8 });
    const frameId = asset.frames[0]?.id ?? "";
    const source = assetFrameBuffer(asset, frameId);
    if (!source) throw new Error("missing frame");
    const painted = applyCommand(source, {
      type: "paint",
      layerId: source.layers[0]?.id ?? "",
      points: [{ x: 0, y: 0, color: 1 }],
    });
    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    const mirrored = mirrorFrame(writeFrame(asset, frameId, painted.buffer), frameId);
    const result = mirrored ? assetFrameBuffer(mirrored, frameId) : undefined;
    expect(result?.layers[0]?.pixels[indexOf(8, 7, 0)]).toBe(1);
    expect(result?.layers[0]?.pixels[indexOf(8, 0, 0)]).toBe(0);
  });

  it("duplicates a frame and keeps the source silhouette", () => {
    const asset = createAsset({ name: "potion", width: 8, height: 8 });
    const frameId = asset.frames[0]?.id ?? "";
    const copy = duplicateFrame(asset, frameId, "left");
    expect(copy?.frames).toHaveLength(2);
    expect(copy?.frames[1]?.name).toBe("left");
    expect(copy?.frames[1]?.id).not.toBe(frameId);
  });

  it("keeps frame indexes unique after a middle frame is dropped", () => {
    const asset = createAsset({ name: "hero", width: 8, height: 8 });
    const first = asset.frames[0]?.id ?? "";
    const second = addFrame(asset, "walk");
    const third = addFrame(second, "run");
    // Drop the middle frame, which leaves a gap in the index sequence.
    const withoutMiddle: Asset = {
      ...third,
      frames: third.frames.filter((frame) => frame.index !== 1),
    };
    expect(withoutMiddle.frames.map((frame) => frame.index)).toEqual([0, 2]);
    const appended = addFrame(withoutMiddle, "idle-again");
    expect(appended.frames.map((frame) => frame.index)).toEqual([0, 2, 3]);
    const copied = duplicateFrame(appended, first, "left");
    expect(copied?.frames.map((frame) => frame.index)).toEqual([0, 2, 3, 4]);
  });

  it("flags an empty frame and accepts an outlined sprite", () => {
    const buffer = createBuffer({
      width: 8,
      height: 8,
      palette: ["#00000000", "#1a1c2c", "#f4efe4"],
    });
    expect(critiqueFrame(buffer, defaultStyle).map((issue) => issue.code)).toContain(
      "EMPTY",
    );
    const layerId = buffer.layers[0]?.id ?? "";
    const painted = applyCommand(buffer, {
      type: "paint",
      layerId,
      points: [
        { x: 1, y: 1, color: 1 },
        { x: 2, y: 1, color: 2 },
      ],
    });
    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    expect(critiqueFrame(painted.buffer, { maxColors: 8, outline: "#1a1c2c" })).toEqual(
      [],
    );
  });

  it("zooms toward the cursor", () => {
    const next = zoomAt({ x: 10, y: 20, zoom: 2 }, 30, 40, 4);
    const beforeX = (30 - 10) / 2;
    expect((30 - next.x) / next.zoom).toBe(beforeX);
  });

  it("confines a selection flood to the selection rectangle", () => {
    const { buffer, layerId } = paint();
    const wall = applyCommand(buffer, {
      type: "line",
      layerId,
      x0: 3,
      y0: 0,
      x1: 3,
      y1: 7,
      color: 1,
    });
    expect(wall.ok).toBe(true);
    if (!wall.ok) return;
    const flooded = applyCommand(wall.buffer, {
      type: "region",
      layerId,
      x: 0,
      y: 0,
      width: 3,
      height: 8,
      color: 2,
      mode: "flood",
    });
    expect(flooded.ok).toBe(true);
    if (!flooded.ok) return;
    const pixels = flooded.buffer.layers[0]?.pixels ?? new Uint8Array();
    // Inside the selection the flood reaches the wall but not past it.
    expect(pixels[indexOf(8, 2, 4)]).toBe(2);
    // Past the wall is untouched even though it is the same connected region.
    expect(pixels[indexOf(8, 4, 4)]).toBe(0);
    expect(pixels[indexOf(8, 3, 4)]).toBe(1);
  });

  it("fills and clears a selection rectangle and rejects one off the canvas", () => {
    const { buffer, layerId } = paint();
    const filled = applyCommand(buffer, {
      type: "region",
      layerId,
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      color: 3,
      mode: "fill",
    });
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    const filledPixels = filled.buffer.layers[0]?.pixels ?? new Uint8Array();
    expect(filledPixels[indexOf(8, 1, 1)]).toBe(3);
    expect(filledPixels[indexOf(8, 2, 2)]).toBe(3);
    expect(filledPixels[indexOf(8, 3, 3)]).toBe(0);

    const cleared = applyCommand(filled.buffer, {
      type: "region",
      layerId,
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      color: 3,
      mode: "clear",
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.buffer.layers[0]?.pixels[indexOf(8, 1, 1)]).toBe(0);

    expect(
      applyCommand(buffer, {
        type: "region",
        layerId,
        x: 6,
        y: 0,
        width: 4,
        height: 2,
        color: 1,
        mode: "fill",
      }),
    ).toMatchObject({ ok: false, code: "OUT_OF_BOUNDS" });
    // A flood has no per-cell backstop, so the rectangle itself must be rejected.
    expect(
      applyCommand(buffer, {
        type: "region",
        layerId,
        x: 6,
        y: 6,
        width: 6,
        height: 6,
        color: 1,
        mode: "flood",
      }),
    ).toMatchObject({ ok: false, code: "OUT_OF_BOUNDS" });
    // A rectangle flush against the far edge is still valid.
    expect(
      applyCommand(buffer, {
        type: "region",
        layerId,
        x: 5,
        y: 5,
        width: 3,
        height: 3,
        color: 1,
        mode: "flood",
      }),
    ).toMatchObject({ ok: true });
  });

  it("renames, hides, and removes layers while keeping at least one", () => {
    const { buffer, layerId } = paint();
    const added = applyCommand(buffer, {
      type: "addLayer",
      id: "layer-2",
      name: "shade",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.buffer.layers.map((layer) => layer.name)).toEqual(["pixels", "shade"]);

    const renamed = applyCommand(added.buffer, {
      type: "renameLayer",
      layerId: "layer-2",
      name: "  shadow  ",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.buffer.layers[1]?.name).toBe("shadow");
    expect(
      applyCommand(renamed.buffer, { type: "renameLayer", layerId, name: "   " }),
    ).toMatchObject({ ok: false, code: "LAYER_NAME" });

    const hidden = applyCommand(renamed.buffer, {
      type: "setLayerVisible",
      layerId,
      visible: false,
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    expect(hidden.buffer.layers[0]?.visible).toBe(false);

    const removed = applyCommand(hidden.buffer, {
      type: "removeLayer",
      layerId: "layer-2",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.buffer.layers).toHaveLength(1);
    expect(applyCommand(removed.buffer, { type: "removeLayer", layerId })).toMatchObject({
      ok: false,
      code: "LAYER_REQUIRED",
    });
    expect(
      applyCommand(removed.buffer, { type: "removeLayer", layerId: "ghost" }),
    ).toMatchObject({ ok: false, code: "LAYER_NOT_FOUND" });
  });
});

import { describe, expect, it } from "vitest";
import { createBuffer, defaultStyle } from "./buffer.js";
import { applyCommand } from "./commands.js";
import { critiqueFrame } from "./critique.js";
import { zoomAt } from "./camera.js";
import { createHistory, pushHistory, redoHistory, undoHistory } from "./history.js";
import {
  assetFrameBuffer,
  createAsset,
  duplicateFrame,
  mirrorFrame,
  writeFrame,
} from "./document.js";
import { indexOf } from "./pixels.js";

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
});

import { describe, expect, it } from "vitest";
import { checkAnimation, frameStats } from "./animation.js";
import { cloneBuffer, createBuffer } from "./buffer.js";
import { applyCommand } from "./commands.js";
import type { FrameBuffer } from "./types.js";

function painted(points: Array<{ x: number; y: number; color?: number }>): FrameBuffer {
  const buffer = createBuffer({ width: 8, height: 8 });
  const layerId = buffer.layers[0]?.id ?? "";
  const result = applyCommand(buffer, {
    type: "paint",
    layerId,
    points: points.map((point) => ({ ...point, color: point.color ?? 1 })),
  });
  if (!result.ok) throw new Error(result.message);
  return result.buffer;
}

describe("checkAnimation", () => {
  it("reports zero drift for identical frames", () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    const report = checkAnimation([
      { id: "a", buffer },
      { id: "b", buffer: cloneBuffer(buffer) },
    ]);
    expect(report.pairs[0]).toMatchObject({
      changedPixels: 0,
      diffBox: null,
      centroidShift: 0,
      silhouetteDrift: 0,
    });
  });

  it("measures a one-pixel shift", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 2, y: 2 }]) },
      { id: "b", buffer: painted([{ x: 3, y: 2 }]) },
    ]);
    expect(report.pairs[0]!.centroidShift).toBeCloseTo(1, 5);
    expect(report.pairs[0]).toMatchObject({
      from: "a",
      to: "b",
      changedPixels: 2,
      diffBox: { x: 2, y: 2, width: 2, height: 1 },
      silhouetteDrift: 1,
    });
  });

  it("flags a centroid that moves further than two pixels", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 5, y: 5 }]) },
    ]);
    expect(report.pairs[0]!.centroidShift).toBeCloseTo(Math.hypot(4, 4), 5);
    expect(report.flags.some((flag) => flag.includes("centroid"))).toBe(true);
  });

  it("flags a loop that jumps further than any internal pair", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 1, y: 2 }]) },
      { id: "c", buffer: painted([{ x: 1, y: 3 }]) },
    ]);
    expect(report.pairs.map((pair) => pair.centroidShift)).toEqual([1, 1]);
    expect(report.loop.centroidShift).toBeCloseTo(2, 5);
    expect(report.flags).toHaveLength(1);
    expect(report.flags[0]).toContain("loop");
  });

  it("leaves a steady cycle unflagged", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 1, y: 2 }]) },
    ]);
    expect(report.flags).toEqual([]);
  });

  it("flags distinct frames that did not change", () => {
    const buffer = painted([{ x: 4, y: 4 }]);
    const report = checkAnimation([
      { id: "a", buffer },
      { id: "b", buffer: cloneBuffer(buffer) },
      { id: "c", buffer: painted([{ x: 4, y: 5 }]) },
    ]);
    expect(report.flags).toContain("a → b: identical frames");
  });

  it("compares composites: a hidden layer change is no change", () => {
    const buffer = painted([{ x: 1, y: 1 }]);
    const hidden = cloneBuffer(buffer);
    hidden.layers.push({
      id: "hidden",
      name: "hidden",
      visible: false,
      pixels: new Uint8Array(64).fill(2),
    });
    const report = checkAnimation([
      { id: "a", buffer },
      { id: "b", buffer: hidden },
    ]);
    expect(report.pairs[0]!.changedPixels).toBe(0);
  });

  it("treats an empty frame as no silhouette instead of inventing one", () => {
    const empty = createBuffer({ width: 8, height: 8 });
    expect(frameStats(empty)).toEqual({ opaquePixels: 0, centroid: null, bounds: null });
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 2, y: 2 }]) },
      { id: "b", buffer: empty },
    ]);
    expect(report.pairs[0]).toMatchObject({ centroidShift: 0, silhouetteDrift: 0 });
  });

  it("flags a pair whose second frame has no opaque pixels", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 2, y: 2 }]) },
      { id: "b", buffer: createBuffer({ width: 8, height: 8 }) },
    ]);
    expect(report.flags).toContain("Frame b has no opaque pixels.");
    // The metrics stay what they were: no invented centroid, no invented shift.
    expect(report.pairs[0]).toMatchObject({ centroidShift: 0, silhouetteDrift: 0 });
  });

  it("flags a single empty frame", () => {
    const report = checkAnimation([
      { id: "a", buffer: createBuffer({ width: 8, height: 8 }) },
    ]);
    expect(report.flags).toEqual(["Frame a has no opaque pixels."]);
  });

  it("flags an empty frame once even when it pairs twice", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 2, y: 2 }]) },
      { id: "b", buffer: createBuffer({ width: 8, height: 8 }) },
      { id: "c", buffer: painted([{ x: 2, y: 3 }]) },
    ]);
    expect(report.flags.filter((flag) => flag.includes("no opaque pixels"))).toHaveLength(
      1,
    );
  });

  it("reports a single frame as a self-pairing loop with no flags", () => {
    const report = checkAnimation([{ id: "a", buffer: painted([{ x: 2, y: 2 }]) }]);
    expect(report.pairs).toEqual([]);
    expect(report.loop).toMatchObject({
      from: "a",
      to: "a",
      changedPixels: 0,
      centroidShift: 0,
    });
    expect(report.flags).toEqual([]);
  });

  it("refuses frames that are not the same size", () => {
    expect(() =>
      checkAnimation([
        { id: "a", buffer: createBuffer({ width: 8, height: 8 }) },
        { id: "b", buffer: createBuffer({ width: 16, height: 8 }) },
      ]),
    ).toThrow("Frames a and b have different sizes.");
  });

  it("refuses an empty frame list", () => {
    expect(() => checkAnimation([])).toThrow(/at least one frame/);
  });
});

describe("frameStats", () => {
  it("measures the opaque centroid and bounds", () => {
    const buffer = painted([
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
    expect(frameStats(buffer)).toEqual({
      opaquePixels: 2,
      centroid: { x: 2.5, y: 4 },
      bounds: { x: 2, y: 4, width: 2, height: 1 },
    });
  });
});

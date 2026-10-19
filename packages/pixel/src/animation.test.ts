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
    // No shared mass to explain the move: this is the drawing itself sliding.
    expect(report.flags.some((flag) => flag.includes("slides"))).toBe(true);
  });

  it("flags a loop that jumps further than any internal pair", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 1, y: 2 }]) },
      { id: "c", buffer: painted([{ x: 1, y: 3 }]) },
      { id: "d", buffer: painted([{ x: 1, y: 4 }]) },
    ]);
    expect(report.pairs.map((pair) => pair.centroidShift)).toEqual([1, 1, 1]);
    expect(report.loop.centroidShift).toBeCloseTo(3, 5);
    expect(report.flags.some((flag) => flag.includes("loop"))).toBe(true);
  });

  it("lets a loop that only rounds the internal motion through", () => {
    // Two frames walking one pixel apart: the loop is the same size as every
    // internal step, give or take rounding. That is a cycle, not a defect.
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 1, y: 2 }]) },
      { id: "c", buffer: painted([{ x: 1, y: 3 }]) },
    ]);
    // A frame-by-frame walk shares nothing between frames and is not what the
    // reference check is for; it is the caller's different question.
    expect(report.reference.every((row) => row.staticBounds === null)).toBe(true);
  });

  it("names the frame, not the id, in a flag", () => {
    const report = checkAnimation([
      {
        id: "e1fa11b2-8855-485d-ac57-828e39022985",
        name: "nyala-a",
        buffer: painted([{ x: 1, y: 1 }]),
      },
      {
        id: "80211502-a013-4582-a730-66462240a7eb",
        name: "nyala-c",
        buffer: painted([{ x: 7, y: 7 }]),
      },
    ]);
    expect(report.flags.join(" ")).toContain("nyala-c");
    expect(report.flags.join(" ")).not.toContain("80211502");
  });

  it("flags a body that drifted the same way in every frame", () => {
    // Two frames redrew the stand lower than the reference by the same amount:
    // consecutive pairs agree with each other, the reference finds them.
    const body = (top: number) => [
      { x: 0, y: top },
      { x: 1, y: top },
      { x: 2, y: top },
      { x: 1, y: top + 1 },
    ];
    const report = checkAnimation(
      [
        { id: "a", name: "idle", buffer: painted(body(3)) },
        { id: "b", name: "walk", buffer: painted([...body(5), { x: 6, y: 1 }]) },
        { id: "c", name: "run", buffer: painted([...body(5), { x: 6, y: 2 }]) },
      ],
      { referenceId: "a" },
    );
    const referenceFlags = report.flags.filter((flag) =>
      flag.includes("reference frame"),
    );
    expect(referenceFlags).toHaveLength(2);
    expect(referenceFlags.join(" ")).toContain("walk");
  });

  it("reserves the reference check for callers that ask for it", () => {
    const report = checkAnimation([
      { id: "a", buffer: painted([{ x: 1, y: 1 }]) },
      { id: "b", buffer: painted([{ x: 1, y: 2 }]) },
    ]);
    // Without a named reference the checks stay about motion between frames.
    expect(report.flags).toEqual([]);
  });

  it("separates a fixed stand from turning blades", () => {
    // The stand sits on the same pixels in every frame; the blades rotate
    // around it. The unchanged mass is the stand, and it does not move.
    const stand = [
      { x: 0, y: 6 },
      { x: 1, y: 6 },
      { x: 6, y: 6 },
      { x: 0, y: 7 },
      { x: 5, y: 7 },
    ];
    const frame = (blade: Array<{ x: number; y: number }>) =>
      painted([...blade, ...stand]);
    const report = checkAnimation([
      { id: "a", buffer: frame([{ x: 3, y: 2 }]) },
      { id: "b", buffer: frame([{ x: 4, y: 2 }]) },
    ]);
    expect(report.pairs[0]!.staticBounds).toEqual({ x: 0, y: 6, width: 7, height: 2 });
    expect(report.pairs[0]!.staticDrift?.centroid).toBeCloseTo(0, 5);
    expect(report.pairs[0]!.staticDrift?.bounds).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    // The one moved blade is a small mass; the pair's shift stays under the
    // threshold a whole-composite metric would still have flagged.
    expect(report.pairs[0]!.centroidShift).toBeLessThan(1);
    expect(report.flags).toEqual([]);
  });

  it("names a rotated part that changed near the frame edge", () => {
    // Only the columns at x=0 and x=7 survive a rotation in place, so the
    // unchanged mass sits on the outside while the middle turns over.
    const line = (positions: Array<[number, number]>) =>
      painted(positions.map(([x, y], position) => ({ x, y, color: (position % 3) + 1 })));
    const report = checkAnimation([
      {
        id: "a",
        buffer: line([
          [0, 2],
          [0, 5],
          [7, 2],
          [7, 5],
          [3, 3],
          [4, 4],
        ]),
      },
      {
        id: "b",
        buffer: line([
          [0, 2],
          [0, 5],
          [7, 2],
          [7, 5],
          [4, 3],
          [3, 4],
        ]),
      },
    ]);
    expect(report.pairs[0]!.staticBounds).toEqual({ x: 0, y: 2, width: 8, height: 4 });
    expect(report.pairs[0]!.staticDrift?.bounds.top).toBe(0);
    expect(report.pairs[0]!.staticDrift?.centroid).toBeCloseTo(0, 5);
    expect(report.flags).toEqual([]);
  });

  it("stamps a resolved block of indices and mirrors one region", () => {
    const { buffer, layerId } = (() => {
      const created = createBuffer({ width: 8, height: 8 });
      return { buffer: created, layerId: created.layers[0]?.id ?? "" };
    })();
    const stamped = applyCommand(buffer, {
      type: "stamp",
      layerId,
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      pixels: [1, 2, 3, 1],
    });
    expect(stamped.ok).toBe(true);
    const index = (x: number, y: number) => y * 8 + x;
    const pixels = stamped.ok ? stamped.buffer.layers[0]!.pixels : new Uint8Array();
    expect([
      pixels[index(1, 1)],
      pixels[index(2, 1)],
      pixels[index(1, 2)],
      pixels[index(2, 2)],
    ]).toEqual([1, 2, 3, 1]);
    const mirrored = applyCommand(stamped.ok ? stamped.buffer : buffer, {
      type: "mirrorRegion",
      layerId,
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      axis: "horizontal",
    });
    const flipped = mirrored.ok ? mirrored.buffer.layers[0]!.pixels : new Uint8Array();
    expect([flipped[index(1, 1)], flipped[index(2, 1)]]).toEqual([2, 1]);
  });

  it("refuses a stamp with a colour outside the palette or a wrong shape", () => {
    const created = createBuffer({ width: 8, height: 8 });
    const layerId = created.layers[0]?.id ?? "";
    const wrongShape = applyCommand(created, {
      type: "stamp",
      layerId,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      pixels: [1, 2, 3],
    });
    expect(wrongShape.ok).toBe(false);
    const outside = applyCommand(created, {
      type: "stamp",
      layerId,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      pixels: [999],
    });
    expect(outside.ok ? "ok" : outside.code).toBe("PALETTE_INDEX");
    const offCanvas = applyCommand(created, {
      type: "stamp",
      layerId,
      x: 7,
      y: 7,
      width: 2,
      height: 1,
      pixels: [1, 1],
    });
    expect(offCanvas.ok ? "ok" : offCanvas.code).toBe("OUT_OF_BOUNDS");
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
    // An empty frame shares nothing with the reference, and that is named.
  });

  it("names a frame that shares nothing with an explicit reference", () => {
    const report = checkAnimation(
      [
        { id: "a", name: "idle", buffer: painted([{ x: 2, y: 2 }]) },
        { id: "b", name: "walk", buffer: createBuffer({ width: 8, height: 8 }) },
      ],
      { referenceId: "a" },
    );
    expect(
      report.flags.filter((flag) => flag.includes("shares no opaque pixels")),
    ).toHaveLength(1);
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

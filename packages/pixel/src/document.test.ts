import { describe, expect, it } from "vitest";
import { addFrame, createAsset, moveFrame } from "./document.js";

describe("moveFrame", () => {
  it("moves a frame to a new slot and renumbers the whole list", () => {
    const base = createAsset({ name: "walk", width: 8, height: 8 });
    const asset = addFrame(addFrame(addFrame(base, "a"), "b"), "c");
    const names = asset.frames.map((frame) => frame.name);
    expect(names).toEqual(["idle", "a", "b", "c"]);

    const last = asset.frames.at(-1);
    expect(last).toBeDefined();
    const moved = moveFrame(asset, last?.id ?? "", 0);
    expect(moved).toBeDefined();
    expect(moved?.frames.map((frame) => frame.name)).toEqual(["c", "idle", "a", "b"]);
    expect(moved?.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3]);
  });

  it("clamps the target slot and refuses an unknown frame", () => {
    const base = createAsset({ name: "walk", width: 8, height: 8 });
    const asset = addFrame(addFrame(base, "a"), "b");

    const first = asset.frames[0];
    expect(first).toBeDefined();
    const clamped = moveFrame(asset, first?.id ?? "", 99);
    expect(clamped?.frames.map((frame) => frame.name)).toEqual(["a", "b", "idle"]);

    expect(moveFrame(asset, "missing", 0)).toBeUndefined();
  });
});

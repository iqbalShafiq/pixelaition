import { describe, expect, it } from "vitest";
import { referencesForWorker, styleLine } from "./tasks.js";

describe("referencesForWorker", () => {
  const plan = {
    assetId: "a",
    frames: [
      { name: "jalan-a", intent: "", layers: [] },
      { name: "idle", intent: "", layers: [] },
    ],
    palette: [],
    review: true,
    references: [
      { url: "https://x.test/all.png", note: "", appliesTo: "all" as const },
      { url: "https://x.test/walk.png", note: "", appliesTo: ["jalan-a"] },
      { url: "https://x.test/idle.png", note: "", appliesTo: ["idle"] },
    ],
    workers: [
      { key: "w1", frames: ["jalan-a"] },
      { key: "w2", frames: ["idle"] },
    ],
  };
  it("selects the references a worker may view", () => {
    expect(referencesForWorker(plan, "w1")).toEqual([
      "https://x.test/all.png",
      "https://x.test/walk.png",
    ]);
    expect(referencesForWorker(plan, "w2")).toEqual([
      "https://x.test/all.png",
      "https://x.test/idle.png",
    ]);
    expect(referencesForWorker(plan, "w9")).toEqual([]);
  });
});

describe("styleLine", () => {
  it("drops a stale maxColors key from the style line", () => {
    expect(styleLine({ outline: "#1a1c2c", maxColors: 8 })).not.toContain("maxColors");
    expect(styleLine(undefined)).toContain("defaultWidth");
  });
});

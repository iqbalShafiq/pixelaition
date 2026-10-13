import { describe, expect, it } from "vitest";
import { referencesForWorker } from "./tasks.js";

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

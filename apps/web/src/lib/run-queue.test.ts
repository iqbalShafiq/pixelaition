import { describe, expect, it } from "vitest";
import {
  addQueuedRun,
  nextQueuedRun,
  removeQueuedRun,
  removeQueuedRuns,
  reorderQueuedRun,
  type QueuedRun,
} from "./run-queue.js";

const items: QueuedRun[] = [
  { id: "a", text: "first" },
  { id: "b", text: "second" },
  { id: "c", text: "third" },
];

describe("run queue", () => {
  it("adds trimmed text and ignores blanks", () => {
    expect(addQueuedRun([], "  hello  ")).toMatchObject([{ text: "hello" }]);
    expect(addQueuedRun(items, "   ")).toBe(items);
  });

  it("removes one item or a batch", () => {
    expect(removeQueuedRun(items, "b").map((item) => item.id)).toEqual(["a", "c"]);
    expect(removeQueuedRuns(items, new Set(["a", "c"])).map((item) => item.id)).toEqual([
      "b",
    ]);
  });

  it("reorders by index and leaves the list alone for bad input", () => {
    expect(reorderQueuedRun(items, 0, 2).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(reorderQueuedRun(items, 2, 0).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(reorderQueuedRun(items, 1, 1)).toBe(items);
    expect(reorderQueuedRun(items, -1, 2)).toBe(items);
    expect(reorderQueuedRun(items, 0, 9)).toBe(items);
  });

  it("names the first item as the next to run", () => {
    expect(nextQueuedRun(items)?.item.id).toBe("a");
    expect(nextQueuedRun([])).toBeNull();
  });
});

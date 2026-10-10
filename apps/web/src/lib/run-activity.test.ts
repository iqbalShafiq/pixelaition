import { describe, expect, it } from "vitest";
import { applyRunEvent, formatDuration, type RunRow } from "./run-activity.js";

describe("run activity rows", () => {
  it("pairs a tool call with its result", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 3, "tool_call", {
      operationId: "0:tool:3",
      name: "paint_stroke",
      input: { points: [{ x: 1, y: 1, color: 2 }] },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "paint_stroke",
      summary: "1 px",
      state: "running",
    });
    rows = applyRunEvent(rows, 4, "tool_completed", {
      operationId: "0:tool:3",
      result: { failed: false },
    });
    expect(rows[0]).toMatchObject({ kind: "tool", state: "ok" });
  });

  it("keeps the provider error on a failed tool", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "tool_call", {
      operationId: "0:tool:1",
      name: "paint_stroke",
    });
    rows = applyRunEvent(rows, 2, "tool_completed", {
      operationId: "0:tool:1",
      result: { failed: true, error: "That layer is not on this frame." },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      state: "error",
      detail: "That layer is not on this frame.",
    });
  });

  it("marks a reasoning phase without inventing text", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 9, "model_started", { operationId: "0:model:1" });
    expect(rows[0]).toMatchObject({ kind: "phase", label: "thinking", state: "running" });
    rows = applyRunEvent(rows, 10, "model_completed", { operationId: "0:model:1" });
    expect(rows[0]).toMatchObject({ kind: "phase", state: "done" });
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("reasoning");
    }
  });

  it("records terminal status with the provider error", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "status", { status: "running" });
    rows = applyRunEvent(rows, 2, "done", {
      status: "failed",
      error: "Reached max turn limit: 24",
    });
    expect(rows.at(-1)).toMatchObject({ kind: "status", state: "failed" });
  });

  it("merges the tool name when the second event carries it", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 5, "tool_started", { operationId: "0:tool:5" });
    expect(rows[0]).toMatchObject({ kind: "tool", name: "tool" });
    rows = applyRunEvent(rows, 6, "tool_call", {
      operationId: "0:tool:5",
      name: "paint_stroke",
      input: {
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
        ],
      },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "paint_stroke",
      summary: "2 px",
    });
  });

  it("ignores unknown events", () => {
    expect(applyRunEvent([], 1, "heartbeat", {})).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations the way the summary bar reads", () => {
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(121_000)).toBe("2m 01s");
  });
});

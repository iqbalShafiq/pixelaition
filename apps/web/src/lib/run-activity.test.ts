import { describe, expect, it } from "vitest";
import { applyRunEvent, formatDuration, type RunRow } from "./run-activity.js";

// Payloads shaped like the real worker stream (captured from pxl-trial logs):
// tool_started data = { operationId, input: { turn, toolCall: { toolName, input }, args } }
const toolStarted = (operationId: string, toolName: string, input: unknown) => ({
  operationId,
  input: {
    turn: 1,
    toolCall: { type: "tool-call", toolName, input },
    args: JSON.stringify(input),
  },
});

describe("run activity rows", () => {
  it("pairs a tool call with its result", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      3,
      "tool_started",
      toolStarted("0:tool:3", "paint_stroke", {
        layerId: "l1",
        label: "outline",
        points: [
          { x: 1, y: 1, color: 2 },
          { x: 2, y: 1, color: 2 },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "paint_stroke",
      summary: "2 px",
      state: "running",
    });
    rows = applyRunEvent(rows, 4, "tool_completed", {
      operationId: "0:tool:3",
      result: { failed: false },
    });
    expect(rows[0]).toMatchObject({ kind: "tool", state: "ok" });
  });

  it("summarizes the observation tools", () => {
    const rows = applyRunEvent([], 1, "tool_started", {
      input: {
        toolCall: {
          toolName: "read_region",
          input: { x: 0, y: 0, width: 8, height: 8 },
        },
      },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "read_region",
      summary: "8×8",
    });

    const preview = applyRunEvent([], 2, "tool_started", {
      input: {
        toolCall: { toolName: "preview_frame", input: { mode: "strip" } },
      },
    });
    expect(preview[0]).toMatchObject({
      kind: "tool",
      name: "preview_frame",
      summary: "strip",
    });
  });

  it("keeps the provider error on a failed tool", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      1,
      "tool_started",
      toolStarted("0:tool:1", "paint_stroke", { points: [] }),
    );
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

  it("summarizes check_animation with its pair count when nothing is flagged", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      7,
      "tool_started",
      toolStarted("0:tool:7", "check_animation", {}),
    );
    rows = applyRunEvent(rows, 8, "tool_completed", {
      operationId: "0:tool:7",
      result: { failed: false, output: { pairs: 3, flags: 0 } },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "check_animation",
      state: "ok",
      summary: "3 pairs · clean",
    });
  });

  it("summarizes flagged drift by count", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      9,
      "tool_started",
      toolStarted("0:tool:9", "check_animation", { frameIds: ["a", "b"] }),
    );
    rows = applyRunEvent(rows, 10, "tool_completed", {
      operationId: "0:tool:9",
      result: { failed: false, output: { pairs: 2, flags: 2 } },
    });
    expect(rows[0]).toMatchObject({ summary: "2 flags" });
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

  it("keeps the provider error when the terminal done arrives", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "status", { status: "running" });
    rows = applyRunEvent(rows, 2, "status", {
      status: "failed",
      error: "Reached max turn limit: 24",
    });
    rows = applyRunEvent(rows, 3, "done", { status: "failed", effort: "xhigh" });
    expect(rows.at(-1)).toMatchObject({
      kind: "status",
      state: "failed",
      detail: "Reached max turn limit: 24",
    });
  });

  it("ignores unknown events", () => {
    expect(applyRunEvent([], 1, "heartbeat", {})).toEqual([]);
    expect(
      applyRunEvent([], 2, "model_delta", { operationId: "0:model:1", event: {} }),
    ).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations the way the summary bar reads", () => {
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(121_000)).toBe("2m 01s");
  });
});

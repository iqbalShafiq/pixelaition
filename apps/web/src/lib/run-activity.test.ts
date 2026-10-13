import { describe, expect, it } from "vitest";
import {
  applyRunEvent,
  formatDuration,
  groupRowsByWorker,
  type RunRow,
} from "./run-activity.js";

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

  it("summarizes the plan tool by its step count", () => {
    const rows = applyRunEvent(
      [],
      1,
      "tool_started",
      toolStarted("0:tool:1", "plan", { steps: ["sketch", "outline", "color"] }),
    );
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "plan",
      summary: "3 steps",
    });
  });

  it("renders the think scratchpad as a thinking row", () => {
    const rows = applyRunEvent(
      [],
      1,
      "tool_started",
      toolStarted("0:tool:1", "think", { thought: "Try a two-layer build." }),
    );
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "think",
      summary: "thinking",
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

  it("summarizes the drawing primitives", () => {
    const row = (toolName: string, input: unknown) =>
      applyRunEvent([], 1, "tool_started", toolStarted("0:tool:1", toolName, input))[0];
    expect(
      row("erase_stroke", {
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
        ],
      }),
    ).toMatchObject({ kind: "tool", name: "erase_stroke", summary: "2 px" });
    expect(row("draw_line", { from: { x: 0, y: 0 }, to: { x: 3, y: 1 } })).toMatchObject({
      summary: "0,0 → 3,1",
    });
    expect(row("flood_fill", { x: 2, y: 5 })).toMatchObject({ summary: "2,5" });
    expect(row("fill_region", { width: 3, height: 4 })).toMatchObject({
      summary: "3×4",
    });
    expect(row("clear_region", { width: 3, height: 4 })).toMatchObject({
      summary: "3×4",
    });
    expect(row("replace_color", { from: 1, to: 4 })).toMatchObject({
      summary: "1 → 4",
    });
    expect(row("resize_canvas", { width: 16, height: 24 })).toMatchObject({
      summary: "16×24",
    });
    expect(row("dither_rect", { width: 4, height: 2, pattern: "checker" })).toMatchObject(
      { summary: "4×2 checker" },
    );
    expect(row("apply_outline", { color: 1 })).toMatchObject({ summary: "color 1" });
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

  it("maps a created asset to a row carrying the editor link target", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      5,
      "tool_started",
      toolStarted("0:tool:5", "create_asset", {
        projectId: "p1",
        name: "slime-biru",
        width: 32,
        height: 32,
      }),
    );
    rows = applyRunEvent(rows, 6, "asset-created", {
      assetId: "a1",
      projectId: "p1",
      name: "slime-biru",
      width: 32,
      height: 32,
      frameCount: 4,
    });
    expect(rows.at(-1)).toEqual({
      id: "asset-6",
      kind: "asset",
      assetId: "a1",
      projectId: "p1",
      name: "slime-biru",
    });
  });

  it("ignores an asset-created event that does not name its target", () => {
    expect(applyRunEvent([], 1, "asset-created", { name: "slime" })).toEqual([]);
    expect(
      applyRunEvent([], 2, "asset-created", { assetId: "a1", projectId: "p1" }),
    ).toEqual([]);
  });

  it("ignores unknown events", () => {
    expect(applyRunEvent([], 1, "heartbeat", {})).toEqual([]);
    expect(
      applyRunEvent([], 2, "model_delta", { operationId: "0:model:1", event: {} }),
    ).toEqual([]);
  });

  it("leaves the rows unchanged for an interaction or its resolved marker", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(
      rows,
      1,
      "tool_started",
      toolStarted("0:tool:1", "present_plan", {
        summary: "a three-frame slime jump",
        frames: [
          { name: "idle", description: "slime resting" },
          { name: "crouch", description: "slime squashed" },
        ],
      }),
    );
    const before = [...rows];
    const after = applyRunEvent(rows, 2, "interaction", {
      id: "int-1",
      type: "tool-approval",
      toolName: "present_plan",
      input: { summary: "a three-frame slime jump", frames: [] },
    });
    expect(after).toEqual(before);
    expect(after.some((row) => JSON.stringify(row).includes("interaction"))).toBe(false);

    const resolved = applyRunEvent(after, 3, "interaction-resolved", { id: "int-1" });
    expect(resolved).toEqual(before);
  });
});

describe("formatting", () => {
  it("formats durations the way the summary bar reads", () => {
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(121_000)).toBe("2m 01s");
  });
});

describe("task events", () => {
  it("maps worker status, phases, steering, and questions into rows", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "task-phase", { phase: "execute", status: "running" });
    expect(rows.at(-1)).toMatchObject({ kind: "task-phase", phase: "execute" });
    rows = applyRunEvent(rows, 2, "worker-status", {
      workerKey: "w2",
      frames: ["jalan-a"],
      status: "working",
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "worker",
      workerKey: "w2",
      frames: ["jalan-a"],
    });
    rows = applyRunEvent(rows, 3, "steering-routed", {
      routed: "w2",
      message: "the shadow is too light",
      frameName: "jalan-a",
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "steering",
      routed: "w2",
      frameName: "jalan-a",
    });
    rows = applyRunEvent(rows, 4, "question-pending", { workerKey: "w1" });
    expect(rows.at(-1)).toMatchObject({ kind: "question", workerKey: "w1" });
  });

  it("tags rows a mirrored child event created with its worker key", () => {
    const rows = applyRunEvent([], 1, "tool_started", {
      operationId: "run-9",
      toolCall: { toolName: "paint_stroke", input: {} },
      workerKey: "w2",
    });
    expect(rows.at(-1)).toMatchObject({ kind: "tool", workerKey: "w2" });
  });
});

describe("groupRowsByWorker", () => {
  it("puts supervisor rows first, then workers in key order", () => {
    const rows = [
      { id: "1", kind: "tool", name: "paint_stroke", state: "ok", workerKey: "w2" },
      { id: "2", kind: "phase", label: "plan", state: "done" },
      { id: "3", kind: "tool", name: "fill_rect", state: "ok", workerKey: "w1" },
    ] as never[];
    expect(groupRowsByWorker(rows).map((group) => group.workerKey)).toEqual([
      null,
      "w1",
      "w2",
    ]);
  });
});

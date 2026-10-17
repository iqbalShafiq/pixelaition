import { describe, expect, it } from "vitest";
import {
  applyRunEvent,
  consoleTabs,
  groupRowsByWorker,
  noteRow,
  recordFollowUp,
  turnsFromAssetLog,
  rowsFromTaskLog,
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
  it("renders a local note as a settled row, never a spinner", () => {
    // The editor logs its own lines ("The task finished"); a spinner on one of
    // them reads as a still-running task that is not running.
    expect(noteRow("note-1", "The task finished")).toEqual({
      id: "note-1",
      kind: "status",
      label: "The task finished",
      state: "completed",
    });
  });

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

describe("asset log", () => {
  it("pairs each prompt with its own steps, oldest first", () => {
    const turns = turnsFromAssetLog(
      {
        id: "latest",
        prompt: "fix the face",
        runs: [
          {
            id: "plan-2",
            role: "plan",
            workerKey: "plan",
            status: "succeeded",
            answer: null,
            createdAt: "2026-10-16T00:00:00.000Z",
            events: [
              {
                sequence: 1,
                type: "tool_completed",
                data: { operationId: "0:tool:1", result: { failed: false } },
              },
            ],
          },
        ],
      },
      [
        {
          id: "first",
          prompt: "please make the sweet face",
          runs: [
            {
              id: "plan-1",
              role: "plan",
              workerKey: "plan",
              status: "succeeded",
              answer: "planned",
              createdAt: "2026-10-15T00:00:00.000Z",
              events: [],
            },
          ],
        },
      ],
    );
    expect(turns.map((turn) => turn.prompt)).toEqual([
      "please make the sweet face",
      "fix the face",
    ]);
    expect(turns[0]?.rows.some((row) => row.kind === "steering")).toBe(false);
    expect(
      turns[0]?.rows.some(
        (row) => row.kind === "supervisor" && row.message === "planned",
      ),
    ).toBe(true);
    expect(turns[1]?.id).toBe("latest");
  });

  it("attaches each turn's usage, model, and timing", () => {
    const turns = turnsFromAssetLog({
      id: "latest",
      prompt: "fix the face",
      usage: { input: 4, cached: 6, output: 2, cost: 0.01, context: null },
      modelId: "muse-spark-1.3-contributor",
      effort: "high",
      createdAt: "2026-10-16T00:00:00.000Z",
      finishedAt: "2026-10-16T00:01:00.000Z",
      runs: [],
    });
    expect(turns[0]?.meta).toEqual({
      usage: { input: 4, cached: 6, output: 2, cost: 0.01 },
      modelId: "muse-spark-1.3-contributor",
      effort: "high",
      startedAt: "2026-10-16T00:00:00.000Z",
      durationMs: 60_000,
    });
  });
});

describe("usage rows", () => {
  it("carries the newest context state, and null for a malformed one", () => {
    const context = {
      model: {
        modelId: "muse-spark-1.3-contributor",
        context: { contextWindow: 1048576 },
      },
      usedTokens: 1000,
      remainingTokens: 1047576,
      usedPercent: 0.1,
      remainingPercent: 99.9,
    };
    let rows = applyRunEvent([], 1, "usage", { input: 4, context });
    expect(rows[0]).toMatchObject({ kind: "usage", input: 4, context });
    rows = applyRunEvent(rows, 2, "usage", {
      input: 5,
      context: { model: { modelId: "m" }, usedTokens: "many" },
    });
    expect(rows[0]).toMatchObject({ kind: "usage", input: 5, context: null });
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

  it("shows a follow-up once, as the user's own line, on the agent it reached", () => {
    let rows: RunRow[] = [];
    rows = recordFollowUp(rows, {
      id: "local",
      kind: "steering",
      routed: "supervisor",
      message: "draw the whole face",
      requestId: "req-1",
      delivery: "clarify",
    });
    rows = applyRunEvent(rows, 1, "supervisor-says", {
      message: "draw the whole face",
      to: "w1",
      frames: ["sweet-face"],
    });
    rows = applyRunEvent(rows, 2, "steering-routed", {
      routed: "w1",
      message: "draw the whole face",
      frameName: "sweet-face",
      relayed: true,
    });
    const chats = rows.filter((row) => row.kind === "steering");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      message: "draw the whole face",
      routed: "w1",
      frameName: "sweet-face",
      delivery: "relayed",
      requestId: "req-1",
    });
    expect(rows.some((row) => row.kind === "supervisor")).toBe(false);
    const tabs = consoleTabs(rows, false);
    expect(tabs.find((tab) => tab.label === "Agent 1")?.rows).toEqual(chats);
    expect(tabs.find((tab) => tab.id === "all")?.rows).toEqual(chats);
  });

  it("keeps the follow-up text when the run reports that request as applied", () => {
    const noted = recordFollowUp([], {
      id: "local",
      kind: "steering",
      routed: "supervisor",
      message: "darken the blush",
      requestId: "req-9",
      delivery: "queued",
    });
    const applied = applyRunEvent(noted, 4, "steering_applied", { id: "req-9", turn: 3 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      kind: "steering",
      message: "darken the blush",
      delivery: "applied",
    });
    const orphan = applyRunEvent([], 5, "steering_queued", { id: "missing" });
    expect(orphan[0]).toMatchObject({ kind: "tool", name: "follow_up" });
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

  it("puts the review after the workers so it is not buried under the plan", () => {
    const rows = [
      { id: "1", kind: "tool", name: "read_frame", state: "ok", workerKey: "review-1" },
      { id: "2", kind: "tool", name: "paint_stroke", state: "ok", workerKey: "w1" },
      { id: "3", kind: "phase", label: "plan", state: "done" },
    ] as never[];
    expect(groupRowsByWorker(rows).map((group) => group.workerKey)).toEqual([
      null,
      "w1",
      "review-1",
    ]);
  });
});

describe("replayed streams", () => {
  it("keeps one phase row per phase, however often the task republishes it", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "task-phase", { phase: "plan", status: "waiting" });
    rows = applyRunEvent(rows, 2, "task-phase", { phase: "plan", status: "running" });
    rows = applyRunEvent(rows, 1, "task-phase", { phase: "plan", status: "waiting" });
    const phases = rows.filter((row) => row.kind === "task-phase");
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ phase: "plan" });
  });

  it("keeps two children's text apart when their operation ids collide", () => {
    let rows: RunRow[] = [];
    const delta = (runId: string, text: string) => ({
      operationId: "0:model:1",
      runId,
      event: { type: "text", text },
    });
    rows = applyRunEvent(rows, 1, "model_delta", delta("run-1", "first"));
    rows = applyRunEvent(rows, 2, "model_delta", delta("run-2", "second"));
    const texts = rows.filter((row) => row.kind === "supervisor");
    expect(texts).toHaveLength(2);
    const messages = texts.map((row) => (row as { message: string }).message);
    expect(messages).toContain("first");
    expect(messages).toContain("second");
  });

  it("keeps thinking and the reply as two rows of the same model call", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "model_delta", {
      operationId: "0:model:1",
      runId: "plan-run",
      workerKey: "plan",
      event: { type: "reasoning", text: "look at the stripes" },
    });
    rows = applyRunEvent(rows, 2, "model_delta", {
      operationId: "0:model:1",
      runId: "plan-run",
      workerKey: "plan",
      event: { type: "text", text: "four views of a tiger" },
    });
    rows = applyRunEvent(rows, 3, "model_note", {
      operationId: "0:model:1",
      runId: "plan-run",
      workerKey: "plan",
      channel: "thinking",
      text: "look at the stripes, then the tail",
    });
    const notes = rows.filter((row) => row.kind === "supervisor");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      channel: "thinking",
      message: "look at the stripes, then the tail",
    });
    expect(notes[1]).toMatchObject({
      channel: "message",
      message: "four views of a tiger",
    });
  });

  it("keeps markdown line breaks in a streaming thought", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "model_delta", {
      operationId: "0:model:1",
      event: { type: "reasoning", text: "Look at the mane.\n" },
    });
    rows = applyRunEvent(rows, 2, "model_delta", {
      operationId: "0:model:1",
      event: { type: "reasoning", text: "\n- ears\n- tail" },
    });
    const note = rows.find((row) => row.kind === "supervisor");
    expect(note && note.kind === "supervisor" ? note.message : "").toBe(
      "Look at the mane.\n\n- ears\n- tail",
    );
  });
});

describe("console tabs", () => {
  it("orders All, then supervisor, workers, fixes, and the reviewer", () => {
    const rows = rowsFromTaskLog([
      {
        id: "review-run",
        role: "review",
        workerKey: "review-1",
        status: "succeeded",
        answer: "the stripes match",
        createdAt: "2026-10-15T00:02:00.000Z",
        events: [
          { sequence: 1, type: "model_started", data: { operationId: "0:model:1" } },
          {
            sequence: 2,
            type: "tool_started",
            data: toolStarted("0:tool:1", "read_frame", {}),
          },
        ],
      },
      {
        id: "plan-run",
        role: "plan",
        workerKey: "plan",
        status: "succeeded",
        answer: null,
        createdAt: "2026-10-15T00:00:00.000Z",
        events: [
          {
            sequence: 1,
            type: "model_note",
            data: {
              operationId: "0:model:1",
              channel: "message",
              text: "plan the four sides",
            },
          },
        ],
      },
      {
        id: "worker-run",
        role: "worker",
        workerKey: "w1",
        status: "succeeded",
        answer: "painted",
        createdAt: "2026-10-15T00:01:00.000Z",
        events: [
          {
            sequence: 1,
            type: "tool_completed",
            data: { operationId: "0:tool:9", result: { failed: false } },
          },
        ],
      },
    ]);
    const tabs = consoleTabs(rows, true);
    expect(tabs.map((item) => item.label)).toEqual([
      "All",
      "Supervisor",
      "Agent 1",
      "Reviewer 1",
    ]);
    expect(tabs[0]?.rows[0]).toMatchObject({
      kind: "supervisor",
      message: "plan the four sides",
    });
    expect(tabs[0]?.rows.at(-1)).toMatchObject({
      kind: "supervisor",
      message: "the stripes match",
    });
    expect(tabs.every((item) => item.status === "done")).toBe(true);
  });

  it("shows the stored plan when the supervisor's text was not kept", () => {
    const rows = rowsFromTaskLog(
      [
        {
          id: "plan-run",
          role: "plan",
          workerKey: null,
          status: "succeeded",
          answer: null,
          createdAt: "2026-10-15T00:00:00.000Z",
          events: [
            { sequence: 1, type: "model_delta", data: { operationId: "0:model:1" } },
          ],
        },
      ],
      { frames: [{ name: "depan", intent: "face on" }] },
    );
    expect(rows[0]).toMatchObject({
      kind: "supervisor",
      channel: "message",
      workerKey: "plan",
    });
    expect((rows[0] as { message: string }).message).toContain("depan");
    expect(consoleTabs(rows, true).map((item) => item.label)).toEqual([
      "All",
      "Supervisor",
    ]);
  });

  it("spins a tab only while that agent is still working", () => {
    const rows = [
      {
        id: "think",
        kind: "phase",
        label: "thinking",
        state: "running",
        workerKey: "review-1",
      },
      { id: "paint", kind: "tool", name: "paint_stroke", state: "ok", workerKey: "w1" },
    ] as unknown as RunRow[];
    const live = consoleTabs(rows, false);
    expect(live.find((item) => item.label === "Reviewer 1")?.status).toBe("running");
    expect(live.find((item) => item.label === "Agent 1")?.status).toBe("done");
    const settled = consoleTabs(rows, true);
    expect(settled.find((item) => item.label === "Reviewer 1")?.status).toBe("done");
  });
});

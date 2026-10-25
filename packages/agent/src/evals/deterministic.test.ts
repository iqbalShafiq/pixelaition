import { defineMetric, EvalOutcome, runEvalSuite } from "@anvia/core/evals";
import { createBuffer, encodePixels, type FrameBuffer } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import { bindRun, getRun, releaseRun } from "../runs.js";
import { activeLayerId, createPixelTools } from "../tools.js";

type DrawOutput = { summary: string; colors: number };

type CallableTool = {
  call: (
    args: Record<string, unknown>,
    context: { operationId: string },
  ) => Promise<unknown>;
};

function toolFor(name: string): CallableTool {
  const tool = createPixelTools().find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name} tool`);
  return tool as unknown as CallableTool;
}

/** Bind one run with the given frames and the test style guide. */
function bindFrames(
  runId: string,
  frames: Array<{ id: string; name: string; buffer: FrameBuffer }>,
): void {
  const [first] = frames;
  if (!first) throw new Error("bindFrames needs at least one frame");
  bindRun(runId, {
    assetId: "asset",
    assetName: "asset",
    originFrameId: first.id,
    currentFrameId: first.id,
    frames: new Map(
      frames.map((frame, index) => [
        frame.id,
        { name: frame.name, index, buffer: frame.buffer },
      ]),
    ),
    palette: [...first.buffer.palette],
    width: first.buffer.width,
    height: first.buffer.height,
    style: {
      defaultWidth: first.buffer.width,
      defaultHeight: first.buffer.height,
      outline: "#1a1c2c",
      shadowDirection: "down",
      notes: "",
    },
    approvedScope: new Set(frames.map((frame) => frame.id)),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
  });
}

const committedPixels = defineMetric<string, DrawOutput, boolean, unknown>({
  name: "committed_pixels_only",
  dataType: "BOOLEAN",
  evaluate: ({ output }) => {
    if (!output) return EvalOutcome.fail(false, { comment: "missing output" });
    const invented = /#[0-9a-f]{6}/i.test(output.summary);
    return invented
      ? EvalOutcome.fail(false, {
          comment: "summary names a hex the tools did not return",
        })
      : EvalOutcome.pass(true);
  },
});

describe("generation decisions and tools", () => {
  it("commits only in-palette strokes", async () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    bindRun("run-1", {
      assetId: "asset",
      assetName: "asset",
      originFrameId: "frame",
      currentFrameId: "frame",
      frames: new Map([["frame", { name: "frame", index: 0, buffer }]]),
      palette: [...buffer.palette],
      width: 8,
      height: 8,
      style: {
        defaultWidth: 8,
        defaultHeight: 8,
        outline: "#1a1c2c",
        shadowDirection: "down",
        notes: "",
      },
      approvedScope: new Set(["frame"]),
      touchedFrames: new Set(),
      strokes: [],
      issues: [],
    });
    const paint = createPixelTools().find((tool) => tool.name === "paint_stroke") as
      | {
          call: (
            args: {
              layerId: string;
              label: string;
              points: Array<{ x: number; y: number; color: number }>;
            },
            context: { operationId: string },
          ) => Promise<unknown>;
        }
      | undefined;
    if (!paint) throw new Error("missing paint tool");
    const committed = await paint.call(
      {
        layerId: activeLayerId(buffer),
        label: "outline",
        points: [{ x: 1, y: 1, color: 1 }],
      },
      { operationId: "run-1/tool:1" },
    );
    expect(committed).toMatchObject({ committed: 1 });
    await expect(
      paint.call(
        {
          layerId: activeLayerId(buffer),
          label: "bad",
          points: [{ x: 1, y: 1, color: 9 }],
        },
        { operationId: "run-1/tool:2" },
      ),
    ).rejects.toThrow(/palette/i);
    releaseRun("run-1");
    expect(
      encodePixels(buffer.layers[0]?.pixels ?? new Uint8Array()).length,
    ).toBeGreaterThan(0);
  });

  it("edits layers through add, rename, hide, and remove", async () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    bindFrames("run-layers", [{ id: "frame", name: "idle", buffer }]);

    const added = (await toolFor("add_layer").call(
      { name: "shade" },
      { operationId: "run-layers/tool:1" },
    )) as { layerId: string };
    expect(added).toMatchObject({ name: "shade", layers: 2 });

    expect(
      await toolFor("rename_layer").call(
        { layerId: added.layerId, name: "shadow" },
        { operationId: "run-layers/tool:2" },
      ),
    ).toMatchObject({ layerId: added.layerId, name: "shadow" });

    expect(
      await toolFor("set_layer_visible").call(
        { layerId: added.layerId, visible: false },
        { operationId: "run-layers/tool:3" },
      ),
    ).toMatchObject({ layerId: added.layerId, visible: false });

    expect(
      await toolFor("remove_layer").call(
        { layerId: added.layerId },
        { operationId: "run-layers/tool:4" },
      ),
    ).toMatchObject({ layers: 1 });

    // The last layer is what the frame is; the command refuses to strip it.
    await expect(
      toolFor("remove_layer").call(
        { layerId: activeLayerId(buffer) },
        { operationId: "run-layers/tool:5" },
      ),
    ).rejects.toThrow(/at least one layer/i);
    releaseRun("run-layers");
  });

  it("think returns the thought and changes no pixels", async () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    bindFrames("run-think", [{ id: "frame", name: "idle", buffer }]);

    expect(
      await toolFor("think").call(
        { thought: "silhouette before shading" },
        { operationId: "run-think/tool:1" },
      ),
    ).toBe("silhouette before shading");

    const pixels =
      getRun("run-think")?.frames.get("frame")?.buffer.layers[0]?.pixels ??
      new Uint8Array();
    expect(pixels.every((value) => value === 0)).toBe(true);
    releaseRun("run-think");
  });

  it("check_animation reports every pair and the loop", async () => {
    const first = createBuffer({ width: 8, height: 8 });
    const second = createBuffer({ width: 8, height: 8 });
    const firstLayer = first.layers[0];
    const secondLayer = second.layers[0];
    if (!firstLayer || !secondLayer) throw new Error("missing layer");
    firstLayer.pixels[0] = 1; // (0, 0)
    secondLayer.pixels[1] = 1; // (1, 0), a one-pixel walk

    bindFrames("run-anim", [
      { id: "a", name: "walk-1", buffer: first },
      { id: "b", name: "walk-2", buffer: second },
    ]);
    const report = (await toolFor("check_animation").call(
      {},
      { operationId: "run-anim/tool:1" },
    )) as {
      pairs: Array<{ from: string; to: string; changedPixels: number }>;
      loop: { from: string; to: string; changedPixels: number };
      flags: string[];
      frames: unknown[];
    };

    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]).toMatchObject({ from: "a", to: "b", changedPixels: 2 });
    expect(report.loop).toMatchObject({ from: "b", to: "a", changedPixels: 2 });
    // A one-pixel walk shares no mass with the first frame, and the report
    // says so by name rather than leaving the reader to notice a blank row.
    expect(report.flags).toEqual([
      "walk-2 shares no opaque pixels with the reference frame walk-1 — the drawing changed entirely",
    ]);
    expect(report.frames).toHaveLength(2);
    releaseRun("run-anim");
  });

  it("draws through the primitives without inventing pixels", async () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    bindFrames("run-primitives", [{ id: "frame", name: "idle", buffer }]);
    const layerId = activeLayerId(buffer);

    expect(
      await toolFor("draw_line").call(
        { layerId, label: "edge", from: { x: 0, y: 0 }, to: { x: 3, y: 0 }, color: 1 },
        { operationId: "run-primitives/tool:1" },
      ),
    ).toMatchObject({ committed: 4 });

    expect(
      await toolFor("flood_fill").call(
        { layerId, x: 5, y: 5, color: 2 },
        { operationId: "run-primitives/tool:2" },
      ),
    ).toMatchObject({ committed: true });

    expect(
      await toolFor("clear_region").call(
        { layerId, x: 0, y: 0, width: 2, height: 2 },
        { operationId: "run-primitives/tool:3" },
      ),
    ).toMatchObject({ committed: true });

    expect(
      await toolFor("dither_rect").call(
        {
          layerId,
          x: 4,
          y: 4,
          width: 4,
          height: 4,
          colorA: 1,
          colorB: 2,
          pattern: "checker",
        },
        { operationId: "run-primitives/tool:4" },
      ),
    ).toMatchObject({ committed: true });

    expect(
      await toolFor("replace_color").call(
        { from: 2, to: 3 },
        { operationId: "run-primitives/tool:5" },
      ),
    ).toMatchObject({ committed: true });

    expect(
      await toolFor("apply_outline").call(
        { color: 1 },
        { operationId: "run-primitives/tool:6" },
      ),
    ).toMatchObject({ committed: true, color: 1 });
    releaseRun("run-primitives");
  });

  it("evaluates groups, timeline, slices, and background cleanup through the eval runner", async () => {
    const buffer = createBuffer({ width: 8, height: 8 });
    const layerId = activeLayerId(buffer);
    const layer = buffer.layers.find((item) => item.id === layerId);
    if (!layer) throw new Error("missing layer");
    layer.pixels.fill(1);
    const changes: Array<{ type: string }> = [];
    bindRun("run-workflow", {
      assetId: "asset",
      assetName: "asset",
      originFrameId: "frame-a",
      currentFrameId: "frame-a",
      frames: new Map([
        ["frame-a", { name: "idle", index: 0, buffer, durationMs: 100 }],
        [
          "frame-b",
          {
            name: "walk",
            index: 1,
            buffer: createBuffer({ width: 8, height: 8, palette: buffer.palette }),
            durationMs: 120,
          },
        ],
      ]),
      palette: [...buffer.palette],
      width: 8,
      height: 8,
      tags: [],
      slices: [],
      style: {
        defaultWidth: 8,
        defaultHeight: 8,
        outline: "#1a1c2c",
        shadowDirection: "down",
        notes: "",
      },
      approvedScope: new Set(["frame-a", "frame-b"]),
      touchedFrames: new Set(),
      strokes: [],
      issues: [],
      onFrameChange: (change) => {
        changes.push(change as { type: string });
      },
    });

    const timelineMetric = defineMetric<boolean, { ok: boolean }, boolean, unknown>({
      name: "timeline_complete",
      dataType: "BOOLEAN",
      evaluate: ({ output }) =>
        output?.ok
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, { comment: "timeline/slices/groups incomplete" }),
    });

    const result = await runEvalSuite({
      name: "pixelaition-workflow-tools",
      cases: [{ id: "workflow", input: true, expected: true }],
      target: async (): Promise<{ ok: boolean }> => {
        const group = (await toolFor("add_layer_group").call(
          { name: "lighting" },
          { operationId: "run-workflow/tool:1" },
        )) as { groupId: string };
        await toolFor("move_layer_to_group").call(
          { layerId, groupId: group.groupId },
          { operationId: "run-workflow/tool:2" },
        );
        await toolFor("set_layer_group_opacity").call(
          { groupId: group.groupId, opacity: 0.5 },
          { operationId: "run-workflow/tool:3" },
        );
        await toolFor("set_frame_duration").call(
          { frameId: "frame-b", durationMs: 180 },
          { operationId: "run-workflow/tool:4" },
        );
        await toolFor("set_tags").call(
          {
            tags: [
              {
                name: "walk",
                fromFrameId: "frame-a",
                toFrameId: "frame-b",
                direction: "pingpong",
                loop: true,
              },
            ],
          },
          { operationId: "run-workflow/tool:5" },
        );
        await toolFor("set_slices").call(
          {
            slices: [
              {
                name: "button",
                x: 0,
                y: 0,
                width: 4,
                height: 4,
                pivot: { x: 2, y: 2 },
              },
            ],
          },
          { operationId: "run-workflow/tool:6" },
        );
        await toolFor("remove_background").call(
          { layerId },
          { operationId: "run-workflow/tool:7" },
        );
        await toolFor("create_variant").call(
          {
            frameId: "frame-b",
            name: "walk-mirror",
            mirror: "horizontal",
            remap: buffer.palette.map((_, index) => index),
          },
          { operationId: "run-workflow/tool:9" },
        );
        await toolFor("check_tiling").call(
          { frameId: "frame-a" },
          { operationId: "run-workflow/tool:8" },
        );
        const live = getRun("run-workflow");
        const alpha = live?.frames.get("frame-a")?.buffer.layers[0]?.pixels;
        return {
          ok:
            live?.tags?.length === 1 &&
            live.slices?.length === 1 &&
            live.frames.get("frame-a")?.buffer.groups?.length === 1 &&
            live.frames.get("frame-b")?.durationMs === 180 &&
            live.frames.size === 3 &&
            alpha !== undefined &&
            [...alpha].every((value) => value === 0) &&
            changes.some((change) => change.type === "slices") &&
            changes.some((change) => change.type === "tags") &&
            changes.some((change) => change.type === "duration"),
        };
      },
      metrics: [timelineMetric],
    });
    expect(result.results[0]?.outcome).toBe("pass");
    releaseRun("run-workflow");
  });

  it("fails a summary that invents a color", async () => {
    const result = await runEvalSuite({
      name: "pixelaition-draws",
      cases: [
        { id: "honest", input: "knight", expected: true },
        { id: "invented", input: "potion", expected: false },
      ],
      target: (input: string): DrawOutput => ({
        summary: input === "potion" ? "Used #ff00aa" : "32 by 32, 4 colors",
        colors: 4,
      }),
      metrics: [committedPixels],
    });
    const invented = result.results.find((item) => item.case.id === "invented");
    const honest = result.results.find((item) => item.case.id === "honest");
    expect(honest?.outcome).toBe("pass");
    expect(invented?.outcome).toBe("fail");
  });
});

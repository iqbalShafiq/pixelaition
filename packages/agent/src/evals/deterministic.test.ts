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
      maxColors: first.buffer.palette.length,
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
      originFrameId: "frame",
      currentFrameId: "frame",
      frames: new Map([["frame", { name: "frame", index: 0, buffer }]]),
      palette: [...buffer.palette],
      width: 8,
      height: 8,
      style: {
        defaultWidth: 8,
        defaultHeight: 8,
        maxColors: 8,
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
    expect(report.flags).toEqual([]);
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

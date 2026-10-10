import { defineMetric, EvalOutcome, runEvalSuite } from "@anvia/core/evals";
import { createBuffer, encodePixels } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import { bindRun, releaseRun } from "../runs.js";
import { activeLayerId, createPixelTools } from "../tools.js";

type DrawOutput = { summary: string; colors: number };

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
      frameId: "frame",
      style: {
        defaultWidth: 8,
        defaultHeight: 8,
        maxColors: 8,
        outline: "#1a1c2c",
        shadowDirection: "down",
        notes: "",
      },
      buffer,
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

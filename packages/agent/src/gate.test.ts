import { createBuffer, defaultStyle, hexToColor, writeCell } from "@pixelaition/pixel";
import { afterEach, describe, expect, it } from "vitest";
import { gateIsHarmless, gateToolCall, toGateOutcome } from "./gate.js";
import type { RunBinding } from "./runs.js";

const run: RunBinding = {
  request: "clear the background around the slime",
  frames: new Map(),
  palette: ["#00000000", "#f4f4f4"],
  style: defaultStyle,
  approvedScope: new Set(),
  touchedFrames: new Set(),
  strokes: [],
  issues: [],
};

const savedKey = process.env.DECISION_MODEL_API_KEY;
const savedModel = process.env.DECISION_MODEL;
const savedBaseUrl = process.env.DECISION_MODEL_BASE_URL;

afterEach(() => {
  if (savedKey === undefined) delete process.env.DECISION_MODEL_API_KEY;
  else process.env.DECISION_MODEL_API_KEY = savedKey;
  if (savedModel === undefined) delete process.env.DECISION_MODEL;
  else process.env.DECISION_MODEL = savedModel;
  if (savedBaseUrl === undefined) delete process.env.DECISION_MODEL_BASE_URL;
  else process.env.DECISION_MODEL_BASE_URL = savedBaseUrl;
});

describe("jev tool gate", () => {
  it("approves only when both checks are at or above the threshold", () => {
    expect(toGateOutcome({ supported: 0.95, proportionate: 0.9 }).outcome).toBe(
      "approve",
    );
    expect(toGateOutcome({ supported: 0.89, proportionate: 0.99 }).outcome).toBe(
      "review",
    );
  });

  it("blocks when either check is at or below the threshold", () => {
    const unsupported = toGateOutcome({ supported: 0.05, proportionate: 0.95 });
    expect(unsupported.outcome).toBe("block");
    expect(unsupported.reason).toContain("not supported by the request");
    expect(toGateOutcome({ supported: 0.95, proportionate: 0.1 }).outcome).toBe("block");
  });

  it("keeps the middle band for review, with every probability named", () => {
    const review = toGateOutcome({ supported: 0.62, proportionate: 0.55 });
    expect(review.outcome).toBe("review");
    expect(review.reason).toContain("supported=0.62");
    expect(review.reason).toContain("proportionate=0.55");
  });

  it("judges a single-question call on that question alone", () => {
    expect(toGateOutcome({ supported: 0.91 }).outcome).toBe("approve");
    expect(toGateOutcome({ supported: 0.6 }).outcome).toBe("review");
    expect(toGateOutcome({ supported: 0.08 }).outcome).toBe("block");
  });

  it("names the missing configuration instead of guessing", async () => {
    delete process.env.DECISION_MODEL_API_KEY;
    delete process.env.DECISION_MODEL;
    delete process.env.DECISION_MODEL_BASE_URL;
    await expect(gateToolCall(run, "clear_region", { x: 0, y: 0 })).rejects.toThrow(
      "Set DECISION_MODEL, DECISION_MODEL_BASE_URL, and DECISION_MODEL_API_KEY",
    );
  });

  it("refuses to judge a tool that is not on the gate", async () => {
    await expect(gateToolCall(run, "paint_stroke", {})).rejects.toThrow(
      "does not pass the Jev request check",
    );
  });

  it("treats a call that cannot touch a painted pixel as harmless", () => {
    const bound = (painted: number[]): { run: RunBinding; layerId: string } => {
      const buffer = createBuffer({
        width: 8,
        height: 8,
        palette: ["#00000000", "#f4f4f4"],
        layerName: "pixels",
      });
      painted.forEach((value, index) => {
        writeCell(
          buffer.layers[0]!.pixels,
          index,
          hexToColor(buffer.palette[value] ?? "#00000000") ?? 0,
        );
      });
      const layerId = buffer.layers[0]!.id;
      return {
        layerId,
        run: {
          assetId: "asset-1",
          assetName: "slime",
          request: "draw a slime",
          originFrameId: "frame-1",
          currentFrameId: "frame-1",
          frames: new Map([["frame-1", { name: "idle", index: 0, buffer }]]),
          palette: ["#00000000", "#f4f4f4"],
          width: 8,
          height: 8,
          style: defaultStyle,
          approvedScope: new Set(["frame-1"]),
          touchedFrames: new Set(),
          strokes: [],
          issues: [],
        },
      };
    };

    const blank = bound([]);
    expect(gateIsHarmless(blank.run, "set_palette", {})).toBe(true);
    expect(
      gateIsHarmless(blank.run, "clear_region", {
        layerId: blank.layerId,
        x: 0,
        y: 0,
        width: 8,
        height: 8,
      }),
    ).toBe(true);
    expect(gateIsHarmless(blank.run, "replace_color", { from: 1, to: 0 })).toBe(true);

    const painted = bound([1]);
    expect(gateIsHarmless(painted.run, "set_palette", {})).toBe(false);
    expect(
      gateIsHarmless(painted.run, "clear_region", {
        layerId: painted.layerId,
        x: 0,
        y: 0,
        width: 8,
        height: 8,
      }),
    ).toBe(false);
    expect(
      gateIsHarmless(painted.run, "clear_region", {
        layerId: painted.layerId,
        x: 2,
        y: 2,
        width: 2,
        height: 2,
      }),
    ).toBe(true);
    expect(gateIsHarmless(painted.run, "replace_color", { from: 1, to: 0 })).toBe(false);
    expect(
      gateIsHarmless(painted.run, "remove_layer", { layerId: painted.layerId }),
    ).toBe(false);
    // A malformed call is never harmless: the check cannot vouch for it.
    expect(gateIsHarmless(blank.run, "clear_region", { layerId: blank.layerId })).toBe(
      false,
    );
    expect(gateIsHarmless(blank.run, "replace_color", {})).toBe(false);
  });
});

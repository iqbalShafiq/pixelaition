import { defaultStyle } from "@pixelaition/pixel";
import { afterEach, describe, expect, it } from "vitest";
import { gateToolCall, toGateOutcome } from "./gate.js";
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

const savedKey = process.env.OPENROUTER_API_KEY;
const savedModel = process.env.JEV_MODEL;

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  if (savedModel === undefined) delete process.env.JEV_MODEL;
  else process.env.JEV_MODEL = savedModel;
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

  it("keeps the middle band for review, with both probabilities named", () => {
    const review = toGateOutcome({ supported: 0.62, proportionate: 0.55 });
    expect(review.outcome).toBe("review");
    expect(review.reason).toContain("supported=0.62");
    expect(review.reason).toContain("proportionate=0.55");
  });

  it("names the missing configuration instead of guessing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_MODEL;
    await expect(
      gateToolCall(run, "clear_region", "Clear a rectangle.", { x: 0, y: 0 }),
    ).rejects.toThrow("Set OPENROUTER_API_KEY and JEV_MODEL");
  });
});

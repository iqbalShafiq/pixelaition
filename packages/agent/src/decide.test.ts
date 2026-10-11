import { describe, expect, it } from "vitest";
import { DecisionNotConfiguredError, decidePrompt, toDecision } from "./decide.js";

describe("jev decisions", () => {
  it("refuses to decide without a configured key and model", async () => {
    await expect(decidePrompt("a 32x32 potion bottle", {})).rejects.toBeInstanceOf(
      DecisionNotConfiguredError,
    );
    await expect(
      decidePrompt("a 32x32 potion bottle", { apiKey: "not-a-real-key" }),
    ).rejects.toBeInstanceOf(DecisionNotConfiguredError);
  });

  it("propagates provider failures instead of deciding offline", async () => {
    await expect(
      decidePrompt("a 32x32 potion bottle", {
        apiKey: "not-a-real-key",
        model: "typesafe/jev-1.13",
        decisionsUrl: "http://127.0.0.1:9/decisions",
      }),
    ).rejects.toThrow();
  });

  it("maps Jev answers onto the draw intent", () => {
    expect(
      toDecision({
        intent: { choice: "variant", confidence: 0.82 },
        specific: { noul: 0.95 },
      }),
    ).toEqual({ intent: "variant", confidence: 0.82, source: "jev" });

    expect(
      toDecision({
        intent: { choice: "draw", confidence: 0.9 },
        specific: { noul: 0.4 },
      }),
    ).toEqual({
      intent: "clarify",
      confidence: 0.4,
      question:
        "What should the pixel asset show, and about how many pixels wide should it be?",
      source: "jev",
    });

    expect(
      toDecision({
        intent: { choice: "clarify", confidence: 0.88 },
        specific: { noul: 0.9 },
      }),
    ).toMatchObject({ intent: "clarify", confidence: 0.88, source: "jev" });

    // An answer outside the option set is not a decision to draw.
    expect(
      toDecision({ intent: { choice: "paint" }, specific: { noul: 0.95 } }).intent,
    ).toBe("clarify");
  });
});

import { describe, expect, it } from "vitest";
import { DecisionNotConfiguredError, decidePrompt, toDecision } from "./decide.js";

describe("draw decisions", () => {
  it("refuses to decide without a configured model", async () => {
    await expect(decidePrompt("a 32x32 potion bottle", {})).rejects.toBeInstanceOf(
      DecisionNotConfiguredError,
    );
  });

  it("propagates provider failures instead of deciding offline", async () => {
    await expect(
      decidePrompt("a 32x32 potion bottle", {
        openaiApiKey: "not-a-real-key",
        openaiBaseUrl: "http://127.0.0.1:9/v1",
        decisionModel: "muse-spark-1.3-contributor",
        decisionApi: "responses",
      }),
    ).rejects.toThrow();
  });

  it("maps a structured decision onto the draw intent", () => {
    expect(toDecision({ intent: "variant", confidence: 0.82 }, "model")).toEqual({
      intent: "variant",
      confidence: 0.82,
      source: "model",
    });
    expect(
      toDecision({ intent: "clarify", confidence: 0.9, question: "What size?" }, "model"),
    ).toEqual({
      intent: "clarify",
      confidence: 0.9,
      question: "What size?",
      source: "model",
    });
  });
});

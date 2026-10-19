import { describe, expect, it } from "vitest";
import {
  applyJevUsage,
  applyModelUsage,
  contextFromResponse,
  emptyUsage,
  mergeUsage,
  type ContextUsage,
} from "./usage.js";

const context: ContextUsage = {
  model: { modelId: "muse-spark-1.3-contributor", context: { contextWindow: 1048576 } },
  usedTokens: 120_000,
  remainingTokens: 928_576,
  usedPercent: 11.4,
  remainingPercent: 88.6,
};

describe("run usage accounting", () => {
  it("starts empty with no context state", () => {
    expect(emptyUsage()).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cached: 0,
      cost: 0,
      modelCalls: 0,
      modelCost: 0,
      jevCalls: 0,
      jevCost: 0,
      context: null,
    });
  });

  it("splits cached input out of the provider's input and bills its cost", () => {
    const totals = emptyUsage();
    applyModelUsage(
      totals,
      { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 6 },
      0.002,
      undefined,
    );
    expect(totals).toMatchObject({
      input: 4,
      cached: 6,
      output: 4,
      total: 14,
      cost: 0.002,
      modelCalls: 1,
      modelCost: 0.002,
      jevCalls: 0,
      jevCost: 0,
    });
  });

  it("keeps only the newest generation's context state", () => {
    const totals = emptyUsage();
    applyModelUsage(
      totals,
      { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      undefined,
      context,
    );
    const newer: ContextUsage = {
      ...context,
      usedTokens: 200_000,
      usedPercent: 19.1,
      remainingPercent: 80.9,
    };
    applyModelUsage(
      totals,
      { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      undefined,
      newer,
    );
    expect(totals.context).toEqual(newer);
    // A generation without context data (an older persisted shape, or a model
    // with no declared window) never wipes the newest state.
    applyModelUsage(
      totals,
      { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      undefined,
      undefined,
    );
    expect(totals.context).toEqual(newer);
  });

  it("bills Jev without touching the model buckets", () => {
    const totals = emptyUsage();
    applyJevUsage(totals, { input: 3, output: 1, total: 4, cost: 0.00005 });
    expect(totals).toMatchObject({
      input: 3,
      output: 1,
      total: 4,
      cost: 0.00005,
      modelCalls: 0,
      modelCost: 0,
      jevCalls: 1,
      jevCost: 0.00005,
    });
  });

  it("merges a persisted rollup and takes its context when defined", () => {
    const totals = emptyUsage();
    mergeUsage(totals, { context });
    mergeUsage(totals, {
      input: 4,
      output: 2,
      total: 6,
      cached: 6,
      cost: 0.01,
      modelCalls: 3,
      modelCost: 0.009,
      jevCalls: 1,
      jevCost: 0.001,
      context: null,
    });
    expect(totals).toMatchObject({
      input: 4,
      output: 2,
      total: 6,
      cached: 6,
      cost: 0.01,
      modelCalls: 3,
      modelCost: 0.009,
      jevCalls: 1,
      jevCost: 0.001,
    });
    // A null context in the part means "no context to report", not "clear it".
    expect(totals.context).toEqual(context);
    const newer = { ...context, usedTokens: 300_000 };
    mergeUsage(totals, { context: newer });
    expect(totals.context).toEqual(newer);
  });

  it("accepts only a well-formed contextUsage from a response", () => {
    expect(contextFromResponse({ ...context })).toEqual(context);
    for (const bad of [
      undefined,
      null,
      {},
      { ...context, usedPercent: "11" },
      { ...context, usedTokens: undefined },
      { ...context, model: { modelId: "m" } },
      { ...context, model: { modelId: "", context: { contextWindow: 1 } } },
      { ...context, model: { modelId: "m", context: { contextWindow: 0 } } },
    ]) {
      expect(contextFromResponse(bad)).toBeUndefined();
    }
  });
});

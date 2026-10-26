import { describe, expect, it } from "vitest";
import {
  contextFromUsage,
  contextTone,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  formatWindow,
  headerTotals,
  sessionTotalsFrom,
  turnMetaFromTask,
  turnUsageFrom,
  userMetaParts,
  userMetaText,
  type SessionTotals,
  type TurnMeta,
} from "./run-usage.js";

const liveContext = {
  model: { modelId: "deepseek-v4.1-flash", context: { contextWindow: 1048576 } },
  usedTokens: 500_000,
  remainingTokens: 548_576,
  usedPercent: 47.68,
  remainingPercent: 52.32,
};

const session: SessionTotals = {
  cost: 0.75,
  input: 105,
  cached: 21,
  output: 12,
  total: 137,
  elapsedMs: 90_000,
  context: {
    model: {
      modelId: "muse-spark-1.3-contributor",
      context: { contextWindow: 1048576 },
    },
    usedTokens: 120_000,
    remainingTokens: 928_576,
    usedPercent: 11.44,
    remainingPercent: 88.56,
  },
  modelId: "muse-spark-1.3-contributor",
  contextWindow: 1048576,
};

const meta = (overrides: Partial<TurnMeta> = {}): TurnMeta => ({
  usage: null,
  modelId: null,
  effort: null,
  startedAt: null,
  durationMs: null,
  ...overrides,
});

describe("context state", () => {
  it("accepts only a well-formed contextUsage", () => {
    expect(contextFromUsage(liveContext)).toEqual(liveContext);
    for (const bad of [
      undefined,
      null,
      {},
      { ...liveContext, usedTokens: "500" },
      { ...liveContext, model: {} },
      { ...liveContext, model: { modelId: "m", context: { contextWindow: 0 } } },
    ]) {
      expect(contextFromUsage(bad)).toBeNull();
    }
  });
});

describe("turn usage", () => {
  it("reads the token and cost buckets off a persisted usage blob", () => {
    expect(
      turnUsageFrom({ input: 4, cached: 6, output: 2, total: 12, cost: 0.01 }),
    ).toEqual({ input: 4, cached: 6, output: 2, cost: 0.01 });
    expect(turnUsageFrom({ cost: 0.5 })).toEqual({
      input: 0,
      cached: 0,
      output: 0,
      cost: 0.5,
    });
    expect(turnUsageFrom(null)).toBeNull();
    expect(turnUsageFrom("usage")).toBeNull();
  });
});

describe("session totals", () => {
  it("accepts only a complete, well-formed session payload", () => {
    expect(sessionTotalsFrom(session)).toEqual(session);
    expect(sessionTotalsFrom({ ...session, context: null })).toEqual({
      ...session,
      context: null,
    });
    for (const bad of [
      undefined,
      null,
      { ...session, cost: "0.75" },
      { ...session, elapsedMs: undefined },
      { cost: 1 },
    ]) {
      expect(sessionTotalsFrom(bad)).toBeNull();
    }
  });

  it("adds the live turn's cost, elapsed, and tokens and prefers its context state", () => {
    const nowMs = 1_000_000;
    const totals = headerTotals(
      session,
      {
        startedAtMs: nowMs - 30_000,
        cost: 0.25,
        input: 5,
        cached: 4,
        output: 3,
        context: liveContext,
      },
      nowMs,
    );
    expect(totals).toEqual({
      cost: 1,
      elapsedMs: 120_000,
      input: 110,
      cached: 25,
      output: 15,
      context: liveContext,
    });
    // Without a live context state the settled one stays.
    expect(
      headerTotals(
        session,
        {
          startedAtMs: nowMs - 30_000,
          cost: 0,
          input: 0,
          cached: 0,
          output: 0,
          context: null,
        },
        nowMs,
      )?.context,
    ).toEqual(session.context);
    // A live turn with no server start yet contributes only its cost and tokens.
    expect(
      headerTotals(
        null,
        { startedAtMs: null, cost: 0.1, input: 5, cached: 4, output: 3, context: null },
        nowMs,
      ),
    ).toEqual({
      cost: 0.1,
      elapsedMs: 0,
      input: 5,
      cached: 4,
      output: 3,
      context: null,
    });
    expect(headerTotals(null, null, nowMs)).toBeNull();
  });
});

describe("formatting", () => {
  it("warms the context bar toward danger as the window fills", () => {
    expect(contextTone(0)).toBe("calm");
    expect(contextTone(69.9)).toBe("calm");
    expect(contextTone(70)).toBe("warm");
    expect(contextTone(89.9)).toBe("warm");
    expect(contextTone(90)).toBe("danger");
    expect(contextTone(100)).toBe("danger");
  });

  it("formats small costs without losing their scale", () => {
    expect(formatCost(0.0431)).toBe("$0.04");
    expect(formatCost(0.0042)).toBe("$0.00420");
    expect(formatCost(12.3)).toBe("$12.30");
  });

  it("formats tokens and windows the way the header reads", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(189_200)).toBe("189.2k");
    expect(formatWindow(1048576)).toBe("1M");
    expect(formatWindow(2_097_152)).toBe("2M");
    expect(formatWindow(500_000)).toBe("500k");
    expect(formatWindow(512)).toBe("512");
  });

  it("formats durations from seconds to minutes", () => {
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(121_000)).toBe("2m 01s");
    expect(formatDuration(1_319_600)).toBe("22m 00s");
    expect(formatDuration(3_599_600)).toBe("60m 00s");
  });

  it("reads the send time as a clock, adding the date on older turns", () => {
    const now = new Date(2026, 9, 17, 14, 40).getTime();
    expect(formatClock(new Date(2026, 9, 17, 14, 32).toISOString(), now)).toBe("14:32");
    expect(formatClock(new Date(2026, 9, 16, 9, 5).toISOString(), now)).toBe(
      "16 Oct, 09:05",
    );
    expect(formatClock("not a date", now)).toBeNull();
  });
});

describe("per-chat meta lines", () => {
  it("writes the user line from clock, model, cost, and total tokens", () => {
    const now = new Date(2026, 9, 17, 14, 40).getTime();
    const turn = meta({
      startedAt: new Date(2026, 9, 17, 14, 32).toISOString(),
      modelId: "deepseek-v4.1-flash",
      effort: "high",
      usage: { input: 4, cached: 6, output: 2, cost: 0.00165 },
    });
    expect(userMetaText(turn, now)).toBe(
      "14:32 · deepseek-v4.1-flash · high · $0.00165 · 12 tok",
    );
    // The popover reads the same buckets, cached input included.
    expect(userMetaParts(turn, now)).toEqual({
      clock: "14:32",
      model: "deepseek-v4.1-flash · high",
      cost: "$0.00165",
      tokens: "12 tok",
      usage: { input: 4, cached: 6, output: 2, cost: 0.00165 },
    });
    // A catalog display name replaces the slug on the readable line.
    expect(userMetaText(turn, now, "Deepseek v4.1 Flash 1017")).toBe(
      "14:32 · Deepseek v4.1 Flash 1017 · high · $0.00165 · 12 tok",
    );
    // Zeros carry no cost or token words, and an empty turn has no line.
    expect(
      userMetaText(meta({ usage: { input: 0, cached: 0, output: 0, cost: 0 } }), now),
    ).toBeNull();
    expect(userMetaText(meta(), now)).toBeNull();
  });
});

describe("turn meta", () => {
  it("builds a turn's meta from a task log entry", () => {
    expect(
      turnMetaFromTask({
        usage: { input: 4, cached: 6, output: 2, cost: 0.01 },
        modelId: "muse-spark-1.3-contributor",
        effort: "high",
        createdAt: "2026-10-17T10:00:00.000Z",
        finishedAt: "2026-10-17T10:01:00.000Z",
      }),
    ).toEqual({
      usage: { input: 4, cached: 6, output: 2, cost: 0.01 },
      modelId: "muse-spark-1.3-contributor",
      effort: "high",
      startedAt: "2026-10-17T10:00:00.000Z",
      durationMs: 60_000,
    });
    expect(
      turnMetaFromTask({
        usage: null,
        modelId: null,
        effort: null,
        createdAt: null,
        finishedAt: null,
      }),
    ).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildAssetSummaryPrompt,
  buildFrameSummaryPrompt,
  clampSummary,
  createSummarizer,
} from "./summarize.js";

describe("clampSummary", () => {
  it("collapses whitespace and strips markdown decorations", () => {
    expect(clampSummary("## A **red** potion\n\n with a cork", 240)).toBe(
      "A red potion with a cork",
    );
  });

  it("cuts at a word boundary inside the limit", () => {
    const text = "one two three four five six seven eight nine ten";
    const clamped = clampSummary(text, 18);
    expect(clamped.length).toBeLessThanOrEqual(18);
    expect(clamped.endsWith(" ")).toBe(false);
    expect(text.startsWith(clamped)).toBe(true);
  });

  it("keeps a single overlong word inside the limit", () => {
    expect(clampSummary("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij");
  });
});

describe("prompt builders", () => {
  it("tells the frame summarizer to name colors and the subject", () => {
    const prompt = buildFrameSummaryPrompt({
      assetName: "potion",
      frameName: "idle",
      width: 32,
      height: 32,
      paletteSize: 8,
      paintedPixels: 210,
    });
    expect(prompt).toContain("one sentence");
    expect(prompt).toContain("idle");
    expect(prompt).toContain("32×32");
    expect(prompt).toContain("no markdown");
  });

  it("forbids inventing content in the asset prompt", () => {
    const prompt = buildAssetSummaryPrompt({
      name: "potion",
      width: 32,
      height: 32,
      paletteSize: 8,
      projectDescription: "fantasy items",
      frames: [{ name: "idle", summary: "a red potion with a cork" }],
    });
    expect(prompt).toContain("do not invent");
    expect(prompt).toContain("a red potion with a cork");
  });
});

describe("createSummarizer", () => {
  it("coalesces repeated queue calls for the same entity", async () => {
    const saved: string[] = [];
    const scheduled: Array<() => void> = [];
    const summarizer = createSummarizer({
      loadFrame: vi.fn(),
      loadAsset: async () => ({
        name: "a1",
        width: 32,
        height: 32,
        paletteSize: 8,
        projectDescription: "",
        frames: [],
      }),
      loadProject: async () => ({
        name: "p1",
        description: "",
        styleNotes: "",
        assets: [],
      }),
      summarizeFrame: vi.fn(),
      summarizeText: async () => "summary",
      save: async (kind, id, summary) => {
        saved.push(`${kind}:${id}:${summary}`);
      },
      schedule: (run) => scheduled.push(run),
    });
    summarizer.queue("asset", "a1");
    summarizer.queue("asset", "a1");
    summarizer.queue("project", "p1");
    expect(scheduled).toHaveLength(2);
    for (const run of scheduled) await run();
    expect(saved).toEqual(["asset:a1:summary", "project:p1:summary"]);
  });

  it("logs a failed summary and keeps the previous value", async () => {
    const save = vi.fn();
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    const runs: Array<() => void | Promise<void>> = [];
    try {
      const summarizer = createSummarizer({
        loadFrame: vi.fn(),
        loadAsset: async () => undefined,
        loadProject: async () => ({
          name: "p1",
          description: "",
          styleNotes: "",
          assets: [],
        }),
        summarizeFrame: vi.fn(),
        summarizeText: async () => {
          throw new Error("provider down");
        },
        save,
        schedule: (run) => runs.push(run),
      });
      summarizer.queue("project", "p1");
      await runs[0]?.();
    } finally {
      console.error = original;
    }
    expect(save).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("[summary] project p1: provider down");
  });

  it("logs the provider's own words through the cause chain", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    const runs: Array<() => void | Promise<void>> = [];
    try {
      const summarizer = createSummarizer({
        loadFrame: vi.fn(),
        loadAsset: async () => undefined,
        loadProject: async () => ({
          name: "p1",
          description: "",
          styleNotes: "",
          assets: [],
        }),
        summarizeFrame: vi.fn(),
        summarizeText: async () => {
          throw new Error("400 Upstream request failed: Model is unavailable.", {
            cause: new Error('{"error":"no deployment for this input"}'),
          });
        },
        save: vi.fn(),
        schedule: (run) => runs.push(run),
      });
      summarizer.queue("project", "p1");
      await runs[0]?.();
    } finally {
      console.error = original;
    }
    expect(errors.join(" ")).toContain(
      'Model is unavailable. ← {"error":"no deployment for this input"}',
    );
  });

  it("skips an entity that no longer exists", async () => {
    const save = vi.fn();
    const runs: Array<() => void | Promise<void>> = [];
    const summarizer = createSummarizer({
      loadFrame: vi.fn(),
      loadAsset: async () => undefined,
      loadProject: async () => undefined,
      summarizeFrame: vi.fn(),
      summarizeText: vi.fn(),
      save,
      schedule: (run) => runs.push(run),
    });
    summarizer.queue("asset", "gone");
    await runs[0]?.();
    expect(save).not.toHaveBeenCalled();
  });
});

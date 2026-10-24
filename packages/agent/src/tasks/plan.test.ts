import { describe, expect, it } from "vitest";
import { drawPlanSchema, paletteCapacity, validatePlan, type DrawPlan } from "./plan.js";

const base: DrawPlan = {
  assetId: "a1",
  frames: [
    { name: "idle", intent: "stands", layers: ["body"] },
    { name: "walk", intent: "steps", layers: ["body", "shadow"] },
  ],
  palette: [{ color: "#f4f4f4", name: "glow" }],
  references: [{ url: "https://example.com/bird.png", note: "wings", appliesTo: "all" }],
  workers: [
    { key: "w1", frames: ["idle"] },
    { key: "w2", frames: ["walk"] },
  ],
  review: true,
};

describe("drawPlanSchema", () => {
  it("accepts a complete plan", () => {
    expect(drawPlanSchema.safeParse(base).success).toBe(true);
  });
  it("rejects a plan without frames", () => {
    expect(drawPlanSchema.safeParse({ ...base, frames: [] }).success).toBe(false);
  });
});

describe("validatePlan", () => {
  const limits = { maxWorkers: 4, maxPalette: 16 };
  it("accepts the base plan", () => {
    expect(validatePlan(base, limits)).toEqual({ ok: true });
  });
  it("names a duplicated frame", () => {
    const plan = {
      ...base,
      frames: [...base.frames, { name: "idle", intent: "again", layers: [] }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'The plan names frame "idle" twice.',
    });
  });
  it("accepts an existing frame marked for removal", () => {
    expect(validatePlan({ ...base, removeFrames: ["old"] }, limits)).toEqual({
      ok: true,
    });
  });
  it("refuses to create and remove the same frame", () => {
    expect(validatePlan({ ...base, removeFrames: ["idle"] }, limits)).toEqual({
      ok: false,
      error: 'The plan both creates and removes frame "idle"; choose one.',
    });
  });
  it("names a frame missing from every worker", () => {
    const plan = { ...base, workers: [{ key: "w1", frames: ["idle"] }] };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Frame "walk" is not assigned to a worker.',
    });
  });
  it("names a frame assigned to two workers", () => {
    const plan = {
      ...base,
      workers: [
        { key: "w1", frames: ["idle", "walk"] },
        { key: "w2", frames: ["walk"] },
      ],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Frame "walk" is assigned to two workers.',
    });
  });
  it("refuses a duplicated worker key", () => {
    const plan = {
      ...base,
      workers: [
        { key: "w1", frames: ["idle"] },
        { key: "w1", frames: ["walk"] },
      ],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'The plan uses worker key "w1" twice.',
    });
  });
  it("caps workers and palette", () => {
    const many = {
      ...base,
      workers: ["w1", "w2", "w3", "w4", "w5"].map((key) => ({ key, frames: ["idle"] })),
    };
    expect(validatePlan(many, limits)).toEqual({
      ok: false,
      error: "The plan uses 5 workers; the cap is 4.",
    });
    const palette = { ...base, palette: [{ color: "#000000", name: "x" }] };
    expect(validatePlan(palette, { ...limits, maxPalette: 0 })).toEqual({
      ok: false,
      error: "The plan adds 1 colour; the palette has room for 0 more.",
    });
  });
  it("accepts plans past the old frame and layer caps", () => {
    const frames = Array.from({ length: 20 }, (_, index) => ({
      name: `pose-${index + 1}`,
      intent: "a key pose",
      layers: [
        "body",
        "face",
        "hair",
        "shadow",
        "glow",
        "eyes",
        "mouth",
        "outline",
        "highlight",
        "props",
      ],
    }));
    const parsed = drawPlanSchema.safeParse({
      ...base,
      frames,
      workers: [{ key: "w1", frames: frames.map((frame) => frame.name) }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(validatePlan(parsed.data, { maxWorkers: 4, maxPalette: 16 })).toEqual({
      ok: true,
    });
  });
  it("computes the remaining palette room", () => {
    expect(paletteCapacity(4)).toBe(252);
    expect(paletteCapacity(256)).toBe(0);
    expect(paletteCapacity(300)).toBe(0);
  });
  it("refuses a non-https reference", () => {
    const plan = {
      ...base,
      references: [{ url: "http://x.test/a.png", note: "", appliesTo: "all" as const }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Reference "http://x.test/a.png" must be an https URL.',
    });
  });
  it("refuses a reference aimed at an unknown frame", () => {
    const plan = {
      ...base,
      references: [{ url: "https://x.test/a.png", note: "", appliesTo: ["nope"] }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Reference "https://x.test/a.png" names unknown frame "nope".',
    });
  });
});

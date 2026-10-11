import { describe, expect, it } from "vitest";
import { parseModelSpecRow, selectRunTarget, type ModelSpec } from "./models.js";

describe("model specs", () => {
  it("validates database rows instead of guessing", () => {
    expect(
      parseModelSpecRow({
        id: "m",
        api: "chat",
        efforts: ["low", "high"],
        vision: false,
      }),
    ).toEqual({
      id: "m",
      api: "chat",
      efforts: ["low", "high"],
      vision: false,
    });
    expect(
      parseModelSpecRow({ id: "m", api: "responses", efforts: ["high"], vision: true })
        .vision,
    ).toBe(true);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "respones", efforts: ["low"], vision: false }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "", efforts: ["low"], vision: false }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "chat", efforts: [], vision: false }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "chat", efforts: ["low", 7], vision: false }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "chat", efforts: ["low"], vision: "yes" }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "chat", efforts: ["low"], vision: true }),
    ).toThrow(/vision/);
  });
  it("selects only exact model and effort pairs", () => {
    const specs: ModelSpec[] = [
      {
        id: "deepseek-v4.1-flash",
        api: "chat",
        efforts: ["low", "high", "max"],
        vision: false,
      },
    ];
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "max")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "max",
    });
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "medium")).toBeUndefined();
    expect(selectRunTarget(specs, "muse-spark-1.3-contributor", "high")).toBeUndefined();
    expect(selectRunTarget([], "deepseek-v4.1-flash", "low")).toBeUndefined();
  });
});

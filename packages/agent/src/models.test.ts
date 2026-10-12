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
        roles: ["summary-text"],
      }),
    ).toEqual({
      id: "m",
      api: "chat",
      efforts: ["low", "high"],
      vision: false,
      roles: ["summary-text"],
    });
    expect(
      parseModelSpecRow({
        id: "m",
        api: "responses",
        efforts: ["high"],
        vision: true,
        roles: [],
      }).vision,
    ).toBe(true);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "respones",
        efforts: ["low"],
        vision: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "",
        efforts: ["low"],
        vision: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: [],
        vision: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low", 7],
        vision: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: "yes",
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: true,
        roles: [],
      }),
    ).toThrow(/vision/);
    // Roles are an explicit catalog assignment; a malformed one fails loud.
    for (const bad of ["summary-text", ["ok", 7], [""]]) {
      expect(() =>
        parseModelSpecRow({
          id: "bad",
          api: "chat",
          efforts: ["low"],
          vision: false,
          roles: bad,
        }),
      ).toThrow(/roles/);
    }
  });
  it("selects only exact model and effort pairs", () => {
    const specs: ModelSpec[] = [
      {
        id: "deepseek-v4.1-flash",
        api: "chat",
        efforts: ["low", "high", "max"],
        vision: false,
        roles: ["summary-text"],
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

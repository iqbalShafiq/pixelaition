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
        maxOutputTokens: 8192,
        roles: ["summary-text"],
      }),
    ).toEqual({
      id: "m",
      api: "chat",
      efforts: ["low", "high"],
      vision: false,
      maxOutputTokens: 8192,
      roles: ["summary-text"],
    });
    expect(
      parseModelSpecRow({
        id: "m",
        api: "responses",
        efforts: ["high"],
        vision: true,
        maxOutputTokens: 1,
        roles: [],
      }).vision,
    ).toBe(true);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "respones",
        efforts: ["low"],
        vision: false,
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "",
        efforts: ["low"],
        vision: false,
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: [],
        vision: false,
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low", 7],
        vision: false,
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: "yes",
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: true,
        maxOutputTokens: 8192,
        roles: [],
      }),
    ).toThrow(/vision/);
    // The output budget is what the provider charges against its rate limit,
    // so a row without a valid one is a configuration error, not a default.
    for (const bad of [undefined, 0, -1, 1.5, "8192", null]) {
      expect(() =>
        parseModelSpecRow({
          id: "bad",
          api: "chat",
          efforts: ["low"],
          vision: false,
          maxOutputTokens: bad,
          roles: [],
        }),
      ).toThrow(/maxOutputTokens/);
    }
    // Roles are an explicit catalog assignment; a malformed one fails loud.
    for (const bad of ["summary-text", ["ok", 7], [""]]) {
      expect(() =>
        parseModelSpecRow({
          id: "bad",
          api: "chat",
          efforts: ["low"],
          vision: false,
          maxOutputTokens: 8192,
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
        maxOutputTokens: 8192,
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

import { describe, expect, it } from "vitest";
import {
  parseModelSpecRow,
  seesUserImages,
  selectRunTarget,
  type ModelSpec,
} from "./models.js";

describe("model specs", () => {
  it("validates database rows instead of guessing", () => {
    expect(
      parseModelSpecRow({
        id: "m",
        api: "chat",
        efforts: ["low", "high"],
        vision: false,
        userImages: false,
        roles: ["summary-text"],
      }),
    ).toEqual({
      id: "m",
      api: "chat",
      efforts: ["low", "high"],
      vision: false,
      userImages: false,
      roles: ["summary-text"],
    });
    expect(
      parseModelSpecRow({
        id: "m",
        api: "responses",
        efforts: ["high"],
        vision: true,
        userImages: false,
        roles: [],
      }).vision,
    ).toBe(true);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "respones",
        efforts: ["low"],
        vision: false,
        userImages: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "",
        efforts: ["low"],
        vision: false,
        userImages: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: [],
        vision: false,
        userImages: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low", 7],
        vision: false,
        userImages: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: "yes",
        userImages: false,
        roles: [],
      }),
    ).toThrow(/bad/);
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: true,
        userImages: false,
        roles: [],
      }),
    ).toThrow(/vision/);
    // A chat-shape model takes images a person attached: the chat adapter
    // delivers user-message images as `image_url` parts, while `vision`
    // (responses-only) guards the tool-result images it flattens.
    expect(
      parseModelSpecRow({
        id: "m",
        api: "chat",
        efforts: ["low"],
        vision: false,
        userImages: true,
        roles: ["summary-text"],
      }),
    ).toMatchObject({ vision: false, userImages: true });
    expect(() =>
      parseModelSpecRow({
        id: "bad",
        api: "chat",
        efforts: ["low"],
        vision: false,
        userImages: "yes",
        roles: [],
      }),
    ).toThrow(/userImages/);
    expect(seesUserImages({ vision: false, userImages: true })).toBe(true);
    expect(seesUserImages({ vision: true, userImages: false })).toBe(true);
    expect(seesUserImages({ vision: false, userImages: false })).toBe(false);
    // Roles are an explicit catalog assignment; a malformed one fails loud.
    for (const bad of ["summary-text", ["ok", 7], [""]]) {
      expect(() =>
        parseModelSpecRow({
          id: "bad",
          api: "chat",
          efforts: ["low"],
          vision: false,
          userImages: false,
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
        userImages: false,
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

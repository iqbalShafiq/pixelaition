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
        displayName: "Model M",
        api: "chat",
        efforts: ["low", "high"],
        vision: false,
        userImages: false,
        roles: ["summary-text"],
      }),
    ).toEqual({
      id: "m",
      displayName: "Model M",
      api: "chat",
      efforts: ["low", "high"],
      vision: false,
      userImages: false,
      roles: ["summary-text"],
    });
    // A row without a display name reads by its slug, and a blank one is not
    // a name either.
    expect(
      parseModelSpecRow({
        id: "m",
        api: "chat",
        efforts: ["low"],
        vision: false,
        userImages: false,
        roles: [],
      }).displayName,
    ).toBe("m");
    expect(
      parseModelSpecRow({
        id: "m",
        displayName: "  ",
        api: "chat",
        efforts: ["low"],
        vision: false,
        userImages: false,
        roles: [],
      }).displayName,
    ).toBe("m");
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
  it("carries a declared context window and leaves an undeclared one out", () => {
    const row = {
      id: "m",
      api: "chat" as const,
      efforts: ["low"],
      vision: false,
      userImages: false,
      roles: [],
    };
    expect(parseModelSpecRow({ ...row, contextWindow: 1048576 }).contextWindow).toBe(
      1048576,
    );
    // A null window means "not declared": the spec omits it so the console
    // shows no context line instead of guessing one.
    expect("contextWindow" in parseModelSpecRow({ ...row, contextWindow: null })).toBe(
      false,
    );
    expect("contextWindow" in parseModelSpecRow(row)).toBe(false);
  });
  it("refuses a malformed context window", () => {
    const row = {
      id: "bad",
      api: "chat" as const,
      efforts: ["low"],
      vision: false,
      userImages: false,
      roles: [],
    };
    for (const bad of [0, -1, 1.5, "1048576"]) {
      expect(() => parseModelSpecRow({ ...row, contextWindow: bad })).toThrow(
        /contextWindow/,
      );
    }
  });
  it("selects only exact model and effort pairs", () => {
    const specs: ModelSpec[] = [
      {
        id: "deepseek-v4.1-flash",
        displayName: "Deepseek v4.1 Flash",
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

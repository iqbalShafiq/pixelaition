import { describe, expect, it } from "vitest";
import { answerValue, isTargetQuestion } from "./interaction-answers.js";

describe("answerValue", () => {
  it("serializes the target questions by convention", () => {
    const project = { id: "project", text: "Which project?" };
    expect(answerValue(project, { choice: "p1", text: "" })).toBe("p1");
    expect(answerValue(project, { choice: "new", text: "" })).toBe("new");
    const asset = { id: "asset", text: "Which asset?" };
    expect(answerValue(asset, { choice: "none", text: "" })).toBe("none");
  });

  it("lets typed text win and serializes _multi ids", () => {
    expect(
      answerValue({ id: "project", text: "?" }, { choice: "p1", text: " kn " }),
    ).toBe("kn");
    expect(
      answerValue({ id: "colors_multi", text: "?" }, { multi: ["a", "b"], text: "" }),
    ).toBe('["a","b"]');
  });
});

describe("isTargetQuestion", () => {
  it("recognizes only the four target ids", () => {
    expect(isTargetQuestion("project")).toBe(true);
    expect(isTargetQuestion("asset")).toBe(true);
    expect(isTargetQuestion("asset_name")).toBe(true);
    expect(isTargetQuestion("project_name")).toBe(true);
    expect(isTargetQuestion("color")).toBe(false);
  });
});

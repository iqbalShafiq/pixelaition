import { describe, expect, it } from "vitest";
import {
  openCodeGoHeaders,
  parseModelSpecRow,
  selectRunTarget,
  type ModelSpec,
} from "./models.js";

describe("model specs", () => {
  it("validates database rows instead of guessing", () => {
    expect(parseModelSpecRow({ id: "m", api: "chat", efforts: ["low", "high"] })).toEqual(
      {
        id: "m",
        api: "chat",
        efforts: ["low", "high"],
      },
    );
    expect(parseModelSpecRow({ id: "m", api: "responses", efforts: ["high"] }).api).toBe(
      "responses",
    );
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "respones", efforts: ["low"] }),
    ).toThrow(/bad/);
    expect(() => parseModelSpecRow({ id: "bad", api: "", efforts: ["low"] })).toThrow(
      /bad/,
    );
    expect(() => parseModelSpecRow({ id: "bad", api: "chat", efforts: [] })).toThrow(
      /bad/,
    );
    expect(() =>
      parseModelSpecRow({ id: "bad", api: "chat", efforts: ["low", 7] }),
    ).toThrow(/bad/);
  });
  it("selects only exact model and effort pairs", () => {
    const specs: ModelSpec[] = [
      { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
    ];
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "max")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "max",
    });
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "medium")).toBeUndefined();
    expect(selectRunTarget(specs, "muse-spark-1.3-contributor", "high")).toBeUndefined();
    expect(selectRunTarget([], "deepseek-v4.1-flash", "low")).toBeUndefined();
  });

  it("sends the OpenCode Go session contract headers", () => {
    expect(openCodeGoHeaders("https://opencode.ai/zen/go/v1", "session-1")).toEqual({
      "x-opencode-session": "session-1",
      "user-agent": "pixelaition/0.1",
    });
    expect(
      openCodeGoHeaders("https://openrouter.ai/api/v1", "session-1"),
    ).toBeUndefined();
    expect(openCodeGoHeaders(undefined, "session-1")).toBeUndefined();
  });
});

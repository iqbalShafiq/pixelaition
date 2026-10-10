import { describe, expect, it } from "vitest";
import { openCodeGoHeaders, selectRunTarget, type ModelSpec } from "./models.js";

describe("model specs", () => {
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

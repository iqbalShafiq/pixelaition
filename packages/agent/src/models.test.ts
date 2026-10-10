import { describe, expect, it } from "vitest";
import {
  defaultApiFor,
  effortsFor,
  genericEfforts,
  openCodeGoHeaders,
  parseModelSpecs,
  selectRunTarget,
} from "./models.js";

const catalog = JSON.stringify([
  { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
  {
    id: "muse-spark-1.3-contributor",
    api: "responses",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
]);

describe("model specs", () => {
  it("parses a JSON catalog with per-model api and efforts", () => {
    expect(parseModelSpecs(catalog)).toEqual([
      { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
      {
        id: "muse-spark-1.3-contributor",
        api: "responses",
        efforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
    ]);
  });

  it("returns no specs when the value is missing or malformed", () => {
    expect(parseModelSpecs(undefined)).toEqual([]);
    expect(parseModelSpecs("  ")).toEqual([]);
    expect(parseModelSpecs("deepseek-v4.1-flash")).toEqual([]);
    expect(parseModelSpecs('[{"api":"chat"}]')).toEqual([]);
  });

  it("keeps specs that omit api and efforts for later defaults", () => {
    expect(parseModelSpecs('[{"id":"deepseek-v4.1-flash"}]')).toEqual([
      { id: "deepseek-v4.1-flash" },
    ]);
  });

  it("falls back to the generic effort set", () => {
    expect(effortsFor(undefined)).toEqual([...genericEfforts]);
    expect(effortsFor([])).toEqual([...genericEfforts]);
    expect(effortsFor(["low", "high", "max"])).toEqual(["low", "high", "max"]);
  });

  it("defaults the api family from the base url", () => {
    expect(defaultApiFor("https://openrouter.ai/api/v1")).toBe("chat");
    expect(defaultApiFor("https://opencode.ai/zen/go/v1")).toBe("responses");
    expect(defaultApiFor(undefined)).toBe("responses");
  });

  it("picks the requested model and effort when both are known", () => {
    const specs = parseModelSpecs(catalog);
    expect(selectRunTarget(specs, "muse-spark-1.3-contributor", "xhigh")).toEqual({
      modelId: "muse-spark-1.3-contributor",
      effort: "xhigh",
    });
  });

  it("falls back to the first model and its first effort", () => {
    const specs = parseModelSpecs(catalog);
    expect(selectRunTarget(specs, "unknown-model", "medium")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "low",
    });
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "xhigh")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "low",
    });
  });

  it("refuses to select without a catalog", () => {
    expect(() => selectRunTarget([], "deepseek-v4.1-flash", "low")).toThrow(
      /at least one model spec/,
    );
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

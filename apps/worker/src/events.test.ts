import { describe, expect, it } from "vitest";
import { sanitizeEvent } from "./events.js";

describe("sanitizeEvent", () => {
  it("reduces a check_animation report to its pair and flag counts", () => {
    const sanitized = sanitizeEvent("tool_completed", {
      operationId: "op-1",
      result: {
        failed: false,
        output: { pairs: [{ a: 1 }, { a: 2 }, { a: 3 }], flags: ["jump"] },
      },
    });
    expect(sanitized).toMatchObject({
      operationId: "op-1",
      result: { failed: false, output: { pairs: 3, flags: 1 } },
    });
  });

  it("keeps the counts when it meets its own output again", () => {
    const first = sanitizeEvent("tool_completed", {
      operationId: "op-1",
      result: { failed: false, output: { pairs: [1, 2, 3], flags: [] } },
    });
    const second = sanitizeEvent("tool_completed", first);
    expect(second).toEqual(first);
    expect(second).toMatchObject({
      result: { output: { pairs: 3, flags: 0 } },
    });
  });

  it("keeps a failed tool's error and drops its absent counts", () => {
    const sanitized = sanitizeEvent("tool_completed", {
      operationId: "op-2",
      result: { failed: true, error: "no frames" },
    }) as { result: Record<string, unknown> };
    expect(sanitized.result).toMatchObject({ failed: true, error: "no frames" });
    expect(sanitized.result.output).toBeUndefined();
  });

  it("passes interactions through untouched", () => {
    const interaction = { id: "i-1", type: "tool-approval", toolName: "present_plan" };
    expect(sanitizeEvent("interaction", interaction)).toBe(interaction);
    expect(sanitizeEvent("interaction-resolved", { id: "i-1" })).toEqual({ id: "i-1" });
  });
});

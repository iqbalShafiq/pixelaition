import { describe, expect, it } from "vitest";
import { outcomeTextFrom, sanitizeEvent } from "./events.js";

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

  it("keeps model text so the console can show a plan while it is written", () => {
    expect(
      sanitizeEvent("model_delta", {
        operationId: "0:model:1",
        event: { type: "text_delta", delta: '{"frames":[' },
      }),
    ).toEqual({
      operationId: "0:model:1",
      event: { type: "text_delta", text: '{"frames":[' },
    });
    const note = sanitizeEvent("model_note", {
      operationId: "0:model:1",
      channel: "message",
      text: "the plan",
    });
    expect(sanitizeEvent("model_note", note)).toEqual(note);
  });

  it("passes interactions through untouched", () => {
    const interaction = { id: "i-1", type: "tool-approval", toolName: "present_plan" };
    expect(sanitizeEvent("interaction", interaction)).toBe(interaction);
    expect(sanitizeEvent("interaction-resolved", { id: "i-1" })).toEqual({ id: "i-1" });
  });
});

describe("outcomeTextFrom", () => {
  it("takes the newest status outcome, never the bare running one", () => {
    // The stored window may still hold the run's `running` status; picking it
    // first left runs with no stored answer at all.
    const stored = [
      { type: "status", data: { status: "running" } },
      { type: "model_note", data: { channel: "message", text: "…" } },
      {
        type: "status",
        data: {
          status: "completed",
          outcome: { text: "Iya, memang belum mirip — bagian mana dulu?" },
        },
      },
    ];
    expect(outcomeTextFrom(stored)).toBe("Iya, memang belum mirip — bagian mana dulu?");
  });

  it("returns undefined without an outcome and the latest one otherwise", () => {
    expect(
      outcomeTextFrom([{ type: "status", data: { status: "running" } }]),
    ).toBeUndefined();
    expect(outcomeTextFrom([])).toBeUndefined();
    expect(
      outcomeTextFrom([
        { type: "status", data: { status: "completed", outcome: { text: "first" } } },
        { type: "status", data: { status: "completed", outcome: { text: "latest" } } },
      ]),
    ).toBe("latest");
    // An empty outcome text is no answer.
    expect(
      outcomeTextFrom([{ type: "status", data: { outcome: { text: "" } } }]),
    ).toBeUndefined();
  });
});

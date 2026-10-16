import { describe, expect, it } from "vitest";
import {
  attachmentsFromUnknown,
  followUpsFromSignals,
  formatPriorContext,
  parseDurableRecord,
  stepsFromRuns,
} from "./prior-context.js";

const jpeg = (mark: string): { mediaType: "image/jpeg"; data: string } => ({
  mediaType: "image/jpeg",
  data: mark.repeat(16),
});

describe("prior context", () => {
  it("reads the request, images, and steered follow-ups from a durable record", () => {
    const parsed = parseDurableRecord(
      JSON.stringify({
        input: {
          request: "i think the asset is not the same with s.coups?",
          attachments: [
            { mediaType: "image/jpeg", data: "a".repeat(16) },
            { mediaType: "text/plain", data: "nope" },
            { mediaType: "image/png", data: "short" },
          ],
        },
        signals: {
          "steer-2": { requestId: "b", value: { message: "whole face" } },
          "steer-1": { value: { message: "darken the blush" } },
          "clarify-1": { value: { message: "ignored" } },
        },
      }),
    );
    expect(parsed?.request).toBe("i think the asset is not the same with s.coups?");
    expect(parsed?.attachments).toEqual([
      { mediaType: "image/jpeg", data: "a".repeat(16) },
    ]);
    expect(parsed?.followUps).toEqual(["darken the blush", "whole face"]);
    expect(attachmentsFromUnknown(null)).toEqual([]);
    expect(followUpsFromSignals(null)).toEqual([]);
  });

  it("records tool results and messages, and skips thinking, deltas, and slot rows", () => {
    const lines = stepsFromRuns([
      {
        role: "plan",
        workerKey: "plan",
        events: [
          {
            sequence: 2,
            type: "tool_completed",
            data: { operationId: "t1", result: { failed: false } },
          },
          {
            sequence: 1,
            type: "tool_started",
            data: {
              operationId: "t1",
              input: { toolCall: { toolName: "present_plan" } },
            },
          },
          {
            sequence: 3,
            type: "model_note",
            data: { channel: "thinking", text: "secret" },
          },
          {
            sequence: 4,
            type: "model_note",
            data: { channel: "message", text: "planned the face" },
          },
          { sequence: 5, type: "model_delta", data: { event: { text: "x" } } },
        ],
      },
      {
        role: "worker",
        workerKey: "slot-w1",
        events: [
          {
            sequence: 1,
            type: "tool_completed",
            data: { operationId: "s", result: { failed: false } },
          },
        ],
      },
      {
        role: "worker",
        workerKey: "w1",
        events: [
          {
            sequence: 1,
            type: "tool_started",
            data: { operationId: "p", input: { toolCall: { toolName: "paint_stroke" } } },
          },
          {
            sequence: 2,
            type: "tool_completed",
            data: { operationId: "p", result: { failed: true, error: "bad colour" } },
          },
        ],
      },
    ]);
    expect(lines).toEqual([
      "Supervisor · present_plan — ok",
      "Supervisor: planned the face",
      "Agent 1 · paint_stroke — bad colour",
    ]);
  });

  it("keeps every user line and the newest images when the caps are hit", () => {
    const oldest = "A".repeat(200);
    const context = formatPriorContext([
      {
        request: "please make the sweet face",
        followUps: ["whole face"],
        steps: Array.from({ length: 80 }, (_, index) => `${oldest} step ${index}`),
        attachments: [jpeg("a"), jpeg("b"), jpeg("c"), jpeg("d")],
      },
      {
        request: "match the photo",
        followUps: [],
        steps: ["Agent 1 · paint_stroke — ok"],
        attachments: [jpeg("e"), jpeg("f"), jpeg("g"), jpeg("h"), jpeg("i")].slice(0, 4),
      },
      {
        request: "one more pass",
        followUps: [],
        steps: ["Reviewer 1: looks closer"],
        attachments: [jpeg("j"), jpeg("k"), jpeg("l"), jpeg("m")],
      },
    ]);
    expect(context.text).toContain("Turn 1. User: please make the sweet face");
    expect(context.text).toContain("User follow-up: whole face");
    expect(context.text).toContain("Turn 2. User: match the photo");
    expect(context.text).toContain("Turn 3. User: one more pass");
    expect(context.text).toContain("earlier steps omitted");
    expect(context.text).toContain("older reference images were left out");
    expect(context.text.length).toBeLessThanOrEqual(16_000);
    expect(context.attachments.map((image) => image.data[0])).toEqual([
      "e",
      "f",
      "g",
      "h",
      "j",
      "k",
      "l",
      "m",
    ]);
  });

  it("leaves the images out when the model cannot view them", () => {
    const context = formatPriorContext(
      [
        {
          request: "match the photo",
          followUps: [],
          steps: ["Agent 1 · paint_stroke — ok"],
          attachments: [jpeg("a"), jpeg("b")],
        },
        {
          request: "one more pass",
          followUps: [],
          steps: [],
          attachments: [jpeg("c")],
        },
      ],
      { images: false },
    );
    expect(context.attachments).toEqual([]);
    expect(context.text).toContain("Turn 1. User: match the photo");
    expect(context.text).toContain("Turn 2. User: one more pass");
    expect(context.text).toContain(
      "Reference images: 2 (not attached: this model cannot view images).",
    );
    expect(context.text).not.toContain("attached before this message's own images");
    expect(context.text).not.toContain("older reference images were left out");
  });

  it("returns nothing when there is no earlier request", () => {
    expect(formatPriorContext([])).toEqual({ text: "", attachments: [] });
  });
});

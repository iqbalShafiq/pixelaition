import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionNotConfiguredError, decidePrompt, toDecision } from "./decide.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jev decisions", () => {
  it("refuses to decide without a configured key and model", async () => {
    await expect(decidePrompt("a 32x32 potion bottle", {})).rejects.toBeInstanceOf(
      DecisionNotConfiguredError,
    );
    await expect(
      decidePrompt("a 32x32 potion bottle", { apiKey: "not-a-real-key" }),
    ).rejects.toBeInstanceOf(DecisionNotConfiguredError);
  });

  it("propagates provider failures instead of deciding offline", async () => {
    await expect(
      decidePrompt("a 32x32 potion bottle", {
        apiKey: "not-a-real-key",
        model: "typesafe/jev-1.13",
        decisionsUrl: "http://127.0.0.1:9/decisions",
      }),
    ).rejects.toThrow();
  });

  it("maps Jev answers onto the draw intent", () => {
    expect(
      toDecision({
        intent: { choice: "variant", confidence: 0.82 },
        drawable: { noul: 0.9 },
        actionable: { noul: 0.95 },
      }),
    ).toEqual({ intent: "variant", confidence: 0.82, source: "jev" });

    // A vague draw request becomes an asking-only turn, never an error.
    expect(
      toDecision({
        intent: { choice: "draw", confidence: 0.9 },
        drawable: { noul: 0.4 },
        actionable: { noul: 0.9 },
      }),
    ).toEqual({ intent: "ask", confidence: 0.4, source: "jev" });

    // A question is an ask whatever the specificity questions say.
    expect(
      toDecision({
        intent: { choice: "ask", confidence: 0.88 },
        drawable: { noul: 0.9 },
        actionable: { noul: 0.9 },
      }),
    ).toMatchObject({ intent: "ask", confidence: 0.88, source: "jev" });

    // An edit is judged by whether it says what to change, not by drawability.
    expect(
      toDecision({
        intent: { choice: "edit", confidence: 0.93 },
        drawable: { noul: 0.42 },
        actionable: { noul: 0.97 },
      }),
    ).toEqual({ intent: "edit", confidence: 0.93, source: "jev" });

    // An edit that says nothing to change turns conversational too.
    expect(
      toDecision({
        intent: { choice: "edit", confidence: 0.8 },
        drawable: { noul: 0.9 },
        actionable: { noul: 0.3 },
      }).intent,
    ).toBe("ask");

    // An answer outside the option set is not a decision to draw.
    expect(
      toDecision({
        intent: { choice: "paint" },
        drawable: { noul: 0.95 },
        actionable: { noul: 0.95 },
      }).intent,
    ).toBe("ask");
  });

  it("carries the thread history and asset so a correction reads as an edit", async () => {
    let sent: unknown;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          answers: {
            intent: { type: "choice", choice: "edit", confidence: 0.9 },
            drawable: { type: "noul", noul: 0.9 },
            actionable: { type: "noul", noul: 0.95 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const decision = await decidePrompt(
      "it's not blue though",
      {
        apiKey: "test-key",
        model: "typesafe/jev-1.13",
        baseUrl: "https://decisions.test",
      },
      {
        history: [{ prompt: "blue sword", answer: "32x32, idle, 4 colors" }],
        asset: {
          name: "sword",
          width: 32,
          height: 32,
          palette: ["#00000000", "#38b764"],
        },
        frames: ["idle"],
        frameName: "idle",
      },
    );
    expect(decision.intent).toBe("edit");
    expect(sent).toMatchObject({
      state: {
        prompt: "it's not blue though",
        history: [{ prompt: "blue sword", answer: "32x32, idle, 4 colors" }],
        asset: { name: "sword", width: 32, height: 32 },
        frames: ["idle"],
        frame: { name: "idle" },
      },
    });
  });
});

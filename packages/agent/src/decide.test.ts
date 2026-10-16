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

  it("picks the task shape from Jev's answers, and names a defaulted one", () => {
    const base = {
      intent: { choice: "draw", confidence: 0.9 },
      drawable: { noul: 0.9 },
      actionable: { noul: 0.9 },
    };
    expect(
      toDecision({ ...base, workers: { choice: "3" }, review: { noul: 0.85 } }).shape,
    ).toEqual({ workers: 3, review: true, source: "jev" });
    expect(
      toDecision({ ...base, workers: { choice: "9" }, review: { noul: 0.2 } }).shape,
    ).toEqual({ workers: 4, review: false, source: "jev" });
    expect(toDecision(base).shape).toEqual({
      workers: 2,
      review: true,
      source: "default",
    });
  });

  it("maps Jev answers onto the draw intent", () => {
    expect(
      toDecision({
        intent: { choice: "variant", confidence: 0.82 },
        drawable: { noul: 0.9 },
        actionable: { noul: 0.95 },
      }),
    ).toEqual({
      intent: "variant",
      confidence: 0.82,
      source: "jev",
      shape: { workers: 2, review: true, source: "default" },
    });

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
    ).toEqual({
      intent: "edit",
      confidence: 0.93,
      source: "jev",
      shape: { workers: 2, review: true, source: "default" },
    });

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

  it("runs a low-confidence ask as an edit when the message plainly asks for a change", () => {
    type AskOver = {
      intent?: { choice: string; confidence?: number };
      actsOnArt?: { noul?: number };
    };
    const ask = (over: AskOver = {}) => ({
      intent: { choice: "ask", confidence: 0.4, ...over.intent },
      drawable: { noul: 0.9 },
      actionable: { noul: 0.9 },
      actsOnArt: { noul: 0.97, ...over.actsOnArt },
    });
    // Jev is torn between replying and acting, and the message asks for a
    // change: the run is an edit, not a read-only turn.
    expect(toDecision(ask())).toEqual({
      intent: "edit",
      confidence: 0.4,
      source: "jev",
      shape: { workers: 2, review: true, source: "default" },
    });
    // A decisive ask stays a question.
    expect(toDecision(ask({ intent: { choice: "ask", confidence: 0.9 } })).intent).toBe(
      "ask",
    );
    // A weak action signal keeps the question.
    expect(toDecision(ask({ actsOnArt: { noul: 0.5 } })).intent).toBe("ask");
    // An answer shape without the action signal keeps the question.
    const { actsOnArt: _dropped, ...older } = ask();
    expect(toDecision(older).intent).toBe("ask");
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
            workers: { type: "choice", choice: "1" },
            review: { type: "noul", noul: 0.3 },
            acts_on_art: { type: "noul", noul: 0.2 },
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
    expect(decision.shape).toEqual({ workers: 1, review: false, source: "jev" });
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

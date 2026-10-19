import { describe, expect, it } from "vitest";
import { userTurnsFromRuns } from "./history.js";

describe("userTurnsFromRuns", () => {
  it("keeps a role-null run as the user's own turn", () => {
    expect(
      userTurnsFromRuns(
        [
          {
            role: null,
            prompt: "  warna rambut di frame ini apa?  ",
            answer: "Cokelat.",
          },
        ],
        4,
      ),
    ).toEqual([{ prompt: "warna rambut di frame ini apa?", answer: "Cokelat." }]);
  });

  it("recovers the request a plan prompt embeds", () => {
    expect(
      userTurnsFromRuns(
        [
          {
            role: "plan",
            prompt:
              "please make the sweet face of scoups of seventeen\n\nAsset name to use: scoups",
            answer: '{"frames":[]}',
          },
        ],
        4,
      ),
    ).toEqual([
      {
        prompt: "please make the sweet face of scoups of seventeen",
        answer: '{"frames":[]}',
      },
    ]);
  });

  it("recovers the request after an earlier-turns block", () => {
    const rows = [
      {
        role: "plan",
        prompt: [
          "Earlier drawing turns on this asset, oldest first. Honour them.",
          "",
          "Turn 1. User: draw a slime",
          "",
          "This message continues that work.",
          "",
          "boy, bisa nggak semisal canvas nya kamu resize jadi lebih besar?",
          'Style: {"defaultWidth":32,"defaultHeight":32}',
        ].join("\n"),
        answer: '{"frames":[]}',
      },
    ];
    expect(userTurnsFromRuns(rows, 4).map((turn) => turn.prompt)).toEqual([
      "boy, bisa nggak semisal canvas nya kamu resize jadi lebih besar?",
    ]);
  });

  it("skips the machinery runs and plan continuations", () => {
    const rows = [
      {
        role: "worker",
        prompt:
          "You are one worker in a supervised team; you paint only the frames you own.",
        answer: "Painted.",
      },
      {
        role: "review",
        prompt: "You are the supervisor's review pass; you never paint.",
        answer: '{"ok":false}',
      },
      {
        role: "fix",
        prompt: "You are a fix worker; you paint only the frames named in your task.",
        answer: "Repainted.",
      },
      {
        role: "plan",
        prompt: "The user already approved this plan. Do not call present_plan.",
        answer: '{"frames":[]}',
      },
      { role: null, prompt: null, answer: null },
      { role: null, prompt: "   ", answer: null },
    ];
    expect(userTurnsFromRuns(rows, 4)).toEqual([]);
  });

  it("returns the newest turns, oldest first, up to the limit", () => {
    const rows = [
      { role: null, prompt: "kenapa warnanya biru?", answer: "Karena permintaan awal." },
      {
        role: "worker",
        prompt:
          "You are one worker in a supervised team; you paint only the frames you own.",
        answer: "Painted.",
      },
      {
        role: "plan",
        prompt: "beri mata lebih besar\n\nAsset name to use: scoups",
        answer: '{"frames":[]}',
      },
      {
        role: "review",
        prompt: "You are the supervisor's review pass; you never paint.",
        answer: '{"ok":false}',
      },
      { role: null, prompt: "bikin pedang", answer: "Selesai." },
    ];
    expect(userTurnsFromRuns(rows, 2)).toEqual([
      { prompt: "beri mata lebih besar", answer: '{"frames":[]}' },
      { prompt: "kenapa warnanya biru?", answer: "Karena permintaan awal." },
    ]);
  });
});

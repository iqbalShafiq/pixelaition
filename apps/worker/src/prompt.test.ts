import { describe, expect, it } from "vitest";
import { buildRunPrompt } from "./prompt.js";

describe("buildRunPrompt", () => {
  it("appends the finished runs as a history block", () => {
    const prompt = buildRunPrompt({
      prompt: "make it walk",
      style: { outline: "#1a1c2c" },
      frameName: "walk-1",
      recent: [
        { prompt: "draw a knight", answer: "Drew a 32 by 32 knight." },
        { prompt: "add a helmet", answer: null },
      ],
    });
    expect(prompt).toBe(
      'make it walk\nStyle: {"outline":"#1a1c2c"}\nFrame: walk-1\nRecent runs:\ndraw a knight → Drew a 32 by 32 knight.\nadd a helmet → ',
    );
  });

  it("omits the block when no run has finished", () => {
    const prompt = buildRunPrompt({
      prompt: "draw a knight",
      style: {},
      frameName: "idle",
      recent: [],
    });
    expect(prompt).not.toContain("Recent runs:");
  });

  it("truncates each side of a history line to 200 characters", () => {
    const long = "x".repeat(500);
    const prompt = buildRunPrompt({
      prompt: "again",
      style: {},
      frameName: "idle",
      recent: [{ prompt: long, answer: long }],
    });
    const line = prompt.split("\n").at(-1) ?? "";
    const [asked, answered] = line.split(" → ");
    expect(asked).toHaveLength(200);
    expect(answered).toHaveLength(200);
  });
});

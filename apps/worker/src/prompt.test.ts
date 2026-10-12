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

  it("lists the frames, palette, and attached references when present", () => {
    const prompt = buildRunPrompt({
      prompt: "add a jump frame",
      style: {},
      frameName: "idle",
      frames: [
        { name: "idle", current: true },
        { name: "walk", current: false },
      ],
      palette: ["#00000000", "#38b764"],
      attachments: 1,
      recent: [],
    });
    expect(prompt).toContain("Frames: idle*, walk (* = current)");
    expect(prompt).toContain("Palette: #00000000, #38b764");
    expect(prompt).toContain("Attachments: 1 reference image with this message");
  });

  it("counts attachments in the plural and omits empty blocks", () => {
    const prompt = buildRunPrompt({
      prompt: "draw this",
      style: {},
      frames: [],
      palette: [],
      attachments: 2,
      recent: [],
    });
    expect(prompt).toContain("Attachments: 2 reference images with this message");
    expect(prompt).not.toContain("Frames:");
    expect(prompt).not.toContain("Palette:");
  });
});

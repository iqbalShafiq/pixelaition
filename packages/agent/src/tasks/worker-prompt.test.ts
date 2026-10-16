import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "./worker-prompt.js";

const input = {
  request: "ksatria berjalan dengan pedang menyala",
  projectName: "Hutan Ksatria",
  assetName: "ksatria-kecil",
  width: 32,
  height: 32,
  paletteSize: 10,
  styleLines: ["one outline color", "no anti-aliasing"],
  ownedFrames: [
    {
      name: "jalan-a",
      intent: "kaki kiri depan",
      layers: ["ksatria", "pedang", "cahaya"],
    },
    {
      name: "jalan-b",
      intent: "kaki kanan depan",
      layers: ["ksatria", "pedang", "cahaya"],
    },
  ],
  readOnlyFrames: ["idle"],
  references: [
    { url: "https://example.com/sword.png", note: "bilah terang, gagang cokelat" },
  ],
  attachments: 1,
};

describe("buildWorkerPrompt", () => {
  it("carries the request, the asset context, and the owned frames with layers", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("ksatria berjalan dengan pedang menyala");
    expect(prompt).toContain("Hutan Ksatria");
    expect(prompt).toContain("ksatria-kecil");
    expect(prompt).toContain("32×32");
    expect(prompt).toContain("jalan-a");
    expect(prompt).toContain("kaki kiri depan");
    expect(prompt).toContain("ksatria, pedang, cahaya");
    expect(prompt).toContain("one outline color");
  });
  it("states the ownership rule and the read-only frames", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("Paint only these frames");
    expect(prompt).toContain("idle");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("The palette already carries every colour you need");
    expect(prompt).toContain("Do not call critique_frame");
    expect(prompt).not.toContain("clean critique");
  });
  it("lists references with their notes and mentions attachments only when present", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("https://example.com/sword.png");
    expect(prompt).toContain("bilah terang, gagang cokelat");
    expect(prompt).toContain("1 reference image");
    expect(buildWorkerPrompt({ ...input, attachments: 0, references: [] })).not.toContain(
      "reference image",
    );
  });
});

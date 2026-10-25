import { createAsset, createProject, type PixelProject } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import {
  frameToPng,
  frameToSvg,
  parseProject,
  serializeProject,
  zipFiles,
} from "./index.js";
import { assetFrameBuffer } from "@pixelaition/pixel";

function sample(): PixelProject {
  const project = createProject("Demo");
  project.assets.push(createAsset({ name: "icon", width: 8, height: 8 }));
  return project;
}

describe("export", () => {
  it("round-trips a project file", () => {
    const project = sample();
    const parsed = parseProject(serializeProject(project));
    expect(parsed.project.name).toBe("Demo");
    expect(parsed.assets[0]?.name).toBe("icon");
  });

  it("imports a v1 file whose style still carries maxColors", () => {
    const project = sample();
    const raw = JSON.parse(serializeProject(project)) as {
      project: { style: Record<string, unknown> };
    };
    raw.project.style.maxColors = 8;
    const parsed = parseProject(JSON.stringify(raw));
    expect(parsed.project.style).not.toHaveProperty("maxColors");
  });

  it("writes a png signature, an svg rect, and a zip entry", () => {
    const project = sample();
    const asset = project.assets[0];
    const frame = asset?.frames[0];
    if (!asset || !frame) throw new Error("missing fixture");
    const buffer = assetFrameBuffer(asset, frame.id);
    if (!buffer) throw new Error("missing buffer");
    const png = frameToPng(buffer, 1);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    // Agent previews can shrink below 1× to fit a payload budget.
    const small = frameToPng(buffer, 0.5);
    expect(small[0]).toBe(0x89);
    expect(small.length).toBeLessThan(png.length);
    const svg = frameToSvg(buffer, 1);
    expect(svg).toContain("<svg");
    const zip = zipFiles({ "icon.svg": svg, "project.pxl": serializeProject(project) });
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
  });
});

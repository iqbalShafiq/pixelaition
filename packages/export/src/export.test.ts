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
    const svg = frameToSvg(buffer, 1);
    expect(svg).toContain("<svg");
    const zip = zipFiles({ "icon.svg": svg, "project.pxl": serializeProject(project) });
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
  });
});

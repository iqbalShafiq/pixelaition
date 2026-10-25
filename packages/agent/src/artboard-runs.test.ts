import { describe, expect, it } from "vitest";
import type { Artboard } from "@pixelaition/artboard";
import {
  bindArtboardRun,
  getArtboardRun,
  releaseArtboardRun,
  writeArtboard,
} from "./artboard-runs.js";

function board(): Artboard {
  return {
    id: "board-1",
    setId: "asset-1",
    presetId: "instagram-post",
    name: "Post",
    width: 1080,
    height: 1080,
    pixelUnit: 4,
    scene: { version: 1, background: { kind: "transparent" }, elements: [] },
    copyOverride: {},
    status: "draft",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("artboard run changes", () => {
  it("streams every scene write before save", () => {
    const seen: Artboard[] = [];
    bindArtboardRun("run-1", {
      setId: "asset-1",
      setName: "Asset",
      projectId: "project-1",
      assetId: "asset-1",
      assetName: "Asset",
      palette: ["#000000", "#ffffff"],
      copy: {},
      artboards: new Map(),
      sprites: new Map(),
      planApproved: true,
      onChange: (artboard) => seen.push(artboard),
    });
    writeArtboard(getArtboardRun("run-1")!, board());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe("board-1");
    releaseArtboardRun("run-1");
  });
});

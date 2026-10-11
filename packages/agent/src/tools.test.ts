import { normalizeToolResultOutput } from "@anvia/core/tool";
import type { FrameBuffer } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import { bindRun, releaseRun } from "./runs.js";
import { createPixelTools } from "./tools.js";

const palette = [
  "#00000000",
  "#f4f4f4",
  "#ef7d57",
  "#a7f070",
  "#38b764",
  "#566c86",
  "#94b0c2",
  "#333c57",
  "#257179",
  "#29366f",
  "#3b5dc9",
  "#41a6f6",
];

// base:            detail:            composite:
// 1 1 0 0          0 0 0 0            1 1 0 0
// 1 1 0 0          0 3 0 0            1 3 0 0
// 0 0 2 2          0 0 3 0            0 0 3 2
// 0 0 2 2          0 0 0 0            0 0 2 2
const basePixels = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2]);
const detailPixels = new Uint8Array([0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0]);

function boundRun(): FrameBuffer {
  const buffer: FrameBuffer = {
    width: 4,
    height: 4,
    palette: [...palette],
    layers: [
      { id: "layer-base", name: "base", visible: true, pixels: basePixels.slice() },
      {
        id: "layer-detail",
        name: "detail",
        visible: true,
        pixels: detailPixels.slice(),
      },
    ],
  };
  bindRun("run-1", {
    assetId: "asset-1",
    frameId: "frame-1",
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    buffer,
    strokes: [],
    issues: [],
  });
  return buffer;
}

type ReadTool = {
  call: (args: unknown, context: { operationId: string }) => Promise<unknown>;
};

function readTool(name: string): ReadTool {
  const found = createPixelTools().find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as unknown as ReadTool;
}

describe("read tools", () => {
  it("read_project lists frames, the current frame, and the palette legend", async () => {
    boundRun();
    const result = (await readTool("read_project").call(
      {},
      { operationId: "run-1" },
    )) as {
      assetId: string;
      frames: Array<{ id: string; name: string; index: number }>;
      currentFrame: { id: string; name: string; index: number };
      palette: Array<{ index: number; hex: string }>;
      layers: Array<{ id: string; name: string; visible: boolean }>;
    };
    expect(result.assetId).toBe("asset-1");
    expect(result.frames).toEqual([{ id: "frame-1", name: "current", index: 0 }]);
    expect(result.currentFrame).toEqual({ id: "frame-1", name: "current", index: 0 });
    expect(result.palette).toHaveLength(12);
    expect(result.palette[0]).toEqual({ index: 0, hex: "#00000000" });
    expect(result.layers).toEqual([
      { id: "layer-base", name: "base", visible: true },
      { id: "layer-detail", name: "detail", visible: true },
    ]);
    releaseRun("run-1");
  });

  it("read_frame defaults to the composite of visible layers", async () => {
    boundRun();
    const result = await readTool("read_frame").call({}, { operationId: "run-1" });
    expect(result).toMatchObject({
      frameId: "frame-1",
      view: "composite",
      width: 4,
      height: 4,
      rows: ["1x2 0x2", "1x1 3x1 0x2", "0x2 3x1 2x1", "0x2 2x2"],
      colors: [
        { index: 1, hex: "#f4f4f4", count: 3 },
        { index: 2, hex: "#ef7d57", count: 3 },
        { index: 3, hex: "#a7f070", count: 2 },
      ],
    });
    releaseRun("run-1");
  });

  it("read_frame reads one layer by id", async () => {
    boundRun();
    const result = await readTool("read_frame").call(
      { layerId: "layer-detail" },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({
      view: "layer",
      layerId: "layer-detail",
      rows: ["0x4", "0x1 3x1 0x2", "0x2 3x1 0x1", "0x4"],
      colors: [{ index: 3, hex: "#a7f070", count: 2 }],
    });
    releaseRun("run-1");
  });

  it("read_frame rejects a layer that is not on the frame", async () => {
    boundRun();
    await expect(
      readTool("read_frame").call({ layerId: "layer-missing" }, { operationId: "run-1" }),
    ).rejects.toThrow(/layer/i);
    releaseRun("run-1");
  });

  it("read_frame rejects a frame that is not the bound frame", async () => {
    boundRun();
    await expect(
      readTool("read_frame").call({ frameId: "frame-2" }, { operationId: "run-1" }),
    ).rejects.toThrow(/frame/i);
    releaseRun("run-1");
  });

  it("read_region encodes the rectangle with RLE rows and colors", async () => {
    boundRun();
    const result = await readTool("read_region").call(
      { x: 1, y: 1, width: 2, height: 2 },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({
      frameId: "frame-1",
      view: "composite",
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      rows: ["3x1 0x1", "0x1 3x1"],
      colors: [{ index: 3, hex: "#a7f070", count: 2 }],
    });
    releaseRun("run-1");
  });

  it("read_region rejects out-of-bounds rectangles", async () => {
    boundRun();
    await expect(
      readTool("read_region").call(
        { x: 3, y: 3, width: 4, height: 4 },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow(/outside/);
    releaseRun("run-1");
  });
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("preview_frame", () => {
  it("is registered only for models with verified vision", () => {
    const names = (tools: ReturnType<typeof createPixelTools>) =>
      tools.map((tool) => tool.name);
    expect(names(createPixelTools())).not.toContain("preview_frame");
    expect(names(createPixelTools({ vision: false }))).not.toContain("preview_frame");
    expect(names(createPixelTools({ vision: true }))).toContain("preview_frame");
  });

  it("returns a text part and a PNG image part", async () => {
    boundRun();
    const found = createPixelTools({ vision: true }).find(
      (item) => item.name === "preview_frame",
    );
    if (!found) throw new Error("missing tool preview_frame");
    const output = (await (
      found as unknown as {
        call: (args: unknown, context: { operationId: string }) => Promise<unknown>;
      }
    ).call({ scale: 2 }, { operationId: "run-1" })) as {
      content: Array<{
        type: string;
        text?: string;
        mediaType?: string;
        data?: { type: string; data: string };
      }>;
    };
    expect(output.content[0]?.type).toBe("text");
    expect(output.content[0]?.text).toContain("4×4");
    expect(output.content[0]?.text).toContain("at 2×");
    const image = output.content[1];
    expect(image?.type).toBe("file");
    expect(image?.mediaType).toBe("image/png");
    expect(image?.data?.type).toBe("data");
    const bytes = Buffer.from(image?.data?.data ?? "", "base64");
    expect(bytes.subarray(0, 8).equals(pngSignature)).toBe(true);
    // The Anvia message schema must accept the rich output, or the run fails
    // at tool-result serialization instead of the model seeing the image.
    expect(normalizeToolResultOutput(output).type).toBe("content");
    releaseRun("run-1");
  });

  it("renders the strip mode through the same PNG path", async () => {
    boundRun();
    const found = createPixelTools({ vision: true }).find(
      (item) => item.name === "preview_frame",
    );
    if (!found) throw new Error("missing tool preview_frame");
    const output = (await (
      found as unknown as {
        call: (args: unknown, context: { operationId: string }) => Promise<unknown>;
      }
    ).call({ mode: "strip", scale: 1 }, { operationId: "run-1" })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(output.content[0]?.text).toContain("4×4");
    releaseRun("run-1");
  });
});

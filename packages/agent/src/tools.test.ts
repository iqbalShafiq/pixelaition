import { normalizeToolResultOutput } from "@anvia/core/tool";
import type { FrameBuffer } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import { bindRun, getRun, releaseRun, type Stroke } from "./runs.js";
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

// frame-1 "idle" — base:            detail:            composite:
// 1 1 0 0          0 0 0 0            1 1 0 0
// 1 1 0 0          0 3 0 0            1 3 0 0
// 0 0 2 2          0 0 3 0            0 0 3 2
// 0 0 2 2          0 0 0 0            0 0 2 2
const basePixels = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2]);
const detailPixels = new Uint8Array([0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0]);
// frame-2 "hop" — a single pixel at (0, 3) so (1, 1) is free for the paint tests.
const hopPixels = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]);

function idleBuffer(): FrameBuffer {
  return {
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
}

function hopBuffer(): FrameBuffer {
  return {
    width: 4,
    height: 4,
    palette: [...palette],
    layers: [{ id: "layer-a", name: "a", visible: true, pixels: hopPixels.slice() }],
  };
}

function boundRun(
  onStroke?: (stroke: Stroke, buffer: FrameBuffer, frameId: string) => void,
): void {
  bindRun("run-1", {
    assetId: "asset-1",
    originFrameId: "frame-1",
    currentFrameId: "frame-1",
    frames: new Map([
      ["frame-1", { name: "idle", buffer: idleBuffer() }],
      ["frame-2", { name: "hop", buffer: hopBuffer() }],
    ]),
    palette: [...palette],
    width: 4,
    height: 4,
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    approvedScope: new Set(["frame-1"]),
    strokes: [],
    issues: [],
    ...(onStroke ? { onStroke } : {}),
  });
}

type Tool = {
  call: (args: unknown, context: { operationId: string }) => Promise<unknown>;
};

function tool(name: string, options?: { vision?: boolean }): Tool {
  const found = createPixelTools(options).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as unknown as Tool;
}

describe("read tools", () => {
  it("read_project lists every frame, the current frame id, and the palette legend", async () => {
    boundRun();
    const result = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      assetId: string;
      frames: Array<{ id: string; name: string }>;
      currentFrameId: string;
      palette: Array<{ index: number; hex: string }>;
      layers: Array<{ id: string; name: string; visible: boolean }>;
    };
    expect(result.assetId).toBe("asset-1");
    expect(result.frames).toEqual([
      { id: "frame-1", name: "idle" },
      { id: "frame-2", name: "hop" },
    ]);
    expect(result.currentFrameId).toBe("frame-1");
    expect(result.palette).toHaveLength(12);
    expect(result.palette[0]).toEqual({ index: 0, hex: "#00000000" });
    expect(result.layers).toEqual([
      { id: "layer-base", name: "base", visible: true },
      { id: "layer-detail", name: "detail", visible: true },
    ]);
    releaseRun("run-1");
  });

  it("read_frame defaults to the composite of the current frame", async () => {
    boundRun();
    const result = await tool("read_frame").call({}, { operationId: "run-1" });
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

  it("read_frame reads another frame by id", async () => {
    boundRun();
    const result = await tool("read_frame").call(
      { frameId: "frame-2" },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({
      frameId: "frame-2",
      view: "composite",
      rows: ["0x4", "0x4", "0x4", "4x1 0x3"],
      colors: [{ index: 4, hex: "#38b764", count: 1 }],
    });
    releaseRun("run-1");
  });

  it("read_frame reads one layer by id", async () => {
    boundRun();
    const result = await tool("read_frame").call(
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
      tool("read_frame").call({ layerId: "layer-missing" }, { operationId: "run-1" }),
    ).rejects.toThrow(/layer/i);
    releaseRun("run-1");
  });

  it("read_frame rejects a frame that is not part of the asset", async () => {
    boundRun();
    await expect(
      tool("read_frame").call({ frameId: "frame-9" }, { operationId: "run-1" }),
    ).rejects.toThrow("Frame frame-9 is not part of this asset.");
    releaseRun("run-1");
  });

  it("read_region encodes the rectangle with RLE rows and colors", async () => {
    boundRun();
    const result = await tool("read_region").call(
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

  it("read_region reads a rectangle of a named frame", async () => {
    boundRun();
    const result = await tool("read_region").call(
      { frameId: "frame-2", x: 0, y: 3, width: 2, height: 1 },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({
      frameId: "frame-2",
      rows: ["4x1 0x1"],
      colors: [{ index: 4, hex: "#38b764", count: 1 }],
    });
    releaseRun("run-1");
  });

  it("read_region rejects out-of-bounds rectangles", async () => {
    boundRun();
    await expect(
      tool("read_region").call(
        { x: 3, y: 3, width: 4, height: 4 },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow(/outside/);
    releaseRun("run-1");
  });
});

describe("drawing tools", () => {
  it("paints on the frame named by the tool call", async () => {
    boundRun();
    await tool("paint_stroke").call(
      {
        frameId: "frame-2",
        layerId: "layer-a",
        label: "dot",
        points: [{ x: 1, y: 1, color: 2 }],
      },
      { operationId: "run-1" },
    );
    const run = getRun("run-1");
    expect(run?.frames.get("frame-2")?.buffer.layers[0]?.pixels[1 * 4 + 1]).toBe(2);
    // The frame the run was bound to is untouched.
    expect(run?.frames.get("frame-1")?.buffer.layers[0]?.pixels[1 * 4 + 1]).toBe(1);
    releaseRun("run-1");
  });

  it("paints on the current frame when no frame is named", async () => {
    boundRun();
    await tool("paint_stroke").call(
      { layerId: "layer-base", label: "dot", points: [{ x: 2, y: 2, color: 5 }] },
      { operationId: "run-1" },
    );
    const run = getRun("run-1");
    const base = run?.frames
      .get("frame-1")
      ?.buffer.layers.find((layer) => layer.id === "layer-base");
    expect(base?.pixels[2 * 4 + 2]).toBe(5);
    expect(run?.frames.get("frame-2")?.buffer.layers[0]?.pixels[2 * 4 + 2]).toBe(0);
    releaseRun("run-1");
  });

  it("hands the edited frame and its buffer to onStroke", async () => {
    const seen: Array<{ frameId: string; painted: number | undefined }> = [];
    boundRun((_stroke, buffer, frameId) => {
      seen.push({ frameId, painted: buffer.layers[0]?.pixels[1 * 4 + 1] });
    });
    await tool("paint_stroke").call(
      {
        frameId: "frame-2",
        layerId: "layer-a",
        label: "dot",
        points: [{ x: 1, y: 1, color: 2 }],
      },
      { operationId: "run-1" },
    );
    expect(seen).toEqual([{ frameId: "frame-2", painted: 2 }]);
    releaseRun("run-1");
  });

  it("fills a rectangle on the frame named by the tool call", async () => {
    const seen: string[] = [];
    boundRun((_stroke, _buffer, frameId) => seen.push(frameId));
    await tool("fill_rect").call(
      {
        frameId: "frame-2",
        layerId: "layer-a",
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        color: 3,
      },
      { operationId: "run-1" },
    );
    const run = getRun("run-1");
    expect(run?.frames.get("frame-2")?.buffer.layers[0]?.pixels[0]).toBe(3);
    expect(run?.frames.get("frame-2")?.buffer.layers[0]?.pixels[5]).toBe(3);
    expect(run?.frames.get("frame-1")?.buffer.layers[0]?.pixels[0]).toBe(1);
    expect(seen).toEqual(["frame-2"]);
    releaseRun("run-1");
  });

  it("refuses a frame that is not part of the asset", async () => {
    boundRun();
    await expect(
      tool("paint_stroke").call(
        {
          frameId: "frame-9",
          layerId: "layer-a",
          label: "dot",
          points: [{ x: 1, y: 1, color: 2 }],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("Frame frame-9 is not part of this asset.");
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
    const output = (await tool("preview_frame", { vision: true }).call(
      { scale: 2 },
      { operationId: "run-1" },
    )) as {
      content: Array<{
        type: string;
        text?: string;
        mediaType?: string;
        data?: { type: string; data: string };
      }>;
    };
    expect(output.content[0]?.type).toBe("text");
    expect(output.content[0]?.text).toContain("idle — 4×4");
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
    const output = (await tool("preview_frame", { vision: true }).call(
      { mode: "strip", scale: 1 },
      { operationId: "run-1" },
    )) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(output.content[0]?.text).toContain("2 frames");
    expect(output.content[0]?.text).toContain("8×4");
    releaseRun("run-1");
  });
});

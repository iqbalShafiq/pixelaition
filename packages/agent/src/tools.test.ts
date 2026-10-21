import { normalizeToolResultOutput } from "@anvia/core/tool";
import { createBuffer, type FrameBuffer } from "@pixelaition/pixel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindRun,
  getRun,
  releaseRun,
  stagedOverrideSchema,
  type AssetSummary,
  type CreateAssetInput,
  type FrameChange,
  type ProjectSummary,
  type RunAsset,
  type RunBinding,
  type Stroke,
} from "./runs.js";
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
  onFrameChange?: (change: FrameChange) => void | Promise<void>,
  overrides: Partial<RunBinding> = {},
): void {
  bindRun("run-1", {
    assetId: "asset-1",
    assetName: "slime",
    originFrameId: "frame-1",
    currentFrameId: "frame-1",
    frames: new Map([
      ["frame-1", { name: "idle", index: 0, buffer: idleBuffer() }],
      ["frame-2", { name: "hop", index: 1, buffer: hopBuffer() }],
    ]),
    palette: [...palette],
    width: 4,
    height: 4,
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    approvedScope: new Set(["frame-1"]),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    ...(onStroke ? { onStroke } : {}),
    ...(onFrameChange ? { onFrameChange } : {}),
    ...overrides,
  });
}

describe("worker frame ownership", () => {
  it("refuses a write to a frame outside the worker's set, with the cause named", async () => {
    boundRun(undefined, undefined, { ownedFrameIds: new Set(["frame-1"]) });
    await expect(
      tool("paint_stroke").call(
        {
          frameId: "frame-2",
          layerId: "base",
          label: "x",
          points: [{ x: 0, y: 0, color: 1 }],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("That frame belongs to another worker.");
    releaseRun("run-1");
  });
  it("allows a write to an owned frame", async () => {
    boundRun(undefined, undefined, { ownedFrameIds: new Set(["frame-1"]) });
    await tool("paint_stroke").call(
      {
        frameId: "frame-1",
        layerId: "base",
        label: "dot",
        points: [{ x: 1, y: 1, color: 1 }],
      },
      { operationId: "run-1" },
    );
    releaseRun("run-1");
  });
  it("paints a native-size frame and emits its full-size stroke", async () => {
    const native = new Uint8Array(1080 * 1080);
    const strokes: Array<{ width: number; height: number; frameId: string }> = [];
    bindRun("run-1", {
      assetId: "asset-1",
      assetName: "native",
      originFrameId: "frame-1",
      currentFrameId: "frame-1",
      frames: new Map([
        [
          "frame-1",
          {
            name: "Instagram announcement",
            index: 0,
            buffer: {
              width: 1080,
              height: 1080,
              palette: [...palette],
              layers: [
                {
                  id: "artwork",
                  name: "Artwork",
                  visible: true,
                  pixels: native,
                },
              ],
            },
          },
        ],
      ]),
      palette: [...palette],
      width: 4,
      height: 4,
      style: { outline: "#f4f4f4", maxColors: 12 } as never,
      approvedScope: new Set(["frame-1"]),
      touchedFrames: new Set(),
      strokes: [],
      issues: [],
      role: "worker",
      ownedFrameIds: new Set(["frame-1"]),
      onStroke: (_stroke, buffer, frameId) =>
        strokes.push({ width: buffer.width, height: buffer.height, frameId }),
    });
    await tool("paint_stroke").call(
      {
        frameId: "frame-1",
        layerId: "artwork",
        label: "native dot",
        points: [{ x: 540, y: 540, color: 1 }],
      },
      { operationId: "run-1" },
    );
    expect(strokes).toEqual([{ width: 1080, height: 1080, frameId: "frame-1" }]);
    releaseRun("run-1");
  });
  it("refuses a structural tool to a worker, with the cause named", async () => {
    boundRun(undefined, undefined, {
      role: "worker",
      ownedFrameIds: new Set(["frame-1"]),
    });
    await expect(
      tool("add_frame").call({ name: "extra" }, { operationId: "run-1" }),
    ).rejects.toThrow("The worker role cannot call add_frame.");
    releaseRun("run-1");
  });
  it("refuses painting to the review pass", async () => {
    boundRun(undefined, undefined, { role: "review" });
    await expect(
      tool("paint_stroke").call(
        {
          frameId: "frame-1",
          layerId: "base",
          label: "x",
          points: [{ x: 0, y: 0, color: 1 }],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("The review role cannot call paint_stroke.");
    releaseRun("run-1");
  });
  it("refuses a structural tool when the operation id carries the durable run prefix", async () => {
    boundRun(undefined, undefined, {
      role: "worker",
      ownedFrameIds: new Set(["frame-1"]),
    });
    // Durable child runs receive "<runId>/<operationKey>" as the operation id;
    // a raw lookup misses the binding and would let the call through.
    await expect(
      tool("resize_canvas").call(
        { width: 8, height: 8 },
        { operationId: "run-1/0:tool:4:call-1" },
      ),
    ).rejects.toThrow("The worker role cannot call resize_canvas.");
    releaseRun("run-1");
  });
  it("lets a worker read a sibling frame but not write it", async () => {
    boundRun(undefined, undefined, {
      role: "worker",
      ownedFrameIds: new Set(["frame-1"]),
    });
    // Reading a sibling is how a worker keeps its style consistent.
    await expect(
      tool("read_frame").call({ frameId: "frame-2" }, { operationId: "run-1" }),
    ).resolves.toBeDefined();
    await expect(
      tool("read_frame").call({ frameId: "hop" }, { operationId: "run-1" }),
    ).resolves.toMatchObject({ frameId: "frame-2", name: "hop" });
    await expect(
      tool("paint_stroke").call(
        {
          frameId: "frame-2",
          layerId: "a",
          label: "x",
          points: [{ x: 0, y: 0, color: 1 }],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("That frame belongs to another worker.");
    releaseRun("run-1");
  });
  it("refuses use_frame to a sibling frame", async () => {
    boundRun(undefined, undefined, { ownedFrameIds: new Set(["frame-1"]) });
    await expect(
      tool("use_frame").call({ frameId: "frame-2" }, { operationId: "run-1" }),
    ).rejects.toThrow("That frame belongs to another worker.");
    releaseRun("run-1");
  });
});

type Tool = {
  call: (args: unknown, context: { operationId: string }) => Promise<unknown>;
  requiresApproval?: unknown;
};

/** Run a tool's approval predicate against the live binding for `run-1`. */
async function approval(
  name: string,
  args: Record<string, unknown>,
  runId = "run-1",
): Promise<boolean | { reason: string }> {
  const requirement = tool(name).requiresApproval;
  if (typeof requirement !== "function") {
    throw new Error(`${name} does not gate approval dynamically.`);
  }
  return (
    requirement as (
      args: unknown,
      context: unknown,
    ) => boolean | Promise<boolean | { reason: string }>
  )(args, {
    toolName: name,
    args,
    rawArgs: JSON.stringify(args),
    toolCallId: "tool-call-1",
    internalCallId: "internal-call-1",
    run: { agentId: "pixel-draw:test:low", runId },
  });
}

/** Stub Jev's Decisions API so both request-check answers land on `noul`. */
function stubJev(noul: number): void {
  process.env.DECISION_MODEL_API_KEY = "test-key";
  process.env.DECISION_MODEL = "typesafe/jev-1.13";
  process.env.DECISION_MODEL_BASE_URL = "https://decisions.test";
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          answers: {
            supported: { type: "noul", noul },
            proportionate: { type: "noul", noul },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

/** The gate reads the process env; leave the suite's env as it found it. */
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DECISION_MODEL_API_KEY;
  delete process.env.DECISION_MODEL;
  delete process.env.DECISION_MODEL_BASE_URL;
  delete process.env.TAVILY_API_KEY;
});

/**
 * An 8×8 run for the frame tools. createBuffer refuses canvases under 8, so
 * the frame CRUD suite cannot reuse the 4×4 read/draw fixture.
 */
function boundFrameRun(
  onFrameChange?: (change: FrameChange) => void | Promise<void>,
): void {
  const blank = (color: number): FrameBuffer => {
    const buffer = createBuffer({ width: 8, height: 8, palette, layerName: "pixels" });
    if (color !== 0) buffer.layers[0]!.pixels[0] = color;
    return buffer;
  };
  bindRun("run-1", {
    assetId: "asset-1",
    assetName: "slime",
    originFrameId: "frame-1",
    currentFrameId: "frame-1",
    frames: new Map([
      ["frame-1", { name: "idle", index: 0, buffer: blank(0) }],
      ["frame-2", { name: "hop", index: 1, buffer: blank(4) }],
    ]),
    palette: [...palette],
    width: 8,
    height: 8,
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    approvedScope: new Set(["frame-1"]),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    ...(onFrameChange ? { onFrameChange } : {}),
  });
}

function tool(name: string, options?: { vision?: boolean; webSearch?: boolean }): Tool {
  const found = createPixelTools(options).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as unknown as Tool;
}

/** A workspace run before it has chosen or created an asset: no frames, no callbacks bound by default. */
function unboundRun(
  options: {
    userId?: string;
    onListProjects?: (userId: string) => Promise<ProjectSummary[]>;
    onListAssets?: (userId: string, projectId: string) => Promise<AssetSummary[]>;
    onCreateAsset?: (userId: string, input: CreateAssetInput) => Promise<RunAsset>;
    onLoadAsset?: (userId: string, assetId: string) => Promise<RunAsset>;
  } = {},
): void {
  bindRun("run-1", {
    frames: new Map(),
    palette: [],
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    approvedScope: new Set(),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.onListProjects ? { onListProjects: options.onListProjects } : {}),
    ...(options.onListAssets ? { onListAssets: options.onListAssets } : {}),
    ...(options.onCreateAsset ? { onCreateAsset: options.onCreateAsset } : {}),
    ...(options.onLoadAsset ? { onLoadAsset: options.onLoadAsset } : {}),
  });
}

/** The asset a workspace callback returns: two 4×4 frames already decoded. */
function loadedAsset(): RunAsset {
  return {
    id: "asset-2",
    name: "slime",
    width: 4,
    height: 4,
    palette: [...palette],
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    frames: [
      { id: "frame-a", name: "idle", summary: "", index: 0, buffer: idleBuffer() },
      { id: "frame-b", name: "hop", summary: "", index: 1, buffer: hopBuffer() },
    ],
    summary: "",
  };
}

describe("read tools", () => {
  it("read_project lists every frame, the current frame id, and the palette legend", async () => {
    boundRun();
    const result = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      assetId: string;
      name: string;
      frames: Array<{ id: string; name: string; index: number }>;
      currentFrame: { id: string; name: string };
      palette: Array<{ index: number; hex: string }>;
      layers: Array<{ id: string; name: string; visible: boolean }>;
    };
    expect(result.assetId).toBe("asset-1");
    expect(result.name).toBe("slime");
    expect(result.frames).toEqual([
      { id: "frame-1", name: "idle", summary: "", index: 0 },
      { id: "frame-2", name: "hop", summary: "", index: 1 },
    ]);
    expect(result.currentFrame).toEqual({ id: "frame-1", name: "idle" });
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
    ).rejects.toThrow('No frame named or identified by "frame-9"');
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

  it("composite reads serialize as strict tool output", async () => {
    boundRun();
    const frame = await tool("read_frame").call({}, { operationId: "run-1" });
    expect(normalizeToolResultOutput(frame).type).toBe("json");
    const region = await tool("read_region").call(
      { x: 0, y: 0, width: 2, height: 2 },
      { operationId: "run-1" },
    );
    expect(normalizeToolResultOutput(region).type).toBe("json");
    releaseRun("run-1");
  });

  it("returns the asset and frame summaries from the binding", async () => {
    boundRun();
    const run = getRun("run-1")!;
    run.summary = "a red potion with a cork";
    run.frames.get("frame-1")!.summary = "a red potion on transparent";
    const project = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      summary?: string;
      frames: Array<{ summary?: string }>;
    };
    expect(project.summary).toBe("a red potion with a cork");
    expect(project.frames[0]?.summary).toBe("a red potion on transparent");
    // A frame read names its asset and frame; the summary of the run's own
    // frame rides read_project, which is where a role looks first.
    const frame = (await tool("read_frame").call({}, { operationId: "run-1" })) as {
      assetName: string;
      name: string;
      palette: Array<{ hex: string }>;
    };
    expect(frame).toMatchObject({ assetName: "slime", name: "idle" });
    expect(frame.palette[0]?.hex).toBe("#00000000");
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

  it("hands the mirrored frame to onStroke so the worker persists it", async () => {
    const seen: Array<{ frameId: string; row0: number[] }> = [];
    boundRun((_stroke, buffer, frameId) => {
      seen.push({
        frameId,
        row0: [...(buffer.layers[0]?.pixels.slice(0, 4) ?? [])],
      });
    });
    await tool("mirror_frame").call({ frameId: "frame-1" }, { operationId: "run-1" });
    // frame-1's base row [1,1,0,0] flips to [0,0,1,1].
    expect(seen).toEqual([{ frameId: "frame-1", row0: [0, 0, 1, 1] }]);
    expect([
      ...(getRun("run-1")?.frames.get("frame-1")?.buffer.layers[0]?.pixels.slice(0, 4) ??
        []),
    ]).toEqual([0, 0, 1, 1]);
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
    ).rejects.toThrow('No frame named or identified by "frame-9"');
    releaseRun("run-1");
  });

  it("set_palette accepts a 256-entry palette", async () => {
    boundRun();
    const palette = [
      "#00000000",
      ...Array.from(
        { length: 255 },
        (_, index) => `#${(index + 1).toString(16).padStart(6, "0")}`,
      ),
    ];
    const result = (await tool("set_palette").call(
      { palette },
      { operationId: "run-1" },
    )) as { palette: string[] };
    expect(result.palette).toHaveLength(256);
    releaseRun("run-1");
  });

  it("read_project drops a stale maxColors key from the style", async () => {
    boundRun();
    const project = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      style: Record<string, unknown>;
    };
    expect(project.style).not.toHaveProperty("maxColors");
    releaseRun("run-1");
  });

  it("keeps the read_project palette legend in step with set_palette", async () => {
    boundRun();
    // The palette belongs to the asset: every frame adopts it (frame-2 uses
    // index 4, so the new palette must keep it).
    const next = ["#00000000", "#111111", "#222222", "#333333", "#444444"];
    await tool("set_palette").call({ palette: next }, { operationId: "run-1" });
    const project = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      palette: Array<{ index: number; hex: string }>;
    };
    expect(project.palette).toEqual([
      { index: 0, hex: "#00000000" },
      { index: 1, hex: "#111111" },
      { index: 2, hex: "#222222" },
      { index: 3, hex: "#333333" },
      { index: 4, hex: "#444444" },
    ]);
    // Both frames carry the new palette, not just the current one.
    expect(getRun("run-1")!.frames.get("frame-2")!.buffer.palette).toEqual(next);
    // The frame reads legend from the same live palette.
    const frame = await tool("read_frame").call({}, { operationId: "run-1" });
    expect(frame).toMatchObject({
      colors: [
        { index: 1, hex: "#111111", count: 3 },
        { index: 2, hex: "#222222", count: 3 },
        { index: 3, hex: "#333333", count: 2 },
      ],
    });
    releaseRun("run-1");
  });

  it("refuses a palette that drops a color another frame still uses", async () => {
    boundRun();
    await expect(
      tool("set_palette").call(
        { palette: ["#00000000", "#111111"] },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow();
    releaseRun("run-1");
  });
});

describe("frame tools", () => {
  it("use_frame switches the frame that later tools default to", async () => {
    boundFrameRun();
    await tool("use_frame").call({ frameId: "frame-2" }, { operationId: "run-1" });
    expect(getRun("run-1")?.currentFrameId).toBe("frame-2");
    const layerId = getRun("run-1")?.frames.get("frame-2")?.buffer.layers[0]?.id ?? "";
    await tool("paint_stroke").call(
      { layerId, label: "dot", points: [{ x: 2, y: 2, color: 2 }] },
      { operationId: "run-1" },
    );
    const run = getRun("run-1");
    expect(run?.frames.get("frame-2")?.buffer.layers[0]?.pixels[2 * 8 + 2]).toBe(2);
    expect(run?.frames.get("frame-1")?.buffer.layers[0]?.pixels[2 * 8 + 2]).toBe(0);
    releaseRun("run-1");
  });

  it("use_frame refuses a frame that is not part of the asset", async () => {
    boundFrameRun();
    await expect(
      tool("use_frame").call({ frameId: "frame-9" }, { operationId: "run-1" }),
    ).rejects.toThrow('No frame named or identified by "frame-9"');
    releaseRun("run-1");
  });

  it("add_frame appends a blank frame, makes it current, and joins the approved scope", async () => {
    const changes: FrameChange[] = [];
    boundFrameRun((change) => {
      changes.push(change);
    });
    const result = (await tool("add_frame").call(
      { name: "jump" },
      { operationId: "run-1" },
    )) as { frameId: string; name: string; index: number };
    const run = getRun("run-1");
    expect([...run!.frames].map(([, frame]) => frame.name)).toEqual([
      "idle",
      "hop",
      "jump",
    ]);
    expect(result).toMatchObject({ name: "jump", index: 2 });
    expect(run!.currentFrameId).toBe(result.frameId);
    expect(run!.approvedScope.has(result.frameId)).toBe(true);
    const added = run!.frames.get(result.frameId);
    expect(added?.index).toBe(2);
    expect(added?.buffer.width).toBe(8);
    expect([...added!.buffer.layers[0]!.pixels]).toEqual(new Array(64).fill(0));
    expect(changes).toEqual([
      {
        type: "add",
        frame: {
          id: result.frameId,
          name: "jump",
          index: 2,
          buffer: added!.buffer,
        },
      },
    ]);
    releaseRun("run-1");
  });

  it("add_frame names an unnamed frame frame-3 after two frames", async () => {
    boundFrameRun();
    const result = (await tool("add_frame").call({}, { operationId: "run-1" })) as {
      name: string;
    };
    expect(result.name).toBe("frame-3");
    releaseRun("run-1");
  });

  it("add_frame with copyOf copies the frame with fresh layer ids", async () => {
    boundFrameRun();
    const result = (await tool("add_frame").call(
      { copyOf: "frame-2" },
      { operationId: "run-1" },
    )) as { frameId: string; name: string };
    const run = getRun("run-1");
    const source = run!.frames.get("frame-2");
    const added = run!.frames.get(result.frameId);
    expect(added?.name).toBe("hop copy");
    expect(added?.buffer.layers[0]?.pixels).toEqual(source?.buffer.layers[0]?.pixels);
    expect(added?.buffer.layers[0]?.pixels[0]).toBe(4);
    expect(added?.buffer.layers[0]?.id).not.toBe(source?.buffer.layers[0]?.id);
    releaseRun("run-1");
  });

  it("add_frame waits for an async frame change before it returns", async () => {
    const order: string[] = [];
    boundFrameRun(async () => {
      await Promise.resolve();
      order.push("persisted");
    });
    await tool("add_frame").call({ name: "jump" }, { operationId: "run-1" });
    order.push("returned");
    expect(order).toEqual(["persisted", "returned"]);
    releaseRun("run-1");
  });

  it("rename_frame trims the name and reports the change", async () => {
    const changes: FrameChange[] = [];
    boundFrameRun((change) => {
      changes.push(change);
    });
    const result = await tool("rename_frame").call(
      { frameId: "frame-2", name: "  hop-2  " },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({ frameId: "frame-2", name: "hop-2" });
    expect(getRun("run-1")?.frames.get("frame-2")?.name).toBe("hop-2");
    expect(changes).toEqual([{ type: "rename", frameId: "frame-2", name: "hop-2" }]);
    releaseRun("run-1");
  });

  it("rename_frame refuses a blank name", async () => {
    boundFrameRun();
    await expect(
      tool("rename_frame").call({ name: "   " }, { operationId: "run-1" }),
    ).rejects.toThrow(/name/i);
    releaseRun("run-1");
  });

  it("move_frame reorders the map and renumbers densely", async () => {
    const changes: FrameChange[] = [];
    boundFrameRun((change) => {
      changes.push(change);
    });
    const result = (await tool("move_frame").call(
      { frameId: "frame-1", toIndex: 1 },
      { operationId: "run-1" },
    )) as { frameId: string; index: number; order: string[] };
    const run = getRun("run-1");
    expect([...run!.frames.keys()]).toEqual(["frame-2", "frame-1"]);
    expect([...run!.frames.values()].map((frame) => frame.index)).toEqual([0, 1]);
    expect(result).toMatchObject({ frameId: "frame-1", index: 1 });
    expect(result.order).toEqual(["frame-2", "frame-1"]);
    expect(changes).toEqual([
      {
        type: "move",
        order: [
          { id: "frame-2", index: 0 },
          { id: "frame-1", index: 1 },
        ],
      },
    ]);
    releaseRun("run-1");
  });

  it("delete_frame removes a frame and keeps the others", async () => {
    const changes: FrameChange[] = [];
    boundFrameRun((change) => {
      changes.push(change);
    });
    await tool("delete_frame").call({ frameId: "frame-2" }, { operationId: "run-1" });
    const run = getRun("run-1");
    expect([...run!.frames.keys()]).toEqual(["frame-1"]);
    expect(changes).toEqual([{ type: "delete", frameId: "frame-2" }]);
    releaseRun("run-1");
  });

  it("delete_frame on the last frame replaces it with a fresh frame-1", async () => {
    const changes: FrameChange[] = [];
    boundFrameRun((change) => {
      changes.push(change);
    });
    await tool("delete_frame").call({ frameId: "frame-1" }, { operationId: "run-1" });
    await tool("delete_frame").call({ frameId: "frame-2" }, { operationId: "run-1" });
    const run = getRun("run-1");
    expect(run!.frames.size).toBe(1);
    const [replacementId, replacement] = [...run!.frames][0]!;
    expect(replacement.name).toBe("frame-1");
    expect(replacement.index).toBe(0);
    expect(run!.currentFrameId).toBe(replacementId);
    expect(run!.approvedScope.has(replacementId)).toBe(true);
    expect(replacement.buffer.layers[0]?.pixels.every((value) => value === 0)).toBe(true);
    expect(changes).toEqual([
      { type: "delete", frameId: "frame-1" },
      {
        type: "delete",
        frameId: "frame-2",
        replacement: {
          id: replacementId,
          name: "frame-1",
          index: 0,
          buffer: replacement.buffer,
        },
      },
    ]);
    releaseRun("run-1");
  });

  it("delete_frame refuses a frame that is not part of the asset", async () => {
    boundFrameRun();
    await expect(
      tool("delete_frame").call({ frameId: "frame-9" }, { operationId: "run-1" }),
    ).rejects.toThrow('No frame named or identified by "frame-9"');
    releaseRun("run-1");
  });

  it("add_frame leaves the binding untouched when the frame change is refused", async () => {
    boundFrameRun(() => {
      throw new Error("The frame change could not be saved.");
    });
    await expect(
      tool("add_frame").call({ name: "jump" }, { operationId: "run-1" }),
    ).rejects.toThrow("The frame change could not be saved.");
    const run = getRun("run-1");
    expect(run?.frames.size).toBe(2);
    expect([...run!.frames.keys()]).toEqual(["frame-1", "frame-2"]);
    expect(run?.currentFrameId).toBe("frame-1");
    expect(run?.approvedScope).toEqual(new Set(["frame-1"]));
    releaseRun("run-1");
  });

  it("delete_frame leaves the binding untouched when the frame change is refused", async () => {
    boundFrameRun(() => {
      throw new Error("The frame change could not be saved.");
    });
    await expect(
      tool("delete_frame").call({ frameId: "frame-2" }, { operationId: "run-1" }),
    ).rejects.toThrow("The frame change could not be saved.");
    const run = getRun("run-1");
    expect([...run!.frames.keys()]).toEqual(["frame-1", "frame-2"]);
    expect(run?.currentFrameId).toBe("frame-1");
    expect(run?.approvedScope).toEqual(new Set(["frame-1"]));
    releaseRun("run-1");
  });

  it("rename_frame leaves the name untouched when the frame change is refused", async () => {
    boundFrameRun(() => {
      throw new Error("The frame change could not be saved.");
    });
    await expect(
      tool("rename_frame").call(
        { frameId: "frame-2", name: "hop-2" },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("The frame change could not be saved.");
    expect(getRun("run-1")?.frames.get("frame-2")?.name).toBe("hop");
    releaseRun("run-1");
  });

  it("move_frame leaves the order untouched when the frame change is refused", async () => {
    boundFrameRun(() => {
      throw new Error("The frame change could not be saved.");
    });
    await expect(
      tool("move_frame").call(
        { frameId: "frame-1", toIndex: 1 },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("The frame change could not be saved.");
    const run = getRun("run-1");
    expect([...run!.frames.keys()]).toEqual(["frame-1", "frame-2"]);
    expect([...run!.frames.values()].map((frame) => frame.index)).toEqual([0, 1]);
    releaseRun("run-1");
  });

  it("add_frame persists the candidate frame before the binding changes", async () => {
    const sizes: number[] = [];
    boundFrameRun(async () => {
      sizes.push(getRun("run-1")?.frames.size ?? -1);
    });
    await tool("add_frame").call({ name: "jump" }, { operationId: "run-1" });
    expect(sizes).toEqual([2]);
    expect(getRun("run-1")?.frames.size).toBe(3);
    releaseRun("run-1");
  });

  it("delete_frame persists before the binding drops the frame", async () => {
    const sizes: number[] = [];
    boundFrameRun(async () => {
      sizes.push(getRun("run-1")?.frames.size ?? -1);
    });
    await tool("delete_frame").call({ frameId: "frame-2" }, { operationId: "run-1" });
    expect(sizes).toEqual([2]);
    expect(getRun("run-1")?.frames.size).toBe(1);
    releaseRun("run-1");
  });
});

describe("layer tools", () => {
  it("add_layer appends a named layer to the current frame and feeds it live", async () => {
    const seen: Array<{ frameId: string; layers: number }> = [];
    boundRun((_stroke, buffer, frameId) => {
      seen.push({ frameId, layers: buffer.layers.length });
    });
    const result = (await tool("add_layer").call(
      { name: "shade" },
      { operationId: "run-1" },
    )) as { layerId: string; name: string; layers: number };
    const run = getRun("run-1");
    const layers = run!.frames.get("frame-1")!.buffer.layers;
    expect(layers).toHaveLength(3);
    expect(layers.at(-1)).toMatchObject({
      id: result.layerId,
      name: "shade",
      visible: true,
    });
    expect(layers.at(-1)!.pixels.every((value) => value === 0)).toBe(true);
    expect(result).toMatchObject({ name: "shade", layers: 3 });
    expect(seen).toEqual([{ frameId: "frame-1", layers: 3 }]);
    releaseRun("run-1");
  });

  it("add_text creates editable pixel text and edit_text rewrites it", async () => {
    boundRun();
    const added = (await tool("add_text").call(
      { text: "A", x: 0, y: 0, size: 16, color: 1 },
      { operationId: "run-1" },
    )) as { layerId: string };
    const run = getRun("run-1");
    const before = run!.frames
      .get("frame-1")!
      .buffer.layers.find((layer) => layer.id === added.layerId);
    expect(before?.text).toMatchObject({ text: "A", color: 1, size: 16 });
    expect(before?.pixels).toHaveLength(16);

    await tool("edit_text").call(
      { layerId: added.layerId, text: "B", x: 1, y: 1, color: 2 },
      { operationId: "run-1" },
    );
    const after = getRun("run-1")!
      .frames.get("frame-1")!
      .buffer.layers.find((layer) => layer.id === added.layerId);
    expect(after?.text).toMatchObject({ text: "B", color: 2, x: 1, y: 1 });
    expect(after?.pixels).toHaveLength(16);
    releaseRun("run-1");
  });

  it("add_text rasterizes glyph pixels on a normal frame", async () => {
    const pixels = new Uint8Array(32 * 32);
    const nativeFrame = {
      width: 32,
      height: 32,
      palette: [...palette],
      layers: [{ id: "artwork", name: "Artwork", visible: true, pixels }],
    };
    boundRun(undefined, undefined, {
      width: 32,
      height: 32,
      frames: new Map([
        [
          "frame-1",
          {
            name: "Instagram announcement",
            index: 0,
            buffer: nativeFrame,
          },
        ],
      ]),
    });
    await tool("add_text").call(
      { text: "A", x: 4, y: 4, size: 16, color: 1 },
      { operationId: "run-1" },
    );
    const layer = getRun("run-1")!
      .frames.get("frame-1")!
      .buffer.layers.find((item) => item.text);
    expect(layer?.text?.text).toBe("A");
    expect(layer?.pixels.some((value) => value === 1)).toBe(true);
    releaseRun("run-1");
  });

  it("add_layer names the layer layer-3 by default", async () => {
    boundRun();
    const result = (await tool("add_layer").call({}, { operationId: "run-1" })) as {
      name: string;
    };
    expect(result.name).toBe("layer-3");
    releaseRun("run-1");
  });

  it("add_layer keeps adding layers past four", async () => {
    boundRun();
    await tool("add_layer").call({}, { operationId: "run-1" });
    await tool("add_layer").call({}, { operationId: "run-1" });
    await tool("add_layer").call({}, { operationId: "run-1" });
    await tool("add_layer").call({}, { operationId: "run-1" });
    expect(getRun("run-1")!.frames.get("frame-1")!.buffer.layers).toHaveLength(6);
    releaseRun("run-1");
  });

  it("rename_layer trims the name and reports it", async () => {
    boundRun();
    const result = await tool("rename_layer").call(
      { layerId: "layer-detail", name: "  highlights  " },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({ layerId: "layer-detail", name: "highlights" });
    expect(getRun("run-1")!.frames.get("frame-1")!.buffer.layers[1]!.name).toBe(
      "highlights",
    );
    releaseRun("run-1");
  });

  it("rename_layer refuses a blank name", async () => {
    boundRun();
    await expect(
      tool("rename_layer").call(
        { layerId: "layer-detail", name: "   " },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow(/name/i);
    releaseRun("run-1");
  });

  it("set_layer_visible hides and shows a layer", async () => {
    boundRun();
    const hidden = await tool("set_layer_visible").call(
      { layerId: "layer-detail", visible: false },
      { operationId: "run-1" },
    );
    expect(hidden).toMatchObject({ layerId: "layer-detail", visible: false });
    expect(getRun("run-1")!.frames.get("frame-1")!.buffer.layers[1]!.visible).toBe(false);
    const shown = await tool("set_layer_visible").call(
      { layerId: "layer-detail", visible: true },
      { operationId: "run-1" },
    );
    expect(shown).toMatchObject({ layerId: "layer-detail", visible: true });
    releaseRun("run-1");
  });

  it("remove_layer drops a layer from the current frame", async () => {
    boundRun();
    const result = await tool("remove_layer").call(
      { layerId: "layer-detail" },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({ removed: "layer-detail", layers: 1 });
    expect(
      getRun("run-1")!
        .frames.get("frame-1")!
        .buffer.layers.map((layer) => layer.id),
    ).toEqual(["layer-base"]);
    releaseRun("run-1");
  });

  it("remove_layer refuses to remove the last layer", async () => {
    boundRun();
    await tool("remove_layer").call(
      { layerId: "layer-detail" },
      { operationId: "run-1" },
    );
    await expect(
      tool("remove_layer").call({ layerId: "layer-base" }, { operationId: "run-1" }),
    ).rejects.toThrow("A frame keeps at least one layer.");
    releaseRun("run-1");
  });
});

describe("think", () => {
  it("registers the Anvia scratchpad and returns the thought", async () => {
    boundRun();
    const result = await tool("think").call(
      { thought: "Two layers: base silhouette, then shading." },
      { operationId: "run-1" },
    );
    expect(result).toBe("Two layers: base silhouette, then shading.");
    releaseRun("run-1");
  });
});

describe("plan", () => {
  it("returns the steps and stores them on the run", async () => {
    boundRun();
    const steps = ["outline the slime", "paint the body", "critique"];
    const result = (await tool("plan").call({ steps }, { operationId: "run-1" })) as {
      steps: string[];
    };
    expect(result.steps).toEqual(steps);
    expect(getRun("run-1")?.plan).toEqual(steps);
    releaseRun("run-1");
  });
});

describe("present_plan", () => {
  const frames = [
    { frameId: "frame-1", name: "idle", description: "rest pose" },
    { frameId: "frame-2", name: "hop", description: "airborne" },
    { name: "land", description: "touch down" },
  ];

  it("always asks for approval", () => {
    expect(tool("present_plan").requiresApproval).toBe(true);
  });

  it("scopes the run's origin frame; the frames arrive with add_frame", async () => {
    boundRun();
    const result = (await tool("present_plan").call(
      { summary: "hop cycle" },
      { operationId: "run-1" },
    )) as { approved: boolean; summary: string; scope: string[] };
    expect(result.approved).toBe(true);
    expect(result.summary).toBe("hop cycle");
    // The approval carries one line; frames the plan creates join the scope
    // through add_frame, which is where frame ids come from now.
    expect(result.scope).toEqual(["frame-1"]);
    expect(getRun("run-1")?.approvedScope).toEqual(new Set(["frame-1"]));
    releaseRun("run-1");
  });

  it("consumes a staged override and scopes exactly its frames", async () => {
    boundRun();
    const run = getRun("run-1")!;
    run.stagedOverride = {
      interactionId: "interaction-1",
      frames: [{ frameId: "frame-2", name: "hop", description: "airborne only" }],
    };
    const result = (await tool("present_plan").call(
      { summary: "hop cycle" },
      { operationId: "run-1" },
    )) as { summary: string; scope: string[] };
    expect(result.summary).toBe("hop cycle");
    expect(result.scope).toEqual(["frame-1", "frame-2"]);
    expect(run.stagedOverride).toBeUndefined();
    releaseRun("run-1");
  });

  it("keys a staged override to the interaction it answers", () => {
    const edited = [{ frameId: "frame-2", name: "hop", description: "airborne only" }];
    expect(stagedOverrideSchema.safeParse({ frames: edited }).success).toBe(false);
    expect(
      stagedOverrideSchema.safeParse({ interactionId: "", frames: edited }).success,
    ).toBe(false);
    expect(
      stagedOverrideSchema.safeParse({ interactionId: "interaction-1", frames: edited })
        .success,
    ).toBe(true);
  });

  it("does not reuse a consumed override for a later proposal", async () => {
    boundRun();
    const run = getRun("run-1")!;
    run.stagedOverride = {
      interactionId: "interaction-1",
      frames: [{ frameId: "frame-2", name: "hop", description: "airborne only" }],
    };
    await tool("present_plan").call(
      { summary: "first proposal" },
      { operationId: "run-1" },
    );
    const second = (await tool("present_plan").call(
      { summary: "second proposal" },
      { operationId: "run-1" },
    )) as { summary: string; scope: string[] };
    expect(second.summary).toBe("second proposal");
    // The override fed the first proposal only; the second scopes the origin.
    expect(second.scope).toEqual(["frame-1"]);
    releaseRun("run-1");
  });

  it("refuses a malformed staged override instead of guessing", async () => {
    boundRun();
    const run = getRun("run-1")!;
    run.stagedOverride = {
      interactionId: "interaction-1",
      frames: [{ name: "", description: "" }],
    } as never;
    await expect(
      tool("present_plan").call(
        { summary: "hop cycle", frames },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow(/override/i);
    releaseRun("run-1");
  });
});

describe("workspace tools", () => {
  it("drawing and read tools fail with the bounded sentence before an asset is bound", async () => {
    unboundRun();
    await expect(
      tool("paint_stroke").call(
        { layerId: "layer-a", label: "dot", points: [{ x: 1, y: 1, color: 2 }] },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("Choose or create an asset first.");
    await expect(tool("read_project").call({}, { operationId: "run-1" })).rejects.toThrow(
      "Choose or create an asset first.",
    );
    await expect(tool("read_frame").call({}, { operationId: "run-1" })).rejects.toThrow(
      "Choose or create an asset first.",
    );
    await expect(tool("add_frame").call({}, { operationId: "run-1" })).rejects.toThrow(
      "Choose or create an asset first.",
    );
    await expect(
      tool("critique_frame").call({}, { operationId: "run-1" }),
    ).rejects.toThrow("Choose or create an asset first.");
    releaseRun("run-1");
  });

  it("a genuinely lost run still fails as no longer active", async () => {
    unboundRun();
    releaseRun("run-1");
    await expect(
      tool("paint_stroke").call(
        { layerId: "layer-a", label: "dot", points: [{ x: 1, y: 1, color: 2 }] },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("This drawing run is no longer active.");
  });

  it("plan tools work before an asset is bound", async () => {
    unboundRun();
    const steps = ["choose a project", "create the asset"];
    expect(await tool("plan").call({ steps }, { operationId: "run-1" })).toEqual({
      steps,
    });
    const proposed = (await tool("present_plan").call(
      { summary: "slime", frames: [{ name: "idle", description: "rest pose" }] },
      { operationId: "run-1" },
    )) as { approved: boolean; scope: string[] };
    expect(proposed.approved).toBe(true);
    expect(proposed.scope).toEqual([]);
    releaseRun("run-1");
  });

  it("use_asset loads the asset through the callback and binds its frames", async () => {
    const calls: Array<{ userId: string; assetId: string }> = [];
    unboundRun({
      userId: "user-1",
      onLoadAsset: async (userId, assetId) => {
        calls.push({ userId, assetId });
        return loadedAsset();
      },
    });
    const result = (await tool("use_asset").call(
      { assetId: "asset-2" },
      { operationId: "run-1" },
    )) as {
      assetId: string;
      name: string;
      currentFrameId: string;
      frames: Array<{ id: string }>;
    };
    expect(calls).toEqual([{ userId: "user-1", assetId: "asset-2" }]);
    expect(result).toMatchObject({
      assetId: "asset-2",
      name: "slime",
      width: 4,
      height: 4,
      currentFrameId: "frame-a",
    });
    expect(result.frames.map((frame) => frame.id)).toEqual(["frame-a", "frame-b"]);
    const run = getRun("run-1")!;
    expect(run.assetId).toBe("asset-2");
    expect(run.originFrameId).toBe("frame-a");
    expect(run.currentFrameId).toBe("frame-a");
    expect([...run.frames.keys()]).toEqual(["frame-a", "frame-b"]);
    expect(run.palette).toEqual(palette);
    expect(run.width).toBe(4);
    expect(run.height).toBe(4);
    expect(run.approvedScope).toEqual(new Set(["frame-a"]));
    // The run can draw right away, on the bound origin frame.
    await tool("paint_stroke").call(
      { layerId: "layer-base", label: "dot", points: [{ x: 2, y: 2, color: 5 }] },
      { operationId: "run-1" },
    );
    expect(run.frames.get("frame-a")!.buffer.layers[0]!.pixels[2 * 4 + 2]).toBe(5);
    releaseRun("run-1");
  });

  it("use_asset switches the binding and restarts the scope at the new origin", async () => {
    unboundRun({
      userId: "user-1",
      onLoadAsset: async () => loadedAsset(),
    });
    await tool("use_asset").call({ assetId: "asset-2" }, { operationId: "run-1" });
    const run = getRun("run-1")!;
    run.approvedScope.add("frame-b");
    run.touchedFrames.add("frame-a");
    await tool("use_asset").call({ assetId: "asset-2" }, { operationId: "run-1" });
    expect(run.approvedScope).toEqual(new Set(["frame-a"]));
    expect(run.touchedFrames.size).toBe(0);
    releaseRun("run-1");
  });

  it("create_asset hands the run's user id to the callback and binds the created asset", async () => {
    const seen: Array<{ userId: string; input: CreateAssetInput }> = [];
    unboundRun({
      userId: "user-7",
      onCreateAsset: async (userId, input) => {
        seen.push({ userId, input });
        return loadedAsset();
      },
    });
    const result = (await tool("create_asset").call(
      {
        projectId: "project-1",
        name: "  slime  ",
        width: 8,
        height: 8,
        palette: ["#00000000", "#FFAA00"],
      },
      { operationId: "run-1" },
    )) as { assetId: string; currentFrameId: string };
    expect(seen).toEqual([
      {
        userId: "user-7",
        input: {
          projectId: "project-1",
          name: "slime",
          width: 8,
          height: 8,
          palette: ["#00000000", "#ffaa00"],
        },
      },
    ]);
    expect(result.assetId).toBe("asset-2");
    expect(result.currentFrameId).toBe("frame-a");
    expect(getRun("run-1")!.assetId).toBe("asset-2");
    releaseRun("run-1");
  });

  it("create_asset refuses a palette that does not start transparent", async () => {
    const seen: CreateAssetInput[] = [];
    unboundRun({
      userId: "user-7",
      onCreateAsset: async (_userId, input) => {
        seen.push(input);
        return loadedAsset();
      },
    });
    await expect(
      tool("create_asset").call(
        {
          projectId: "project-1",
          name: "slime",
          width: 8,
          height: 8,
          palette: ["#ffaa00", "#00000000"],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("#00000000");
    expect(seen).toEqual([]);
    expect(getRun("run-1")!.assetId).toBeUndefined();
    releaseRun("run-1");
  });

  it("list tools hand the run's user id to the callbacks and return their rows", async () => {
    const seen: string[] = [];
    unboundRun({
      userId: "user-3",
      onListProjects: async (userId) => {
        seen.push(userId);
        return [
          {
            id: "project-1",
            name: "Pixelaition",
            summary: "pixel assets",
            updatedAt: "2026-10-11T00:00:00.000Z",
            assetCount: 2,
          },
        ];
      },
      onListAssets: async (userId, projectId) => {
        seen.push(`${userId}:${projectId}`);
        return [
          {
            id: "asset-2",
            name: "slime",
            summary: "a green slime",
            width: 32,
            height: 32,
            frameCount: 4,
            updatedAt: "2026-10-11T00:00:00.000Z",
          },
        ];
      },
    });
    expect(await tool("list_projects").call({}, { operationId: "run-1" })).toEqual([
      {
        id: "project-1",
        name: "Pixelaition",
        summary: "pixel assets",
        updatedAt: "2026-10-11T00:00:00.000Z",
        assetCount: 2,
      },
    ]);
    expect(
      await tool("list_assets").call(
        { projectId: "project-1" },
        { operationId: "run-1" },
      ),
    ).toEqual([
      {
        id: "asset-2",
        name: "slime",
        width: 32,
        height: 32,
        summary: "a green slime",
        frameCount: 4,
        updatedAt: "2026-10-11T00:00:00.000Z",
      },
    ]);
    expect(seen).toEqual(["user-3", "user-3:project-1"]);
    releaseRun("run-1");
  });

  it("lets a worker list projects on an asset run that carries the owner callbacks", async () => {
    boundRun(undefined, undefined, { role: "worker" });
    const run = getRun("run-1");
    if (!run) throw new Error("missing run");
    run.userId = "user-3";
    run.onListProjects = async () => [
      {
        id: "project-1",
        name: "Hutan Ksatria",
        summary: "",
        updatedAt: "2026-10-15T00:00:00.000Z",
        assetCount: 1,
      },
    ];
    // A worker reads the whole project, but through the catalog a worker
    // actually carries: the workspace listing and target tools belong to the
    // supervisor, so the worker is never offered one.
    await expect(
      tool("list_projects").call({}, { operationId: "run-1" }),
    ).rejects.toThrow("The worker role cannot call list_projects.");
    await expect(
      tool("critique_frame").call({}, { operationId: "run-1" }),
    ).rejects.toThrow("The worker role cannot call critique_frame.");
    await expect(
      tool("list_project_frames").call({}, { operationId: "run-1" }),
    ).resolves.toMatchObject({ assets: [{ name: "slime" }] });
    releaseRun("run-1");
  });

  it("workspace tools fail closed on a run without callbacks", async () => {
    unboundRun();
    await expect(
      tool("list_projects").call({}, { operationId: "run-1" }),
    ).rejects.toThrow("This run cannot list projects.");
    await expect(
      tool("list_assets").call({ projectId: "project-1" }, { operationId: "run-1" }),
    ).rejects.toThrow("This run cannot list assets.");
    await expect(
      tool("create_asset").call(
        { projectId: "project-1", name: "slime", width: 8, height: 8 },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("This run cannot create an asset.");
    await expect(
      tool("use_asset").call({ assetId: "asset-2" }, { operationId: "run-1" }),
    ).rejects.toThrow("This run cannot choose an asset.");
    releaseRun("run-1");
  });
});

describe("drawing approval", () => {
  it("never gates a painting tool, whatever the scope", async () => {
    boundRun();
    stubJev(0.97);
    const run = getRun("run-1")!;
    run.approvedScope = new Set(["frame-2"]);
    const stroke = {
      frameId: "frame-2",
      layerId: "layer-a",
      label: "dot",
      points: [{ x: 1, y: 1, color: 2 }],
    };
    // Drawing is harmless: laying pixels down is never a question, inside the
    // approved scope or outside it.
    const painting: Array<[string, Record<string, unknown>]> = [
      ["paint_stroke", stroke],
      ["paint_stroke", { ...stroke, frameId: "frame-3" }],
      ["fill_rect", { frameId: "frame-3" }],
      ["erase_stroke", { frameId: "frame-3" }],
      ["draw_line", { frameId: "frame-3" }],
      ["flood_fill", { frameId: "frame-3" }],
      ["fill_region", { frameId: "frame-3" }],
      ["clear_region", { frameId: "frame-3" }],
      ["set_palette", { frameId: "frame-3" }],
      ["apply_outline", { frameId: "frame-3" }],
      ["dither_rect", { frameId: "frame-3" }],
      ["mirror_frame", { frameId: "frame-3" }],
    ];
    for (const [name] of painting) {
      // Harmless by declaration: the predicate exists but never asks.
      const requirement = tool(name).requiresApproval;
      expect(typeof requirement).toBe("function");
      if (typeof requirement === "function") {
        expect(await requirement({} as never, {} as never)).toBe(false);
      }
    }
    // Recolour still asks outside the approved scope. A palette change does not.
    expect(await approval("replace_color", { frameId: "frame-2", from: 1, to: 0 })).toBe(
      false,
    );
    expect(await approval("replace_color", { frameId: "frame-3", from: 1, to: 0 })).toBe(
      true,
    );
    releaseRun("run-1");
  });

  it("gates a destructive call without a frame id on the current frame", async () => {
    boundRun();
    stubJev(0.97);
    const run = getRun("run-1")!;
    run.approvedScope = new Set(["frame-2"]);
    expect(await approval("replace_color", { from: 1, to: 0 })).toBe(true);
    run.currentFrameId = "frame-2";
    expect(await approval("replace_color", { from: 1, to: 0 })).toBe(false);
    releaseRun("run-1");
  });

  it("reads the binding live, so a frame approved later stops asking", async () => {
    boundRun();
    stubJev(0.97);
    const call = {
      layerId: "layer-a",
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      frameId: "frame-2",
    };
    expect(await approval("replace_color", { ...call, from: 1, to: 0 })).toBe(true);
    getRun("run-1")!.approvedScope.add("frame-2");
    expect(await approval("replace_color", { ...call, from: 1, to: 0 })).toBe(false);
    releaseRun("run-1");
  });

  it("asks for approval when no binding is live", async () => {
    boundRun();
    stubJev(0.97);
    expect(
      await approval("replace_color", { frameId: "frame-1", from: 1, to: 0 }, "run-9"),
    ).toBe(true);
    releaseRun("run-1");
  });

  it("refuses a call Jev blocks instead of touching the frame", async () => {
    boundRun();
    stubJev(0.02);
    expect(await approval("replace_color", { frameId: "frame-1", from: 1, to: 0 })).toBe(
      false,
    );
    const result = await tool("replace_color").call(
      { from: 1, to: 0 },
      { operationId: "run-1" },
    );
    expect(result).toMatchObject({
      refused: expect.stringContaining("not supported"),
    });
    const layer = getRun("run-1")!.frames.get("frame-1")!.buffer.layers[0]!;
    expect([...layer.pixels]).toEqual([...basePixels]);
    releaseRun("run-1");
  });

  it("pauses a call Jev cannot call clearly, with its verdict as the reason", async () => {
    boundRun();
    stubJev(0.6);
    const verdict = await approval("replace_color", {
      frameId: "frame-1",
      from: 1,
      to: 0,
    });
    expect(verdict).toMatchObject({
      reason: expect.stringContaining("Jev: the request check is not clear"),
    });
    releaseRun("run-1");
  });

  it("gates a frame delete on the request check", async () => {
    boundRun();
    stubJev(0.02);
    expect(await approval("delete_frame", { frameId: "frame-1" })).toBe(false);
    const refused = await tool("delete_frame").call(
      { frameId: "frame-1" },
      { operationId: "run-1" },
    );
    expect(refused).toMatchObject({
      refused: expect.stringContaining("not supported"),
    });
    expect(getRun("run-1")!.frames.size).toBe(2);
    releaseRun("run-1");
  });

  it("runs a resize without asking when the size cannot drop a pixel or the request check approves", async () => {
    boundRun();
    // The same size is harmless: no Jev call, no approval.
    expect(await approval("resize_canvas", { width: 4, height: 4 })).toBe(false);
    stubJev(0.97);
    expect(await approval("resize_canvas", { width: 8, height: 8 })).toBe(false);
    releaseRun("run-1");
  });

  it("reports the resize as an asset change so the canvas size is persisted", async () => {
    const changes: FrameChange[] = [];
    const strokes: string[] = [];
    boundRun(
      (stroke) => {
        strokes.push(stroke.label);
      },
      (change) => {
        changes.push(change);
      },
    );
    const result = await tool("resize_canvas").call(
      { width: 8, height: 8 },
      { operationId: "run-1" },
    );
    expect(result).toEqual({ width: 8, height: 8, frames: 2 });
    expect(strokes).toEqual(["resize", "resize"]);
    // The frames were replaced at the new size; the asset row needs the same
    // size, or a reload decodes 8×8 pixels against a 4×4 asset.
    expect(changes).toEqual([{ type: "resize", width: 8, height: 8 }]);
    const run = getRun("run-1");
    expect(run?.width).toBe(8);
    expect(
      [...(run?.frames.values() ?? [])].every((frame) => frame.buffer.width === 8),
    ).toBe(true);
    releaseRun("run-1");
  });
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("check_animation", () => {
  it("measures every pair in index order and the loop back to the first frame", async () => {
    boundRun();
    const result = (await tool("check_animation").call({}, { operationId: "run-1" })) as {
      pairs: Array<{ from: string; to: string; centroidShift: number }>;
      loop: { from: string; to: string };
      flags: string[];
      frames: Array<{ id: string; name: string; opaquePixels: number }>;
    };
    expect(result.pairs.map((pair) => [pair.from, pair.to])).toEqual([
      ["frame-1", "frame-2"],
    ]);
    expect(result.loop).toMatchObject({ from: "frame-2", to: "frame-1" });
    expect(
      result.frames.map((frame) => [frame.id, frame.name, frame.opaquePixels]),
    ).toEqual([
      ["frame-1", "idle", 8],
      ["frame-2", "hop", 1],
    ]);
    // idle's centroid sits at (1.5, 1.5) and hop's at (0, 3): the drawing
    // slides more than two pixels, and the flag names the frame, not its id.
    expect(result.flags.some((flag) => flag.includes("slides"))).toBe(true);
    expect(result.flags.join(" ")).toContain("hop");
    releaseRun("run-1");
  });

  it("measures only the named frames, in the order given", async () => {
    boundRun();
    const result = (await tool("check_animation").call(
      { frameIds: ["frame-2", "frame-1"] },
      { operationId: "run-1" },
    )) as {
      pairs: Array<{ from: string; to: string }>;
      loop: { from: string; to: string };
    };
    expect(result.pairs.map((pair) => [pair.from, pair.to])).toEqual([
      ["frame-2", "frame-1"],
    ]);
    expect(result.loop).toMatchObject({ from: "frame-1", to: "frame-2" });
    releaseRun("run-1");
  });

  it("refuses a frame that is not part of the asset", async () => {
    boundRun();
    await expect(
      tool("check_animation").call({ frameIds: ["frame-9"] }, { operationId: "run-1" }),
    ).rejects.toThrow('No frame named or identified by "frame-9"');
    releaseRun("run-1");
  });
});

describe("3-shade rock", () => {
  it("draws a rock with outline and dither that critiques clean", async () => {
    boundFrameRun();
    const layerId = getRun("run-1")!.frames.get("frame-1")!.buffer.layers[0]!.id;
    // A 4×4 body at (2,2)–(5,5): one base shade, the lower half dithered, and
    // the style outline ringed around it. One empty border pixel all round.
    const body: Array<{ x: number; y: number; color: number }> = [];
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) body.push({ x, y, color: 2 });
    }
    await tool("paint_stroke").call(
      { layerId, label: "rock base", points: body },
      { operationId: "run-1" },
    );
    await tool("dither_rect").call(
      {
        layerId,
        x: 2,
        y: 4,
        width: 4,
        height: 2,
        colorA: 2,
        colorB: 3,
        pattern: "checker",
      },
      { operationId: "run-1" },
    );
    expect(await tool("apply_outline").call({}, { operationId: "run-1" })).toMatchObject({
      committed: true,
      color: 1,
    });
    const result = (await tool("critique_frame").call({}, { operationId: "run-1" })) as {
      issues: Array<{ code: string }>;
    };
    expect(result.issues).toEqual([]);
    releaseRun("run-1");
  });
});

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

describe("layer references by name", () => {
  it("paints, reads, renames, hides, and removes a layer by its name", async () => {
    boundRun();
    const added = (await tool("add_layer").call(
      { name: "shade" },
      { operationId: "run-1" },
    )) as {
      layerId: string;
    };
    await tool("paint_stroke").call(
      { layerId: "shade", label: "dot", points: [{ x: 1, y: 1, color: 1 }] },
      { operationId: "run-1" },
    );
    const frame = (await tool("read_frame").call(
      { layerId: "shade" },
      { operationId: "run-1" },
    )) as { layerId?: string; rows: string[] };
    expect(frame.layerId).toBe(added.layerId);
    expect(frame.rows.join(" ")).toContain("1x1");
    await tool("rename_layer").call(
      { layerId: "shade", name: "shadow" },
      { operationId: "run-1" },
    );
    const project = (await tool("read_project").call({}, { operationId: "run-1" })) as {
      layers: Array<{ name: string }>;
    };
    expect(project.layers.map((layer) => layer.name)).toContain("shadow");
    await tool("set_layer_visible").call(
      { layerId: "shadow", visible: false },
      { operationId: "run-1" },
    );
    const removed = (await tool("remove_layer").call(
      { layerId: "shadow" },
      { operationId: "run-1" },
    )) as { removed: string };
    expect(removed.removed).toBe("shadow");
    releaseRun("run-1");
  });

  it("names the cause for an unknown layer reference", async () => {
    boundRun();
    await expect(
      tool("paint_stroke").call(
        { layerId: "nope", label: "x", points: [{ x: 0, y: 0, color: 1 }] },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow('No layer named or identified by "nope"');
    releaseRun("run-1");
  });
});

describe("web search and reference images", () => {
  it("registers web_search and view_image whenever search is configured", () => {
    const names = (tools: ReturnType<typeof createPixelTools>) =>
      tools.map((item) => item.name);
    expect(names(createPixelTools())).not.toContain("web_search");
    expect(names(createPixelTools())).not.toContain("view_image");
    expect(names(createPixelTools({ webSearch: true }))).toContain("web_search");
    expect(names(createPixelTools({ webSearch: true }))).toContain("view_image");
    expect(names(createPixelTools({ vision: true }))).not.toContain("view_image");
    expect(names(createPixelTools({ vision: true, webSearch: true }))).toContain(
      "view_image",
    );
  });

  it("names the missing Tavily key instead of searching without one", async () => {
    boundRun();
    delete process.env.TAVILY_API_KEY;
    await expect(
      tool("web_search", { webSearch: true }).call(
        { query: "pixel art slime" },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("Set TAVILY_API_KEY");
    releaseRun("run-1");
  });

  it("lists results and only the viewable image URLs", async () => {
    boundRun();
    process.env.TAVILY_API_KEY = "tvly-test";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Slime sprite",
                url: "https://example.com/slime",
                content: "A green slime.",
              },
            ],
            images: [
              { url: "https://cdn.example.com/slime.png", description: "green slime" },
              { url: "http://cdn.example.com/plain.png", description: "no https" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const output = (await tool("web_search", { webSearch: true }).call(
      { query: "slime pixel art" },
      { operationId: "run-1" },
    )) as string;
    expect(output).toContain("Slime sprite");
    expect(output).toContain("https://example.com/slime");
    expect(output).toContain("https://cdn.example.com/slime.png");
    expect(output).not.toContain("plain.png");
    releaseRun("run-1");
  });

  it("fetches a searched image as a file part the model can see", async () => {
    boundRun();
    process.env.TAVILY_API_KEY = "tvly-test";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            results: [],
            images: [{ url: "https://cdn.example.com/slime.png" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await tool("web_search", { webSearch: true }).call(
      { query: "slime pixel art" },
      { operationId: "run-1" },
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://cdn.example.com/slime.png",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => png,
    }));
    const output = (await tool("view_image", { vision: true, webSearch: true }).call(
      { url: "https://cdn.example.com/slime.png" },
      { operationId: "run-1" },
    )) as {
      content: Array<{
        type: string;
        text?: string;
        mediaType?: string;
        data?: { type: string; data: string };
      }>;
    };
    expect(output.content[0]?.text).toContain("image/png");
    const image = output.content[1];
    expect(image?.type).toBe("file");
    expect(image?.mediaType).toBe("image/png");
    expect(Buffer.from(image?.data?.data ?? "", "base64").equals(png)).toBe(true);
    // The Anvia message schema must accept the rich output, or the run fails
    // at tool-result serialization instead of the model seeing the image.
    expect(normalizeToolResultOutput(output).type).toBe("content");
    releaseRun("run-1");
  });

  it("describes a searched image when the drawing model cannot see", async () => {
    boundRun();
    const run = getRun("run-1");
    if (!run) throw new Error("missing run");
    run.searchImages = new Set(["https://cdn.example.com/slime.png"]);
    run.onDescribeImage = async (image) => `gold cub, ${image.mediaType}`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://cdn.example.com/slime.png",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => png,
    }));
    const output = await tool("view_image", { webSearch: true }).call(
      { url: "https://cdn.example.com/slime.png" },
      { operationId: "run-1" },
    );
    expect(output).toContain("seen by the vision model");
    expect(output).toContain("gold cub, image/png");
    releaseRun("run-1");
  });

  it("names a missing vision model instead of pretending to see", async () => {
    boundRun();
    const run = getRun("run-1");
    if (!run) throw new Error("missing run");
    run.searchImages = new Set(["https://cdn.example.com/slime.png"]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://cdn.example.com/slime.png",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => png,
    }));
    await expect(
      tool("view_image", { webSearch: true }).call(
        { url: "https://cdn.example.com/slime.png" },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("no vision model is configured");
    releaseRun("run-1");
  });

  it("refuses an image URL the run never searched", async () => {
    boundRun();
    await expect(
      tool("view_image", { vision: true, webSearch: true }).call(
        { url: "https://evil.example.com/tracker.png" },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("only accepts https image URLs returned by web_search");
    releaseRun("run-1");
  });

  it("refuses an image that redirects to a private host", async () => {
    boundRun();
    process.env.TAVILY_API_KEY = "tvly-test";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            results: [],
            images: [{ url: "https://cdn.example.com/slime.png" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await tool("web_search", { webSearch: true }).call(
      { query: "slime pixel art" },
      { operationId: "run-1" },
    );
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      url: "https://127.0.0.1/private.png",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from([0]),
    }));
    await expect(
      tool("view_image", { vision: true, webSearch: true }).call(
        { url: "https://cdn.example.com/slime.png" },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("redirected to a host the worker will not fetch");
    releaseRun("run-1");
  });
});

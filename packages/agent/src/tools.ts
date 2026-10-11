import { createTool } from "@anvia/core";
import { ToolOutput } from "@anvia/core/tool";
import { frameToPng, type ExportScale } from "@pixelaition/export";
import {
  addFrame,
  applyCommand,
  bufferToFrame,
  composite,
  duplicateFrame,
  frameToBuffer,
  moveFrame,
  type Asset,
  type Command,
  type Frame,
  type FrameBuffer,
} from "@pixelaition/pixel";
import { z } from "zod";
import { encodeRowsRle } from "./format.js";
import {
  frameBuffer,
  paintStroke,
  refreshCritique,
  replaceFrameBuffer,
  requireRun,
  type RunBinding,
  type RunFrame,
} from "./runs.js";

const point = z.object({
  x: z.number().int(),
  y: z.number().int(),
  color: z.number().int().nonnegative(),
});

const readView = z.enum(["composite", "layer"]);

/** The frame named by the call, or the run's current frame. */
function resolveFrame(
  run: RunBinding,
  frameId?: string,
): { id: string; name: string; buffer: FrameBuffer; frame: RunFrame } {
  const buffer = frameBuffer(run, frameId);
  const id = frameId ?? run.currentFrameId;
  const frame = run.frames.get(id);
  if (!frame) throw new Error("Choose or create a frame first.");
  return { id, name: frame.name, buffer, frame };
}

function resolvePixels(
  buffer: FrameBuffer,
  view: "composite" | "layer",
  layerId?: string,
): { pixels: Uint8Array; layerId?: string } {
  if (view === "composite") {
    if (layerId !== undefined) {
      throw new Error("A layer id cannot be combined with the composite view.");
    }
    return { pixels: composite(buffer) };
  }
  const layer =
    layerId === undefined
      ? (buffer.layers.find((item) => item.visible) ?? buffer.layers[0])
      : buffer.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error("That layer is not on this frame.");
  return { pixels: layer.pixels, layerId: layer.id };
}

/** Apply a command to one frame's buffer and write the result back to the run. */
function editFrame(
  run: RunBinding,
  frameId: string | undefined,
  command: Command,
): { id: string; buffer: FrameBuffer } {
  const frame = resolveFrame(run, frameId);
  const result = applyCommand(frame.buffer, command);
  if (!result.ok) throw new Error(result.message);
  replaceFrameBuffer(run, frame.id, result.buffer);
  return { id: frame.id, buffer: result.buffer };
}

function colorCounts(
  pixels: Uint8Array,
  palette: string[],
): Array<{ index: number; hex: string; count: number }> {
  const counts = new Map<number, number>();
  for (const value of pixels) {
    if (value === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, count]) => {
      const hex = palette[index];
      if (hex === undefined) {
        throw new Error(
          `The frame uses palette index ${index}, which the palette does not define.`,
        );
      }
      return { index, hex, count };
    });
}

/** Image payloads over this size are refused rather than silently downscaled. */
const MAX_PREVIEW_BYTES = 1024 * 1024;

/** Contact sheet: every frame's composite, side by side, one synthetic buffer. */
function composeStrip(buffers: FrameBuffer[]): FrameBuffer {
  const [first, ...rest] = buffers;
  if (!first) throw new Error("There are no frames to preview.");
  for (const buffer of rest) {
    if (
      buffer.palette.length !== first.palette.length ||
      buffer.palette.some((hex, index) => hex !== first.palette[index])
    ) {
      throw new Error("Frames with different palettes cannot share one preview strip.");
    }
  }
  const width = buffers.reduce((sum, buffer) => sum + buffer.width, 0);
  const height = Math.max(...buffers.map((buffer) => buffer.height));
  const pixels = new Uint8Array(width * height);
  let offsetX = 0;
  for (const buffer of buffers) {
    const composited = composite(buffer);
    for (let y = 0; y < buffer.height; y += 1) {
      pixels.set(
        composited.subarray(y * buffer.width, (y + 1) * buffer.width),
        y * width + offsetX,
      );
    }
    offsetX += buffer.width;
  }
  return {
    width,
    height,
    palette: [...first.palette],
    layers: [{ id: "strip", name: "strip", visible: true, pixels }],
  };
}

/**
 * The run's frames as a pixel-package Asset. Pixels are encoded only for the
 * frames a pixel function reads them from: addFrame and moveFrame read only
 * ids, names, and indexes, so their other frames carry empty layer lists.
 */
function assetView(run: RunBinding, withPixels: string[] = []): Asset {
  const encoded = new Set(withPixels);
  return {
    id: run.assetId,
    name: "",
    width: run.width,
    height: run.height,
    palette: [...run.palette],
    frames: [...run.frames].map(([id, frame]) => ({
      id,
      name: frame.name,
      index: frame.index,
      layers: encoded.has(id)
        ? bufferToFrame(frame.buffer, { id, name: frame.name, index: frame.index }).layers
        : [],
    })),
  };
}

/** Decode a frame the pixel package produced back into the run's shape. */
function runFrameFrom(frame: Frame, run: RunBinding): RunFrame {
  return {
    name: frame.name,
    index: frame.index,
    buffer: frameToBuffer(frame, run.width, run.height, run.palette),
  };
}

/** A run frame as the persistence change union describes it. */
function changeFrame(id: string, frame: RunFrame) {
  return { id, name: frame.name, index: frame.index, buffer: frame.buffer };
}

export function createPixelTools(options: { vision?: boolean } = {}) {
  const readProject = createTool({
    name: "read_project",
    description:
      "Read the asset id, frames, current frame, palette legend, layers, and style guide before painting.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run);
      return {
        assetId: run.assetId,
        frames: [...run.frames].map(([id, item]) => ({ id, name: item.name })),
        currentFrameId: run.currentFrameId,
        width: run.width,
        height: run.height,
        palette: run.palette.map((hex, index) => ({ index, hex })),
        layers: frame.buffer.layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
        })),
        style: run.style,
      };
    },
  });

  const readFrame = createTool({
    name: "read_frame",
    description:
      "Read a frame as RLE rows (`colorxcount`). Defaults to the current frame and to the composite of visible layers; pass frameId or layerId to read another frame or one layer. Zero is transparent.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string().optional(),
      view: readView.optional(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run, input.frameId);
      const view = input.view ?? (input.layerId === undefined ? "composite" : "layer");
      const read = resolvePixels(frame.buffer, view, input.layerId);
      return {
        frameId: frame.id,
        view,
        layerId: read.layerId,
        width: frame.buffer.width,
        height: frame.buffer.height,
        rows: encodeRowsRle(read.pixels, frame.buffer.width, frame.buffer.height),
        colors: colorCounts(read.pixels, frame.buffer.palette),
      };
    },
  });

  const readRegion = createTool({
    name: "read_region",
    description:
      "Read a rectangle of a frame as RLE rows (`colorxcount`) and color counts. Coordinates are frame pixels; defaults to the current frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      view: readView.optional(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run, input.frameId);
      const buffer = frame.buffer;
      if (
        input.x < 0 ||
        input.y < 0 ||
        input.x + input.width > buffer.width ||
        input.y + input.height > buffer.height
      ) {
        throw new Error("That region is outside the frame.");
      }
      const view = input.view ?? "composite";
      const read = resolvePixels(buffer, view);
      const pixels = new Uint8Array(input.width * input.height);
      for (let row = 0; row < input.height; row += 1) {
        const start = (input.y + row) * buffer.width + input.x;
        pixels.set(read.pixels.subarray(start, start + input.width), row * input.width);
      }
      return {
        frameId: frame.id,
        view,
        layerId: read.layerId,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rows: encodeRowsRle(pixels, input.width, input.height),
        colors: colorCounts(pixels, buffer.palette),
      };
    },
  });

  const paint = createTool({
    name: "paint_stroke",
    description:
      "Paint up to 48 pixels on a layer of the current frame. Colors are palette indexes. The server stores only the pixels it accepts.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      points: z.array(point).min(1).max(48),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const stroke = paintStroke(
        run,
        input.frameId,
        input.layerId,
        input.label,
        input.points,
      );
      return { committed: stroke.points.length, label: stroke.label };
    },
  });

  const fillRect = createTool({
    name: "fill_rect",
    description:
      "Fill a rectangle on a layer of the current frame. Pass frameId to fill another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color: z.number().int().nonnegative(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...rect } = input;
      const edited = editFrame(run, frameId, { type: "rect", ...rect, filled: true });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const setPalette = createTool({
    name: "set_palette",
    description: "Replace the palette of the current frame. Index 0 must stay #00000000.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      palette: z.array(z.string()).min(2).max(33),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const edited = editFrame(run, input.frameId, {
        type: "setPalette",
        palette: input.palette,
      });
      // read_project's legend must never disagree with the frame it describes.
      run.palette = [...edited.buffer.palette];
      return { palette: edited.buffer.palette };
    },
  });

  const critique = createTool({
    name: "critique_frame",
    description:
      "Run the deterministic pixel critique on the current frame. Finish only when issues is empty.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      return { issues: refreshCritique(run, input.frameId) };
    },
  });

  const mirror = createTool({
    name: "mirror_frame",
    description:
      "Flip every layer of the current frame horizontally. Use this for a left/right variant before painting differences.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      editFrame(run, input.frameId, { type: "mirror" });
      return { committed: true };
    },
  });

  const useFrame = createTool({
    name: "use_frame",
    description: "Switch the current frame. Later tools without a frameId act on it.",
    inputSchema: z.object({ frameId: z.string() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run, input.frameId);
      run.currentFrameId = frame.id;
      return { currentFrameId: frame.id, name: frame.name };
    },
  });

  const addFrameTool = createTool({
    name: "add_frame",
    description:
      "Add a frame after the last one and make it current. Blank by default; pass copyOf to copy a frame's pixels. Use it to build animation frames.",
    inputSchema: z.object({
      name: z.string().max(40).optional(),
      copyOf: z.string().optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const source =
        input.copyOf === undefined ? undefined : resolveFrame(run, input.copyOf);
      const next = source
        ? duplicateFrame(assetView(run, [source.id]), source.id, input.name ?? "")
        : addFrame(assetView(run), input.name ?? "");
      if (!next) throw new Error(`Frame ${input.copyOf} is not part of this asset.`);
      const added = next.frames.at(-1);
      if (!added) throw new Error("The frame could not be added.");
      const frame = runFrameFrom(added, run);
      run.frames.set(added.id, frame);
      run.currentFrameId = added.id;
      run.approvedScope.add(added.id);
      await run.onFrameChange?.({ type: "add", frame: changeFrame(added.id, frame) });
      return {
        frameId: added.id,
        name: frame.name,
        index: frame.index,
        currentFrameId: added.id,
      };
    },
  });

  const renameFrameTool = createTool({
    name: "rename_frame",
    description: "Rename a frame. The name is trimmed and must not be blank.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      name: z.string().min(1).max(40),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run, input.frameId);
      const name = input.name.trim();
      if (!name) throw new Error("A frame name cannot be blank.");
      frame.frame.name = name;
      await run.onFrameChange?.({ type: "rename", frameId: frame.id, name });
      return { frameId: frame.id, name };
    },
  });

  const moveFrameTool = createTool({
    name: "move_frame",
    description:
      "Move a frame to a 0-based position. The list is renumbered densely from 0.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      toIndex: z.number().int().nonnegative(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const { id } = resolveFrame(run, input.frameId);
      const next = moveFrame(assetView(run), id, input.toIndex);
      if (!next) throw new Error(`Frame ${id} is not part of this asset.`);
      const reordered = new Map<string, RunFrame>();
      for (const item of next.frames) {
        const frame = run.frames.get(item.id);
        if (!frame) throw new Error(`Frame ${item.id} is not part of this asset.`);
        frame.index = item.index;
        reordered.set(item.id, frame);
      }
      run.frames = reordered;
      const order = next.frames.map((item) => ({ id: item.id, index: item.index }));
      await run.onFrameChange?.({ type: "move", order });
      return {
        frameId: id,
        index: order.find((item) => item.id === id)?.index ?? 0,
        order: order.map((item) => item.id),
      };
    },
  });

  const deleteFrameTool = createTool({
    name: "delete_frame",
    description:
      "Delete a frame. Deleting the last frame leaves a fresh blank frame named frame-1, so the asset always keeps one frame.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const { id } = resolveFrame(run, input.frameId);
      run.frames.delete(id);
      run.approvedScope.delete(id);
      let replacement: ReturnType<typeof changeFrame> | undefined;
      if (run.frames.size === 0) {
        // The app's rule: an asset keeps at least one frame, so the last
        // delete replaces it with a fresh blank frame instead of refusing.
        const next = addFrame(assetView(run), "");
        const added = next.frames.at(-1);
        if (!added) throw new Error("The replacement frame could not be created.");
        const frame = runFrameFrom(added, run);
        run.frames.set(added.id, frame);
        run.approvedScope.add(added.id);
        replacement = changeFrame(added.id, frame);
      }
      if (run.currentFrameId === id) {
        run.currentFrameId = replacement?.id ?? [...run.frames.keys()][0] ?? "";
      }
      await run.onFrameChange?.({
        type: "delete",
        frameId: id,
        ...(replacement ? { replacement } : {}),
      });
      return {
        deleted: id,
        currentFrameId: run.currentFrameId,
        replacementFrameId: replacement?.id,
      };
    },
  });

  // Only registered for models with verified image input; every other model
  // must read the frame as RLE data instead of pretending to see it.
  const preview = createTool({
    name: "preview_frame",
    description:
      "Render the current frame (or every frame as one strip) to a PNG you can see. Use it to verify your work before finishing.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      mode: z.enum(["frame", "strip"]).default("frame"),
      scale: z.number().int().min(1).max(10).default(4),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const frame = resolveFrame(run, input.frameId);
      const buffer =
        input.mode === "strip"
          ? composeStrip([...run.frames.values()].map((item) => item.buffer))
          : frame.buffer;
      const label = input.mode === "strip" ? `${run.frames.size} frames` : frame.name;
      // rasterize accepts any positive integer scale; the schema bounds it to 1..10.
      const png = frameToPng(buffer, input.scale as ExportScale);
      if (png.length > MAX_PREVIEW_BYTES) {
        throw new Error(
          `The preview is ${png.length} bytes, over the ${MAX_PREVIEW_BYTES}-byte image limit. Lower the scale.`,
        );
      }
      return ToolOutput.content([
        {
          type: "text",
          text: `${label} — ${buffer.width}×${buffer.height} pixels at ${input.scale}× (${png.length} bytes PNG).`,
        },
        {
          type: "file",
          data: { type: "data", data: Buffer.from(png).toString("base64") },
          mediaType: "image/png",
          filename: "preview.png",
        },
      ]);
    },
  });

  return [
    readProject,
    readFrame,
    readRegion,
    paint,
    fillRect,
    setPalette,
    critique,
    mirror,
    useFrame,
    addFrameTool,
    renameFrameTool,
    moveFrameTool,
    deleteFrameTool,
    ...(options.vision === true ? [preview] : []),
  ];
}

export function activeLayerId(buffer: FrameBuffer): string {
  return buffer.layers.find((layer) => layer.visible)?.id ?? buffer.layers[0]?.id ?? "";
}

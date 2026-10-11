import { createTool, type ToolApprovalContext } from "@anvia/core";
import { ToolOutput } from "@anvia/core/tool";
import { frameToPng, type ExportScale } from "@pixelaition/export";
import {
  addFrame,
  applyCommand,
  bufferToFrame,
  checkAnimation,
  composite,
  duplicateFrame,
  frameStats,
  frameToBuffer,
  linePoints,
  moveFrame,
  normalizeHex,
  type Asset,
  type Command,
  type Frame,
  type FrameBuffer,
} from "@pixelaition/pixel";
import { z } from "zod";
import { encodeRowsRle } from "./format.js";
import {
  frameBuffer,
  getRun,
  paintStroke,
  planFrameSchema,
  refreshCritique,
  replaceFrameBuffer,
  requireRun,
  stagedOverrideSchema,
  type RunBinding,
  type RunFrame,
  type Stroke,
} from "./runs.js";

const point = z.object({
  x: z.number().int(),
  y: z.number().int(),
  color: z.number().int().nonnegative(),
});

const strokePoint = z.object({
  x: z.number().int(),
  y: z.number().int(),
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
  run.touchedFrames.add(frame.id);
  return { id: frame.id, buffer: result.buffer };
}

/** Record a labeled stroke and hand the edited frame to the run's live feed. */
function recordStroke(
  run: RunBinding,
  stroke: Stroke,
  edited: { id: string; buffer: FrameBuffer },
): void {
  run.strokes.push(stroke);
  run.onStroke?.(stroke, edited.buffer, edited.id);
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
 * `omit` builds the candidate view a delete would leave behind.
 */
function assetView(
  run: RunBinding,
  options: { withPixels?: string[]; omit?: string } = {},
): Asset {
  const encoded = new Set(options.withPixels ?? []);
  return {
    id: run.assetId,
    name: "",
    width: run.width,
    height: run.height,
    palette: [...run.palette],
    frames: [...run.frames]
      .filter(([id]) => id !== options.omit)
      .map(([id, frame]) => ({
        id,
        name: frame.name,
        index: frame.index,
        layers: encoded.has(id)
          ? bufferToFrame(frame.buffer, { id, name: frame.name, index: frame.index })
              .layers
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

/**
 * Approval is per frame: a drawing call on a frame inside the run's approved
 * scope runs without a card, and every other frame asks first. The approval
 * context names the durable run, which is the binding's key; without a live
 * binding the answer fails closed, because an unknown scope must not write.
 */
function frameNeedsApproval(
  args: { frameId?: string },
  context: ToolApprovalContext<{ frameId?: string }>,
): boolean {
  const run = getRun(context.run.runId);
  if (!run) return true;
  return !run.approvedScope.has(args.frameId ?? run.currentFrameId);
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
    requiresApproval: frameNeedsApproval,
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
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...rect } = input;
      const edited = editFrame(run, frameId, { type: "rect", ...rect, filled: true });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const eraseStroke = createTool({
    name: "erase_stroke",
    description:
      "Erase up to 48 pixels on a layer of the current frame, clearing them to transparency. Pass frameId to erase another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      points: z.array(strokePoint).min(1).max(48),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, label, ...erase } = input;
      const edited = editFrame(run, frameId, { type: "erase", ...erase });
      recordStroke(
        run,
        {
          label,
          points: input.points.map((pixel) => ({ ...pixel, color: 0 })),
        },
        edited,
      );
      return { committed: input.points.length, label };
    },
  });

  const drawLine = createTool({
    name: "draw_line",
    description:
      "Draw a straight line between two pixels on a layer of the current frame. Pass frameId to draw on another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      from: strokePoint,
      to: strokePoint,
      color: z.number().int().nonnegative(),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, from, to, label } = input;
      const edited = editFrame(run, frameId, {
        type: "line",
        layerId: input.layerId,
        x0: from.x,
        y0: from.y,
        x1: to.x,
        y1: to.y,
        color: input.color,
      });
      const stroke = {
        label,
        points: linePoints(from.x, from.y, to.x, to.y).map((pixel) => ({
          ...pixel,
          color: input.color,
        })),
      };
      recordStroke(run, stroke, edited);
      return { committed: stroke.points.length, label };
    },
  });

  const floodFill = createTool({
    name: "flood_fill",
    description:
      "Flood-fill the connected run of one color around (x, y) on a layer of the current frame. Pass frameId to fill another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      color: z.number().int().nonnegative(),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...fill } = input;
      const edited = editFrame(run, frameId, { type: "fill", ...fill });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const fillRegion = createTool({
    name: "fill_region",
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
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...region } = input;
      const edited = editFrame(run, frameId, { type: "region", ...region, mode: "fill" });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const clearRegion = createTool({
    name: "clear_region",
    description:
      "Clear a rectangle on a layer of the current frame to transparency. Pass frameId to clear another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...region } = input;
      const edited = editFrame(run, frameId, {
        type: "region",
        ...region,
        color: 0,
        mode: "clear",
      });
      run.onStroke?.({ label: "clear", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const replaceColorTool = createTool({
    name: "replace_color",
    description:
      "Replace every pixel of one palette index with another on the current frame: one layer when layerId is given, every layer otherwise.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string().optional(),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...swap } = input;
      const edited = editFrame(run, frameId, { type: "replaceColor", ...swap });
      run.onStroke?.({ label: "replace", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const applyOutline = createTool({
    name: "apply_outline",
    description:
      "Ring the silhouette of the current frame with the style guide's outline color, or the palette color you pass. Paints on the active layer unless layerId names one.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string().optional(),
      color: z.number().int().nonnegative().optional(),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const buffer = frameBuffer(run, input.frameId);
      const layerId = input.layerId ?? activeLayerId(buffer);
      if (!layerId) throw new Error("This frame has no layer to outline.");
      let color = input.color;
      if (color === undefined) {
        const outline = normalizeHex(run.style.outline);
        color = outline ? buffer.palette.indexOf(outline) : -1;
        if (color <= 0) {
          throw new Error("The style guide outline color is not in the palette.");
        }
      }
      const edited = editFrame(run, input.frameId, { type: "outline", layerId, color });
      run.onStroke?.({ label: "outline", points: [] }, edited.buffer, edited.id);
      return { committed: true, layerId, color };
    },
  });

  const ditherRect = createTool({
    name: "dither_rect",
    description:
      "Dither a rectangle on a layer of the current frame with two palette colors: `checker` alternates both axes, `50` alternates columns. Use it for texture and shading.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      colorA: z.number().int().nonnegative(),
      colorB: z.number().int().nonnegative(),
      pattern: z.enum(["checker", "50"]),
    }),
    requiresApproval: frameNeedsApproval,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const { frameId, ...dither } = input;
      const edited = editFrame(run, frameId, { type: "dither", ...dither });
      run.onStroke?.({ label: "dither", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const resizeCanvas = createTool({
    name: "resize_canvas",
    description:
      "Resize the whole canvas (8–128). Every frame keeps the pixels that fit and drops the rest. This is destructive and always asks for approval.",
    inputSchema: z.object({
      width: z.number().int(),
      height: z.number().int(),
    }),
    requiresApproval: true,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      // Resize every frame, the way the editor's asset resize does, so no frame
      // is left at a different size than the asset. Nothing is committed until
      // every frame has accepted the new size.
      const resized = [...run.frames].map(([id, frame]) => {
        const result = applyCommand(frame.buffer, {
          type: "resize",
          width: input.width,
          height: input.height,
        });
        if (!result.ok) throw new Error(result.message);
        return { id, buffer: result.buffer };
      });
      run.width = input.width;
      run.height = input.height;
      for (const frame of resized) {
        replaceFrameBuffer(run, frame.id, frame.buffer);
        run.touchedFrames.add(frame.id);
        run.onStroke?.({ label: "resize", points: [] }, frame.buffer, frame.id);
      }
      return { width: input.width, height: input.height, frames: resized.length };
    },
  });

  const setPalette = createTool({
    name: "set_palette",
    description: "Replace the palette of the current frame. Index 0 must stay #00000000.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      palette: z.array(z.string()).min(2).max(33),
    }),
    requiresApproval: frameNeedsApproval,
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

  const plan = createTool({
    name: "plan",
    description:
      "Write the steps you will take before painting. The plan is shown in the run console; revise it by calling plan again.",
    inputSchema: z.object({
      steps: z.array(z.string().min(1).max(200)).min(1).max(20),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      run.plan = [...input.steps];
      return { steps: input.steps };
    },
  });

  const presentPlan = createTool({
    name: "present_plan",
    description:
      "Propose the frames for the job and wait for the user to approve or edit the list. The plan only runs once approved, and the approved frames become the run's editable scope; frames added later with add_frame join that scope. If the user edited the list, the executed plan reflects the edited version.",
    inputSchema: z.object({
      summary: z.string().min(1).max(300),
      frames: z.array(planFrameSchema).min(1).max(24),
    }),
    requiresApproval: true,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      // Consume-once: a staged override is the user's edit of this proposal,
      // never a standing policy for later calls. The worker hydrates it only
      // for the interaction it was staged for; a denied card clears it.
      const staged = run.stagedOverride;
      run.stagedOverride = undefined;
      let frames = input.frames;
      if (staged !== undefined) {
        const parsed = stagedOverrideSchema.safeParse(staged);
        if (!parsed.success) throw new Error("The staged plan override is malformed.");
        frames = parsed.data.frames;
      }
      const scope = new Set<string>([run.originFrameId]);
      for (const frame of frames) {
        if (frame.frameId !== undefined && run.frames.has(frame.frameId)) {
          scope.add(frame.frameId);
        }
      }
      run.approvedScope = scope;
      return {
        approved: true,
        plan: { summary: input.summary, frames },
        scope: [...scope],
      };
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

  const checkAnimationTool = createTool({
    name: "check_animation",
    description:
      "Measure animation continuity across the frames: changed pixels, diff box, centroid shift, and silhouette drift for every consecutive pair and for the loop back to the first frame. Flags mark identical distinct frames, centroid moves over two pixels, and a loop that jumps further than any internal pair. Fix flagged drift before finishing.",
    inputSchema: z.object({ frameIds: z.array(z.string()).optional() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const ids =
        input.frameIds ??
        [...run.frames]
          .sort(([, left], [, right]) => left.index - right.index)
          .map(([id]) => id);
      const frames = ids.map((id) => {
        const frame = run.frames.get(id);
        if (!frame) throw new Error(`Frame ${id} is not part of this asset.`);
        return { id, name: frame.name, buffer: frame.buffer };
      });
      const report = checkAnimation(frames);
      return {
        ...report,
        frames: frames.map(({ id, name, buffer }) => ({
          id,
          name,
          ...frameStats(buffer),
        })),
      };
    },
  });

  const mirror = createTool({
    name: "mirror_frame",
    description:
      "Flip every layer of the current frame horizontally. Use this for a left/right variant before painting differences.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    requiresApproval: frameNeedsApproval,
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
        ? duplicateFrame(
            assetView(run, { withPixels: [source.id] }),
            source.id,
            input.name ?? "",
          )
        : addFrame(assetView(run), input.name ?? "");
      if (!next) throw new Error(`Frame ${input.copyOf} is not part of this asset.`);
      const added = next.frames.at(-1);
      if (!added) throw new Error("The frame could not be added.");
      const frame = runFrameFrom(added, run);
      // Persist first: a refused save leaves the binding exactly as it was.
      await run.onFrameChange?.({ type: "add", frame: changeFrame(added.id, frame) });
      run.frames.set(added.id, frame);
      run.currentFrameId = added.id;
      run.approvedScope.add(added.id);
      run.touchedFrames.add(added.id);
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
      // Persist first: a refused save leaves the name exactly as it was.
      await run.onFrameChange?.({ type: "rename", frameId: frame.id, name });
      frame.frame.name = name;
      run.touchedFrames.add(frame.id);
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
      const candidates = next.frames.map((item) => {
        const frame = run.frames.get(item.id);
        if (!frame) throw new Error(`Frame ${item.id} is not part of this asset.`);
        return { id: item.id, index: item.index, frame };
      });
      const order = candidates.map((item) => ({ id: item.id, index: item.index }));
      // Persist first: a refused save leaves the order exactly as it was.
      await run.onFrameChange?.({ type: "move", order });
      const reordered = new Map<string, RunFrame>();
      for (const item of candidates) {
        item.frame.index = item.index;
        reordered.set(item.id, item.frame);
      }
      run.frames = reordered;
      run.touchedFrames.add(id);
      return {
        frameId: id,
        index: candidates.find((item) => item.id === id)?.index ?? 0,
        order: candidates.map((item) => item.id),
      };
    },
  });

  const deleteFrameTool = createTool({
    name: "delete_frame",
    description:
      "Delete a frame. Deleting the last frame leaves a fresh blank frame named frame-1, so the asset always keeps one frame.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    requiresApproval: true,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const { id } = resolveFrame(run, input.frameId);
      // The candidate state this delete would commit. The binding is only
      // touched once the worker confirms the change is saved.
      let replacement: { id: string; frame: RunFrame } | undefined;
      if (run.frames.size === 1) {
        // The app's rule: an asset keeps at least one frame, so the last
        // delete replaces it with a fresh blank frame instead of refusing.
        const next = addFrame(assetView(run, { omit: id }), "");
        const added = next.frames.at(-1);
        if (!added) throw new Error("The replacement frame could not be created.");
        replacement = { id: added.id, frame: runFrameFrom(added, run) };
      }
      const remaining = [...run.frames.keys()].filter((frameId) => frameId !== id);
      const nextCurrent =
        run.currentFrameId === id
          ? (replacement?.id ?? remaining[0] ?? "")
          : run.currentFrameId;
      await run.onFrameChange?.({
        type: "delete",
        frameId: id,
        ...(replacement
          ? { replacement: changeFrame(replacement.id, replacement.frame) }
          : {}),
      });
      // Persisted; now commit the same state to the binding.
      run.frames.delete(id);
      run.approvedScope.delete(id);
      if (replacement) {
        run.frames.set(replacement.id, replacement.frame);
        run.approvedScope.add(replacement.id);
      }
      run.currentFrameId = nextCurrent;
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
    eraseStroke,
    drawLine,
    floodFill,
    fillRegion,
    clearRegion,
    replaceColorTool,
    applyOutline,
    ditherRect,
    resizeCanvas,
    setPalette,
    plan,
    presentPlan,
    critique,
    checkAnimationTool,
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

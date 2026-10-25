import { createThinkTool, createTool, type ToolApprovalContext } from "@anvia/core";
import { ToolOutput } from "@anvia/core/tool";
import {
  applyTilemap,
  frameToPng,
  type ExportScale,
  type TilemapJson,
} from "@pixelaition/export";
import {
  addFrame,
  applyCommand,
  blendModes,
  colorToHex,
  hexToColor,
  readCell,
  bufferToFrame,
  checkAnimation,
  composite,
  duplicateFrame,
  frameStats,
  frameToBuffer,
  linePoints,
  moveFrame,
  emptyPixels,
  normalizeHex,
  seamReport,
  suggestedTileSize,
  type Asset,
  type Command,
  type Frame,
  type FrameBuffer,
  type FrameTag,
  type Slice,
  type TextLayerSpec,
} from "@pixelaition/pixel";
import { drawText } from "@pixelaition/artboard";
import { z } from "zod";
import { decodeRowsRle, encodeRowsRle } from "./format.js";
import {
  gateIsHarmless,
  gateToolCall,
  rememberGateOutcome,
  takeGateOutcome,
  type ToolGateOutcome,
} from "./gate.js";
import {
  bindRunAsset,
  frameBuffer,
  getRun,
  paintStroke,
  refreshCritique,
  replaceFrameBuffer,
  assertOwnedFrame,
  assertOwnedLayer,
  assertRoleAllowsTool,
  requireAsset,
  requireRun,
  resolveFrameId,
  resolveLayerRef,
  runIdFromOperation,
  searchImagesFor,
  stagedOverrideSchema,
  type BoundRunBinding,
  type FrameChange,
  type RunAsset,
  type RunBinding,
  type RunFrame,
  type Stroke,
} from "./runs.js";
import {
  copyLayers,
  layerOf,
  projectListing,
  readRegion as readFrameRegion,
  resolveReadFrame,
  toFrameBuffer,
} from "./frames.js";
import {
  fetchReferenceImage,
  parseHttpsPublicUrl,
  searchWeb,
  tavilyApiKey,
} from "./search.js";

const colorSchema = z.union([
  z.string().describe("A hex RGBA colour such as #d8a64eff."),
  z.number().int().nonnegative().describe("Legacy palette index or packed RGBA."),
]);

const point = z.object({
  x: z.number().int(),
  y: z.number().int(),
  color: colorSchema,
});

const strokePoint = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const readView = z.enum(["composite", "layer"]);

/** The frame named by the call, or the run's current frame. */
function resolveFrame(
  run: BoundRunBinding,
  frameId?: string,
): { id: string; name: string; buffer: FrameBuffer; frame: RunFrame } {
  const id = resolveFrameId(run, frameId);
  const frame = run.frames.get(id);
  if (!frame) throw new Error("Choose or create a frame first.");
  return { id, name: frame.name, buffer: frame.buffer, frame };
}

/**
 * Validate and persist a full tag list. Tags may name frames by id or name, but
 * they are always stored as ids; the range must exist and run forwards.
 */
async function saveTimelineTags(
  run: BoundRunBinding,
  input: Array<{
    id?: string;
    name: string;
    fromFrameId: string;
    toFrameId: string;
    direction: "forward" | "reverse" | "pingpong";
    loop: boolean;
    color?: string;
  }>,
): Promise<FrameTag[]> {
  if (!run.onFrameChange) throw new Error("This run cannot save animation tags.");
  const tags: FrameTag[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const item of input) {
    const name = item.name.trim();
    if (!name) throw new Error("A tag needs a name.");
    if (names.has(name.toLowerCase())) throw new Error(`Two tags are named ${name}.`);
    names.add(name.toLowerCase());
    const fromFrameId = resolveFrameId(run, item.fromFrameId);
    const toFrameId = resolveFrameId(run, item.toFrameId);
    const from = run.frames.get(fromFrameId);
    const to = run.frames.get(toFrameId);
    if (!from || !to) throw new Error(`Tag ${name} names a frame outside this run.`);
    if (from.index > to.index) throw new Error(`Tag ${name} starts after it ends.`);
    const id = item.id ?? crypto.randomUUID();
    if (ids.has(id)) throw new Error(`Two tags share the id ${id}.`);
    ids.add(id);
    tags.push({
      id,
      name,
      fromFrameId,
      toFrameId,
      direction: item.direction,
      loop: item.loop,
      ...(item.color ? { color: item.color } : {}),
    });
  }
  await run.onFrameChange({ type: "tags", tags });
  run.tags = tags;
  return tags;
}

/** Apply a command to one frame's buffer and write the result back to the run. */
/** Accept hex colours at the tool boundary and hand packed RGBA to commands. */
function normalizeCommandColors(command: Command): Command {
  const next = { ...command } as Record<string, unknown>;
  const convert = (value: unknown) =>
    typeof value === "string" ? (hexToColor(value) ?? 0) : value;
  if ("color" in next) next.color = convert(next.color);
  if ("from" in next) next.from = convert(next.from);
  if ("to" in next) next.to = convert(next.to);
  if (Array.isArray(next.points)) {
    next.points = next.points.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const pixel = { ...(item as Record<string, unknown>) };
      if ("color" in pixel) pixel.color = convert(pixel.color);
      return pixel;
    });
  }
  if (typeof next.text === "object" && next.text !== null) {
    const text = { ...(next.text as Record<string, unknown>) };
    if ("color" in text) text.color = convert(text.color);
    next.text = text;
  }
  return next as Command;
}

function editFrame(
  run: BoundRunBinding,
  frameId: string | undefined,
  input: Command | Record<string, unknown>,
): { id: string; buffer: FrameBuffer } {
  const command = input as Command;
  const frame = resolveFrame(run, frameId);
  // A worker may write only its own frames; reads stay open so it can look at
  // the neighbours for reference.
  assertOwnedFrame(run, frame.id);
  const named = (command as { layerId?: unknown }).layerId;
  if (typeof named === "string") assertOwnedLayer(run, named);
  // Every command that names a layer takes an id or a name; normalize here so
  // no layer tool has to know the difference.
  const ref = (command as { layerId?: unknown }).layerId;
  const normalized: Command =
    typeof ref === "string"
      ? ({ ...command, layerId: resolveLayerRef(frame.buffer, ref) } as Command)
      : command;
  const result = applyCommand(frame.buffer, normalizeCommandColors(normalized));
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
  pixels: Uint8Array | Uint32Array | number[],
  palette: string[],
): Array<{ index: number; hex: string; count: number }> {
  const counts = new Map<number, number>();
  const raw = pixels instanceof Uint8Array;
  const bytesPerCell = raw && pixels.length % 4 === 0;
  const count = bytesPerCell
    ? pixels.length / 4
    : (pixels as Uint32Array | number[]).length;
  for (let cell = 0; cell < count; cell += 1) {
    const color = bytesPerCell
      ? readCell(pixels as Uint8Array, cell)
      : ((pixels as Uint32Array | number[])[cell] ?? 0);
    if ((color & 0xff) === 0) continue;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([color, amount]) => {
      const hex = colorToHex(color);
      const index = palette.findIndex(
        (swatch) => swatch.toLowerCase() === hex.toLowerCase(),
      );
      return { index, hex, count: amount };
    })
    .sort((left, right) => right.count - left.count);
}

/**
 * Where each current colour lands in a new palette, matched by hex. A colour
 * the new palette drops keeps its next new slot when the palette grew (a new
 * colour appended beside the old ones), and fails otherwise — a palette change
 * never silently turns a painted pixel into a different colour.
 */
function colourMapping(
  current: readonly string[],
  next: readonly string[],
  painted: ReadonlySet<number>,
): Record<string, number> {
  const target = next.map((hex) => normalizeHex(hex) ?? hex);
  const taken = new Set<number>();
  const mapping: Record<string, number> = {};
  const pending: number[] = [];
  current.forEach((hex, index) => {
    const found = target.indexOf(normalizeHex(hex) ?? hex);
    if (found >= 0) {
      mapping[String(index)] = found;
      taken.add(found);
    } else if (painted.has(index)) {
      // Only a colour the canvas actually uses needs a home; an unused slot
      // the new palette drops is dropped with its (absent) pixels.
      pending.push(index);
    }
  });
  // Transparency is index 0 in every palette; nothing else may claim it.
  mapping["0"] = 0;
  for (const index of pending) {
    const free = target.findIndex((_, slot) => slot > 0 && !taken.has(slot));
    if (free === -1) {
      throw new Error(
        `This palette drops colour ${current[index]}, which is painted, and has no free slot to keep it in. Add it to the palette or clear the pixels first.`,
      );
    }
    mapping[String(index)] = free;
    taken.add(free);
  }
  return mapping;
}

/** Every colour index a frame's layers actually use. */
function paintedIndices(buffer: FrameBuffer): Set<number> {
  const painted = new Set<number>();
  for (const layer of buffer.layers) {
    for (const value of layer.pixels) if (value !== 0) painted.add(value);
  }
  return painted;
}

/** The asset and frame a read should open: `assetId` names a sibling asset of the project. */
const frameLocator = {
  assetId: z
    .string()
    .optional()
    .describe(
      "Frame's asset id; omit for this run's asset. Any asset of the same project.",
    ),
  frameId: z
    .string()
    .optional()
    .describe("Frame id or name; omit for the current frame."),
};

/** The locator plus the mode a second preview frame may carry. */
const comparedFrameLocator = {
  ...frameLocator,
  mode: z.enum(["frame", "strip"]).default("frame"),
};

/** The rectangle a copy reads or writes, in frame pixels. */
const regionShape = {
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
};

/** A source colour and the target palette index that replaces it. */
const paletteMapShape = z
  .array(
    z.object({
      hex: z.string().describe("Source colour, as the source palette legend prints it."),
      to: z.number().int().nonnegative().describe("Index in the target palette."),
    }),
  )
  .optional()
  .describe(
    "Only when the source and target palettes differ: one entry per source colour. Without it the palettes must be identical.",
  );

function regionOf(input: { x: number; y: number; width: number; height: number }) {
  return { x: input.x, y: input.y, width: input.width, height: input.height };
}

/** The stamp command for a paste: packed RGBA colours travel unchanged. */
function stampCommand(
  input: { layerId: string; x: number; y: number; width: number; height: number },
  _targetPalette: readonly string[],
  pixels: Uint32Array | number[],
): Command {
  return {
    type: "stamp",
    layerId: input.layerId,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    pixels: Array.from(pixels),
  };
}

/**
 * The layer rectangle repeated to the frame's edge in one direction: the
 * column/row the rectangle came from is tiled across the rest. `tile` walks
 * the whole frame from the rectangle's corner; the other directions continue
 * outwards from its outer edge only.
 */
function repeatPixels(
  buffer: FrameBuffer,
  rect: { x: number; y: number; width: number; height: number },
  layerId: string,
  direction: "right" | "left" | "down" | "up" | "tile",
): { x: number; y: number; width: number; height: number; pixels: number[] } {
  if (rect.x + rect.width > buffer.width || rect.y + rect.height > buffer.height) {
    throw new Error("The repeated region reaches outside the canvas.");
  }
  const ref = layerId.trim().toLowerCase();
  const layer =
    buffer.layers.find((candidate) => candidate.id === layerId) ??
    buffer.layers.find((candidate) => candidate.name.trim().toLowerCase() === ref);
  if (!layer) throw new Error(`No layer named or identified by "${layerId}".`);
  const origin = Array.from({ length: rect.height }, (_, row) =>
    Array.from(
      { length: rect.width },
      (_, column) => layer.pixels[(rect.y + row) * buffer.width + rect.x + column] ?? 0,
    ),
  );
  const target =
    direction === "tile"
      ? {
          x: rect.x,
          y: rect.y,
          width: buffer.width - rect.x,
          height: buffer.height - rect.y,
        }
      : direction === "right" || direction === "left"
        ? {
            // Mirror the source horizontally when repeating to the left so the
            // pattern reads continuously from the rectangle's edge.
            x: direction === "right" ? rect.x : 0,
            y: rect.y,
            width: direction === "right" ? buffer.width - rect.x : rect.x + rect.width,
            height: rect.height,
          }
        : {
            x: rect.x,
            y: direction === "down" ? rect.y : 0,
            width: rect.width,
            height: direction === "down" ? buffer.height - rect.y : rect.y + rect.height,
          };
  const pixels: number[] = [];
  for (let row = 0; row < target.height; row += 1) {
    for (let column = 0; column < target.width; column += 1) {
      const offsetX =
        direction === "left" ? target.width - 1 - column : target.x + column - rect.x;
      const offsetY =
        direction === "up" ? target.height - 1 - row : target.y + row - rect.y;
      const sourceX = ((offsetX % rect.width) + rect.width) % rect.width;
      const sourceY = ((offsetY % rect.height) + rect.height) % rect.height;
      pixels.push(origin[sourceY]?.[sourceX] ?? 0);
    }
  }
  return { ...target, pixels };
}

/** Image payloads over this size are refused rather than silently downscaled. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

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
  run: BoundRunBinding,
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
function runFrameFrom(frame: Frame, run: BoundRunBinding): RunFrame {
  return {
    name: frame.name,
    index: frame.index,
    buffer: frameToBuffer(
      frame,
      frame.width ?? run.width,
      frame.height ?? run.height,
      run.palette,
    ),
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
  args: Record<string, unknown>,
  context: ToolApprovalContext<Record<string, unknown>>,
): boolean {
  const run = getRun(context.run.runId);
  if (!run) return true;
  // An unbound run has no current frame; an unknown frame always asks first.
  const named = typeof args.frameId === "string" ? args.frameId : undefined;
  const frameId = named ?? run.currentFrameId;
  if (frameId === undefined) return true;
  return !run.approvedScope.has(frameId);
}

/**
 * Destructive tools pass Jev's request check before they run: a clearly
 * supported call proceeds, a clearly unsupported one is refused to the model,
 * and an unclear one pauses for the human through the normal approval flow.
 * The scope rule runs first — a frame the user has not approved always asks.
 */
function gatedApproval<Args extends Record<string, unknown>>(
  toolName: string,
  base: (args: Args, context: ToolApprovalContext<Args>) => boolean,
) {
  return async (
    args: Args,
    context: ToolApprovalContext<Args>,
  ): Promise<boolean | { reason: string }> => {
    if (base(args, context)) return true;
    const run = getRun(context.run.runId);
    if (!run) return true;
    // A call that cannot touch a painted pixel has nothing to check.
    if (gateIsHarmless(run, toolName, args)) return false;
    const outcome = await gateToolCall(run, toolName, args);
    rememberGateOutcome(context.run.runId, toolName, outcome);
    if (outcome.outcome === "review") return { reason: `Jev: ${outcome.reason}` };
    return false;
  };
}

/**
 * A call Jev blocked is refused to the model as a result instead of touching
 * the frame. Anything else (an approval, or no verdict at all) executes.
 */
function gateRefusal(
  operationId: string | undefined,
  toolName: string,
): ToolGateOutcome | undefined {
  const outcome = takeGateOutcome(runIdFromOperation(operationId), toolName);
  return outcome?.outcome === "block" ? outcome : undefined;
}

/** Normalize a palette the way set_palette does, or fail with the same cause. */
function normalizePalette(palette: string[]): string[] {
  const normalized: string[] = [];
  for (const color of palette) {
    const hex = normalizeHex(color);
    if (!hex) throw new Error("Index 0 must be #00000000 and every entry must be hex.");
    normalized.push(hex);
  }
  if (normalized[0] !== "#00000000") {
    throw new Error("Index 0 must be #00000000 and every entry must be hex.");
  }
  return normalized;
}

/** The model-facing shape of a just-bound asset: the ids it needs to paint. */
function bindResult(asset: RunAsset, run: BoundRunBinding) {
  return {
    assetId: asset.id,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    currentFrameId: run.currentFrameId,
    frames: [...asset.frames]
      .sort((left, right) => left.index - right.index)
      .map((frame) => ({ id: frame.id, name: frame.name, index: frame.index })),
  };
}

export function createPixelTools(
  options: { vision?: boolean; webSearch?: boolean } = {},
) {
  const readProject = createTool({
    name: "read_project",
    description:
      "Read the asset id, frames, current frame, palette legend, layers, and style guide before painting.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run);
      return {
        assetId: run.assetId,
        name: run.assetName,
        summary: run.summary ?? "",
        // The Map is insertion order, which the frame tools keep in index
        // order; the index still travels so the model never has to assume it.
        frames: [...run.frames].map(([id, item]) => ({
          id,
          name: item.name,
          summary: item.summary ?? "",
          index: item.index,
          width: item.buffer.width,
          height: item.buffer.height,
          layers: item.buffer.layers.map((layer) => ({
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            ...(layer.text ? { text: layer.text } : {}),
          })),
        })),
        currentFrame: { id: frame.id, name: frame.name },
        width: run.width,
        height: run.height,
        palette: run.palette.map((hex, index) => ({ index, hex })),
        paletteLocked: run.paletteLocked === true,
        styleLocked: run.styleLocked === true,
        colorMode: run.colorMode ?? "indexed",
        layers: frame.buffer.layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
        })),
        style: {
          defaultWidth: run.style.defaultWidth,
          defaultHeight: run.style.defaultHeight,
          outline: run.style.outline,
          shadowDirection: run.style.shadowDirection,
          notes: run.style.notes,
        },
      };
    },
  });

  const readFrame = createTool({
    name: "read_frame",
    description:
      "Read any frame of this project as RLE rows (`colorxcount`): a frame of this asset (including one another worker is painting) or a frame of any sibling asset in the project. Defaults to the current frame and to the composite of visible layers. frameId and layerId each accept an id or a name. Zero is transparent.",
    inputSchema: z.object({
      ...frameLocator,
      layerId: z.string().optional(),
      view: readView.optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const view = input.view ?? (input.layerId === undefined ? "composite" : "layer");
      const frame = await resolveReadFrame(run, input);
      const read = layerOf(frame, view === "composite" ? undefined : input.layerId);
      if (!read) {
        throw new Error(
          `That layer is not on ${frame.frameName}. Layers: ${frame.layers
            .map((layer) => layer.name)
            .join(", ")}.`,
        );
      }
      return {
        assetId: frame.assetId,
        assetName: frame.assetName,
        frameId: frame.frameId,
        name: frame.frameName,
        index: frame.index ?? null,
        summary: frame.summary ?? "",
        view,
        width: frame.width,
        height: frame.height,
        layers: frame.layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          ...(layer.text ? { text: layer.text } : {}),
        })),
        // Composite reads have no layer; an undefined key is not strict JSON.
        ...(read.layerId === "" ? {} : { layerId: read.layerId }),
        palette: frame.palette.map((hex, index) => ({ index, hex })),
        rows: encodeRowsRle(read.pixels, frame.width, frame.height),
        colors: colorCounts(read.pixels, frame.palette),
      };
    },
  });

  const readRegion = createTool({
    name: "read_region",
    description:
      "Read a rectangle of a frame as RLE rows (`colorxcount`) and color counts. Coordinates are frame pixels; defaults to the current frame. Pass layerId to read one layer instead of the composite.",
    inputSchema: z.object({
      ...frameLocator,
      ...regionShape,
      layerId: z
        .string()
        .optional()
        .describe("Read one layer (id or name); omit for the composite."),
      view: readView.optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = await resolveReadFrame(run, input);
      const view = input.view ?? (input.layerId === undefined ? "composite" : "layer");
      if (view === "layer" && input.layerId === undefined) {
        throw new Error("Reading a layer view needs a layerId.");
      }
      const read = layerOf(frame, view === "composite" ? undefined : input.layerId);
      if (!read) throw new Error(`That layer is not on ${frame.frameName}.`);
      const pixels = readFrameRegion(
        frame,
        regionOf(input),
        view === "composite" ? undefined : read.layerId,
      ).pixels;
      return {
        assetId: frame.assetId,
        assetName: frame.assetName,
        frameId: frame.frameId,
        name: frame.frameName,
        view,
        // Composite reads have no layer; an undefined key is not strict JSON.
        ...(read.layerId === "" ? {} : { layerId: read.layerId }),
        ...regionOf(input),
        rows: encodeRowsRle(pixels, input.width, input.height),
        colors: colorCounts(pixels, frame.palette),
      };
    },
  });

  // --- moving pixels between frames without redrawing them ------------------

  const copyRegion = createTool({
    name: "copy_region",
    description:
      "Copy a rectangle of any frame in this project (this asset or a sibling asset) and get its RGBA colours back as RLE rows (#rrggbbaa x count), ready to pass to paste_region. Use it when a part must match another frame exactly, instead of reading pixels and retyping them.",
    inputSchema: z.object({
      ...frameLocator,
      ...regionShape,
      layerId: z.string().optional().describe("Copy one layer instead of the composite."),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = await resolveReadFrame(run, input);
      const copied = readFrameRegion(frame, regionOf(input), input.layerId);
      return {
        source: {
          assetId: frame.assetId,
          assetName: frame.assetName,
          frameId: frame.frameId,
          frameName: frame.frameName,
          layer: copied.layerName,
        },
        ...regionOf(input),
        palette: frame.palette.map((hex, index) => ({ index, hex })),
        rows: encodeRowsRle(copied.pixels, input.width, input.height),
      };
    },
  });

  const pasteRegion = createTool({
    name: "paste_region",
    description:
      "Stamp RLE rows (from copy_region or read_region) into a layer of a frame you own, at x,y. This is the paste of a copy: one commit, no per-pixel calls. When the source and target palettes differ, pass map with one entry per source colour.",
    inputSchema: z.object({
      frameId: z
        .string()
        .optional()
        .describe("Target frame you own; omit for your current one."),
      layerId: z.string(),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      rows: z
        .array(z.string())
        .min(1)
        .describe("One RLE row per line, as copy_region returned them."),
      sourcePalette: z
        .array(z.string())
        .optional()
        .describe("The palette the rows were read with; omit when it is this asset's."),
      map: paletteMapShape,
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      const pixels = decodeRowsRle(input.rows, input.width, input.height);
      const edited = editFrame(
        run,
        frame.id,
        stampCommand(input, frame.buffer.palette, pixels),
      );
      recordStroke(run, { label: "paste_region", points: [] }, edited);
      return {
        committed: true,
        frameId: edited.id,
        name: frame.name,
        ...regionOf(input),
      };
    },
  });

  const mirrorRegionTool = createTool({
    name: "mirror_region",
    description:
      "Flip a rectangle of a layer you own in place (horizontal or vertical), leaving the rest of the layer alone. Use it for a facing variant or to undo a mirrored paste.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      ...regionShape,
      axis: z.enum(["horizontal", "vertical"]),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      const edited = editFrame(run, frame.id, {
        type: "mirrorRegion",
        layerId: input.layerId,
        ...regionOf(input),
        axis: input.axis,
      });
      recordStroke(run, { label: "mirror_region", points: [] }, edited);
      return { committed: true, frameId: edited.id, axis: input.axis };
    },
  });

  const repeatRegionTool = createTool({
    name: "repeat_region",
    description:
      "Repeat a rectangle of a layer you own across the frame: row by row, column by column, or tiled. Use it for rails, teeth, scales, brick courses and other repeating parts.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      ...regionShape,
      direction: z.enum(["right", "left", "down", "up", "tile"]),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      const repeated = repeatPixels(
        frame.buffer,
        regionOf(input),
        input.layerId,
        input.direction,
      );
      const edited = editFrame(run, frame.id, {
        type: "stamp",
        layerId: input.layerId,
        ...repeated,
      });
      recordStroke(run, { label: "repeat_region", points: [] }, edited);
      return {
        committed: true,
        frameId: edited.id,
        direction: input.direction,
        x: repeated.x,
        y: repeated.y,
        width: repeated.width,
        height: repeated.height,
      };
    },
  });

  const copyLayersTool = createTool({
    name: "copy_layers",
    description:
      "Copy whole layers from a frame of any asset in this project into a frame you own: the 'make this frame's body identical to that one' move. A target layer with the same name receives the pixels; otherwise the layer is added.",
    inputSchema: z.object({
      ...frameLocator,
      frames: z
        .array(
          z.object({
            name: z.string().describe("Layer id or name on the source frame."),
            map: paletteMapShape,
          }),
        )
        .min(1)
        .describe("Layers to copy, in paint order."),
      toFrameId: z
        .string()
        .optional()
        .describe("Target frame you own; omit for your current one."),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const source = await resolveReadFrame(run, input);
      const target = resolveFrame(run, input.toFrameId);
      for (const layer of input.frames) assertOwnedLayer(run, layer.name);
      const buffer = copyLayers(target.buffer, source, input.frames);
      replaceFrameBuffer(run, target.id, buffer);
      run.touchedFrames.add(target.id);
      recordStroke(run, { label: "copy_layer", points: [] }, { id: target.id, buffer });
      return {
        committed: true,
        frameId: target.id,
        from: { assetName: source.assetName, frameName: source.frameName },
        layers: buffer.layers.map((layer) => layer.name),
      };
    },
  });

  const paint = createTool({
    name: "paint_stroke",
    description:
      "Paint up to 48 pixels on a layer of the current frame. layerId takes the layer id or its name. Colours are hex RGBA strings (or legacy palette indexes). The server stores only the pixels it accepts.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      points: z.array(point).min(1).max(48),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const stroke = paintStroke(
        run,
        input.frameId,
        input.layerId,
        input.label,
        input.points.map((pixel) => ({
          ...pixel,
          color:
            typeof pixel.color === "string"
              ? (hexToColor(pixel.color) ?? 0)
              : pixel.color,
        })),
      );
      return { committed: stroke.points.length, label: stroke.label };
    },
  });

  const fillRect = createTool({
    name: "fill_rect",
    description:
      "Fill a rectangle on a layer of the current frame. layerId takes the layer id or its name. Pass frameId to fill another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color: colorSchema,
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...rect } = input;
      const edited = editFrame(run, frameId, { type: "rect", ...rect, filled: true });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const eraseStroke = createTool({
    name: "erase_stroke",
    description:
      "Erase up to 48 pixels on a layer of the current frame, clearing them to transparency. layerId takes the layer id or its name. Pass frameId to erase another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      points: z.array(strokePoint).min(1).max(48),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
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
      "Draw a straight line between two pixels on a layer of the current frame. layerId takes the layer id or its name. Pass frameId to draw on another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      label: z.string().min(1).max(40),
      from: strokePoint,
      to: strokePoint,
      color: colorSchema,
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, from, to, label } = input;
      const color =
        typeof input.color === "string" ? (hexToColor(input.color) ?? 0) : input.color;
      const edited = editFrame(run, frameId, {
        type: "line",
        layerId: input.layerId,
        x0: from.x,
        y0: from.y,
        x1: to.x,
        y1: to.y,
        color,
      });
      const stroke = {
        label,
        points: linePoints(from.x, from.y, to.x, to.y).map((pixel) => ({
          ...pixel,
          color,
        })),
      };
      recordStroke(run, stroke, edited);
      return { committed: stroke.points.length, label };
    },
  });

  const drawEllipse = createTool({
    name: "draw_ellipse",
    description:
      "Draw an ellipse inside a bounding box on a layer of the current frame. Set filled for a solid ellipse, omit it for an outline.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color: colorSchema,
      filled: z.boolean().optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...ellipse } = input;
      const edited = editFrame(run, frameId, {
        type: "ellipse",
        ...ellipse,
        filled: input.filled ?? false,
      });
      run.onStroke?.({ label: "ellipse", points: [] }, edited.buffer, edited.id);
      return { committed: true, filled: input.filled ?? false };
    },
  });

  const moveRegionTool = createTool({
    name: "move_region",
    description:
      "Move a rectangle of pixels on a layer. By default the source is cleared, so this is a real move rather than a copy; pass eraseSource false to leave the source.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      dx: z.number().int(),
      dy: z.number().int(),
      eraseSource: z.boolean().optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...move } = input;
      const edited = editFrame(run, frameId, {
        type: "moveRegion",
        ...move,
        eraseSource: input.eraseSource ?? true,
      });
      run.onStroke?.({ label: "move", points: [] }, edited.buffer, edited.id);
      return { committed: true, dx: input.dx, dy: input.dy };
    },
  });

  const rotateRegionTool = createTool({
    name: "rotate_region",
    description:
      "Rotate a square selection by one quarter turn clockwise or anticlockwise. A non-square region is refused rather than resampled.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      turns: z.union([z.literal(1), z.literal(-1)]),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...rotate } = input;
      const edited = editFrame(run, frameId, { type: "rotateRegion", ...rotate });
      run.onStroke?.({ label: "rotate", points: [] }, edited.buffer, edited.id);
      return { committed: true, turns: input.turns };
    },
  });

  const floodFill = createTool({
    name: "flood_fill",
    description:
      "Flood-fill the connected run of one color around (x, y) on a layer of the current frame. layerId takes the layer id or its name. Pass frameId to fill another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      color: colorSchema,
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...fill } = input;
      const edited = editFrame(run, frameId, { type: "fill", ...fill });
      run.onStroke?.({ label: "fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const fillRegion = createTool({
    name: "fill_region",
    description:
      "Fill a rectangle on a layer of the current frame. layerId takes the layer id or its name. Pass frameId to fill another frame.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color: colorSchema,
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
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
    // Clearing a rectangle is part of drawing. It does not pause for Jev or
    // a clarification card; the frame tools still refuse a bad rectangle.
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
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
      "Replace every pixel of one RGBA colour with another on the current frame: one layer when layerId is given (id or name), every layer otherwise. Both colours are hex or packed RGBA.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string().optional(),
      from: colorSchema,
      to: colorSchema,
    }),
    requiresApproval: gatedApproval("replace_color", frameNeedsApproval),
    execute: (input, context) => {
      const refused = gateRefusal(context.operationId, "replace_color");
      if (refused) return { refused: refused.reason };
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...swap } = input;
      const edited = editFrame(run, frameId, { type: "replaceColor", ...swap });
      run.onStroke?.({ label: "replace", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const applyOutline = createTool({
    name: "apply_outline",
    description:
      "Ring the silhouette of the current frame with the style guide's outline color, or the palette color you pass. Paints on the active layer unless layerId names one (id or name).",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string().optional(),
      color: colorSchema.optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const buffer = frameBuffer(run, input.frameId);
      const layerId = input.layerId ?? activeLayerId(buffer);
      if (!layerId) throw new Error("This frame has no layer to outline.");
      let color =
        input.color === undefined
          ? undefined
          : typeof input.color === "string"
            ? (hexToColor(input.color) ?? -1)
            : input.color;
      if (color === undefined) {
        const outline = normalizeHex(run.style.outline);
        color = outline ? (hexToColor(outline) ?? -1) : -1;
        if (color <= 0) {
          throw new Error("The style guide outline color is invalid.");
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
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...dither } = input;
      const edited = editFrame(run, frameId, { type: "dither", ...dither });
      run.onStroke?.({ label: "dither", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const resizeCanvas = createTool({
    name: "resize_canvas",
    description:
      "Resize the whole canvas to any positive size. Every frame keeps the pixels that fit and drops the rest. This structural call does not pause for human approval.",
    inputSchema: z.object({
      width: z.number().int(),
      height: z.number().int(),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const refused = gateRefusal(context.operationId, "resize_canvas");
      if (refused) return { refused: refused.reason };
      const run = requireRun(context.operationId);
      requireAsset(run);
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
      // The asset row carries the canvas size a reload decodes the frames
      // against; persist it before the frames commit, so a failed save leaves
      // the run untouched instead of diverging from the database. Without it
      // the frames were 48×48 while the asset row still said 32×32, and the
      // editor failed to load them.
      await run.onFrameChange?.({
        type: "resize",
        width: input.width,
        height: input.height,
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

  const setPaletteDescription =
    "Replace the asset's palette; every frame uses it. Index 0 must stay #00000000. Add the colours the request needs before painting with them.";
  const resizeFrame = createTool({
    name: "resize_frame",
    description:
      "Resize one frame's pixel canvas without changing the asset's other frames. Use this for a profile or cover whose output size differs from the asset canvas; pass width and height in pixels.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      const result = applyCommand(frame.buffer, {
        type: "resize",
        width: input.width,
        height: input.height,
      });
      if (!result.ok) throw new Error(result.message);
      replaceFrameBuffer(run, frame.id, result.buffer);
      run.touchedFrames.add(frame.id);
      run.onStroke?.({ label: "resize", points: [] }, result.buffer, frame.id);
      return {
        frameId: frame.id,
        name: frame.name,
        width: result.buffer.width,
        height: result.buffer.height,
      };
    },
  });

  /** Apply one explicit old-index -> new-index map to every frame. */
  function applyPaletteMapping(
    run: BoundRunBinding,
    nextPalette: string[],
    mapping: number[],
  ): {
    palette: string[];
    repainted: string[];
  } {
    const current = resolveFrame(run);
    const adopted = [...run.frames.entries()].map(([id, frame]) => {
      const result = applyCommand(frame.buffer, {
        type: "reindexPalette",
        palette: nextPalette,
        mapping: Object.fromEntries(mapping.map((to, from) => [from, to])),
      });
      if (!result.ok) throw new Error(result.message);
      return { id, buffer: result.buffer };
    });
    for (const item of adopted) {
      replaceFrameBuffer(run, item.id, item.buffer);
      run.touchedFrames.add(item.id);
    }
    run.palette = [...nextPalette];
    const edited = adopted.find((item) => item.id === current.id);
    if (edited)
      run.onStroke?.({ label: "palette", points: [] }, edited.buffer, edited.id);
    for (const item of adopted) {
      if (item.id === current.id) continue;
      void run.onFrameChange?.({
        type: "frame-pixels",
        frameId: item.id,
        buffer: item.buffer,
      });
    }
    void run.onFrameChange?.({ type: "palette", palette: run.palette });
    return { palette: run.palette, repainted: adopted.map((item) => item.id) };
  }

  const setPalette = createTool({
    name: "set_palette",
    description: `${setPaletteDescription} The pixels follow their colours: a colour that moves to another index is rewritten, and a new colour is simply appended (or given an index and used by the next stroke), so one frame changing the palette never repaints another.`,
    inputSchema: z.object({
      frameId: z.string().optional(),
      palette: z.array(z.string()).min(2).max(256),
    }),
    // Choosing colours is part of drawing. It does not pause for Jev or a
    // clarification card; index 0 and the hex rules still refuse a bad palette.
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (run.paletteLocked) {
        throw new Error(
          "The palette is locked for this asset; ask the user to unlock it.",
        );
      }
      const current = resolveFrame(run, input.frameId);
      // The palette belongs to the asset, exactly like the editor's palette
      // panel: every frame must be able to adopt it before any of them
      // changes, and the change is persisted with the run, so painted pixels
      // never outlive the palette they were painted against.
      const adopted = [...run.frames.entries()].map(([id, frame]) => {
        const result = applyCommand(frame.buffer, {
          type: "reindexPalette",
          palette: input.palette,
          mapping: colourMapping(
            frame.buffer.palette,
            input.palette,
            paintedIndices(frame.buffer),
          ),
        });
        if (!result.ok) throw new Error(result.message);
        return { id, buffer: result.buffer };
      });
      for (const item of adopted) {
        replaceFrameBuffer(run, item.id, item.buffer);
        run.touchedFrames.add(item.id);
      }
      const edited = adopted.find((item) => item.id === current.id);
      if (!edited) throw new Error("The palette change did not reach the frame.");
      // read_project's legend must never disagree with the frames it describes.
      run.palette = [...edited.buffer.palette];
      // The canvas feed carries the frames this palette move repainted, every
      // layer, so a change made on one frame shows on all of them. The worker
      // persists the asset palette once the repaint is done.
      run.onStroke?.({ label: "palette", points: [] }, edited.buffer, current.id);
      const frameChanges: FrameChange[] = [
        ...adopted
          .filter((item) => item.id !== current.id)
          .map((item) => ({
            type: "frame-pixels" as const,
            frameId: item.id,
            buffer: item.buffer,
          })),
        { type: "palette", palette: run.palette },
      ];
      for (const change of frameChanges) void run.onFrameChange?.(change);
      return {
        palette: run.palette,
        repainted: adopted.map((item) => item.id),
      };
    },
  });

  const editPaletteColor = createTool({
    name: "edit_palette_color",
    description:
      "Change one palette swatch without moving any pixel. Every frame adopts the swatch; index 0 cannot be edited.",
    inputSchema: z.object({
      index: z.number().int().positive(),
      color: z.string(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (run.paletteLocked) {
        throw new Error(
          "The palette is locked for this asset; ask the user to unlock it.",
        );
      }
      if (input.index >= run.palette.length) {
        throw new Error("That colour index is not in the palette.");
      }
      const color = normalizeHex(input.color);
      if (!color || color === "#00000000") {
        throw new Error("A visible palette entry needs a hex colour.");
      }
      const nextPalette = [...run.palette];
      nextPalette[input.index] = color;
      for (const [id, frame] of run.frames) {
        replaceFrameBuffer(run, id, { ...frame.buffer, palette: nextPalette });
      }
      run.palette = nextPalette;
      const current = resolveFrame(run);
      run.onStroke?.({ label: "palette", points: [] }, current.buffer, current.id);
      void run.onFrameChange?.({ type: "palette", palette: nextPalette });
      return { palette: nextPalette, index: input.index, color };
    },
  });

  const removePaletteColor = createTool({
    name: "remove_palette_color",
    description:
      "Remove one visible palette colour and rewrite every pixel that used it to another index (0 = transparent). This is asset-wide and pauses for approval when Jev cannot support it.",
    inputSchema: z.object({
      index: z.number().int().positive(),
      remapTo: z.number().int().nonnegative().default(0),
    }),
    requiresApproval: gatedApproval("remove_palette_color", frameNeedsApproval),
    execute: (input, context) => {
      const refused = gateRefusal(context.operationId, "remove_palette_color");
      if (refused) return { refused: refused.reason };
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (run.paletteLocked) {
        throw new Error(
          "The palette is locked for this asset; ask the user to unlock it.",
        );
      }
      if (input.index >= run.palette.length || input.remapTo >= run.palette.length) {
        throw new Error("That palette index is not in the palette.");
      }
      if (input.index === input.remapTo) {
        throw new Error("Choose a different colour to keep, or clear to transparent.");
      }
      const nextPalette = run.palette.filter((_, index) => index !== input.index);
      const mapping = run.palette.map((_, source) => {
        if (source === 0) return 0;
        if (source === input.index) {
          return input.remapTo > input.index ? input.remapTo - 1 : input.remapTo;
        }
        return source > input.index ? source - 1 : source;
      });
      return applyPaletteMapping(run, nextPalette, mapping);
    },
  });

  const reorderPalette = createTool({
    name: "reorder_palette",
    description:
      "Reorder the palette swatches with an explicit old-index order. Pixel colours do not move; social scenes follow the swatch colour. Index 0 must stay first.",
    inputSchema: z.object({
      order: z.array(z.number().int().nonnegative()).min(2),
    }),
    requiresApproval: gatedApproval("reorder_palette", frameNeedsApproval),
    execute: (input, context) => {
      const refused = gateRefusal(context.operationId, "reorder_palette");
      if (refused) return { refused: refused.reason };
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (run.paletteLocked) {
        throw new Error(
          "The palette is locked for this asset; ask the user to unlock it.",
        );
      }
      const order = input.order;
      if (
        order.length !== run.palette.length ||
        new Set(order).size !== order.length ||
        order.some((value) => value < 0 || value >= run.palette.length) ||
        order[0] !== 0
      ) {
        throw new Error("The order must list every palette index once, starting at 0.");
      }
      const nextPalette = order.map((source) => run.palette[source] ?? "#00000000");
      const mapping = new Array<number>(run.palette.length).fill(0);
      order.forEach((source, target) => {
        mapping[source] = target;
      });
      return applyPaletteMapping(run, nextPalette, mapping);
    },
  });

  const textSizes = [4, 6, 8, 10, 12, 16, 24, 32, 48, 64, 96, 120];
  function textSizeFor(height: number, requested?: number): number {
    if (requested) return Math.max(1, Math.round(requested));
    const preferred = height <= 64 ? Math.max(4, height * 0.25) : height * 0.06;
    return textSizes.reduce((best, value) =>
      Math.abs(value - preferred) < Math.abs(best - preferred) ? value : best,
    );
  }

  function textSpec(
    buffer: FrameBuffer,
    input: {
      text: string;
      x?: number;
      y?: number;
      size?: number;
      color?: number;
      width?: number;
      align?: "left" | "center" | "right";
      face?: "silkscreen" | "pixelify" | "mono";
      weight?: 400 | 700;
      lineHeight?: number;
      maxLines?: number;
      letterSpacing?: number;
      scale?: number;
      height?: number;
      rotation?: number;
    },
  ): TextLayerSpec {
    const color = input.color ?? 1;
    if (!Number.isInteger(color) || color < 1 || color >= buffer.palette.length) {
      throw new Error("That text colour is not in the palette.");
    }
    return {
      text: input.text,
      face: input.face ?? "silkscreen",
      weight: input.weight ?? 700,
      size: textSizeFor(buffer.height, input.size),
      color,
      x: Math.max(
        0,
        Math.min(input.x ?? Math.round(buffer.width * 0.06), buffer.width - 1),
      ),
      y: Math.max(
        0,
        Math.min(input.y ?? Math.round(buffer.height * 0.12), buffer.height - 1),
      ),
      width: Math.max(
        1,
        Math.min(input.width ?? Math.round(buffer.width * 0.8), buffer.width),
      ),
      align: input.align ?? "left",
      ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
      ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : { maxLines: 3 }),
      ...(input.letterSpacing !== undefined
        ? { letterSpacing: input.letterSpacing }
        : {}),
      ...(input.scale !== undefined ? { scale: input.scale } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
    };
  }

  function textPixels(buffer: FrameBuffer, spec: TextLayerSpec): Uint8Array {
    const pixels = emptyPixels(buffer.width, buffer.height);
    drawText(
      pixels,
      buffer.width,
      buffer.height,
      { ...spec, id: "text", kind: "text" },
      buffer.palette.length,
    );
    return pixels;
  }

  const addTextTool = createTool({
    name: "add_text",
    description:
      "Add editable pixel text to the current frame. Text survives as a text layer: its content, colour, size, width, alignment and position can be edited with edit_text later. Coordinates and size are document pixels.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      text: z.string().min(1).max(500),
      x: z.number().int().nonnegative().optional(),
      y: z.number().int().nonnegative().optional(),
      size: z.number().int().positive().optional(),
      color: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      rotation: z.number().min(-360).max(360).optional(),
      layerName: z.string().min(1).max(40).optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      const spec = textSpec(frame.buffer, input);
      const layerId = crypto.randomUUID().slice(0, 8);
      const baseName = input.layerName ?? "Text";
      const used = new Set(frame.buffer.layers.map((layer) => layer.name));
      let layerName = baseName;
      for (let suffix = 2; used.has(layerName); suffix += 1) {
        layerName = `${baseName} ${suffix}`;
      }
      const added = editFrame(run, frame.id, {
        type: "addLayer",
        id: layerId,
        name: layerName,
      });
      const edited = editFrame(run, frame.id, {
        type: "replaceLayer",
        layerId,
        pixels: textPixels(added.buffer, spec),
        text: spec,
      });
      run.onStroke?.({ label: "text", points: [] }, edited.buffer, edited.id);
      return {
        layerId,
        text: spec.text,
        box: { x: spec.x, y: spec.y, width: spec.width },
      };
    },
  });

  const editTextTool = createTool({
    name: "edit_text",
    description:
      "Edit an editable text layer on the current frame: content, size, colour, width, alignment or position. layerId takes the layer id or its name. Moving x/y is a drag in the model; the pixels are rebuilt at the same canvas size.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      text: z.string().max(500).optional(),
      x: z.number().int().nonnegative().optional(),
      y: z.number().int().nonnegative().optional(),
      size: z.number().int().positive().optional(),
      color: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      rotation: z.number().min(-360).max(360).optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      const layerId = resolveLayerRef(frame.buffer, input.layerId);
      const layer = frame.buffer.layers.find((item) => item.id === layerId);
      if (!layer?.text) throw new Error("That layer is not editable text.");
      const spec = textSpec(frame.buffer, {
        ...layer.text,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.x !== undefined ? { x: input.x } : {}),
        ...(input.y !== undefined ? { y: input.y } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.align !== undefined ? { align: input.align } : {}),
        ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
      });
      const edited = editFrame(run, frame.id, {
        type: "replaceLayer",
        layerId,
        pixels: textPixels(frame.buffer, spec),
        text: spec,
      });
      run.onStroke?.({ label: "text", points: [] }, edited.buffer, edited.id);
      return {
        layerId,
        text: spec.text,
        box: { x: spec.x, y: spec.y, width: spec.width },
      };
    },
  });

  const addLayerTool = createTool({
    name: "add_layer",
    description:
      "Add a layer to the current frame (layers have no limit). It starts blank and visible; paint on it by its layer id or the name you gave.",
    inputSchema: z.object({
      name: z.string().min(1).max(40).optional(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const buffer = frameBuffer(run);
      const name = input.name ?? `layer-${buffer.layers.length + 1}`;
      const edited = editFrame(run, undefined, {
        type: "addLayer",
        id: crypto.randomUUID(),
        name,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      const added = edited.buffer.layers.at(-1);
      if (!added) throw new Error("The layer could not be added.");
      return { layerId: added.id, name: added.name, layers: edited.buffer.layers.length };
    },
  });

  const renameLayerTool = createTool({
    name: "rename_layer",
    description:
      "Rename a layer on the current frame; layerId takes the layer id or its current name. The new name is trimmed and must not be blank.",
    inputSchema: z.object({
      layerId: z.string(),
      name: z.string().min(1).max(40),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "renameLayer",
        layerId: input.layerId,
        name: input.name,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      const layer = edited.buffer.layers.find((item) => item.id === input.layerId);
      return { layerId: input.layerId, name: layer?.name ?? input.name.trim() };
    },
  });

  const setLayerVisibleTool = createTool({
    name: "set_layer_visible",
    description:
      "Show or hide a layer on the current frame; layerId takes the layer id or its name. A hidden layer stays in the frame but leaves the composite.",
    inputSchema: z.object({
      layerId: z.string(),
      visible: z.boolean(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerVisible",
        layerId: input.layerId,
        visible: input.visible,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { layerId: input.layerId, visible: input.visible };
    },
  });

  const removeLayerTool = createTool({
    name: "remove_layer",
    description:
      "Remove a layer from the current frame; layerId takes the layer id or its name. A frame keeps at least one layer, so the last layer cannot be removed.",
    inputSchema: z.object({ layerId: z.string() }),
    // Layer cleanup during drawing does not ask. The frame keeps its last
    // layer, and the call is not a Jev review the way a clear or a delete is.
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "removeLayer",
        layerId: input.layerId,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { removed: input.layerId, layers: edited.buffer.layers.length };
    },
  });

  const checkTiling = createTool({
    name: "check_tiling",
    description:
      "Measure whether the frame's composited pixels meet when tiled. Returns mismatch counts for the left/right and top/bottom seams.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      return {
        frameId: frame.id,
        name: frame.name,
        ...seamReport(frame.buffer),
        suggestedTile: suggestedTileSize(frame.buffer),
      };
    },
  });

  const readSlices = createTool({
    name: "read_slices",
    description:
      "Read the asset's export slices, including nine-slice borders and pivots.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      return { slices: run.slices ?? [] };
    },
  });

  const setSlices = createTool({
    name: "set_slices",
    description:
      "Replace the asset's export slices. Each slice is a named rectangle inside the asset canvas; optional nine-slice borders and a pivot ride the sheet atlas.",
    inputSchema: z.object({
      slices: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().min(1).max(40),
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            nineSlice: z
              .object({
                left: z.number().int().nonnegative(),
                right: z.number().int().nonnegative(),
                top: z.number().int().nonnegative(),
                bottom: z.number().int().nonnegative(),
              })
              .optional(),
            pivot: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
          }),
        )
        .max(256),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (!run.onFrameChange) throw new Error("This run cannot save slices.");
      const width = run.width ?? 0;
      const height = run.height ?? 0;
      const names = new Set<string>();
      const slices: Slice[] = input.slices.map((slice) => {
        const name = slice.name.trim();
        if (!name) throw new Error("A slice needs a name.");
        if (names.has(name.toLowerCase()))
          throw new Error(`Two slices are named ${name}.`);
        names.add(name.toLowerCase());
        if (slice.x + slice.width > width || slice.y + slice.height > height) {
          throw new Error(`Slice ${name} reaches outside the ${width}×${height} canvas.`);
        }
        if (
          slice.nineSlice &&
          slice.nineSlice.left + slice.nineSlice.right > slice.width
        ) {
          throw new Error(`Slice ${name} has nine-slice borders wider than the slice.`);
        }
        return { ...slice, id: slice.id ?? crypto.randomUUID() } as Slice;
      });
      await run.onFrameChange({ type: "slices", slices });
      run.slices = slices;
      return { slices };
    },
  });

  const readTimeline = createTool({
    name: "read_timeline",
    description:
      "Read the bound asset's animation timeline: each sprite frame's delay in milliseconds and the named tags with their ranges and directions.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frames = [...run.frames].map(([id, frame]) => ({
        id,
        name: frame.name,
        index: frame.index,
        durationMs: frame.durationMs ?? 100,
      }));
      return {
        assetId: run.assetId,
        frames: frames.sort((left, right) => left.index - right.index),
        tags: run.tags ?? [],
      };
    },
  });

  const setFrameDuration = createTool({
    name: "set_frame_duration",
    description:
      "Set one frame's animation delay in milliseconds (10–60000). Frame ids and names both work. This writes the timeline, not the pixels.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      durationMs: z.number().int().min(10).max(60_000),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      if (!run.onFrameChange) throw new Error("This run cannot save frame timing.");
      await run.onFrameChange({
        type: "duration",
        frameId: frame.id,
        durationMs: input.durationMs,
      });
      frame.frame.durationMs = input.durationMs;
      return { frameId: frame.id, name: frame.name, durationMs: input.durationMs };
    },
  });

  const setTags = createTool({
    name: "set_tags",
    description:
      "Replace the asset's animation tags with a full list. Each tag names a from/to frame, a direction (forward, reverse, pingpong) and whether it loops. Use read_timeline first; this replaces rather than merges.",
    inputSchema: z.object({
      tags: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().min(1).max(40),
            fromFrameId: z.string().min(1),
            toFrameId: z.string().min(1),
            direction: z.enum(["forward", "reverse", "pingpong"]),
            loop: z.boolean(),
            color: z.string().optional(),
          }),
        )
        .max(64),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const tags = await saveTimelineTags(run, input.tags);
      return { tags };
    },
  });

  const addTag = createTool({
    name: "add_tag",
    description:
      "Add one animation tag without replacing the existing tags. Frame ids and names both work.",
    inputSchema: z.object({
      name: z.string().min(1).max(40),
      fromFrameId: z.string().min(1),
      toFrameId: z.string().min(1),
      direction: z.enum(["forward", "reverse", "pingpong"]).optional(),
      loop: z.boolean().optional(),
      color: z.string().optional(),
    }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const tags = await saveTimelineTags(run, [
        ...(run.tags ?? []),
        {
          ...input,
          direction: input.direction ?? "forward",
          loop: input.loop ?? true,
        },
      ]);
      return { tags };
    },
  });

  const deleteTag = createTool({
    name: "delete_tag",
    description: "Remove one animation tag by name or id.",
    inputSchema: z.object({ tag: z.string().min(1) }),
    requiresApproval: () => false,
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const existing = run.tags ?? [];
      const match = existing.find(
        (tag) =>
          tag.id === input.tag || tag.name.toLowerCase() === input.tag.toLowerCase(),
      );
      if (!match) throw new Error("That tag is not on this asset.");
      const tags = await saveTimelineTags(
        run,
        existing.filter((tag) => tag.id !== match.id),
      );
      return { tags };
    },
  });

  const checkTimeline = createTool({
    name: "check_timeline",
    description:
      "Measure the timeline before calling it finished: delay ranges, tag ranges and directions, duplicate tag names, and tags that point at missing frames.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frames = [...run.frames].map(([id, frame]) => ({ id, frame }));
      const frameIds = new Set(frames.map((entry) => entry.id));
      const issues: string[] = [];
      for (const { frame } of frames) {
        const duration = frame.durationMs ?? 100;
        if (!Number.isInteger(duration) || duration < 10 || duration > 60_000) {
          issues.push(`${frame.name} has a ${duration} ms delay outside 10–60000 ms.`);
        }
      }
      const names = new Set<string>();
      for (const tag of run.tags ?? []) {
        if (names.has(tag.name.toLowerCase())) {
          issues.push(`Two tags are named ${tag.name}.`);
        }
        names.add(tag.name.toLowerCase());
        if (!frameIds.has(tag.fromFrameId) || !frameIds.has(tag.toFrameId)) {
          issues.push(`Tag ${tag.name} points at a frame outside this run.`);
          continue;
        }
        const from = frames.find((entry) => entry.id === tag.fromFrameId)?.frame;
        const to = frames.find((entry) => entry.id === tag.toFrameId)?.frame;
        if (from && to && from.index > to.index) {
          issues.push(`Tag ${tag.name} starts after it ends.`);
        }
      }
      return { ok: issues.length === 0, issues, frames, tags: run.tags ?? [] };
    },
  });

  const tileFillTool = createTool({
    name: "tile_fill",
    description:
      "Repeat a rectangular tile across a destination region on a layer. The tile is read from the same frame before the fill, so a pixel map can be built from a tileset.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      tileX: z.number().int().nonnegative(),
      tileY: z.number().int().nonnegative(),
      tileWidth: z.number().int().positive(),
      tileHeight: z.number().int().positive(),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...fill } = input;
      const edited = editFrame(run, frameId, { type: "tileFill", ...fill });
      run.onStroke?.({ label: "tile fill", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const applyTilemapTool = createTool({
    name: "apply_tilemap",
    description:
      "Apply a tile-index map to a frame. The tileset rectangles are read from the same frame before any cell is written, so a map can reuse the frame's own tiles.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      tilemap: z.object({
        version: z.literal(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        tileWidth: z.number().int().positive(),
        tileHeight: z.number().int().positive(),
        tileset: z.array(
          z.object({
            index: z.number().int().nonnegative(),
            name: z.string(),
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }),
        ),
        layers: z.array(
          z.object({
            name: z.string(),
            data: z.array(z.number().int().min(-1)),
          }),
        ),
      }),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      const next = applyTilemap(frame.buffer, input.tilemap as TilemapJson);
      for (const layer of next.layers) {
        editFrame(run, frame.id, {
          type: "replaceLayer",
          layerId: layer.id,
          pixels: layer.pixels,
        });
      }
      run.onStroke?.({ label: "tilemap", points: [] }, frame.buffer, frame.id);
      return { committed: true, layers: next.layers.length };
    },
  });

  const removeBackground = createTool({
    name: "remove_background",
    description:
      "Erase a flat background from a layer. By default it samples the top-left pixel and removes the connected border region; tolerance widens the match and edgesOnly false removes every matching pixel.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      layerId: z.string(),
      color: colorSchema.optional(),
      tolerance: z.number().min(0).max(255).optional(),
      edgesOnly: z.boolean().optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const { frameId, ...background } = input;
      const edited = editFrame(run, frameId, {
        type: "removeBackground",
        ...background,
      });
      run.onStroke?.({ label: "background", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const addLayerGroup = createTool({
    name: "add_layer_group",
    description:
      "Create a layer group on the current frame. Layers move into it with move_layer_to_group; groups use the same opacity and visibility model as layers.",
    inputSchema: z.object({ name: z.string().min(1).max(40) }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const id = crypto.randomUUID();
      const edited = editFrame(run, undefined, {
        type: "addLayerGroup",
        id,
        name: input.name,
      });
      run.onStroke?.({ label: "groups", points: [] }, edited.buffer, edited.id);
      return { groupId: id, name: input.name };
    },
  });

  const setLayerGroupVisible = createTool({
    name: "set_layer_group_visible",
    description:
      "Show or hide a layer group, which hides every layer and group inside it.",
    inputSchema: z.object({ groupId: z.string(), visible: z.boolean() }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerGroupVisible",
        groupId: input.groupId,
        visible: input.visible,
      });
      run.onStroke?.({ label: "groups", points: [] }, edited.buffer, edited.id);
      return input;
    },
  });

  const setLayerGroupOpacity = createTool({
    name: "set_layer_group_opacity",
    description: "Set a layer group's opacity from 0 to 1; nested groups multiply it.",
    inputSchema: z.object({ groupId: z.string(), opacity: z.number().min(0).max(1) }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerGroupOpacity",
        groupId: input.groupId,
        opacity: input.opacity,
      });
      run.onStroke?.({ label: "groups", points: [] }, edited.buffer, edited.id);
      return input;
    },
  });

  const removeLayerGroup = createTool({
    name: "remove_layer_group",
    description:
      "Delete a layer group; its layers and child groups move up to the deleted group's parent rather than being deleted.",
    inputSchema: z.object({ groupId: z.string() }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "removeLayerGroup",
        groupId: input.groupId,
      });
      run.onStroke?.({ label: "groups", points: [] }, edited.buffer, edited.id);
      return input;
    },
  });

  const moveLayerToGroup = createTool({
    name: "move_layer_to_group",
    description:
      "Put a layer into a group, or pass null to take it out. A layer keeps its pixel data and stack position.",
    inputSchema: z.object({
      layerId: z.string(),
      groupId: z.string().nullable(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "moveLayerToGroup",
        layerId: input.layerId,
        groupId: input.groupId,
      });
      run.onStroke?.({ label: "groups", points: [] }, edited.buffer, edited.id);
      return input;
    },
  });

  const setLayerOpacity = createTool({
    name: "set_layer_opacity",
    description:
      "Set a layer's opacity from 0 to 1. The layer's pixels stay indexed; the shared renderer composites them for the canvas and every export.",
    inputSchema: z.object({
      layerId: z.string(),
      opacity: z.number().min(0).max(1),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerOpacity",
        layerId: input.layerId,
        opacity: input.opacity,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { layerId: input.layerId, opacity: input.opacity };
    },
  });

  const setLayerBlend = createTool({
    name: "set_layer_blend",
    description:
      "Set a layer's blend mode (normal, multiply, screen, overlay, add, subtract, darken, lighten, difference, exclusion, hard-light, soft-light, color-dodge, color-burn).",
    inputSchema: z.object({
      layerId: z.string(),
      blend: z.enum(blendModes),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerBlend",
        layerId: input.layerId,
        blend: input.blend,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { layerId: input.layerId, blend: input.blend };
    },
  });

  const setLayerLocked = createTool({
    name: "set_layer_locked",
    description:
      "Lock or unlock a layer. A locked layer can be read but every pixel write is refused; locking is still allowed so a layer can be protected.",
    inputSchema: z.object({ layerId: z.string(), locked: z.boolean() }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, undefined, {
        type: "setLayerLocked",
        layerId: input.layerId,
        locked: input.locked,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { layerId: input.layerId, locked: input.locked };
    },
  });

  const duplicateLayer = createTool({
    name: "duplicate_layer",
    description:
      "Duplicate a layer directly above itself, with a new name. The copy keeps the source's opacity, blend mode, lock state and text spec.",
    inputSchema: z.object({
      layerId: z.string(),
      name: z.string().min(1).max(40).optional(),
    }),
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run);
      const source = frame.buffer.layers.find(
        (layer) => layer.id === input.layerId || layer.name === input.layerId,
      );
      if (!source) throw new Error("That layer is not on this frame.");
      const id = crypto.randomUUID();
      const name = (input.name?.trim() || `${source.name} copy`).slice(0, 40);
      const edited = editFrame(run, undefined, {
        type: "duplicateLayer",
        layerId: source.id,
        id,
        name,
      });
      run.onStroke?.({ label: "layers", points: [] }, edited.buffer, edited.id);
      return { layerId: id, name, layers: edited.buffer.layers.length };
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
    // The plan itself rides in the supervisor's reply as JSON (the runtime
    // reads it and the card shows it). This call is only the approval, so its
    // arguments stay one short string: a tool call the provider streams in a
    // single delta, which every chat-completions model handles.
    inputSchema: z.object({
      summary: z.string().min(1).max(300),
    }),
    requiresApproval: true,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      // Consume-once: a staged override is the user's edit of this proposal,
      // never a standing policy for later calls. The worker hydrates it only
      // for the interaction it was staged for; a denied card clears it.
      const staged = run.stagedOverride;
      run.stagedOverride = undefined;
      let frames: Array<{ name: string; frameId?: string }> = [];
      if (staged !== undefined) {
        const parsed = stagedOverrideSchema.safeParse(staged);
        if (!parsed.success) throw new Error("The staged plan override is malformed.");
        frames = parsed.data.frames;
      }
      // An unbound workspace run may propose before it has an asset; its scope
      // then only holds the frame ids of an asset the run already has.
      const scope = new Set<string>();
      if (run.originFrameId !== undefined) scope.add(run.originFrameId);
      for (const frame of frames) {
        if (frame.frameId !== undefined && run.frames.has(frame.frameId)) {
          scope.add(frame.frameId);
        }
      }
      run.approvedScope = scope;
      run.onScopeChange?.([...scope]);
      return {
        approved: true,
        summary: input.summary,
        scope: [...scope],
        next: "Create the approved frames now with add_frame using exactly those names and each frame's planned width and height, then add the plan's palette colours with set_palette and delete every frame named in removeFrames.",
      };
    },
  });

  const listProjects = createTool({
    name: "list_projects",
    description:
      "List your projects with their asset counts. Workspace runs call this before choosing or creating the asset to draw on.",
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const run = requireRun(context.operationId);
      if (!run.onListProjects || run.userId === undefined) {
        throw new Error("This run cannot list projects.");
      }
      return run.onListProjects(run.userId);
    },
  });

  const listAssets = createTool({
    name: "list_assets",
    description: "List the assets of one project with their sizes and frame counts.",
    inputSchema: z.object({ projectId: z.string().min(1) }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      if (!run.onListAssets || run.userId === undefined) {
        throw new Error("This run cannot list assets.");
      }
      return run.onListAssets(run.userId, input.projectId);
    },
  });

  const createAssetTool = createTool({
    name: "create_asset",
    description:
      "Create a new asset in a project and bind this run to it, so you can read and draw on it right away. The size is 8–4096; the palette is optional and index 0 must stay #00000000.",
    inputSchema: z.object({
      projectId: z.string().min(1),
      name: z.string().min(1).max(80),
      width: z.number().int().min(8).max(128),
      height: z.number().int().min(8).max(128),
      palette: z.array(z.string()).min(2).max(256).optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      if (!run.onCreateAsset || run.userId === undefined) {
        throw new Error("This run cannot create an asset.");
      }
      const name = input.name.trim();
      if (!name) throw new Error("An asset name cannot be blank.");
      const palette =
        input.palette === undefined ? undefined : normalizePalette(input.palette);
      const asset = await run.onCreateAsset(run.userId, {
        projectId: input.projectId,
        name,
        width: input.width,
        height: input.height,
        ...(palette === undefined ? {} : { palette }),
      });
      bindRunAsset(run, asset);
      return bindResult(asset, run);
    },
  });

  const useAsset = createTool({
    name: "use_asset",
    description:
      "Bind this run to an existing asset so you can read and draw on it. Use list_assets first to find the asset id.",
    inputSchema: z.object({ assetId: z.string().min(1) }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      if (!run.onLoadAsset || run.userId === undefined) {
        throw new Error("This run cannot choose an asset.");
      }
      const asset = await run.onLoadAsset(run.userId, input.assetId);
      bindRunAsset(run, asset);
      return bindResult(asset, run);
    },
  });

  // Anvia's scratchpad: it records a thought and changes nothing else.
  const think = createThinkTool();

  const critique = createTool({
    name: "critique_frame",
    description:
      "Run the deterministic pixel critique on the current frame. Finish only when issues is empty.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      return { issues: refreshCritique(run, input.frameId) };
    },
  });

  const checkAnimationTool = createTool({
    name: "check_animation",
    description:
      "Measure animation continuity. Two questions: did a frame's changed part slide the whole drawing (consecutive pairs and the loop), and does every frame keep the shared body of the reference frame in the same place. A moving flame or arm inside a still body is not a flag; a body redrawn slightly lower in some frames is. Flags name frames by name. Fix flagged drift before finishing.",
    inputSchema: z.object({
      frameIds: z.array(z.string()).optional(),
      referenceFrame: z
        .string()
        .optional()
        .describe("The frame others keep their body from; defaults to the first one."),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const ids =
        input.frameIds ??
        [...run.frames]
          .sort(([, left], [, right]) => left.index - right.index)
          .map(([id]) => id);
      const frames = ids.map((ref) => {
        const id = resolveFrameId(run, ref);
        const frame = run.frames.get(id);
        if (!frame) throw new Error("Choose or create a frame first.");
        return { id, name: frame.name, buffer: frame.buffer };
      });
      const referenceId =
        input.referenceFrame === undefined
          ? frames[0]?.id
          : resolveFrameId(run, input.referenceFrame);
      const report =
        referenceId === undefined
          ? checkAnimation(frames)
          : checkAnimation(frames, { referenceId });
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
    requiresApproval: () => false,
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const edited = editFrame(run, input.frameId, { type: "mirror" });
      run.onStroke?.({ label: "mirror", points: [] }, edited.buffer, edited.id);
      return { committed: true };
    },
  });

  const useFrame = createTool({
    name: "use_frame",
    description: "Switch the current frame. Later tools without a frameId act on it.",
    inputSchema: z.object({ frameId: z.string() }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      run.currentFrameId = frame.id;
      return { currentFrameId: frame.id, name: frame.name };
    },
  });

  const addFrameTool = createTool({
    name: "add_frame",
    description:
      "Add a frame after the last one and make it current. Blank by default; pass copyOf to copy a frame's pixels. Pass width and height to make this frame its own canvas, such as a 400×400 profile or a 1500×500 cover; without them it inherits the asset's canvas.",
    inputSchema: z.object({
      name: z.string().max(40).optional(),
      copyOf: z.string().optional(),
      width: z.number().int().min(8).max(4096).optional(),
      height: z.number().int().min(8).max(4096).optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const source =
        input.copyOf === undefined ? undefined : resolveFrame(run, input.copyOf);
      const requestedName = input.name?.trim();
      if (requestedName && requestedName.length > 0) {
        const duplicate = [...run.frames.values()].find(
          (frame) => frame.name.trim().toLowerCase() === requestedName.toLowerCase(),
        );
        if (duplicate) {
          throw new Error(
            `A frame named "${requestedName}" already exists. Use that frame or choose a different name.`,
          );
        }
      }
      const next = source
        ? duplicateFrame(
            assetView(run, { withPixels: [source.id] }),
            source.id,
            requestedName ?? "",
          )
        : addFrame(assetView(run), requestedName ?? "", {
            width: input.width,
            height: input.height,
          });
      if (!next) throw new Error(`Frame ${input.copyOf} is not part of this asset.`);
      const added = next.frames.at(-1);
      if (!added) throw new Error("The frame could not be added.");
      const frame = runFrameFrom(added, run);
      // Persist first: a refused save leaves the binding exactly as it was.
      await run.onFrameChange?.({ type: "add", frame: changeFrame(added.id, frame) });
      run.frames.set(added.id, frame);
      run.currentFrameId = added.id;
      run.approvedScope.add(added.id);
      run.onScopeChange?.([...run.approvedScope]);
      run.touchedFrames.add(added.id);
      return {
        frameId: added.id,
        name: frame.name,
        index: frame.index,
        currentFrameId: added.id,
      };
    },
  });

  const createVariant = createTool({
    name: "create_variant",
    description:
      "Create a new frame as a variant of an existing frame. Optionally mirror it and map swatch indexes for artboard scenes; pixel colours are copied unchanged. Use it for alternate poses, recolours, or mirrored sprites.",
    inputSchema: z.object({
      frameId: z.string().optional(),
      name: z.string().min(1).max(40),
      mirror: z.enum(["horizontal", "vertical"]).optional(),
      /** One target index per palette index; index 0 stays transparent. */
      remap: z.array(z.number().int().min(0).max(255)).optional(),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const source = resolveFrame(run, input.frameId);
      const name = input.name.trim();
      if (!name) throw new Error("A variant needs a name.");
      if (
        [...run.frames.values()].some(
          (frame) => frame.name.trim().toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new Error(`A frame named "${name}" already exists.`);
      }
      const next = duplicateFrame(
        assetView(run, { withPixels: [source.id] }),
        source.id,
        name,
      );
      if (!next) throw new Error("The variant frame could not be created.");
      const added = next.frames.at(-1);
      if (!added) throw new Error("The variant frame could not be created.");
      const frame = runFrameFrom(added, run);
      if (input.remap) {
        if (input.remap.length !== frame.buffer.palette.length || input.remap[0] !== 0) {
          throw new Error(
            "A remap must list every palette index exactly once, starting at 0.",
          );
        }
        for (const layer of frame.buffer.layers) {
          for (let index = 0; index < layer.pixels.length; index += 1) {
            layer.pixels[index] = input.remap[layer.pixels[index] ?? 0] ?? 0;
          }
        }
      }
      if (input.mirror) {
        for (const layer of frame.buffer.layers) {
          const flipped = new Uint8Array(layer.pixels.length);
          for (let y = 0; y < frame.buffer.height; y += 1) {
            for (let x = 0; x < frame.buffer.width; x += 1) {
              const fromX =
                input.mirror === "horizontal" ? frame.buffer.width - 1 - x : x;
              const fromY = input.mirror === "vertical" ? frame.buffer.height - 1 - y : y;
              flipped[y * frame.buffer.width + x] =
                layer.pixels[fromY * frame.buffer.width + fromX] ?? 0;
            }
          }
          layer.pixels = flipped;
        }
      }
      await run.onFrameChange?.({ type: "add", frame: changeFrame(added.id, frame) });
      run.frames.set(added.id, frame);
      run.currentFrameId = added.id;
      run.approvedScope.add(added.id);
      run.onScopeChange?.([...run.approvedScope]);
      run.touchedFrames.add(added.id);
      return { frameId: added.id, name: frame.name, mirror: input.mirror ?? null };
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
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      const name = input.name.trim();
      if (!name) throw new Error("A frame name cannot be blank.");
      const duplicate = [...run.frames.entries()].find(
        ([id, candidate]) =>
          id !== frame.id && candidate.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(
          `A frame named "${name}" already exists. Choose a different name.`,
        );
      }
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
      requireAsset(run);
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
    requiresApproval: gatedApproval("delete_frame", frameNeedsApproval),
    execute: async (input, context) => {
      const refused = gateRefusal(context.operationId, "delete_frame");
      if (refused) return { refused: refused.reason };
      const run = requireRun(context.operationId);
      requireAsset(run);
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
      run.onScopeChange?.([...run.approvedScope]);
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
      "Render a frame — or every frame as one strip — to a PNG you can see, and optionally a second frame beside it for comparison. Use it to verify your work, or to look at what another frame looks like before copying from it.",
    inputSchema: z.object({
      ...frameLocator,
      mode: z.enum(["frame", "strip"]).default("frame"),
      compareWith: z
        .object(comparedFrameLocator)
        .optional()
        .describe("A second frame to show beside the first."),
      scale: z.number().min(0.25).max(10).default(4),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const parts: Array<{ label: string; buffer: FrameBuffer }> = [];
      const compose = async (
        locator: { assetId?: string; frameId?: string },
        mode: "frame" | "strip",
      ): Promise<{ label: string; buffer: FrameBuffer }> => {
        const view = await resolveReadFrame(run, locator);
        const strip = view.assetId === run.assetId && mode === "strip";
        return {
          label: strip
            ? `${view.assetName} · ${run.frames.size} frames`
            : `${view.assetName} · ${view.frameName}`,
          buffer: strip
            ? composeStrip([...run.frames.values()].map((item) => item.buffer))
            : toFrameBuffer(view),
        };
      };
      parts.push(
        await compose(
          {
            ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
            ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
          },
          input.mode,
        ),
      );
      if (input.compareWith !== undefined) {
        parts.push(await compose(input.compareWith, input.compareWith.mode));
      }
      const gap = 1;
      const width =
        parts.reduce((total, part) => total + part.buffer.width, 0) +
        gap * (parts.length - 1);
      const height = Math.max(...parts.map((part) => part.buffer.height));
      const canvas = new Uint8Array(width * height);
      const palette = parts[0]?.buffer.palette ?? run.palette;
      let offset = 0;
      for (const part of parts) {
        for (let y = 0; y < part.buffer.height; y += 1) {
          for (let x = 0; x < part.buffer.width; x += 1) {
            canvas[(y + (height - part.buffer.height)) * width + offset + x] =
              part.buffer.layers.reduce(
                (color, layer) =>
                  layer.visible && (layer.pixels[y * part.buffer.width + x] ?? 0) !== 0
                    ? (layer.pixels[y * part.buffer.width + x] ?? 0)
                    : color,
                0,
              );
          }
        }
        offset += part.buffer.width + gap;
      }
      const png = frameToPng(
        {
          width,
          height,
          palette,
          layers: [
            {
              ...(parts[0]?.buffer.layers[0] ?? {
                id: "preview",
                name: "preview",
                visible: true,
              }),
              pixels: canvas,
            },
          ],
        },
        input.scale,
      );
      if (png.length > MAX_PREVIEW_BYTES) {
        throw new Error(
          `The preview is ${png.length} bytes, over the ${MAX_PREVIEW_BYTES}-byte image limit. Lower the scale.`,
        );
      }
      return ToolOutput.content([
        {
          type: "text",
          text: `${parts.map((part) => part.label).join(" | ")} — ${width}×${height} pixels at ${input.scale}× (${png.length} bytes PNG).`,
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

  const compareFrames = createTool({
    name: "compare_frames",
    description:
      "Diff two frames of this project and read the result: changed pixels, where they are, and — when the frames are the same size — a coloured PNG where every changed pixel is highlighted over a dim copy of the first frame. Use it to match a part to a reference frame exactly.",
    inputSchema: z.object({
      ...frameLocator,
      against: z
        .object(frameLocator)
        .describe("The second frame, of this asset or a sibling asset."),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const left = await resolveReadFrame(run, input);
      const right = await resolveReadFrame(run, input.against);
      const leftPixels = composite(toFrameBuffer(left));
      const rightPixels = composite(toFrameBuffer(right));
      const sameSize = left.width === right.width && left.height === right.height;
      let changed = 0;
      let minX = left.width;
      let maxX = -1;
      let minY = left.height;
      let maxY = -1;
      if (sameSize) {
        for (let index = 0; index < leftPixels.length; index += 1) {
          if (leftPixels[index] === rightPixels[index]) continue;
          changed += 1;
          const x = index % left.width;
          const y = Math.floor(index / left.width);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const summary = {
        left: { assetName: left.assetName, frameName: left.frameName },
        right: { assetName: right.assetName, frameName: right.frameName },
        sameSize,
        changedPixels: changed,
        diffBox:
          changed > 0
            ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
            : null,
        leftColors: colorCounts(leftPixels, left.palette),
        rightColors: colorCounts(rightPixels, right.palette),
      };
      if (!sameSize) return summary;
      // Changed pixels take the last palette colour, everything else a dimmed copy.
      const highlight = left.palette.length - 1;
      const dim = 1;
      const overlay = new Uint8Array(leftPixels.length);
      for (let index = 0; index < overlay.length; index += 1) {
        overlay[index] =
          leftPixels[index] !== rightPixels[index]
            ? highlight
            : leftPixels[index] === 0
              ? 0
              : dim;
      }
      const png = frameToPng(
        {
          width: left.width,
          height: left.height,
          palette: left.palette,
          layers: [{ id: "diff", name: "diff", visible: true, pixels: overlay }],
        },
        6 as ExportScale,
      );
      return ToolOutput.content([
        { type: "text", text: JSON.stringify(summary) },
        {
          type: "file",
          data: { type: "data", data: Buffer.from(png).toString("base64") },
          mediaType: "image/png",
          filename: "diff.png",
        },
      ]);
    },
  });

  const readPalette = createTool({
    name: "read_palette",
    description:
      "Read the palette of this asset or of any sibling asset in the project, as index:hex swatches. Pixel colours copy across assets unchanged; the swatches are style guidance.",
    inputSchema: z.object({
      assetId: z
        .string()
        .optional()
        .describe("Another asset of the project; omit for this asset."),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      if (input.assetId === undefined || input.assetId === run.assetId) {
        return {
          assetId: run.assetId,
          assetName: run.assetName,
          palette: run.palette.map((hex, index) => ({ index, hex })),
          paletteLocked: run.paletteLocked === true,
          styleLocked: run.styleLocked === true,
          colorMode: run.colorMode ?? "indexed",
        };
      }
      const view = await resolveReadFrame(run, { assetId: input.assetId });
      return {
        assetId: view.assetId,
        assetName: view.assetName,
        palette: view.palette.map((hex, index) => ({ index, hex })),
      };
    },
  });

  const listProjectFrames = createTool({
    name: "list_project_frames",
    description:
      "List every asset of this project with its size, palette and frames. Every frame carries its id, name, summary, index, width, height and layers — the complete metadata for the current frame and every other frame.",
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      return {
        projectId: run.projectId ?? null,
        projectName: run.projectName ?? null,
        style: run.style,
        assets: await projectListing(run),
      };
    },
  });

  const writeFrame = createTool({
    name: "write_frame",
    description:
      "Move your write cursor to another frame you own. Without it the writer is pinned to its first frame, so you can never paint a neighbour by accident.",
    inputSchema: z.object({ frameId: z.string() }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      run.currentFrameId = frame.id;
      await run.onSelectWriteFrame?.(frame.id);
      return { currentFrameId: frame.id, name: frame.name };
    },
  });

  const saveFrame = createTool({
    name: "save_frame",
    description:
      "Save the frame you have been painting. Strokes commit as they happen; this marks the frame finished at the end of your work.",
    inputSchema: z.object({ frameId: z.string().optional() }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      requireAsset(run);
      const frame = resolveFrame(run, input.frameId);
      assertOwnedFrame(run, frame.id);
      await run.onSaveFrame?.(frame.id);
      return { saved: true, frameId: frame.id, name: frame.name };
    },
  });

  // Search and reference images. Registered only when the server holds a
  // Tavily key; the tool re-checks at call time so a missing key always names
  // itself. The text results serve the asking-only agent too, while view_image
  // needs a model that can actually see.
  const webSearch = createTool({
    name: "web_search",
    description:
      "Search the web for text and real reference images. Call this first whenever the message asks for a search, a reference, or a real-world subject you cannot picture; then view_image to look at a result.",
    inputSchema: z.object({
      query: z.string().min(2).max(400),
      maxResults: z.number().int().min(1).max(8).default(5),
    }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const apiKey = tavilyApiKey();
      if (!apiKey) {
        throw new Error("Set TAVILY_API_KEY on the server to search the web.");
      }
      const outcome = await searchWeb(input.query, {
        apiKey,
        maxResults: input.maxResults,
      });
      const seen = searchImagesFor(run);
      for (const image of outcome.images) {
        const url = parseHttpsPublicUrl(image.url);
        if (url) seen.add(url.href);
      }
      const results = outcome.results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.content}`,
        )
        .join("\n");
      const images = outcome.images
        .map((image, index) => {
          const url = parseHttpsPublicUrl(image.url);
          if (!url) return undefined;
          return `${index + 1}. ${url.href}${image.description ? ` — ${image.description}` : ""}`;
        })
        .filter((line): line is string => line !== undefined)
        .join("\n");
      return [
        `Results for "${input.query}":`,
        results.length > 0 ? results : "(no text results)",
        "",
        images.length > 0
          ? `Images — call view_image with a URL to look at one:\n${images}`
          : "No viewable images came back for this query.",
      ].join("\n");
    },
  });

  const viewImage = createTool({
    name: "view_image",
    description:
      "Look at one image a web_search in this run returned. A model that can see receives the picture. A model that cannot receives a description from the vision model. Say only what this tool showed you.",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async (input, context) => {
      const run = requireRun(context.operationId);
      const url = parseHttpsPublicUrl(input.url);
      if (!url || !searchImagesFor(run).has(url.href)) {
        throw new Error(
          "view_image only accepts https image URLs returned by web_search in this run.",
        );
      }
      const image = await fetchReferenceImage(url);
      if (options.vision === true) {
        return ToolOutput.content([
          {
            type: "text",
            text: `${url.href} — ${image.mediaType}, ${image.bytes} bytes.`,
          },
          {
            type: "file",
            data: { type: "data", data: image.data },
            mediaType: image.mediaType,
            filename: "reference",
          },
        ]);
      }
      if (!run.onDescribeImage) {
        throw new Error("This model cannot view images: no vision model is configured.");
      }
      const description = await run.onDescribeImage({
        data: image.data,
        mediaType: image.mediaType,
      });
      return `${url.href} — seen by the vision model:\n${description}`;
    },
  });

  const tools = [
    readProject,
    readFrame,
    readRegion,
    paint,
    fillRect,
    eraseStroke,
    drawLine,
    drawEllipse,
    tileFillTool,
    applyTilemapTool,
    removeBackground,
    moveRegionTool,
    rotateRegionTool,
    floodFill,
    fillRegion,
    clearRegion,
    replaceColorTool,
    applyOutline,
    ditherRect,
    resizeCanvas,
    resizeFrame,
    setPalette,
    editPaletteColor,
    removePaletteColor,
    reorderPalette,
    addLayerTool,
    addTextTool,
    editTextTool,
    renameLayerTool,
    setLayerVisibleTool,
    checkTiling,
    readSlices,
    setSlices,
    readTimeline,
    setFrameDuration,
    setTags,
    addTag,
    deleteTag,
    checkTimeline,
    addLayerGroup,
    setLayerGroupVisible,
    setLayerGroupOpacity,
    removeLayerGroup,
    moveLayerToGroup,
    setLayerOpacity,
    setLayerBlend,
    setLayerLocked,
    duplicateLayer,
    removeLayerTool,
    plan,
    presentPlan,
    listProjects,
    listAssets,
    createAssetTool,
    useAsset,
    think,
    critique,
    checkAnimationTool,
    compareFrames,
    readPalette,
    listProjectFrames,
    copyRegion,
    pasteRegion,
    mirrorRegionTool,
    repeatRegionTool,
    copyLayersTool,
    writeFrame,
    saveFrame,
    mirror,
    useFrame,
    addFrameTool,
    createVariant,
    renameFrameTool,
    moveFrameTool,
    deleteFrameTool,
    ...(options.webSearch === true ? [webSearch, viewImage] : []),
    ...(options.vision === true ? [preview] : []),
  ];
  // One agent carries the full tool list (so `continueFrom` keeps working
  // across plan and worker); the role a child plays decides what it may call,
  // and the refusal is named at this single gate.
  // A Tool's execution entry point is `call` (there is no public `execute`),
  // so the gate wraps that: same name, schema, and definition, one check.
  return tools.map((entry) => ({
    ...entry,
    call: async (args: never, context?: { operationId?: string }) => {
      const operationId = context?.operationId;
      // Durable child runs call tools with "<runId>/<operationKey>" as the
      // operation id; resolving through the shared prefix keeps the role gate
      // from silently missing its binding.
      const run =
        operationId === undefined ? undefined : getRun(runIdFromOperation(operationId));
      if (run !== undefined) assertRoleAllowsTool(run, entry.name);
      return entry.call(args, context as never);
    },
  })) as typeof tools;
}

export function activeLayerId(buffer: FrameBuffer): string {
  return buffer.layers.find((layer) => layer.visible)?.id ?? buffer.layers[0]?.id ?? "";
}

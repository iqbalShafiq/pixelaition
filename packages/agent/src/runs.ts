import {
  applyCommand,
  cloneBuffer,
  critiqueFrame,
  defaultStyle,
  type CritiqueIssue,
  type FrameBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import { REVIEW_TOOL_NAMES, WORKER_TOOL_NAMES } from "./tasks/roles.js";
import { z } from "zod";
import type { JevUsage } from "./jev.js";

export type Stroke = {
  label: string;
  points: Array<{ x: number; y: number; color: number }>;
};

/** One frame the plan proposes; frameId names an existing frame, absent means add_frame will create it. */
export const planFrameSchema = z.object({
  frameId: z.string().min(1).optional(),
  name: z.string().min(1).max(40),
  description: z.string().min(1).max(200),
});

export type PlanFrame = z.infer<typeof planFrameSchema>;

/**
 * The editable slice of a plan the user may stage before answering the
 * approval card, keyed to the interaction it answers. The stage endpoint
 * validates it on write and the worker hydrates it only for that interaction;
 * present_plan validates it again on read, because jsonb carries no shape of
 * its own.
 */
export const stagedOverrideSchema = z.object({
  interactionId: z.string().min(1),
  frames: z.array(planFrameSchema).min(1).max(24),
});

export type StagedPlanOverride = z.infer<typeof stagedOverrideSchema>;

/** One frame of the asset, held in memory for the run's lifetime. */
export type RunFrame = {
  name: string;
  /** Generated description; absent until the summarizer has run. */
  summary?: string;
  index: number;
  buffer: FrameBuffer;
};

/**
 * A frame-level change the tools made. The worker persists it exactly like the
 * editor's routes do: `add` inserts a row, `rename` updates one, `move` writes
 * the dense renumbering, and `delete` removes a row (inserting `replacement`
 * when the last frame had to be replaced).
 */
export type FrameChange =
  | {
      type: "add";
      frame: { id: string; name: string; index: number; buffer: FrameBuffer };
    }
  | { type: "rename"; frameId: string; name: string }
  | { type: "move"; order: Array<{ id: string; index: number }> }
  | { type: "palette"; palette: string[] }
  | {
      type: "delete";
      frameId: string;
      replacement?: { id: string; name: string; index: number; buffer: FrameBuffer };
    };

/** One project the workspace tools list, with its asset count. */
export type ProjectSummary = {
  id: string;
  name: string;
  /** Generated description; empty until the summarizer has run. */
  summary: string;
  updatedAt: string;
  assetCount: number;
};

/** One asset of a project, as the workspace tools list it. */
export type AssetSummary = {
  id: string;
  name: string;
  /** Generated description; empty until the summarizer has run. */
  summary: string;
  width: number;
  height: number;
  frameCount: number;
  updatedAt: string;
};

export type CreateAssetInput = {
  projectId: string;
  name: string;
  width: number;
  height: number;
  palette?: string[];
};

/**
 * An asset a workspace run can bind: the frames already decoded into buffers,
 * the palette, the canvas size, and the project's style guide. The worker loads
 * it from the database after enforcing ownership.
 */
export type RunAsset = {
  id: string;
  name: string;
  /** Generated description; empty until the summarizer has run. */
  summary: string;
  width: number;
  height: number;
  palette: string[];
  style: StyleGuide;
  frames: Array<{
    id: string;
    name: string;
    /** Generated description; empty until the summarizer has run. */
    summary: string;
    index: number;
    buffer: FrameBuffer;
  }>;
};

/** One Jev gate call, for the run's trace. */
export type JevGateCheck = {
  toolName: string;
  outcome: "approve" | "block" | "review";
  reason: string;
  checks: Record<string, number>;
  durationMs: number;
  model: string;
  usage?: JevUsage;
};

export type RunBinding = {
  /** The asset the run draws on; absent until a workspace run chooses or creates one. */
  assetId?: string;
  assetName?: string;
  /** The asset's generated description; absent until the summarizer has run. */
  summary?: string;
  /** The user's own words for this run; the Jev request check judges calls against it. */
  request?: string;
  originFrameId?: string;
  currentFrameId?: string;
  frames: Map<string, RunFrame>;
  palette: string[];
  width?: number;
  height?: number;
  style: StyleGuide;
  approvedScope: Set<string>;
  /** Frames this run edited or changed; the run terminal snapshots exactly these. */
  touchedFrames: Set<string>;
  /** Fires whenever the approved frame scope grows or shrinks, for persistence. */
  onScopeChange?: (scope: string[]) => void;
  /** A user-edited plan staged for the next present_plan call; consumed once. */
  stagedOverride?: StagedPlanOverride;
  strokes: Stroke[];
  issues: CritiqueIssue[];
  plan?: string[];
  /** The run owner; the workspace callbacks enforce ownership with this id. */
  userId?: string;
  onStroke?: (stroke: Stroke, buffer: FrameBuffer, frameId: string) => void;
  /** Records one Jev request check on the run's trace. */
  onJevCheck?: (check: JevGateCheck) => void;
  onFrameChange?: (change: FrameChange) => void | Promise<void>;
  onListProjects?: (userId: string) => Promise<ProjectSummary[]>;
  onListAssets?: (userId: string, projectId: string) => Promise<AssetSummary[]>;
  onCreateAsset?: (userId: string, input: CreateAssetInput) => Promise<RunAsset>;
  onLoadAsset?: (userId: string, assetId: string) => Promise<RunAsset>;
  /**
   * Describes a reference image for a model that cannot see file parts.
   * The summary-vision model does the looking; a missing vision model throws.
   */
  onDescribeImage?: (image: { data: string; mediaType: string }) => Promise<string>;
  /**
   * Image URLs this run's web searches returned; view_image may look at these
   * and nothing else, so the model cannot point the worker at arbitrary hosts.
   */
  searchImages?: Set<string>;
  /** The task this run belongs to, when a supervisor owns it. */
  taskId?: string;
  /** The role this run plays inside its task. */
  role?: "plan" | "worker" | "review" | "fix";
  /** w1..w4 for a worker child. */
  workerKey?: string;
  /**
   * The user already approved this plan. A correction pass must not call
   * present_plan again, or the same card appears twice.
   */
  planApproved?: boolean;
  /** Workers carry the frames they own; every write is checked against it. */
  ownedFrameIds?: ReadonlySet<string>;
};

/**
 * The role a child plays decides which tools it may call at all: workers
 * cannot touch structure or the palette, and the review never paints. The
 * agent carries the full tool list (one agent keeps `continueFrom` working
 * across plan and worker), so the refusal lives here, named.
 */
export function assertRoleAllowsTool(run: RunBinding, toolName: string): void {
  if (run.planApproved === true && toolName === "present_plan") {
    throw new Error(
      "The user already approved this plan. Do not call present_plan. Reply with the corrected JSON only.",
    );
  }
  if (run.role === undefined) return;
  const allowed =
    run.role === "plan"
      ? undefined
      : run.role === "review"
        ? REVIEW_TOOL_NAMES
        : WORKER_TOOL_NAMES;
  if (allowed !== undefined && !allowed.has(toolName)) {
    throw new Error(`The ${run.role} role cannot call ${toolName}.`);
  }
}

/**
 * A worker may only write its own frames. Plan and review runs carry no set,
 * so nothing changes for them; a worker that reaches for a sibling frame is
 * refused with the cause instead of painting over another worker's work.
 */
export function assertOwnedFrame(run: RunBinding, frameId: string): void {
  if (run.ownedFrameIds !== undefined && !run.ownedFrameIds.has(frameId)) {
    throw new Error("That frame belongs to another worker.");
  }
}

/** The run's seen-image set, created on first use. */
export function searchImagesFor(run: RunBinding): Set<string> {
  run.searchImages ??= new Set();
  return run.searchImages;
}

/** A run that has an asset: the fields every drawing tool reads are present. */
export type BoundRunBinding = RunBinding & {
  assetId: string;
  assetName: string;
  originFrameId: string;
  currentFrameId: string;
  width: number;
  height: number;
};

const runs = new Map<string, RunBinding>();

export function bindRun(runId: string, binding: RunBinding): void {
  runs.set(runId, {
    ...binding,
    frames: new Map(
      [...binding.frames].map(([id, frame]) => [
        id,
        { name: frame.name, index: frame.index, buffer: cloneBuffer(frame.buffer) },
      ]),
    ),
    palette: [...binding.palette],
    approvedScope: new Set(binding.approvedScope),
    touchedFrames: new Set(binding.touchedFrames),
    strokes: [...binding.strokes],
  });
}

export function releaseRun(runId: string): void {
  runs.delete(runId);
}

export function getRun(runId: string): RunBinding | undefined {
  return runs.get(runId);
}

export function runIdFromOperation(operationId: string | undefined): string {
  if (!operationId) throw new Error("The drawing tools need a durable operation id.");
  const slash = operationId.indexOf("/");
  return slash === -1 ? operationId : operationId.slice(0, slash);
}

export function requireRun(operationId: string | undefined): RunBinding {
  const run = getRun(runIdFromOperation(operationId));
  if (!run) throw new Error("This drawing run is no longer active.");
  return run;
}

/**
 * The asset guard for every tool that reads or writes pixels: a workspace run
 * starts unbound, and until it chooses or creates an asset there is nothing to
 * read or draw on.
 */
export function requireAsset(run: RunBinding): asserts run is BoundRunBinding {
  if (
    run.assetId === undefined ||
    run.assetName === undefined ||
    run.originFrameId === undefined ||
    run.currentFrameId === undefined ||
    run.width === undefined ||
    run.height === undefined ||
    run.frames.size === 0
  ) {
    throw new Error("Choose or create an asset first.");
  }
}

/**
 * Bind a loaded asset to a live run in place. The origin frame is the first
 * frame by index; the approved scope restarts there, and touched frames are
 * reset because the terminal snapshots describe the currently bound asset.
 */
export function bindRunAsset(
  run: RunBinding,
  asset: RunAsset,
): asserts run is BoundRunBinding {
  const frames = [...asset.frames].sort((left, right) => left.index - right.index);
  const origin = frames[0];
  if (!origin) throw new Error("That asset has no frames.");
  run.assetId = asset.id;
  run.assetName = asset.name;
  run.summary = asset.summary;
  run.originFrameId = origin.id;
  run.currentFrameId = origin.id;
  run.frames = new Map(
    frames.map((frame) => [
      frame.id,
      {
        name: frame.name,
        summary: frame.summary,
        index: frame.index,
        buffer: cloneBuffer(frame.buffer),
      },
    ]),
  );
  run.palette = [...asset.palette];
  run.width = asset.width;
  run.height = asset.height;
  run.style = asset.style;
  run.approvedScope = new Set([origin.id]);
  run.touchedFrames = new Set();
}

/**
 * A frame reference is an id or a name. Reads use this so any agent can look
 * at a frame it does not paint; writes still pass the resolved id to the
 * ownership check.
 */
export function resolveFrameId(run: BoundRunBinding, frameId?: string): string {
  if (frameId === undefined) {
    if (!run.frames.has(run.currentFrameId)) {
      throw new Error("Choose or create a frame first.");
    }
    return run.currentFrameId;
  }
  if (run.frames.has(frameId)) return frameId;
  const wanted = frameId.trim().toLowerCase();
  const matches = [...run.frames.entries()].filter(
    ([, frame]) => frame.name.trim().toLowerCase() === wanted,
  );
  if (matches.length === 1) {
    const id = matches[0]?.[0];
    if (id !== undefined) return id;
  }
  if (matches.length > 1) {
    throw new Error(`More than one frame is named "${frameId}". Pass the frame id.`);
  }
  const names = [...run.frames.values()].map((frame) => frame.name);
  const list = names.length > 0 ? names.join(", ") : "(none)";
  throw new Error(
    `No frame named or identified by "${frameId}". Frames on this asset: ${list}.`,
  );
}

/**
 * The buffer of the frame named by the caller, or of the run's current frame.
 * An unknown frame id and a run without a current frame fail with named causes.
 */
export function frameBuffer(run: BoundRunBinding, frameId?: string): FrameBuffer {
  const frame = run.frames.get(resolveFrameId(run, frameId));
  if (!frame) throw new Error("Choose or create a frame first.");
  return frame.buffer;
}

export function replaceFrameBuffer(
  run: RunBinding,
  frameId: string,
  buffer: FrameBuffer,
): void {
  const frame = run.frames.get(frameId);
  if (!frame) throw new Error(`Frame ${frameId} is not part of this asset.`);
  frame.buffer = buffer;
}

/**
 * A layer reference is an id or a name; every layer tool accepts either so the
 * model can work with the names read_project prints. An unknown reference
 * fails with its cause instead of painting on the wrong layer.
 */
export function resolveLayerRef(buffer: FrameBuffer, ref: string): string {
  const byId = buffer.layers.find((layer) => layer.id === ref);
  if (byId) return byId.id;
  const wanted = ref.trim().toLowerCase();
  const byName = buffer.layers.find(
    (layer) => layer.name.trim().toLowerCase() === wanted,
  );
  if (!byName) {
    throw new Error(`No layer named or identified by "${ref}" on this frame.`);
  }
  return byName.id;
}

export function paintStroke(
  run: BoundRunBinding,
  frameId: string | undefined,
  layerId: string,
  label: string,
  points: Stroke["points"],
): Stroke {
  const id = resolveFrameId(run, frameId);
  assertOwnedFrame(run, id);
  const buffer = frameBuffer(run, id);
  const result = applyCommand(buffer, {
    type: "paint",
    layerId: resolveLayerRef(buffer, layerId),
    points,
  });
  if (!result.ok) throw new Error(result.message);
  replaceFrameBuffer(run, id, result.buffer);
  run.touchedFrames.add(id);
  const stroke = { label, points };
  run.strokes.push(stroke);
  run.onStroke?.(stroke, result.buffer, id);
  return stroke;
}

export function refreshCritique(run: BoundRunBinding, frameId?: string): CritiqueIssue[] {
  run.issues = critiqueFrame(frameBuffer(run, frameId), run.style ?? defaultStyle);
  return run.issues;
}

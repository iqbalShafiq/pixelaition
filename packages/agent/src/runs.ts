import {
  applyCommand,
  cloneBuffer,
  critiqueFrame,
  defaultStyle,
  type CritiqueIssue,
  type FrameBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import { z } from "zod";

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
 * approval card. The stage endpoint validates it on write and present_plan
 * validates it again on read, because jsonb carries no shape of its own.
 */
export const stagedOverrideSchema = z.object({
  frames: z.array(planFrameSchema).min(1).max(24),
});

export type StagedPlanOverride = z.infer<typeof stagedOverrideSchema>;

/** One frame of the asset, held in memory for the run's lifetime. */
export type RunFrame = {
  name: string;
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
  | {
      type: "delete";
      frameId: string;
      replacement?: { id: string; name: string; index: number; buffer: FrameBuffer };
    };

export type RunBinding = {
  assetId: string;
  originFrameId: string;
  currentFrameId: string;
  frames: Map<string, RunFrame>;
  palette: string[];
  width: number;
  height: number;
  style: StyleGuide;
  approvedScope: Set<string>;
  /** A user-edited plan staged for the next present_plan call; consumed once. */
  stagedOverride?: StagedPlanOverride;
  strokes: Stroke[];
  issues: CritiqueIssue[];
  plan?: string[];
  onStroke?: (stroke: Stroke, buffer: FrameBuffer, frameId: string) => void;
  onFrameChange?: (change: FrameChange) => void | Promise<void>;
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
 * The buffer of the frame named by the caller, or of the run's current frame.
 * An unknown frame id and a run without a current frame fail with named causes.
 */
export function frameBuffer(run: RunBinding, frameId?: string): FrameBuffer {
  if (frameId !== undefined) {
    const frame = run.frames.get(frameId);
    if (!frame) throw new Error(`Frame ${frameId} is not part of this asset.`);
    return frame.buffer;
  }
  const frame = run.frames.get(run.currentFrameId);
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

export function paintStroke(
  run: RunBinding,
  frameId: string | undefined,
  layerId: string,
  label: string,
  points: Stroke["points"],
): Stroke {
  const id = frameId ?? run.currentFrameId;
  const result = applyCommand(frameBuffer(run, frameId), {
    type: "paint",
    layerId,
    points,
  });
  if (!result.ok) throw new Error(result.message);
  replaceFrameBuffer(run, id, result.buffer);
  const stroke = { label, points };
  run.strokes.push(stroke);
  run.onStroke?.(stroke, result.buffer, id);
  return stroke;
}

export function refreshCritique(run: RunBinding, frameId?: string): CritiqueIssue[] {
  run.issues = critiqueFrame(frameBuffer(run, frameId), run.style ?? defaultStyle);
  return run.issues;
}

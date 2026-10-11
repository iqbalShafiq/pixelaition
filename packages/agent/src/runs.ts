import {
  applyCommand,
  cloneBuffer,
  critiqueFrame,
  defaultStyle,
  type CritiqueIssue,
  type FrameBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";

export type Stroke = {
  label: string;
  points: Array<{ x: number; y: number; color: number }>;
};

export type RunFrame = {
  id: string;
  name: string;
  index: number;
};

export type RunBinding = {
  assetId: string;
  frameId: string;
  frames: RunFrame[];
  style: StyleGuide;
  buffer: FrameBuffer;
  strokes: Stroke[];
  issues: CritiqueIssue[];
  onStroke?: (stroke: Stroke, buffer: FrameBuffer) => void;
};

const runs = new Map<string, RunBinding>();

export function bindRun(
  runId: string,
  binding: Omit<RunBinding, "frames"> & { frames?: RunFrame[] },
): void {
  runs.set(runId, {
    ...binding,
    frames: binding.frames ?? [{ id: binding.frameId, name: "current", index: 0 }],
    buffer: cloneBuffer(binding.buffer),
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

export function paintStroke(
  run: RunBinding,
  layerId: string,
  label: string,
  points: Stroke["points"],
): Stroke {
  const result = applyCommand(run.buffer, { type: "paint", layerId, points });
  if (!result.ok) throw new Error(result.message);
  run.buffer = result.buffer;
  const stroke = { label, points };
  run.strokes.push(stroke);
  run.onStroke?.(stroke, run.buffer);
  return stroke;
}

export function refreshCritique(run: RunBinding): CritiqueIssue[] {
  run.issues = critiqueFrame(run.buffer, run.style ?? defaultStyle);
  return run.issues;
}

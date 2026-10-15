import { agentLabel } from "./agent-label.js";

export type RunRow =
  | { id: string; kind: "phase"; label: string; state: "running" | "done" }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary?: string;
      state: "running" | "ok" | "error";
      detail?: string;
    }
  | {
      id: string;
      kind: "status";
      label: string;
      state: "running" | "completed" | "failed" | "cancelled";
      detail?: string;
    }
  | {
      /** A workspace run's created asset: the console's link target. */
      id: string;
      kind: "asset";
      assetId: string;
      projectId: string;
      name: string;
    }
  | {
      /** One worker of a task: its frames and its live state. */
      id: string;
      kind: "worker";
      workerKey: string;
      status: string;
      frames: string[];
    }
  | {
      /** A task phase transition (plan, execute, review). */
      id: string;
      kind: "task-phase";
      phase: string;
      status: string;
    }
  | {
      /** A steering message and where it went. */
      id: string;
      kind: "steering";
      routed: string;
      message: string;
      frameName?: string;
      relayed?: boolean;
    }
  | {
      /** The supervisor's own line, or any agent's thinking or reply. */
      id: string;
      kind: "supervisor";
      message: string;
      channel?: "thinking" | "message";
      to?: string;
      held?: boolean;
    }
  | {
      /** A worker is waiting for the user's answer. */
      id: string;
      kind: "question";
      workerKey: string;
    }
  | {
      /** The run's live cost and token totals; replaced on every update. */
      id: string;
      kind: "usage";
      input: number;
      output: number;
      total: number;
      cached: number;
      cost: number;
      modelCalls: number;
      modelCost: number;
      jevCalls: number;
      jevCost: number;
    };

const TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function toolPayload(body: Record<string, unknown> | undefined): {
  name?: string;
  input: unknown;
} {
  const inner = (body?.input ?? {}) as {
    toolCall?: { toolName?: unknown; input?: unknown };
  };
  const name =
    typeof inner.toolCall?.toolName === "string" ? inner.toolCall.toolName : undefined;
  return { name, input: inner.toolCall?.input };
}

/** `4×2` when both sides are numbers, otherwise nothing. */
function sizeText(value: Record<string, unknown>): string | undefined {
  return typeof value.width === "number" && typeof value.height === "number"
    ? `${value.width}×${value.height}`
    : undefined;
}

/** `3,5` from an object with numeric x and y, otherwise nothing. */
function pointText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" ? `${x},${y}` : undefined;
}

function toolSummary(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (
    (name === "paint_stroke" || name === "erase_stroke") &&
    Array.isArray(value.points)
  ) {
    return `${value.points.length} px`;
  }
  if (name === "set_palette" && Array.isArray(value.palette)) {
    return `${value.palette.length} colors`;
  }
  if (name === "plan" && Array.isArray(value.steps)) {
    return `${value.steps.length} steps`;
  }
  if (name === "think") {
    return "thinking";
  }
  if (
    name === "fill_rect" ||
    name === "fill_region" ||
    name === "clear_region" ||
    name === "resize_canvas" ||
    name === "read_region"
  ) {
    return sizeText(value);
  }
  if (name === "dither_rect") {
    const size = sizeText(value);
    return size && typeof value.pattern === "string" ? `${size} ${value.pattern}` : size;
  }
  if (name === "draw_line") {
    const from = pointText(value.from);
    const to = pointText(value.to);
    return from && to ? `${from} → ${to}` : undefined;
  }
  if (name === "flood_fill") {
    return pointText(value);
  }
  if (
    name === "replace_color" &&
    typeof value.from === "number" &&
    typeof value.to === "number"
  ) {
    return `${value.from} → ${value.to}`;
  }
  if (name === "apply_outline" && typeof value.color === "number") {
    return `color ${value.color}`;
  }
  if (name === "preview_frame" && typeof value.mode === "string") {
    return value.mode;
  }
  return undefined;
}

/** `3 pairs · clean` when nothing is flagged, otherwise the flag count. */
function animationSummary(pairs: number, flags: number): string {
  if (flags > 0) return `${flags} flag${flags === 1 ? "" : "s"}`;
  return `${pairs} pair${pairs === 1 ? "" : "s"} · clean`;
}

/**
 * Folds one worker stream event into the console rows. Unknown events are
 * ignored on purpose: the console shows what the run really did, never a guess.
 * Reasoning text is rendered only when an event carries it; Muse sends
 * encrypted reasoning, so its turns appear as timed "thinking" phases.
 */
export function applyRunEvent(
  rows: RunRow[],
  sequence: number,
  type: string,
  data: unknown,
): RunRow[] {
  const body = data as Record<string, unknown> | undefined;
  const operationId =
    typeof body?.operationId === "string" ? body.operationId : undefined;
  // Operation ids repeat inside every child ("0:model:1" lives in each one);
  // scoping by the child keeps one agent's rows from merging into another's,
  // and keeps a replayed stream from stacking the same row twice.
  const scope =
    typeof body?.runId === "string"
      ? body.runId
      : typeof body?.workerKey === "string"
        ? body.workerKey
        : "";
  const scoped = (raw: string): string => (scope === "" ? raw : `${scope}:${raw}`);
  const id = scoped(operationId ?? `seq-${sequence}`);
  // Child events mirrored into the task stream carry their worker key; every
  // row they create belongs to that worker's group in the console tree.
  const workerKey = typeof body?.workerKey === "string" ? body.workerKey : undefined;
  const tag = <T extends RunRow>(row: T): T =>
    workerKey === undefined ? row : ({ ...row, workerKey } as T);

  if (type === "model_delta") {
    const inner = body as
      | {
          operationId?: unknown;
          event?: {
            type?: unknown;
            text?: unknown;
            delta?: unknown;
            toolCall?: { toolCallId?: unknown; toolName?: unknown; input?: unknown };
          };
        }
      | undefined;
    const operation =
      typeof inner?.operationId === "string" ? inner.operationId : undefined;
    const streamed = inner?.event;
    const kind = typeof streamed?.type === "string" ? streamed.type : undefined;
    const thinking = kind === "reasoning" || (kind?.startsWith("reasoning") ?? false);
    if (kind === "text" || kind === "text_delta" || thinking) {
      const raw = streamed?.text ?? streamed?.delta;
      const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trimStart() : "";
      if (text.length === 0) return rows;
      // Thinking and the reply of one model call stay two rows, so a plan
      // can be read while the agent is still writing it.
      const channel = thinking ? "thinking" : "message";
      const id = scoped(`text-${operation ?? sequence}:${channel}`);
      const index = rows.findIndex((row) => row.id === id);
      const previous =
        index >= 0 && rows[index]?.kind === "supervisor"
          ? (rows[index] as { message: string }).message
          : "";
      const merged = tag({
        id,
        kind: "supervisor" as const,
        channel: channel as "thinking" | "message",
        message: `${previous}${text}`.slice(-8000),
      });
      if (index < 0) return [...rows, merged];
      return rows.map((row, at) => (at === index ? merged : row));
    }
    if (kind === "tool_call" && typeof streamed?.toolCall?.toolName === "string") {
      const name = streamed.toolCall.toolName;
      const id = scoped(
        `call-${String(streamed.toolCall.toolCallId ?? `${operation ?? sequence}`)}`,
      );
      if (rows.some((row) => row.id === id)) return rows;
      // The arguments arrive before the call completes: the console shows what
      // the agent is about to do, not just that it is running.
      return [
        ...rows,
        tag({
          id,
          kind: "tool",
          name,
          summary: toolSummary(name, streamed.toolCall.input),
          state: "running",
        }),
      ];
    }
    return rows;
  }
  if (type === "model_started") {
    if (rows.some((row) => row.id === id)) return rows;
    return [...rows, tag({ id, kind: "phase", label: "thinking", state: "running" })];
  }
  // Interactions render as the card above the composer, never as step rows;
  // the resolved marker only retires the card.
  if (type === "interaction" || type === "interaction-resolved") return rows;
  if (type === "model_note") {
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.length === 0) return rows;
    const channel = body?.channel === "thinking" ? "thinking" : "message";
    const operation =
      typeof body?.operationId === "string" ? body.operationId : String(sequence);
    const noteId = scoped(`note-${operation}:${channel}`);
    const streamId = scoped(`text-${operation}:${channel}`);
    const existing = rows.findIndex((row) => row.id === noteId || row.id === streamId);
    const next = tag({
      id: existing >= 0 ? rows[existing]!.id : noteId,
      kind: "supervisor" as const,
      channel,
      message: text.slice(0, 8000),
    });
    if (existing < 0) return [...rows, next];
    return rows.map((row, index) => (index === existing ? next : row));
  }
  if (type === "model_completed") {
    return rows.map((row) =>
      row.id === id && row.kind === "phase" ? { ...row, state: "done" } : row,
    );
  }
  if (type === "tool_call" || type === "tool_started") {
    const { name, input } = toolPayload(body);
    const existing = rows.find((row) => row.id === id);
    if (existing && existing.kind === "tool") {
      if (name && existing.name === "tool") {
        return rows.map((row) =>
          row.id === id && row.kind === "tool"
            ? { ...row, name, summary: toolSummary(name, input) ?? row.summary }
            : row,
        );
      }
      return rows;
    }
    const finalName = name ?? "tool";
    return [
      ...rows,
      tag({
        id,
        kind: "tool",
        name: finalName,
        summary: toolSummary(finalName, input),
        state: "running",
      }),
    ];
  }
  if (type === "tool_completed") {
    const result = body?.result as
      | {
          failed?: boolean;
          error?: string;
          output?: { pairs?: unknown; flags?: unknown };
        }
      | undefined;
    const detail =
      typeof result?.error === "string"
        ? result.error
        : typeof body?.error === "string"
          ? body.error
          : undefined;
    const summary =
      typeof result?.output?.pairs === "number" &&
      typeof result?.output?.flags === "number"
        ? animationSummary(result.output.pairs, result.output.flags)
        : undefined;
    return rows.map((row) =>
      row.id === id && row.kind === "tool"
        ? {
            ...row,
            state: result?.failed ? "error" : "ok",
            detail,
            ...(row.name === "check_animation" && summary ? { summary } : {}),
          }
        : row,
    );
  }
  if (type === "asset-created" || type === "asset-bound") {
    // The event is the only source of the link target; a payload missing the
    // id, project, or name is ignored rather than guessed.
    const assetId = typeof body?.assetId === "string" ? body.assetId : undefined;
    const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;
    const name = typeof body?.name === "string" ? body.name : undefined;
    if (!assetId || !projectId || !name) return rows;
    // A rejoin replays the stream from 0; the same asset must not stack rows.
    return [
      ...rows.filter((row) => !(row.kind === "asset" && row.assetId === assetId)),
      { id: `asset-${sequence}`, kind: "asset", assetId, projectId, name },
    ];
  }
  if (type === "status") {
    const status = typeof body?.status === "string" ? body.status : "running";
    const state = TERMINAL[status] ?? "running";
    return [
      ...rows.filter((row) => row.kind !== "status"),
      {
        id: `status-${sequence}`,
        kind: "status",
        label: state === "running" ? "running" : state,
        state,
        detail: typeof body?.error === "string" ? body.error : undefined,
      },
    ];
  }
  if (type === "task-phase") {
    const phase = typeof body?.phase === "string" ? body.phase : "task";
    const status = typeof body?.status === "string" ? body.status : "running";
    // One row per phase, updated in place: the task republishes its phase on
    // every status change, and a rejoined stream replays them all.
    const id = scoped("phase");
    if (rows.some((row) => row.id === id)) {
      return rows.map((row) => (row.id === id ? { ...row, phase, status } : row));
    }
    return [...rows, { id, kind: "task-phase", phase, status }];
  }
  if (type === "worker-spawned" || type === "worker-status") {
    const key = typeof body?.workerKey === "string" ? body.workerKey : "worker";
    const status = typeof body?.status === "string" ? body.status : "running";
    const frames = Array.isArray(body?.frames)
      ? (body.frames as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const existing = rows.find((row) => row.kind === "worker" && row.workerKey === key);
    if (existing !== undefined && existing.kind === "worker") {
      return rows.map((row) =>
        row.id === existing.id ? { ...row, status, frames } : row,
      );
    }
    return [
      ...rows,
      tag({ id: `worker-${key}`, kind: "worker", workerKey: key, status, frames }),
    ];
  }
  if (type === "supervisor-says") {
    const message = typeof body?.message === "string" ? body.message : "";
    const to = typeof body?.to === "string" ? body.to : undefined;
    const held = body?.held === true;
    return [
      ...rows,
      tag({
        id: `says-${sequence}`,
        kind: "supervisor",
        message,
        ...(to !== undefined ? { to } : {}),
        ...(held ? { held: true } : {}),
      }),
    ];
  }
  if (type === "steering-routed") {
    const routed = typeof body?.routed === "string" ? body.routed : "supervisor";
    const message = typeof body?.message === "string" ? body.message : "";
    const frameName = typeof body?.frameName === "string" ? body.frameName : undefined;
    const relayed = body?.relayed === true;
    return [
      ...rows,
      tag({
        id: `steer-${sequence}`,
        kind: "steering",
        routed,
        message,
        ...(frameName !== undefined ? { frameName } : {}),
        ...(relayed ? { relayed: true } : {}),
      }),
    ];
  }
  if (type === "question-pending") {
    const key = typeof body?.workerKey === "string" ? body.workerKey : "worker";
    return [
      ...rows,
      tag({ id: `question-${sequence}`, kind: "question", workerKey: key }),
    ];
  }
  if (type === "usage") {
    // Live events carry the flat totals; the persisted pass wraps them as
    // `{ usage }`, and the console must read both shapes.
    const wrapped = (body as { usage?: Record<string, unknown> } | undefined)?.usage;
    const data = wrapped ?? body;
    if (!data) return rows;
    const number = (key: string) =>
      typeof data[key] === "number" ? (data[key] as number) : 0;
    return [
      ...rows.filter((row) => row.kind !== "usage"),
      {
        id: `usage-${sequence}`,
        kind: "usage",
        input: number("input"),
        output: number("output"),
        total: number("total"),
        cached: number("cached"),
        cost: number("cost"),
        modelCalls: number("modelCalls"),
        modelCost: number("modelCost"),
        jevCalls: number("jevCalls"),
        jevCost: number("jevCost"),
      },
    ];
  }
  if (type === "steering_queued" || type === "steering_applied") {
    return [
      ...rows,
      tag({
        id: `steer-${sequence}`,
        kind: "tool",
        name: "follow_up",
        summary: type === "steering_applied" ? "applied" : "queued for the next turn",
        state: "ok",
      }),
    ];
  }
  if (type === "done") {
    const status = typeof body?.status === "string" ? body.status : "completed";
    const state = TERMINAL[status] ?? "completed";
    const previous = rows.find((row) => row.kind === "status");
    const detail =
      typeof body?.error === "string"
        ? body.error
        : previous && previous.kind === "status"
          ? previous.detail
          : undefined;
    return [
      ...rows.filter((row) => row.kind !== "status"),
      {
        id: `done-${sequence}`,
        kind: "status",
        label: state,
        state,
        ...(detail ? { detail } : {}),
      },
    ];
  }
  return rows;
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export type TaskLogRun = {
  id: string;
  role: string | null;
  workerKey: string | null;
  status: string;
  answer: string | null;
  createdAt: string;
  events: Array<{ sequence: number; type: string; data: unknown }>;
};

/** Rebuild the console from the persisted children, oldest agent first. */
export function rowsFromTaskLog(runs: TaskLogRun[], plan?: unknown): RunRow[] {
  const ordered = [...runs].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  let rows: RunRow[] = [];
  for (const run of ordered) {
    const key =
      run.workerKey && run.workerKey.length > 0
        ? run.workerKey
        : run.role === "plan"
          ? "plan"
          : run.role === "review"
            ? "review"
            : run.role === "fix"
              ? "fix"
              : undefined;
    const stamp = key ? { workerKey: key, runId: run.id } : { runId: run.id };
    for (const event of [...run.events].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      const data =
        event.data !== null && typeof event.data === "object"
          ? { ...(event.data as Record<string, unknown>), ...stamp }
          : stamp;
      rows = applyRunEvent(rows, event.sequence, event.type, data);
    }
    const hasNote = run.events.some((event) => event.type === "model_note");
    if (!hasNote && run.answer && run.answer.trim().length > 0) {
      rows = applyRunEvent(rows, 1_000_000, "model_note", {
        ...stamp,
        operationId: `${run.id}:answer`,
        channel: "message",
        text: run.answer,
      });
    }
  }
  // Older runs stored the approved plan on the task, and the plan child's
  // streamed text was not kept. Show that plan when the supervisor left no line.
  const supervisorSpoke = rows.some(
    (row) =>
      row.kind === "supervisor" &&
      "workerKey" in row &&
      typeof row.workerKey === "string" &&
      (row.workerKey === "plan" || row.workerKey.startsWith("plan")) &&
      row.message.trim().length > 0,
  );
  if (!supervisorSpoke && plan !== null && typeof plan === "object") {
    const text = JSON.stringify(plan, null, 2).slice(0, 8000);
    if (text.length > 2) {
      const note = applyRunEvent([], 0, "model_note", {
        workerKey: "plan",
        runId: "stored-plan",
        operationId: "stored-plan",
        channel: "message",
        text,
      });
      rows = [...note, ...rows];
    }
  }
  return rows;
}

export type ConsoleTab = {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  rows: RunRow[];
};

function rowOwner(row: RunRow): string | null {
  if (
    "workerKey" in row &&
    typeof row.workerKey === "string" &&
    row.workerKey.length > 0
  ) {
    return row.workerKey;
  }
  if (row.kind === "steering") {
    if (row.routed === "supervisor" || row.routed === "plan") return "supervisor";
    return row.routed;
  }
  if (row.kind === "supervisor") return "supervisor";
  return null;
}

function rowLive(row: RunRow): boolean {
  if (row.kind === "phase" || row.kind === "tool") return row.state === "running";
  if (row.kind === "status") return row.state === "running";
  if (row.kind === "worker") {
    return !["succeeded", "completed", "failed", "cancelled", "done"].includes(
      row.status,
    );
  }
  return false;
}

function rowFailed(row: RunRow): boolean {
  if (row.kind === "tool") return row.state === "error";
  if (row.kind === "status") return row.state === "failed" || row.state === "cancelled";
  if (row.kind === "worker") return row.status === "failed" || row.status === "cancelled";
  return false;
}

function tabStatus(rows: RunRow[], settled: boolean): ConsoleTab["status"] {
  // A finished session must not keep spinning because one tool row never
  // received its completion. While the run is live, a running row is the spinner.
  if (!settled && rows.some(rowLive)) return "running";
  const workers = rows.filter((row) => row.kind === "worker");
  const lastWorker = workers.at(-1);
  if (
    lastWorker?.kind === "worker" &&
    (lastWorker.status === "failed" || lastWorker.status === "cancelled")
  ) {
    return "failed";
  }
  if (workers.length === 0) {
    const lastStatus = [...rows].reverse().find((row) => row.kind === "status");
    if (
      lastStatus?.kind === "status" &&
      (lastStatus.state === "failed" || lastStatus.state === "cancelled")
    ) {
      return "failed";
    }
    if (rows.some(rowFailed) && lastStatus === undefined) return "failed";
  }
  return "done";
}

function tabOrder(label: string): number {
  if (label === "All") return 0;
  if (label.startsWith("Supervisor")) return 1;
  if (label.startsWith("Agent")) return 2;
  if (label.startsWith("Fix")) return 3;
  if (label.startsWith("Reviewer")) return 4;
  return 5;
}

/**
 * All is the whole transcript in arrival order. The other tabs are one per
 * agent that actually spoke, merged when they share a label (plan and plan-1
 * are both Supervisor).
 */
export function consoleTabs(rows: RunRow[], settled = false): ConsoleTab[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) continue;
    const label = owner === "supervisor" ? "Supervisor" : agentLabel(owner);
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  const rest = [...groups.entries()]
    .sort(
      (left, right) =>
        tabOrder(left[0]) - tabOrder(right[0]) || left[0].localeCompare(right[0]),
    )
    .map(([label, group]) => ({
      id: label,
      label,
      status: tabStatus(group, settled),
      rows: group,
    }));
  return [{ id: "all", label: "All", status: tabStatus(rows, settled), rows }, ...rest];
}

/**
 * Plan rows sit above the workers. Review rows sit last, so the pass that is
 * happening now is at the bottom of the console, where the eye already is.
 */
function rankWorker(key: string | null): number {
  if (key === null || key.startsWith("plan")) return 0;
  if (key.startsWith("review")) return 2;
  return 1;
}

function compareKeys(left: string | null, right: string | null): number {
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
}

/**
 * The console tree: supervisor rows (no worker key) first, then each worker's
 * rows in key order, and the review after the workers.
 */
export function groupRowsByWorker(
  rows: Array<RunRow & { workerKey?: string | null }>,
): Array<{
  workerKey: string | null;
  rows: Array<RunRow & { workerKey?: string | null }>;
}> {
  const groups = new Map<string | null, Array<RunRow & { workerKey?: string | null }>>();
  for (const row of rows) {
    const key = row.workerKey ?? null;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const keys = [...groups.keys()].sort(
    (left, right) => rankWorker(left) - rankWorker(right) || compareKeys(left, right),
  );
  return keys.map((workerKey) => ({ workerKey, rows: groups.get(workerKey) ?? [] }));
}

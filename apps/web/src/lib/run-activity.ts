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
  const id = operationId ?? `seq-${sequence}`;

  if (type === "model_started") {
    if (rows.some((row) => row.id === id)) return rows;
    return [...rows, { id, kind: "phase", label: "thinking", state: "running" }];
  }
  // Interactions render as the card above the composer, never as step rows;
  // the resolved marker only retires the card.
  if (type === "interaction" || type === "interaction-resolved") return rows;
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
      {
        id,
        kind: "tool",
        name: finalName,
        summary: toolSummary(finalName, input),
        state: "running",
      },
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
  if (type === "asset-created") {
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

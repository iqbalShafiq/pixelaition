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
    };

const TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function toolSummary(name: string, data: unknown): string | undefined {
  const input = (data as { input?: Record<string, unknown> } | undefined)?.input;
  if (!input) return undefined;
  if (name === "paint_stroke" && Array.isArray(input.points)) {
    return `${input.points.length} px`;
  }
  if (name === "set_palette" && Array.isArray(input.palette)) {
    return `${input.palette.length} colors`;
  }
  if (name === "fill_rect") {
    return `${input.width}×${input.height}`;
  }
  return undefined;
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
  if (type === "model_completed") {
    return rows.map((row) =>
      row.id === id && row.kind === "phase" ? { ...row, state: "done" } : row,
    );
  }
  if (type === "tool_call" || type === "tool_started") {
    const name =
      typeof body?.name === "string" && body.name.length > 0 ? body.name : undefined;
    const existing = rows.find((row) => row.id === id);
    if (existing && existing.kind === "tool") {
      if (name && existing.name === "tool") {
        return rows.map((row) =>
          row.id === id && row.kind === "tool"
            ? { ...row, name, summary: toolSummary(name, body) ?? row.summary }
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
        summary: toolSummary(finalName, body),
        state: "running",
      },
    ];
  }
  if (type === "tool_completed") {
    const result = body?.result as { failed?: boolean; error?: string } | undefined;
    const detail =
      typeof result?.error === "string"
        ? result.error
        : typeof body?.error === "string"
          ? body.error
          : undefined;
    return rows.map((row) =>
      row.id === id && row.kind === "tool"
        ? { ...row, state: result?.failed ? "error" : "ok", detail }
        : row,
    );
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
    return [
      ...rows.filter((row) => row.kind !== "status"),
      { id: `done-${sequence}`, kind: "status", label: state, state },
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

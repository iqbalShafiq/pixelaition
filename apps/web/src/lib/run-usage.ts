/**
 * The console's usage vocabulary, in Anvia's semantics: `contextUsage` is the
 * context window snapshot of one generation (used/remaining tokens and
 * percent against a declared window), and a turn's usage is a sum of buckets
 * that never double-counts cached input. Everything here is pure so the
 * console's numbers can be tested without a browser.
 */

/** From Anvia's `ContextUsage`, as the worker persists it on a run's usage. */
export type ContextUsage = {
  model: { modelId: string; context: { contextWindow: number } };
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
};

/** The whole asset conversation's settled spend, as the API aggregates it. */
export type SessionTotals = {
  cost: number;
  input: number;
  cached: number;
  output: number;
  total: number;
  elapsedMs: number;
  context: ContextUsage | null;
  /** The model the newest generation used; null before its first call. */
  modelId: string | null;
  /** That model's catalog window, so the empty bar can still read `0 / 1M`. */
  contextWindow: number | null;
};

/** The running turn's live contribution to the header totals. */
export type LiveTurn = {
  /** The turn's server start, so elapsed is not reset by a reload. */
  startedAtMs: number | null;
  cost: number;
  /** Its token buckets, so the session detail includes it before it settles. */
  input: number;
  cached: number;
  output: number;
  context: ContextUsage | null;
};

export type HeaderTotals = {
  cost: number;
  elapsedMs: number;
  input: number;
  cached: number;
  output: number;
  context: ContextUsage | null;
};

/** One turn's token buckets, split so cached input is never counted twice. */
export type TurnUsage = {
  input: number;
  cached: number;
  output: number;
  cost: number;
};

/** What the console prints under one chat turn. */
export type TurnMeta = {
  usage: TurnUsage | null;
  modelId: string | null;
  effort: string | null;
  /** The user's send time, ISO; the server's run/task createdAt. */
  startedAt: string | null;
  durationMs: number | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a persisted context state. A malformed or absent one reads as
 * "no context", never as a guess.
 */
export function contextFromUsage(value: unknown): ContextUsage | null {
  if (!isRecord(value)) return null;
  const model = value.model;
  if (!isRecord(model)) return null;
  const modelId = model.modelId;
  const context = model.context;
  const contextWindow = isRecord(context) ? context.contextWindow : undefined;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  if (!isFiniteNumber(contextWindow) || contextWindow <= 0) return null;
  if (
    !isFiniteNumber(value.usedTokens) ||
    !isFiniteNumber(value.remainingTokens) ||
    !isFiniteNumber(value.usedPercent) ||
    !isFiniteNumber(value.remainingPercent)
  ) {
    return null;
  }
  return {
    model: { modelId, context: { contextWindow } },
    usedTokens: value.usedTokens,
    remainingTokens: value.remainingTokens,
    usedPercent: value.usedPercent,
    remainingPercent: value.remainingPercent,
  };
}

/**
 * Reads a persisted usage blob into a turn's buckets. Fields the blob does not
 * carry are zero; a value that is not an object is no usage at all.
 */
export function turnUsageFrom(value: unknown): TurnUsage | null {
  if (!isRecord(value)) return null;
  const number = (key: string) => (isFiniteNumber(value[key]) ? value[key] : 0);
  return {
    input: number("input"),
    cached: number("cached"),
    output: number("output"),
    cost: number("cost"),
  };
}

/**
 * Validates the session aggregate the API returns. A payload missing any of
 * its numbers is unusable and reads as no session rather than a partial sum.
 */
export function sessionTotalsFrom(value: unknown): SessionTotals | null {
  if (!isRecord(value)) return null;
  for (const key of ["cost", "input", "cached", "output", "total", "elapsedMs"]) {
    if (!isFiniteNumber(value[key])) return null;
  }
  return {
    cost: value.cost as number,
    input: value.input as number,
    cached: value.cached as number,
    output: value.output as number,
    total: value.total as number,
    elapsedMs: value.elapsedMs as number,
    context: contextFromUsage(value.context),
    // The newest model and its window are a convenience for the header, not
    // spend; an absent or malformed one reads as unknown.
    modelId:
      typeof value.modelId === "string" && value.modelId.length > 0
        ? value.modelId
        : null,
    contextWindow:
      isFiniteNumber(value.contextWindow) && value.contextWindow > 0
        ? value.contextWindow
        : null,
  };
}

/** Builds a turn's meta from one task-log entry (or a history run). */
export function turnMetaFromTask(value: {
  usage: unknown;
  modelId: string | null;
  effort: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}): TurnMeta | null {
  const usage = turnUsageFrom(value.usage);
  const modelId = value.modelId ?? null;
  const startedAt = value.createdAt ?? null;
  const starts = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const ends = value.finishedAt === null ? Number.NaN : Date.parse(value.finishedAt);
  const durationMs = Number.isNaN(starts) || Number.isNaN(ends) ? null : ends - starts;
  if (usage === null && modelId === null && startedAt === null) return null;
  return { usage, modelId, effort: value.effort, startedAt, durationMs };
}

/**
 * The header's numbers: the settled session totals plus the live turn's
 * contribution. The live context state wins while it exists — it is the
 * newest generation, exactly like Anvia's own `contextUsage`.
 */
export function headerTotals(
  session: SessionTotals | null | undefined,
  live: LiveTurn | null | undefined,
  nowMs: number,
): HeaderTotals | null {
  if (!session && !live) return null;
  const liveElapsed =
    live?.startedAtMs != null ? Math.max(0, nowMs - live.startedAtMs) : 0;
  return {
    cost: (session?.cost ?? 0) + (live?.cost ?? 0),
    elapsedMs: (session?.elapsedMs ?? 0) + liveElapsed,
    input: (session?.input ?? 0) + (live?.input ?? 0),
    cached: (session?.cached ?? 0) + (live?.cached ?? 0),
    output: (session?.output ?? 0) + (live?.output ?? 0),
    context: live?.context ?? session?.context ?? null,
  };
}

/** `$0.00042` — small costs keep five decimals; large ones keep two. */
export function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(5)}`;
}

/** `14.6k` over a thousand, otherwise the count. */
export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** `121000` → `2m 01s`; a duration the console reads at a glance. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * `524288` → `512k`, `1048576` → `1M`: a window reads as one token of scale,
 * so `used / window` stays short in the header.
 */
export function formatWindow(tokens: number): string {
  const scaled = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (tokens >= 1_048_576) return `${scaled(tokens / 1_048_576)}M`;
  if (tokens >= 1000) return `${scaled(tokens / 1000)}k`;
  return String(tokens);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The send time as a clock: `14:32` on today's turns, `16 Oct, 09:05` on older
 * ones. An unparseable timestamp has no clock at all.
 */
export function formatClock(iso: string, nowMs: number): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date(nowMs);
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(
    then.getMinutes(),
  ).padStart(2, "0")}`;
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return clock;
  return `${then.getDate()} ${MONTHS[then.getMonth()]}, ${clock}`;
}

/**
 * The pieces of a turn's meta line, split so the total-token word can own its
 * detail popover. The line reads: time · model (with effort) · cost · total
 * tokens; cached input is never printed there, only in the popover.
 */
export type UserMetaParts = {
  clock: string | null;
  model: string | null;
  cost: string | null;
  tokens: string | null;
  usage: TurnUsage | null;
};

/**
 * The line under the user's message: when, with which model, what it cost.
 * `displayName` is the catalog's name for the turn's model; the slug is the
 * fallback so a turn on a retired model still names something exact.
 */
export function userMetaParts(
  meta: TurnMeta,
  nowMs: number,
  displayName?: string | null,
): UserMetaParts {
  const clock = meta.startedAt === null ? null : formatClock(meta.startedAt, nowMs);
  const name =
    displayName !== undefined && displayName !== null && displayName.length > 0
      ? displayName
      : meta.modelId;
  const model =
    name !== null && name.length > 0
      ? meta.effort !== null && meta.effort.length > 0
        ? `${name} · ${meta.effort}`
        : name
      : null;
  const cost =
    meta.usage !== null && meta.usage.cost > 0 ? formatCost(meta.usage.cost) : null;
  const total =
    meta.usage !== null ? meta.usage.input + meta.usage.cached + meta.usage.output : 0;
  return {
    clock,
    model,
    cost,
    tokens: total > 0 ? `${formatTokens(total)} tok` : null,
    usage: meta.usage,
  };
}

/** The plain text of that line, for tests and any non-interactive surface. */
export function userMetaText(
  meta: TurnMeta,
  nowMs: number,
  displayName?: string | null,
): string | null {
  const parts = userMetaParts(meta, nowMs, displayName);
  const text = [parts.clock, parts.model, parts.cost, parts.tokens]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return text.length > 0 ? text : null;
}

/** How many of the context bar's ten cells are filled. */
export function contextBarCells(percent: number): number {
  return Math.max(0, Math.min(10, Math.round((percent / 100) * 10)));
}

/**
 * How full the window reads, for the bar's colour. Pixel art blends with hard
 * steps, not opacity: the fill stays `accent` while there is room, dithers
 * toward `erase` as it fills, and is fully `erase` near the top, so a nearly
 * full window reads as danger before it actually overflows.
 */
export type ContextTone = "calm" | "warm" | "danger";

export function contextTone(percent: number): ContextTone {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warm";
  return "calm";
}

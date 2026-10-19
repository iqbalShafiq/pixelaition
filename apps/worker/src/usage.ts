/**
 * Per-run usage accounting, independent of Langfuse: every model generation
 * and every Jev call adds to the run's totals, which stream to the console
 * live and persist on the run row so the user can see what a run costs.
 *
 * The context state mirrors Anvia's `contextUsage` exactly (model window,
 * used/remaining tokens, used/remaining percent) so the console can show the
 * same numbers the runtime computes. The newest generation's state wins: a
 * context state is a snapshot of one request, never a sum.
 */

/** The provider's normalized usage, as the agent observer reports it. */
export type ModelUsageLike = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
};

/** From Anvia's `ContextUsage`, as the adapter attaches it to a response. */
export type ContextUsage = {
  model: { modelId: string; context: { contextWindow: number } };
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
};

/** Jev's own token usage and USD cost, as the request-check hook reports it. */
export type JevUsageLike = {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
};

export type RunUsage = {
  input: number;
  output: number;
  total: number;
  cached: number;
  cost: number;
  modelCalls: number;
  modelCost: number;
  jevCalls: number;
  jevCost: number;
  /** The newest generation's context window state; never a sum. */
  context: ContextUsage | null;
};

export function emptyUsage(): RunUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cached: 0,
    cost: 0,
    modelCalls: 0,
    modelCost: 0,
    jevCalls: 0,
    jevCost: 0,
    context: null,
  };
}

/**
 * Folds one model generation into the totals. Cached input is split out of
 * the provider's input count so the two never double-count; the provider's
 * raw cost lands in both the run total and the model slice.
 */
export function applyModelUsage(
  totals: RunUsage,
  usage: ModelUsageLike,
  cost: number | undefined,
  context: ContextUsage | undefined,
): void {
  const cached =
    typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
  totals.input += Math.max(0, usage.inputTokens - cached);
  totals.output += usage.outputTokens;
  totals.total += usage.totalTokens;
  totals.cached += cached;
  totals.modelCalls += 1;
  if (typeof cost === "number") {
    totals.cost += cost;
    totals.modelCost += cost;
  }
  if (context !== undefined) totals.context = context;
}

/** One Jev call (guardrail, decision, or request check) and its cost. */
export function applyJevUsage(totals: RunUsage, usage: JevUsageLike | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.total += usage.total ?? 0;
  totals.cost += usage.cost ?? 0;
  totals.jevCost += usage.cost ?? 0;
  totals.jevCalls += 1;
}

/**
 * Adds a persisted partial (the API's seed or a finished child's usage) and
 * takes its context state when it carries one. Missing fields stay 0; a null
 * context means "no context to report", never "clear the newest one".
 */
export function mergeUsage(totals: RunUsage, part: Partial<RunUsage>): void {
  totals.input += part.input ?? 0;
  totals.output += part.output ?? 0;
  totals.total += part.total ?? 0;
  totals.cached += part.cached ?? 0;
  totals.cost += part.cost ?? 0;
  totals.modelCalls += part.modelCalls ?? 0;
  totals.modelCost += part.modelCost ?? 0;
  totals.jevCalls += part.jevCalls ?? 0;
  totals.jevCost += part.jevCost ?? 0;
  if (part.context !== undefined && part.context !== null) {
    totals.context = part.context;
  }
}

function isFinite(token: unknown): token is number {
  return typeof token === "number" && Number.isFinite(token);
}

/**
 * Validates the `contextUsage` a response may carry. Anvia attaches it only
 * when the model declared `contextLimits`; a malformed or absent value stays
 * undefined so the console shows no context line instead of guessing.
 */
export function contextFromResponse(value: unknown): ContextUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<ContextUsage>;
  const model = candidate.model as
    { modelId?: unknown; context?: { contextWindow?: unknown } } | undefined;
  const modelId = model?.modelId;
  const contextWindow = model?.context?.contextWindow;
  if (typeof modelId !== "string" || modelId.length === 0) return undefined;
  if (!isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (
    !isFinite(candidate.usedTokens) ||
    !isFinite(candidate.remainingTokens) ||
    !isFinite(candidate.usedPercent) ||
    !isFinite(candidate.remainingPercent)
  ) {
    return undefined;
  }
  return {
    model: { modelId, context: { contextWindow } },
    usedTokens: candidate.usedTokens,
    remainingTokens: candidate.remainingTokens,
    usedPercent: candidate.usedPercent,
    remainingPercent: candidate.remainingPercent,
  };
}

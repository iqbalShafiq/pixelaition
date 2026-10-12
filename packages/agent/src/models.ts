export type ModelSpec = {
  id: string;
  api: "chat" | "responses";
  efforts: string[];
  vision: boolean;
  /**
   * The output budget the worker sends as `max_output_tokens`. The provider
   * charges a request's budget against its output-token rate limit, so an
   * unset cap means the model maximum on every call and a quick 429.
   */
  maxOutputTokens: number;
};
export type RunTarget = { modelId: string; effort: string };

/**
 * Validates one `models` row. A malformed row is a configuration error and
 * must fail loud; it never silently becomes a different endpoint family.
 */
export function parseModelSpecRow(row: {
  id: string;
  api: unknown;
  efforts: unknown;
  vision: unknown;
  maxOutputTokens: unknown;
}): ModelSpec {
  if (row.api !== "chat" && row.api !== "responses") {
    throw new Error(`Model ${row.id} declares an invalid api: ${String(row.api)}`);
  }
  if (
    !Array.isArray(row.efforts) ||
    row.efforts.length === 0 ||
    row.efforts.some((effort) => typeof effort !== "string" || effort.length === 0)
  ) {
    throw new Error(
      `Model ${row.id} declares invalid efforts: ${JSON.stringify(row.efforts)}`,
    );
  }
  if (typeof row.vision !== "boolean") {
    throw new Error(`Model ${row.id} declares invalid vision: ${String(row.vision)}`);
  }
  if (
    typeof row.maxOutputTokens !== "number" ||
    !Number.isInteger(row.maxOutputTokens) ||
    row.maxOutputTokens <= 0
  ) {
    throw new Error(
      `Model ${row.id} declares invalid maxOutputTokens: ${String(row.maxOutputTokens)}`,
    );
  }
  // The pinned OpenAI chat adapter flattens tool-result file parts to
  // `[file:image/png]` text, so a chat model cannot actually see a preview.
  // Only the responses adapter maps them to provider image input.
  if (row.vision === true && row.api !== "responses") {
    throw new Error(
      `Model ${row.id} declares vision with api ${row.api}, which cannot deliver tool-result images.`,
    );
  }
  return {
    id: row.id,
    api: row.api,
    efforts: [...(row.efforts as string[])],
    vision: row.vision,
    maxOutputTokens: row.maxOutputTokens,
  };
}

/** Exact match only: an unknown pair returns undefined and the caller fails loud. */
export function selectRunTarget(
  specs: ModelSpec[],
  modelId: string,
  effort: string,
): RunTarget | undefined {
  const model = specs.find((spec) => spec.id === modelId);
  if (!model || !model.efforts.includes(effort)) return undefined;
  return { modelId: model.id, effort };
}

/**
 * OpenCode Go's usage guidelines ask every client to (1) identify itself with
 * its own user agent rather than a generic SDK name and (2) send a stable
 * session id in `x-opencode-session` for each conversation so routing and
 * prompt caching stay warm; requests without it may start failing. Only
 * requests to that endpoint get these headers.
 */
export function openCodeGoHeaders(
  baseUrl: string | undefined,
  sessionId: string,
): Record<string, string> | undefined {
  if (!baseUrl?.includes("opencode.ai")) return undefined;
  return { "x-opencode-session": sessionId, "user-agent": "pixelaition/0.1" };
}

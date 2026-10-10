export type ModelSpec = { id: string; api: "chat" | "responses"; efforts: string[] };
export type RunTarget = { modelId: string; effort: string };

/**
 * Validates one `models` row. A malformed row is a configuration error and
 * must fail loud; it never silently becomes a different endpoint family.
 */
export function parseModelSpecRow(row: {
  id: string;
  api: unknown;
  efforts: unknown;
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
  return { id: row.id, api: row.api, efforts: [...(row.efforts as string[])] };
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
 * The OpenCode Go endpoint rejects requests that carry no stable session id
 * and asks its clients to identify themselves instead of looking like a
 * plain SDK. Only requests to that endpoint get these headers.
 */
export function openCodeGoHeaders(
  baseUrl: string | undefined,
  sessionId: string,
): Record<string, string> | undefined {
  if (!baseUrl?.includes("opencode.ai")) return undefined;
  return { "x-opencode-session": sessionId, "user-agent": "pixelaition/0.1" };
}

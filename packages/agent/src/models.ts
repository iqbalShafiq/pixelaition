export type ModelSpec = {
  id: string;
  api: "chat" | "responses";
  efforts: string[];
  vision: boolean;
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

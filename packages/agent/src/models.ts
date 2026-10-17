export type ModelSpec = {
  id: string;
  /**
   * The name a person reads in the composer, the console header, and a turn's
   * meta. `id` stays the provider slug the request is sent with.
   */
  displayName: string;
  api: "chat" | "responses";
  efforts: string[];
  /**
   * The model's context window in tokens, when the catalog declares one. The
   * worker passes it to Anvia as `contextLimits`, which attaches `contextUsage`
   * (used/remaining tokens and percent) to every completion response. A
   * missing window means "not declared": the console shows no context line.
   */
  contextWindow?: number;
  /**
   * Images inside tool results: a `view_image` preview, a frame handed to a
   * look. The pinned chat adapter flattens those file parts to
   * `[file:image/png]` text, so only the responses shape can deliver them.
   */
  vision: boolean;
  /**
   * Images a person attached to the message: composer references and the
   * reference images of earlier turns. The chat adapter delivers user-message
   * images as `image_url` parts, so either shape can take them.
   */
  userImages: boolean;
  /**
   * Jobs the catalog assigns to this model (`summary-vision`, `summary-text`).
   * Selecting a summary model by capability and position once picked a test
   * fixture over the real model; a role is an explicit choice.
   */
  roles: string[];
};
export type RunTarget = { modelId: string; effort: string };

/**
 * Whether the model receives images a person attached, on either shape. This
 * is the attachments gate (composer references, prior turns' images); images
 * inside tool results stay behind the stronger `vision` capability.
 */
export function seesUserImages(spec: { vision: boolean; userImages: boolean }): boolean {
  return spec.vision === true || spec.userImages === true;
}

/**
 * Validates one `models` row. A malformed row is a configuration error and
 * must fail loud; it never silently becomes a different endpoint family.
 */
export function parseModelSpecRow(row: {
  id: string;
  displayName?: unknown;
  api: unknown;
  efforts: unknown;
  vision: unknown;
  userImages: unknown;
  roles: unknown;
  contextWindow?: unknown;
}): ModelSpec {
  // The display name is what people read; a row that predates the column (or
  // was seeded blank) falls back to the slug rather than inventing a name.
  const displayName =
    typeof row.displayName === "string" && row.displayName.trim().length > 0
      ? row.displayName.trim()
      : row.id;
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
  if (typeof row.userImages !== "boolean") {
    throw new Error(
      `Model ${row.id} declares invalid userImages: ${String(row.userImages)}`,
    );
  }
  if (
    !Array.isArray(row.roles) ||
    row.roles.some((role) => typeof role !== "string" || role.length === 0)
  ) {
    throw new Error(
      `Model ${row.id} declares invalid roles: ${JSON.stringify(row.roles)}`,
    );
  }
  // The pinned OpenAI chat adapter flattens tool-result file parts to
  // `[file:image/png]` text, so a chat model cannot actually see a preview.
  // Only the responses adapter maps them to provider image input. Images a
  // person attached ride `userImages` instead — the chat adapter delivers
  // those as `image_url`, and this flag stays tool-result-only.
  if (row.vision === true && row.api !== "responses") {
    throw new Error(
      `Model ${row.id} declares vision with api ${row.api}, which cannot deliver tool-result images.`,
    );
  }
  // A declared window must be a real token count; a zero, fractional, or
  // string value is a configuration error, not a model without a window.
  const contextWindow = row.contextWindow ?? undefined;
  if (
    contextWindow !== undefined &&
    (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)
  ) {
    throw new Error(
      `Model ${row.id} declares invalid contextWindow: ${JSON.stringify(row.contextWindow)}`,
    );
  }
  return {
    id: row.id,
    displayName,
    api: row.api,
    efforts: [...(row.efforts as string[])],
    ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
    vision: row.vision,
    userImages: row.userImages,
    roles: [...(row.roles as string[])],
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

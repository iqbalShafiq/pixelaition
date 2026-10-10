export type ModelSpec = { id: string; api: "chat" | "responses"; efforts: string[] };
export type RunTarget = { modelId: string; effort: string };

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

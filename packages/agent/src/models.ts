import { z } from "zod";

/** The effort options used when a model does not declare its own. */
export const genericEfforts = ["none", "low", "medium", "high"] as const;

export type ModelApi = "chat" | "responses";

export type ModelSpec = {
  id: string;
  /** Which OpenAI endpoint family serves the model. */
  api?: ModelApi;
  /** The reasoning-effort options the composer offers for this model. */
  efforts?: string[];
};

export type RunTarget = { modelId: string; effort: string };

const catalogSchema = z.array(
  z.object({
    id: z.string().min(1),
    api: z.enum(["chat", "responses"]).optional(),
    efforts: z.array(z.string().min(1)).min(1).optional(),
  }),
);

/**
 * Parses OPENAI_MODELS, a JSON array of { id, api?, efforts? }. A malformed
 * value yields no specs so the caller can fall back to OPENAI_MODEL.
 */
export function parseModelSpecs(raw: string | undefined): ModelSpec[] {
  const text = raw?.trim();
  if (!text) return [];
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** A model's effort options, with the generic set as the fallback. */
export function effortsFor(efforts: string[] | undefined): string[] {
  return efforts && efforts.length > 0 ? [...efforts] : [...genericEfforts];
}

/**
 * OpenRouter only serves its chat-completions endpoint; every other
 * OpenAI-compatible endpoint the worker talks to defaults to responses.
 */
export function defaultApiFor(baseUrl: string | undefined): ModelApi {
  return baseUrl?.includes("openrouter.ai") ? "chat" : "responses";
}

/**
 * Resolves one run's model and effort against the configured specs. Unknown
 * values fall back to the first model, then to the model's first effort,
 * because a Durable submission only carries an agent id.
 */
export function selectRunTarget(
  specs: ModelSpec[],
  modelId: string,
  effort: string,
): RunTarget {
  const model = specs.find((spec) => spec.id === modelId) ?? specs[0];
  if (!model) throw new Error("selectRunTarget needs at least one model spec");
  const options = effortsFor(model.efforts);
  return {
    modelId: model.id,
    effort: options.includes(effort) ? effort : (options[0] ?? "none"),
  };
}

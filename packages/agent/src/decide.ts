import { check, choice, decide } from "@anvia/core/decision";
import type { DecisionModel } from "@anvia/core/decision";
import { JEV_LATEST, JevClient } from "@anvia/jev";
import { OpenAIClient } from "@anvia/openai";

export type DrawIntent = "draw" | "edit" | "variant" | "clarify";

export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  question?: string;
  /** Which path answered, so a run can be traced back to its decision. */
  source: "local" | "jev" | "openai";
};

/** Below this the prompt is treated as too vague to draw from. */
export const specificityFloor = 0.7;

const vague =
  /^(gambar|buat|make|draw)?\s*(sesuatu|something|anything|ini|itu)?[.!?\s]*$/i;
const variantWords =
  /\b(kiri|kanan|left|right|lari|jalan|run|walk|idle|hadap|facing|state|varian|variant)\b/i;

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist on the frame.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const satisfies Record<DrawIntent, string>;

const clarification =
  "What should the pixel asset show, and about how many pixels wide should it be?";

const intentQuestion = choice({
  instructions:
    "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists.",
  options: intentOptions,
});

const specificQuestion = check({
  instructions:
    "Answer yes when the request names a concrete subject and enough detail to draw it. Answer no when it is a placeholder such as 'draw something'.",
});

type DecisionModelShape = DecisionModel<unknown>;

function asIntent(value: string): DrawIntent {
  return value in intentOptions ? (value as DrawIntent) : "draw";
}

/**
 * The offline decision. It is deterministic, costs nothing, and is the path used
 * when no decision model is configured.
 */
export function decideFromPrompt(prompt: string): DrawDecision {
  const text = prompt.trim();
  if (text.length < 8 || vague.test(text)) {
    return {
      intent: "clarify",
      confidence: 0.9,
      question: clarification,
      source: "local",
    };
  }
  if (variantWords.test(text)) {
    return { intent: "variant", confidence: 0.8, source: "local" };
  }
  if (/\b(ubah|edit|fix|perbaiki|warnai|recolor)\b/i.test(text)) {
    return { intent: "edit", confidence: 0.75, source: "local" };
  }
  return { intent: "draw", confidence: 0.7, source: "local" };
}

async function ask(model: DecisionModelShape, prompt: string): Promise<DrawDecision> {
  const result = await decide({
    model,
    state: { prompt },
    questions: { intent: intentQuestion, specific: specificQuestion },
  });
  const { intent, specific } = result.answers;
  const chosen = asIntent(intent.choice);
  if (chosen === "clarify" || specific.probability < specificityFloor) {
    return {
      intent: "clarify",
      confidence: specific.probability,
      question: clarification,
      source: "jev",
    };
  }
  return {
    intent: chosen,
    confidence: intent.confidence ?? specific.probability,
    source: "jev",
  };
}

function jevModel(apiKey: string): DecisionModelShape {
  return new JevClient({ apiKey }).decisionModel({ modelId: JEV_LATEST });
}

function openAiModel(apiKey: string, baseUrl: string | undefined, modelId: string) {
  const client = new OpenAIClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  // The decision model is operator-configured through DECISION_MODEL, so the id is
  // never guessed here.
  return client.decisionModel({ modelId: modelId as never }) as DecisionModelShape;
}

/**
 * The semantic decision. Jev answers when TYPESAFE_API_KEY is present; otherwise a
 * DECISION_MODEL on the configured OpenAI-compatible endpoint answers. When neither
 * is available, or the provider call fails, the offline decision stands so a
 * drawing session never dies on a decision.
 */
export async function decidePrompt(
  prompt: string,
  env: {
    typesafeApiKey?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    decisionModel?: string;
  } = {},
): Promise<DrawDecision> {
  const local = decideFromPrompt(prompt);
  if (local.intent === "clarify") return local;

  let model: DecisionModelShape | undefined;
  let source: DrawDecision["source"] = "jev";
  if (env.typesafeApiKey?.trim()) {
    model = jevModel(env.typesafeApiKey.trim());
  } else if (env.decisionModel?.trim() && env.openaiApiKey?.trim()) {
    model = openAiModel(
      env.openaiApiKey.trim(),
      env.openaiBaseUrl?.trim(),
      env.decisionModel.trim(),
    );
    source = "openai";
  }
  if (!model) return local;

  try {
    const decided = await ask(model, prompt);
    return { ...decided, source };
  } catch {
    // A decision provider that is down must not stop a drawing session.
    return local;
  }
}

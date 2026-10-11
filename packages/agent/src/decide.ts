import { z } from "zod";

export type DrawIntent = "draw" | "edit" | "variant" | "clarify";
export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  question?: string;
  source: "jev";
};

/** Generation refuses to start until Jev is configured. */
export class DecisionNotConfiguredError extends Error {
  constructor() {
    super("Set JEV_MODEL and OPENROUTER_API_KEY before generating.");
    this.name = "DecisionNotConfiguredError";
  }
}

/**
 * Jev is a System One decision model served by OpenRouter's Decisions API,
 * not the OpenAI-compatible chat endpoints. One OpenRouter key authenticates
 * it; there is no separate TypeSafe account or key.
 */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist on the frame.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const;

const clarifyQuestion =
  "What should the pixel asset show, and about how many pixels wide should it be?";

/** The typed questions Jev answers in one parallel request. */
const jevQuestions = {
  intent: {
    type: "choice",
    instructions:
      "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists.",
    criteria: intentOptions,
  },
  specific: {
    type: "noul",
    instructions:
      "Does the request name a concrete subject and enough detail to draw it? Answer no for a placeholder such as 'draw something'.",
    criteria: {
      true: "The request names a concrete subject and enough detail to draw it.",
      false: "It is a placeholder or too vague to draw from.",
    },
  },
} as const;

const jevAnswerSchema = z.object({
  answers: z.object({
    intent: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: z.number().min(0).max(1),
    }),
    specific: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1),
    }),
  }),
  usage: z.object({ cost: z.number().optional() }).optional(),
});
export type JevAnswers = z.infer<typeof jevAnswerSchema>["answers"];

/**
 * Jev returns typed answers, never prose, so the clarifying question is ours.
 * A low `specific` probability routes to clarify regardless of intent.
 */
export function toDecision(answers: JevAnswers): DrawDecision {
  const chosen = answers.intent.choice;
  const intent =
    chosen === "clarify" || !(chosen in intentOptions)
      ? "clarify"
      : (chosen as DrawIntent);
  const specific = answers.specific.noul;
  const confidence = Math.min(answers.intent.confidence, specific);
  if (intent === "clarify" || specific < 0.7) {
    return { intent: "clarify", confidence, question: clarifyQuestion, source: "jev" };
  }
  return { intent, confidence, source: "jev" };
}

export async function decidePrompt(
  prompt: string,
  env: {
    apiKey?: string | undefined;
    model?: string | undefined;
    /** Test seam; production always uses the OpenRouter Decisions endpoint. */
    decisionsUrl?: string | undefined;
  },
): Promise<DrawDecision> {
  const apiKey = env.apiKey?.trim();
  const model = env.model?.trim();
  if (!apiKey || !model) throw new DecisionNotConfiguredError();
  const response = await fetch(env.decisionsUrl ?? JEV_DECISIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, state: { prompt }, questions: jevQuestions }),
  });
  if (!response.ok) {
    throw new Error(`The Jev decision provider returned ${response.status}.`);
  }
  const parsed = jevAnswerSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Jev returned an answer shape this client does not understand.");
  }
  return toDecision(parsed.data.answers);
}

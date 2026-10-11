import {
  askJev,
  JevNotConfiguredError,
  type JevAnswer,
  type JevEnv,
  type JevQuestion,
} from "./jev.js";

export type DrawIntent = "draw" | "edit" | "variant" | "clarify";
export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  question?: string;
  source: "jev";
};

/** The decision path keeps its own name for the shared configuration error. */
export { JevNotConfiguredError as DecisionNotConfiguredError };

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist on the frame.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const;

const clarifyQuestion =
  "What should the pixel asset show, and about how many pixels wide should it be?";

/** The typed questions Jev answers in one parallel request. */
const jevQuestions: Record<string, JevQuestion> = {
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
};

/**
 * Jev returns typed answers, never prose, so the clarifying question is ours.
 * A low `specific` probability routes to clarify regardless of intent.
 */
export function toDecision(answers: {
  intent: JevAnswer;
  specific: JevAnswer;
}): DrawDecision {
  const chosen = answers.intent.choice;
  const intent =
    chosen === undefined || chosen === "clarify" || !(chosen in intentOptions)
      ? "clarify"
      : (chosen as DrawIntent);
  const specific = answers.specific.noul ?? 0;
  const confidence = Math.min(answers.intent.confidence ?? specific, specific);
  if (intent === "clarify" || specific < 0.7) {
    return { intent: "clarify", confidence, question: clarifyQuestion, source: "jev" };
  }
  return { intent, confidence, source: "jev" };
}

export async function decidePrompt(prompt: string, env: JevEnv): Promise<DrawDecision> {
  const { answers } = await askJev({ prompt }, jevQuestions, env);
  return toDecision({
    intent: answers.intent ?? {},
    specific: answers.specific ?? {},
  });
}

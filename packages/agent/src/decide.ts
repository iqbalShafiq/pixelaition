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
  edit: "Change pixels or colors that already exist on the frame, including a follow-up that corrects the previous result.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const;

const clarifyQuestion =
  "What should the pixel asset show, and about how many pixels wide should it be?";

/** What the last run did, so a short follow-up reads as a correction. */
export type DecisionContext = {
  previousPrompt?: string;
  previousAnswer?: string;
  assetName?: string;
};

/** The typed questions Jev answers in one parallel request. */
const jevQuestions: Record<string, JevQuestion> = {
  intent: {
    type: "choice",
    instructions:
      "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists.",
    criteria: intentOptions,
  },
  // Two speculative specificity questions run in parallel; code picks the one
  // that matters for the chosen intent (the docs' fan-out pattern). A drawing
  // must describe itself; an edit or a variant must say what to change.
  drawable: {
    type: "noul",
    instructions:
      "If the request asks for something new to be drawn, does it name a concrete subject? A subject with a size or a couple of qualities is enough detail; it does not need a full description. For a request that only changes or extends existing art, answer yes.",
    criteria: {
      true: "A new drawing names a concrete subject, optionally with a size or a few qualities.",
      false:
        "It asks for a new drawing but names no subject at all, or only a placeholder like 'something'.",
    },
  },
  actionable: {
    type: "noul",
    instructions:
      "If the request asks to change or extend existing art, does it say what to change? A short follow-up may refer to `previous` (the last request and its result) — for example, 'it's not blue though' says what to change. Use `previous` whenever it is present. For a request that draws something new, answer yes.",
    criteria: {
      true: "An edit or variant says what to change, directly or by referring to `previous`, or the request does not edit existing art.",
      false:
        "It asks to change existing art but does not say what to change, even with `previous` as context.",
    },
  },
};

/**
 * Jev returns typed answers, never prose, so the clarifying question is ours.
 * The chosen intent is only trusted when its own specificity question agrees:
 * a drawing needs `drawable`, an edit or variant needs `actionable`.
 */
export function toDecision(answers: {
  intent: JevAnswer;
  drawable: JevAnswer;
  actionable: JevAnswer;
}): DrawDecision {
  const chosen = answers.intent.choice;
  const intent =
    chosen === undefined || chosen === "clarify" || !(chosen in intentOptions)
      ? "clarify"
      : (chosen as DrawIntent);
  const drawable = answers.drawable.noul ?? 0;
  const actionable = answers.actionable.noul ?? 0;
  const support = intent === "draw" ? drawable : actionable;
  const confidence = Math.min(answers.intent.confidence ?? support, support);
  if (intent === "clarify" || support < 0.7) {
    return { intent: "clarify", confidence, question: clarifyQuestion, source: "jev" };
  }
  return { intent, confidence, source: "jev" };
}

export async function decidePrompt(
  prompt: string,
  env: JevEnv,
  context: DecisionContext = {},
): Promise<DrawDecision> {
  const previous =
    context.previousPrompt !== undefined || context.previousAnswer !== undefined
      ? {
          ...(context.previousPrompt !== undefined
            ? { prompt: context.previousPrompt }
            : {}),
          ...(context.previousAnswer !== undefined
            ? { answer: context.previousAnswer }
            : {}),
        }
      : undefined;
  const { answers } = await askJev(
    {
      prompt,
      ...(previous !== undefined ? { previous } : {}),
      ...(context.assetName !== undefined ? { asset: { name: context.assetName } } : {}),
    },
    jevQuestions,
    env,
  );
  return toDecision({
    intent: answers.intent ?? {},
    drawable: answers.drawable ?? {},
    actionable: answers.actionable ?? {},
  });
}

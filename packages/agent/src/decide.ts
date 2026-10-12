import {
  askJev,
  JevNotConfiguredError,
  type JevAnswer,
  type JevEnv,
  type JevQuestion,
} from "./jev.js";

export type DrawIntent = "draw" | "edit" | "variant" | "ask";
export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  source: "jev";
};

/** The decision path keeps its own name for the shared configuration error. */
export { JevNotConfiguredError as DecisionNotConfiguredError };

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist, including a follow-up that corrects the previous result.",
  variant: "Produce another state, direction, or action of an existing frame.",
  ask: "The user is asking a question, chatting about the work, or the message needs a reply instead of a drawing.",
} as const;
/** One earlier exchange, oldest first, so a follow-up reads in context. */
export type DecisionHistoryEntry = {
  prompt: string;
  answer?: string;
};

/** Everything the decision may look at besides the new message. */
export type DecisionContext = {
  history?: DecisionHistoryEntry[];
  projectName?: string;
  asset?: { name: string; width: number; height: number; palette: string[] };
  frames?: string[];
  frameName?: string;
  /** How many reference images the message carries. */
  attachments?: number;
};

/** The typed questions Jev answers in one parallel request. */
const jevQuestions: Record<string, JevQuestion> = {
  intent: {
    type: "choice",
    instructions:
      "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists; a short noun phrase naming a new state or action is variant, not ask. Prefer ask when the message is a question or a remark that wants an answer, not a drawing. A message that asks for a drawing of attached reference images is still draw or edit, not ask.",
    criteria: intentOptions,
  },
  // Two speculative specificity questions run in parallel; code picks the one
  // that matters for the chosen intent (the docs' fan-out pattern). A drawing
  // must describe itself; an edit or a variant must say what to change.
  drawable: {
    type: "noul",
    instructions:
      "If the request asks for something new to be drawn, does it name a concrete subject? A subject with a size or a couple of qualities is enough detail; it does not need a full description. When the message carries attached reference images, the subject is already concrete: answer yes. For a request that only changes or extends existing art, answer yes.",
    criteria: {
      true: "A new drawing names a concrete subject, optionally with a size or a few qualities, or the message carries attached reference images.",
      false:
        "It asks for a new drawing but names no subject at all, or only a placeholder like 'something'.",
    },
  },
  actionable: {
    type: "noul",
    instructions:
      "If the request asks to change or extend existing art, does it say what to change? A short follow-up may refer to `history` (the thread's recent requests and results, newest last) — for example, 'it's not blue though' says what to change. A variant that names the state, direction, or action to add — even as a short noun phrase — says what to change. Use `history`, `project`, `asset`, `frames`, and `frame` whenever they are present; attached reference images count as saying what to change. For a request that draws something new, answer yes.",
    criteria: {
      true: "An edit or variant says what to change, directly, by naming the state or action to add, by referring to `history`, or with attached reference images, or the request does not edit existing art.",
      false:
        "It asks to change existing art but does not say what to change, even with `history` as context.",
    },
  },
};

/**
 * Jev returns typed answers, never prose. The chosen intent is only trusted
 * when its own specificity question agrees: a drawing needs `drawable`, an
 * edit or variant needs `actionable`, and an ask needs neither.
 */
export function toDecision(answers: {
  intent: JevAnswer;
  drawable: JevAnswer;
  actionable: JevAnswer;
}): DrawDecision {
  const chosen = answers.intent.choice;
  const intent =
    chosen === undefined || !(chosen in intentOptions) ? "ask" : (chosen as DrawIntent);
  if (intent === "ask") {
    return { intent, confidence: answers.intent.confidence ?? 0.5, source: "jev" };
  }
  const drawable = answers.drawable.noul ?? 0;
  const actionable = answers.actionable.noul ?? 0;
  const support = intent === "draw" ? drawable : actionable;
  const confidence = Math.min(answers.intent.confidence ?? support, support);
  if (support < 0.7) {
    // A vague draw request is a conversational turn: the agent asks back.
    return { intent: "ask", confidence, source: "jev" };
  }
  return { intent, confidence, source: "jev" };
}

export async function decidePrompt(
  prompt: string,
  env: JevEnv,
  context: DecisionContext = {},
): Promise<DrawDecision> {
  const { answers } = await askJev(
    {
      prompt,
      ...(context.history !== undefined && context.history.length > 0
        ? { history: context.history }
        : {}),
      ...(context.projectName !== undefined
        ? { project: { name: context.projectName } }
        : {}),
      ...(context.asset !== undefined ? { asset: context.asset } : {}),
      ...(context.frames !== undefined ? { frames: context.frames } : {}),
      ...(context.frameName !== undefined ? { frame: { name: context.frameName } } : {}),
      ...(context.attachments !== undefined && context.attachments > 0
        ? { attachments: context.attachments }
        : {}),
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

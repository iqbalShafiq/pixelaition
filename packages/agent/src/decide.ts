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
  /**
   * The task shape Jev chose: how many workers may paint in parallel and
   * whether a review round is worth it. `source: "default"` means the answers
   * were missing, and the caller logs that instead of hiding it.
   */
  shape?: { workers: number; review: boolean; source: "jev" | "default" };
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
  asset?: {
    name: string;
    width: number;
    height: number;
    palette: string[];
    /** Generated description of what the asset depicts. */
    summary?: string;
  };
  frames?: string[];
  frameName?: string;
  /** Generated description of the current frame. */
  frameSummary?: string;
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
  acts_on_art: {
    type: "noul",
    instructions:
      "Does the message ask this agent to change the artwork itself — repaint, resize, recolor, fix the likeness, add detail, or produce another state — even when it is phrased as a question, a suggestion, or a short comment? Answer false when the message only wants information, an opinion, a description, or a reply.",
    criteria: {
      true: "The message asks for a change to the artwork, however softly it is phrased.",
      false: "The message only wants an answer, not a change to the artwork.",
    },
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
  workers: {
    type: "choice",
    instructions:
      "How many workers should paint this request in parallel? One worker for a single subject or a small tweak to existing art. Two to four when the request needs several frames or distinct parts that can be painted independently. Never more than four; when unsure, choose two.",
    criteria: {
      "1": "A single subject, a small tweak, or work that is inherently sequential.",
      "2": "A few frames or two clearly separate parts; the common case for animation.",
      "3": "Several frames or three parts that can be split cleanly.",
      "4": "Many frames or four independent parts; the request is clearly large.",
    },
  },
  review: {
    type: "noul",
    instructions:
      "After the workers finish, should the supervisor review every frame for continuity, palette, and outlines? Yes when the request involves motion, several frames, or consistency across frames. No for a single simple still subject.",
    criteria: {
      true: "Motion, several frames, or consistency across frames matters.",
      false: "One simple still subject where a review would add nothing.",
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
 * Below this, Jev's ask choice is a toss-up between replying and acting
 * (observed between 0.29 and 0.57 on messages it was torn about), so a clear
 * action signal decides instead.
 */
const ASK_ACTION_FLOOR = 0.6;
/** The action signal a low-confidence ask needs before it runs. */
const ASK_ACTION_CONFIDENCE = 0.9;

/**
 * Jev returns typed answers, never prose. The chosen intent is only trusted
 * when its own specificity question agrees: a drawing needs `drawable`, an
 * edit or variant needs `actionable`, and an ask needs the action check —
 * below `ASK_ACTION_FLOOR` a decisive `acts_on_art` turns the ask into an
 * edit, so a request phrased as a question is still acted on.
 */
export function toDecision(answers: {
  intent: JevAnswer;
  drawable: JevAnswer;
  actionable: JevAnswer;
  workers?: JevAnswer;
  review?: JevAnswer;
  actsOnArt?: JevAnswer;
}): DrawDecision {
  const shapeFrom = (): {
    workers: number;
    review: boolean;
    source: "jev" | "default";
  } => {
    const raw = Number(answers.workers?.choice);
    const answered = Number.isFinite(raw) && answers.review?.noul !== undefined;
    const workers = Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.round(raw))) : 2;
    const review = (answers.review?.noul ?? 0.6) >= 0.5;
    return { workers, review, source: answered ? "jev" : "default" };
  };
  const chosen = answers.intent.choice;
  const intent =
    chosen === undefined || !(chosen in intentOptions) ? "ask" : (chosen as DrawIntent);
  if (intent === "ask") {
    const confidence = answers.intent.confidence ?? 0.5;
    // A low-confidence ask is Jev torn between replying and acting. When the
    // message plainly asks for a change to the artwork, run it as an edit
    // rather than answering "I cannot do that from here".
    if (
      confidence < ASK_ACTION_FLOOR &&
      (answers.actsOnArt?.noul ?? 0) >= ASK_ACTION_CONFIDENCE
    ) {
      return { intent: "edit", confidence, source: "jev", shape: shapeFrom() };
    }
    return { intent, confidence, source: "jev" };
  }
  const drawable = answers.drawable.noul ?? 0;
  const actionable = answers.actionable.noul ?? 0;
  const support = intent === "draw" ? drawable : actionable;
  const confidence = Math.min(answers.intent.confidence ?? support, support);
  if (support < 0.7) {
    // A vague draw request is a conversational turn: the agent asks back.
    return { intent: "ask", confidence, source: "jev" };
  }
  return { intent, confidence, source: "jev", shape: shapeFrom() };
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
      ...(context.frameName !== undefined
        ? {
            frame: {
              name: context.frameName,
              ...(context.frameSummary !== undefined && context.frameSummary.length > 0
                ? { summary: context.frameSummary }
                : {}),
            },
          }
        : {}),
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
    workers: answers.workers ?? {},
    review: answers.review ?? {},
    actsOnArt: answers.acts_on_art ?? {},
  });
}

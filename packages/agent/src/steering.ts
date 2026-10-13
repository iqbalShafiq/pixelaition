import { askJev, type JevEnv } from "./jev.js";

/**
 * Which frame a steering message is about. Jev reads the message, the plan,
 * and what each worker is doing; the code trusts the answer only above the
 * confidence threshold, and the caller asks the user below it.
 */
export type SteeringRoute = {
  target: "supervisor" | string;
  frames: string[];
  confidence: number;
  source: "jev";
};

export const STEERING_CONFIDENCE = 0.7;

export type SteeringContext = {
  /** The worker split from the approved plan. */
  workers: Array<{ key: string; frames: string[] }>;
  /** The frame names the plan knows, for validation of the answer. */
  frameNames: string[];
  /** What each worker is doing right now, when known. */
  activity?: Array<{ key: string; status: string }>;
};

const questions = {
  target: {
    type: "choice" as const,
    instructions:
      'The user sent a message while several workers paint frames of one asset. Which target should receive it? Choose a worker key when the message clearly concerns the frames that worker owns (a colour, a shape, a detail of that frame). Choose "supervisor" when the message is about the whole asset, the plan, or several frames at once, or when it is unclear which frame it concerns.',
    criteria: {
      supervisor:
        "The message concerns the whole asset, the plan, or several frames, or no single frame is clearly meant.",
    },
  },
  frames: {
    type: "choice" as const,
    instructions:
      'If the message clearly concerns one or more specific frames, choose the frame name it is about; otherwise choose "none".',
    criteria: { none: "No single frame is clearly meant." },
  },
};

/**
 * A message the user anchored to a frame needs no decision: the caller routes
 * it directly and never spends a Jev call. Only free-form steering reaches
 * this function, and an answer naming an unknown frame or worker is dropped
 * to the supervisor rather than trusted.
 */
export async function routeSteering(
  message: string,
  context: SteeringContext,
  env: JevEnv,
): Promise<SteeringRoute> {
  const targetOptions: Record<string, string> = {
    supervisor: "The whole asset, the plan, or several frames at once.",
  };
  for (const worker of context.workers) {
    targetOptions[worker.key] = `Frames ${worker.frames.join(", ")}.`;
  }
  const frameOptions: Record<string, string> = {
    none: "No single frame is clearly meant.",
  };
  for (const name of context.frameNames) frameOptions[name] = `The frame "${name}".`;

  const { answers } = await askJev(
    {
      message,
      workers: context.workers,
      frames: context.frameNames,
      ...(context.activity !== undefined && context.activity.length > 0
        ? { activity: context.activity }
        : {}),
    },
    {
      target: { ...questions.target, criteria: targetOptions },
      frames: { ...questions.frames, criteria: frameOptions },
    },
    env,
  );

  const chosenTarget = answers.target?.choice;
  const knownTarget = chosenTarget !== undefined && chosenTarget in targetOptions;
  const target = knownTarget ? (chosenTarget as string) : "supervisor";
  const chosenFrame = answers.frames?.choice;
  const frames =
    chosenFrame !== undefined && chosenFrame !== "none" && chosenFrame in frameOptions
      ? [chosenFrame]
      : [];
  // An unrecognized target is no answer: zero confidence forces the caller to
  // ask the user rather than route on a guess.
  const confidence = knownTarget
    ? Math.min(answers.target?.confidence ?? 0, answers.frames?.confidence ?? 1)
    : 0;
  return { target, frames, confidence, source: "jev" };
}

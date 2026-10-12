import { z } from "zod";

/**
 * The one transport every Jev call goes through. Jev is a System One decision
 * model served by a Decisions API: the base URL comes from
 * `DECISION_MODEL_BASE_URL` and the `/alpha/decisions` path is appended, so a
 * different decision provider is a .env change. One key authenticates it.
 */

/** Generation refuses to start until Jev is configured. */
export class JevNotConfiguredError extends Error {
  constructor() {
    super(
      "Set DECISION_MODEL, DECISION_MODEL_BASE_URL, and DECISION_MODEL_API_KEY before generating.",
    );
    this.name = "JevNotConfiguredError";
  }
}

export type JevEnv = {
  apiKey?: string | undefined;
  model?: string | undefined;
  /** The provider's API root; the Decisions path is appended to it. */
  baseUrl?: string | undefined;
  /** Test seam; production derives the URL from `baseUrl`. */
  decisionsUrl?: string | undefined;
  /** Called once per successful request with its usage, for telemetry. */
  onCall?: ((call: { model: string; latencyMs: number } & JevUsage) => void) | undefined;
};

/** Token counts and cost as Jev reports them, in Langfuse's usage keys. */
export type JevUsage = {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
};

export type JevQuestion = {
  type: "noul" | "choice" | "score";
  instructions: unknown;
  criteria?: unknown;
};

export type JevAnswer = {
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
};

const answerSchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      type: z.string(),
      noul: z.number().min(0).max(1).optional(),
      choice: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      score: z.number().optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

/**
 * Ask Jev one battery of questions about one state. A missing key, an
 * unreachable provider, a missing answer, or a shape this client does not
 * understand is an error naming the cause; it never becomes a silent default.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  env: JevEnv,
): Promise<{ answers: Record<string, JevAnswer>; usage: JevUsage; model: string }> {
  const apiKey = env.apiKey?.trim();
  const model = env.model?.trim();
  const baseUrl = env.baseUrl?.replace(/\/$/, "");
  const url = env.decisionsUrl ?? (baseUrl ? `${baseUrl}/alpha/decisions` : undefined);
  if (!apiKey || !model || !url) throw new JevNotConfiguredError();
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`The Jev decision provider returned ${response.status}.`);
  }
  const parsed = answerSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Jev returned an answer shape this client does not understand.");
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[name];
    if (!answer) {
      throw new Error(`Jev did not answer the ${name} question.`);
    }
    if (question.type === "noul" && answer.noul === undefined) {
      throw new Error(`Jev answered ${name} without a probability.`);
    }
    if (question.type === "choice" && answer.choice === undefined) {
      throw new Error(`Jev answered ${name} without a choice.`);
    }
    if (question.type === "score" && answer.score === undefined) {
      throw new Error(`Jev answered ${name} without a score.`);
    }
    answers[name] = {
      ...(answer.noul !== undefined ? { noul: answer.noul } : {}),
      ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      ...(answer.score !== undefined ? { score: answer.score } : {}),
    };
  }
  const reported = parsed.data.usage;
  const usage: JevUsage = {
    ...(reported?.input_tokens !== undefined ? { input: reported.input_tokens } : {}),
    ...(reported?.output_tokens !== undefined ? { output: reported.output_tokens } : {}),
    ...(reported?.input_tokens !== undefined && reported?.output_tokens !== undefined
      ? { total: reported.input_tokens + reported.output_tokens }
      : {}),
    ...(reported?.cost !== undefined ? { cost: reported.cost } : {}),
  };
  env.onCall?.({ model, ...usage, latencyMs: Date.now() - started });
  return { answers, usage, model };
}

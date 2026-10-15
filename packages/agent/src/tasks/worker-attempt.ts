import type { AgentPrompt } from "@anvia/core/agent";
import { defineTask, type TaskTransition } from "@anvia/durable";
import { z } from "zod";

/**
 * One worker paints on its own. A malformed tool call or a provider failure
 * gets another attempt immediately, without waiting for the other workers.
 * The user only hears "failed" after every attempt is spent.
 */
export const WORKER_ATTEMPTS = 3;

const promptSchema = z.custom<AgentPrompt>(
  (value) => typeof value === "string" || (typeof value === "object" && value !== null),
);

export const workerAttemptInputSchema = z.object({
  agentId: z.string().min(1),
  workerKey: z.string().regex(/^w[1-4]$/),
  prompt: promptSchema,
});

const checkpointSchema = z.object({
  attempt: z
    .number()
    .int()
    .min(0)
    .max(WORKER_ATTEMPTS - 1),
  childKey: z.string().optional(),
});

const outputSchema = z.object({
  workerKey: z.string(),
  attempts: z.number().int().min(1).max(WORKER_ATTEMPTS),
});

type Checkpoint = z.infer<typeof checkpointSchema>;
type Output = z.infer<typeof outputSchema>;

function childKey(workerKey: string, attempt: number): string {
  return attempt === 0 ? workerKey : `${workerKey}-retry-${attempt}`;
}

export const workerAttemptTask = defineTask({
  name: "worker-attempt",
  version: 1,
  input: workerAttemptInputSchema,
  checkpoint: checkpointSchema,
  output: outputSchema,
  initial: (): Checkpoint => ({ attempt: 0 }),
  run: async (ctx): Promise<TaskTransition<Checkpoint, Output>> => {
    const { workerKey, agentId, prompt } = ctx.input;
    const checkpoint = ctx.checkpoint;
    if (checkpoint.childKey === undefined) {
      const key = childKey(workerKey, checkpoint.attempt);
      const id = ctx.spawnAgent(key, { agentId, prompt });
      return {
        status: "waiting",
        checkpoint: { ...checkpoint, childKey: key },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    }
    const outcome = ctx
      .children()
      .find((child) => child.key === checkpoint.childKey)?.outcome;
    if (outcome?.status === "completed") {
      return {
        status: "completed",
        output: { workerKey, attempts: checkpoint.attempt + 1 },
      };
    }
    if (outcome?.status === "cancelled") {
      return {
        status: "cancelled",
        error: outcome.error ?? `Worker ${workerKey} was cancelled.`,
      };
    }
    const next = checkpoint.attempt + 1;
    if (next < WORKER_ATTEMPTS) {
      const key = childKey(workerKey, next);
      const id = ctx.spawnAgent(key, { agentId, prompt });
      return {
        status: "waiting",
        checkpoint: { attempt: next, childKey: key },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    }
    return {
      status: "failed",
      error:
        outcome?.error ?? `Worker ${workerKey} failed after ${WORKER_ATTEMPTS} attempts.`,
    };
  },
});

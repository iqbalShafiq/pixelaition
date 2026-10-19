import type { TaskContext } from "@anvia/durable";
import { describe, expect, it } from "vitest";
import { WORKER_ATTEMPTS, workerAttemptTask } from "./worker-attempt.js";

function ctx(options: {
  checkpoint: { attempt: number; childKey?: string };
  children?: Array<{ key: string; outcome?: { status: string; error?: string } }>;
}) {
  const spawned: string[] = [];
  const context = {
    input: { agentId: "pixel-draw:test:medium", workerKey: "w2", prompt: "paint" },
    checkpoint: options.checkpoint,
    children: () => options.children ?? [],
    spawnAgent: (key: string) => {
      spawned.push(key);
      return `child-${key}`;
    },
  } as unknown as TaskContext<
    { agentId: string; workerKey: string; prompt: string },
    { attempt: number; childKey?: string }
  >;
  return { context, spawned };
}

describe("worker-attempt", () => {
  it("retries a failed worker immediately, up to the attempt cap", async () => {
    const first = ctx({ checkpoint: { attempt: 0 } });
    await expect(workerAttemptTask.run(first.context)).resolves.toMatchObject({
      status: "waiting",
      wait: { ids: ["child-w2"] },
    });
    expect(first.spawned).toEqual(["w2"]);

    const failed = ctx({
      checkpoint: { attempt: 0, childKey: "w2" },
      children: [{ key: "w2", outcome: { status: "failed", error: "malformed JSON" } }],
    });
    const retry = await workerAttemptTask.run(failed.context);
    expect(retry).toMatchObject({
      status: "waiting",
      checkpoint: { attempt: 1, childKey: "w2-retry-1" },
    });
    expect(failed.spawned).toEqual(["w2-retry-1"]);

    const spent = ctx({
      checkpoint: { attempt: WORKER_ATTEMPTS - 1, childKey: "w2-retry-2" },
      children: [
        { key: "w2-retry-2", outcome: { status: "failed", error: "still bad" } },
      ],
    });
    await expect(workerAttemptTask.run(spent.context)).resolves.toMatchObject({
      status: "failed",
      error: "still bad",
    });
    expect(spent.spawned).toEqual([]);
  });

  it("does not retry a cancelled worker", async () => {
    const { context, spawned } = ctx({
      checkpoint: { attempt: 0, childKey: "w2" },
      children: [{ key: "w2", outcome: { status: "cancelled", error: "stopped" } }],
    });
    await expect(workerAttemptTask.run(context)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(spawned).toEqual([]);
  });
});

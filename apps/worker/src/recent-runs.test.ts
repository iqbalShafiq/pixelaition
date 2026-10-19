import { randomUUID } from "node:crypto";
import {
  assets,
  createDatabase,
  generationRuns,
  generationThreads,
  projects,
  user,
  type Database,
} from "@pixelaition/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentRuns } from "./tasks.js";

/**
 * The run prompt's recent-runs block must carry the user's turns, never the
 * prompts of an earlier drawing task's supervisor, workers, review, or fixes.
 * Needs a live database; skips when DATABASE_URL is absent or unreachable.
 */
async function probe(url: string | undefined): Promise<Database | undefined> {
  if (!url) return undefined;
  const candidate = createDatabase(url);
  try {
    await Promise.race([
      candidate.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database probe timed out")), 3000),
      ),
    ]);
    return candidate;
  } catch {
    await candidate.$client.end({ timeout: 1 }).catch(() => undefined);
    return undefined;
  }
}

const db = await probe(process.env.DATABASE_URL);

describe.skipIf(!db)("recent runs", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  const assetId = randomUUID();
  let live: Database;

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    await live.insert(user).values({
      id: userId,
      name: "Recent Runs Test",
      email: `recent-runs-${userId}@test.local`,
    });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "svt",
      description: "",
      style: {
        notes: "",
        outline: "#1a1c2c",
        defaultWidth: 32,
        defaultHeight: 32,
        shadowDirection: "down",
      },
    });
    await live.insert(assets).values({
      id: assetId,
      projectId,
      name: "scoups",
      width: 32,
      height: 32,
      palette: ["#00000000", "#1a1c2c"],
    });
    const threadId = randomUUID();
    await live.insert(generationThreads).values({ id: threadId, assetId, userId });
    const at = (seconds: number) => new Date(1_760_000_000_000 + seconds * 1000);
    const run = (
      seconds: number,
      over: Partial<typeof generationRuns.$inferInsert>,
    ): typeof generationRuns.$inferInsert => ({
      id: randomUUID(),
      threadId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "recent-runs-test-model",
      reasoningEffort: "low",
      createdAt: at(seconds),
      ...over,
    });
    await live.insert(generationRuns).values([
      run(1, { prompt: "bikin pedang", answer: "Selesai." }),
      run(2, {
        role: "worker",
        workerKey: "w1",
        prompt:
          "You are one worker in a supervised team; you paint only the frames you own.",
        answer: "Painted.",
      }),
      run(3, {
        role: "plan",
        workerKey: "plan",
        prompt: "beri mata lebih besar\n\nAsset name to use: scoups",
        answer: '{"frames":[]}',
      }),
      run(4, {
        role: "review",
        workerKey: "review-1",
        prompt: "You are the supervisor's review pass; you never paint.",
        answer: '{"ok":false}',
      }),
      run(5, { prompt: "kenapa warnanya biru?", answer: "Karena permintaan awal." }),
      run(6, { prompt: "masih jalan", answer: null, status: "running" }),
    ]);
  });

  afterAll(async () => {
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("carries the newest user turns, oldest first, and skips the machinery", async () => {
    expect(await recentRuns(live, { assetId })).toEqual([
      { prompt: "bikin pedang", answer: "Selesai." },
      { prompt: "beri mata lebih besar", answer: '{"frames":[]}' },
      { prompt: "kenapa warnanya biru?", answer: "Karena permintaan awal." },
    ]);
  });
});

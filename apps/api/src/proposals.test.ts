import { randomUUID } from "node:crypto";
import { createDatabase, user, type Database } from "@pixelaition/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeProposal, insertProposal } from "./store.js";

/**
 * Proposals need a live database; when DATABASE_URL is absent or the database
 * cannot be reached, the suite skips instead of failing. This file owns its
 * connection so another suite ending the shared client cannot break it.
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

describe.skipIf(!db)("run proposals", () => {
  const userId = randomUUID();
  let live: Database;

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    await live.insert(user).values({
      id: userId,
      name: "Proposal Test",
      email: `proposal-${userId}@test.local`,
    });
  });

  afterAll(async () => {
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("consumes a proposal once, then refuses it", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: "draw a knight",
      intent: "draw",
      project: { id: "new", confidence: 0.6 },
      guardrail: { action: "pass" },
      decision: { intent: "draw" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const first = await consumeProposal(live, userId, row.id);
    expect("proposal" in first).toBe(true);
    const second = await consumeProposal(live, userId, row.id);
    expect("failure" in second && second.failure.code).toBe("PROPOSAL_CONSUMED");
  });

  it("refuses an expired proposal with a named cause", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: "x",
      intent: "draw",
      project: { id: "new", confidence: 0.5 },
      guardrail: { action: "pass" },
      decision: {},
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await consumeProposal(live, userId, row.id);
    expect("failure" in result && result.failure.code).toBe("PROPOSAL_EXPIRED");
  });

  it("refuses another user's proposal as not found", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: "x",
      intent: "draw",
      project: { id: "new", confidence: 0.5 },
      guardrail: { action: "pass" },
      decision: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await consumeProposal(live, randomUUID(), row.id);
    expect("failure" in result && result.failure.code).toBe("NOT_FOUND");
  });
});

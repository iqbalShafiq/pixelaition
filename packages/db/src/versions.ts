import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { versions, type VersionAuthor, type VersionScope } from "./schema.js";

/** Snapshots from the same author and kind this close together replace each other. */
export const COALESCE_WINDOW_MS = 120_000;

/** Newest snapshots kept per asset; labeled snapshots always survive. */
export const RETENTION_LIMIT = 200;

export type VersionInput = {
  assetId: string;
  frameId?: string | null;
  scope: VersionScope;
  kind: string;
  author: VersionAuthor;
  runId?: string | null;
  label?: string | null;
  snapshot: unknown;
};

export type VersionRow = {
  id: string;
  assetId: string;
  frameId: string | null;
  scope: VersionScope;
  kind: string;
  author: VersionAuthor;
  runId: string | null;
  label: string | null;
  snapshot: unknown;
  createdAt: Date;
};

export type VersionCandidate = Pick<VersionRow, "id" | "label" | "createdAt">;

/**
 * An incoming snapshot joins an existing one when both come from the same
 * author on the same kind of work (same scope, same frame), the existing one
 * is younger than the window, and the existing one carries no label — a label
 * marks a snapshot worth keeping, so it is never overwritten in place.
 */
export function shouldCoalesce(
  existing: VersionRow,
  incoming: VersionInput,
  now: Date,
): boolean {
  if (existing.author !== incoming.author) return false;
  if (existing.kind !== incoming.kind) return false;
  if (existing.scope !== incoming.scope) return false;
  if (existing.frameId !== (incoming.frameId ?? null)) return false;
  if (existing.label !== null) return false;
  const elapsed = now.getTime() - existing.createdAt.getTime();
  return elapsed >= 0 && elapsed <= COALESCE_WINDOW_MS;
}

/**
 * The ids to delete so an asset keeps its newest {@link RETENTION_LIMIT}
 * snapshots. Oldest unlabeled snapshots go first; labeled snapshots are never
 * returned, so an asset can exceed the limit when old labels survive.
 */
export function pruneOrder(rows: VersionCandidate[]): string[] {
  if (rows.length <= RETENTION_LIMIT) return [];
  const newestFirst = [...rows].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const toDelete: string[] = [];
  let remaining = newestFirst.length;
  for (const row of [...newestFirst].reverse()) {
    if (remaining <= RETENTION_LIMIT) break;
    if (row.label !== null) continue;
    toDelete.push(row.id);
    remaining -= 1;
  }
  return toDelete;
}

/** Normalizes an input (with its assigned id and timestamp) into a table row. */
export function toVersionRow(
  row: VersionInput & { id: string; createdAt: Date },
): VersionRow {
  return {
    id: row.id,
    assetId: row.assetId,
    frameId: row.frameId ?? null,
    scope: row.scope,
    kind: row.kind,
    author: row.author,
    runId: row.runId ?? null,
    label: row.label ?? null,
    snapshot: row.snapshot,
    createdAt: row.createdAt,
  };
}

async function pruneVersions(db: Database, assetId: string) {
  const rows = await db
    .select({ id: versions.id, label: versions.label, createdAt: versions.createdAt })
    .from(versions)
    .where(eq(versions.assetId, assetId));
  const stale = pruneOrder(rows);
  if (stale.length > 0) await db.delete(versions).where(inArray(versions.id, stale));
}

/**
 * Records a snapshot for an asset. A recent unlabeled snapshot by the same
 * author on the same kind of work is replaced in place instead of piling up a
 * twin; every write then trims the asset back to its retention limit. Shared
 * by the API's store hooks and the worker's run terminal.
 */
export async function createVersion(db: Database, input: VersionInput) {
  const now = new Date();
  const frameId = input.frameId ?? null;
  const [existing] = await db
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.assetId, input.assetId),
        eq(versions.scope, input.scope),
        eq(versions.kind, input.kind),
        eq(versions.author, input.author),
        frameId === null ? isNull(versions.frameId) : eq(versions.frameId, frameId),
      ),
    )
    .orderBy(desc(versions.createdAt), desc(versions.id))
    .limit(1);

  if (existing && shouldCoalesce(existing, input, now)) {
    const [updated] = await db
      .update(versions)
      .set({
        snapshot: input.snapshot,
        runId: input.runId ?? existing.runId,
        label: input.label ?? existing.label,
        createdAt: now,
      })
      .where(eq(versions.id, existing.id))
      .returning();
    await pruneVersions(db, input.assetId);
    return updated;
  }

  const [inserted] = await db
    .insert(versions)
    .values(toVersionRow({ ...input, id: randomUUID(), createdAt: now }))
    .returning();
  await pruneVersions(db, input.assetId);
  return inserted;
}

import type { VersionAuthor, VersionScope } from "@pixelaition/db";

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

/**
 * The editor's follow-up queue: prompts typed while a run is working. Items
 * live in localStorage per asset, drain one by one as runs finish, and can be
 * steered into the live run immediately. Pure helpers, so the dock and the
 * editor share one model.
 */
export type QueuedRun = {
  id: string;
  text: string;
};

const QUEUE_STORAGE_PREFIX = "pixelaition.queue.";

export function queueStorageKey(assetId: string): string {
  return `${QUEUE_STORAGE_PREFIX}${assetId}`;
}

function parseItem(entry: unknown): QueuedRun | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.text !== "string" || value.text.trim().length === 0) return null;
  return { id: value.id, text: value.text };
}

export function readQueue(assetId: string): QueuedRun[] {
  try {
    const raw = localStorage.getItem(queueStorageKey(assetId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const item = parseItem(entry);
      return item === null ? [] : [item];
    });
  } catch {
    return [];
  }
}

export function writeQueue(assetId: string, items: QueuedRun[]): void {
  try {
    localStorage.setItem(queueStorageKey(assetId), JSON.stringify(items));
  } catch {
    // Storage unavailable — the in-memory queue still works this session.
  }
}

export function addQueuedRun(items: QueuedRun[], text: string): QueuedRun[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return items;
  return [...items, { id: crypto.randomUUID(), text: trimmed }];
}

export function removeQueuedRun(items: QueuedRun[], id: string): QueuedRun[] {
  return items.filter((item) => item.id !== id);
}

export function removeQueuedRuns(
  items: QueuedRun[],
  ids: ReadonlySet<string>,
): QueuedRun[] {
  return items.filter((item) => !ids.has(item.id));
}

/** Move the item at `fromIndex` to `toIndex`, both clamped to the list. */
export function reorderQueuedRun(
  items: QueuedRun[],
  fromIndex: number,
  toIndex: number,
): QueuedRun[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return items;
  next.splice(toIndex, 0, moved);
  return next;
}

/** The first item waiting to run; the auto-flush starts exactly this one. */
export function nextQueuedRun(
  items: QueuedRun[],
): { index: number; item: QueuedRun } | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item) return { index, item };
  }
  return null;
}

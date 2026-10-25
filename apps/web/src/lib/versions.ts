import { frameToBuffer, type FrameBuffer } from "@pixelaition/pixel";

/** One row from `GET /api/assets/:id/versions`, newest first. */
export type VersionRow = {
  id: string;
  assetId: string;
  frameId: string | null;
  scope: "frame" | "asset";
  kind: string;
  author: "user" | "agent";
  runId: string | null;
  label: string | null;
  snapshot: unknown;
  createdAt: string;
};

/** A frame-scoped snapshot, as the API's store hooks write it. */
export type FrameVersionSnapshot = {
  name: string;
  layers: Array<{ id: string; name: string; visible: boolean; pixels: string }>;
};

/** What the panel renders for one version; display strings resolved here. */
export type HistoryRow = {
  id: string;
  frameId: string | null;
  scope: "frame" | "asset";
  kind: string;
  kindLabel: string;
  author: "user" | "agent";
  authorLabel: string;
  label: string | null;
  runId: string | null;
  createdAt: string;
  relativeTime: string;
};

const KIND_LABELS: Record<string, string> = {
  run: "Agent run",
  edit: "Drawing",
  restore: "Restore",
  "frame-add": "Frame added",
  "frame-delete": "Frame deleted",
  "frame-move": "Frame order",
  resize: "Canvas resize",
  palette: "Palette",
  rename: "Rename",
};

/** The stored kind as a readable label; unknown kinds stay verbatim. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** A coarse "how long ago" that never needs a ticker. */
export function relativeTime(createdAt: string, now: Date = new Date()): string {
  const then = new Date(createdAt).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/**
 * The badge a version carries: user edits are `You`; an agent run names its
 * model when the run is known, and stays plain `Agent` when it is not. No
 * guessed model ever reaches the badge.
 */
export function authorLabel(
  author: "user" | "agent",
  runId: string | null,
  modelsByRunId: ReadonlyMap<string, string>,
): string {
  if (author === "user") return "You";
  const model = runId ? modelsByRunId.get(runId) : undefined;
  return model ? `Agent · ${model}` : "Agent";
}

export function toHistoryRows(
  versions: VersionRow[],
  modelsByRunId: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
): HistoryRow[] {
  return versions.map((version) => ({
    id: version.id,
    frameId: version.frameId,
    scope: version.scope,
    kind: version.kind,
    kindLabel: kindLabel(version.kind),
    author: version.author,
    authorLabel: authorLabel(version.author, version.runId, modelsByRunId),
    label: version.label,
    runId: version.runId,
    createdAt: version.createdAt,
    relativeTime: relativeTime(version.createdAt, now),
  }));
}

/** Reads a frame-scoped snapshot; null when the value is not one. */
export function frameSnapshotOf(snapshot: unknown): FrameVersionSnapshot | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const value = snapshot as { name?: unknown; layers?: unknown };
  if (typeof value.name !== "string" || !Array.isArray(value.layers)) return null;
  const layers: FrameVersionSnapshot["layers"] = [];
  for (const layer of value.layers) {
    if (typeof layer !== "object" || layer === null) return null;
    const item = layer as {
      id?: unknown;
      name?: unknown;
      visible?: unknown;
      pixels?: unknown;
    };
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.visible !== "boolean" ||
      typeof item.pixels !== "string"
    ) {
      return null;
    }
    layers.push({
      id: item.id,
      name: item.name,
      visible: item.visible,
      pixels: item.pixels,
    });
  }
  return { name: value.name, layers };
}

/**
 * A frame snapshot as the canvas buffer the preview draws. A snapshot that is
 * not a frame, or whose pixels do not fit this asset's canvas, previews as
 * nothing rather than as invented pixels.
 */
export function snapshotToBuffer(
  snapshot: unknown,
  width: number,
  height: number,
  palette: string[],
): FrameBuffer | null {
  const frame = frameSnapshotOf(snapshot);
  if (!frame) return null;
  try {
    return frameToBuffer(
      { id: "version", name: frame.name, index: 0, layers: frame.layers },
      width,
      height,
      palette,
      false,
    );
  } catch {
    return null;
  }
}

export type RunGroup = {
  runId: string;
  authorLabel: string;
  createdAt: string;
  rows: HistoryRow[];
};

/** Frame entries of the same run, folded into one group, newest run first. */
export function groupByRun(rows: HistoryRow[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const row of rows) {
    if (row.scope !== "frame" || !row.runId) continue;
    const group = groups.get(row.runId);
    if (group) {
      group.rows.push(row);
      continue;
    }
    groups.set(row.runId, {
      runId: row.runId,
      authorLabel: row.authorLabel,
      createdAt: row.createdAt,
      rows: [row],
    });
  }
  return [...groups.values()];
}

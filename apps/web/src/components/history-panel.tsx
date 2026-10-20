import type { FrameBuffer } from "@pixelaition/pixel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Eye, Pencil, Play } from "./pixel-icons.js";
import { FrameThumb } from "./editor-panels.js";
import {
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  Panel,
  useToast,
} from "./ui.js";
import { api } from "../lib/api.js";
import {
  frameSnapshotOf,
  groupByRun,
  snapshotToBuffer,
  toHistoryRows,
  type HistoryRow,
  type VersionRow,
} from "../lib/versions.js";

/** A version the editor should draw as the canvas ghost. */
export type VersionPreview = {
  versionId: string;
  frameId: string;
  buffer: FrameBuffer;
};

type Props = {
  assetId: string;
  frameId: string | null;
  palette: string[];
  width: number;
  height: number;
  /** runId → modelId, for runs this session knows the model of. */
  runModels: ReadonlyMap<string, string>;
  previewingId: string | null;
  onPreview: (preview: VersionPreview | null) => void;
  /** The server now holds restored pixels; the editor reloads its drafts. */
  onRestore: () => void;
  /** Desktop passes `min-h-0 flex-1` so only the list scrolls. */
  className?: string;
};

type VersionsResponse = { versions: VersionRow[]; nextCursor: string | null };

export function HistoryPanel({
  assetId,
  frameId,
  palette,
  width,
  height,
  runModels,
  previewingId,
  onPreview,
  onRestore,
  className = "",
}: Props) {
  const client = useQueryClient();
  const notify = useToast();
  const [tab, setTab] = useState<"frame" | "asset">("frame");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingRestore, setPendingRestore] = useState<HistoryRow | null>(null);

  const versions = useQuery({
    queryKey: ["versions", assetId],
    queryFn: () => api<VersionsResponse>(`/api/assets/${assetId}/versions?limit=100`),
  });

  const snapshots = new Map(
    (versions.data?.versions ?? []).map((version) => [version.id, version.snapshot]),
  );
  const rows = toHistoryRows(versions.data?.versions ?? [], runModels).filter((row) => {
    // Social scenes belong to the artboard inspector, not the pixel history;
    // their snapshot has no layers to preview or ghost on the sprite canvas.
    const snapshot = snapshots.get(row.id);
    return !(typeof snapshot === "object" && snapshot !== null && "social" in snapshot);
  });
  const frameRows = rows.filter(
    (row) => row.scope === "frame" && row.frameId === frameId,
  );
  const assetRows = rows.filter((row) => row.scope === "asset");
  const runGroups = groupByRun(rows);

  const label = useMutation({
    mutationFn: (input: { versionId: string; value: string | null }) =>
      api(`/api/assets/${assetId}/versions/${input.versionId}`, {
        method: "PATCH",
        body: JSON.stringify({ label: input.value }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["versions", assetId] });
    },
    onError: (reason: unknown) => {
      notify({
        title: "The label did not save",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    },
  });

  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api(`/api/assets/${assetId}/versions/${versionId}/restore`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      notify({ title: "Version restored" });
      onPreview(null);
      onRestore();
      void client.invalidateQueries({ queryKey: ["versions", assetId] });
    },
    onError: (reason: unknown) => {
      notify({
        title: "The restore did not run",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    },
  });

  function commitEdit() {
    const row = rows.find((item) => item.id === editingId);
    const next = draft.trim();
    if (row && next !== (row.label ?? "")) {
      label.mutate({ versionId: row.id, value: next || null });
    }
    setEditingId(null);
  }

  function startEdit(row: HistoryRow) {
    setEditingId(row.id);
    setDraft(row.label ?? "");
  }

  function preview(row: HistoryRow) {
    if (previewingId === row.id) {
      onPreview(null);
      return;
    }
    if (!row.frameId) return;
    const buffer = snapshotToBuffer(snapshots.get(row.id), width, height, palette);
    if (!buffer) {
      notify({
        title: "This version cannot be previewed",
        description: "Its snapshot is not a frame that fits this canvas.",
      });
      return;
    }
    onPreview({ versionId: row.id, frameId: row.frameId, buffer });
  }

  function entry(row: HistoryRow) {
    return (
      <VersionEntry
        key={row.id}
        row={row}
        snapshot={frameSnapshotOf(snapshots.get(row.id))}
        palette={palette}
        width={width}
        height={height}
        previewing={previewingId === row.id}
        editing={editingId === row.id}
        draft={draft}
        busy={restore.isPending || label.isPending}
        onDraft={setDraft}
        onCommitEdit={commitEdit}
        onCancelEdit={() => setEditingId(null)}
        onStartEdit={() => startEdit(row)}
        onPreview={() => preview(row)}
        onRestore={() => setPendingRestore(row)}
      />
    );
  }

  return (
    <Panel
      title="History"
      className={className}
      action={
        <span className="text-pixel-mono text-muted">
          {versions.isPending ? "…" : rows.length}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div
          role="tablist"
          aria-label="History scope"
          className="grid grid-cols-2 border-2 border-line"
        >
          {(["frame", "asset"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`px-2 py-1.5 text-pixel-mono uppercase tracking-[0.14em] transition-colors duration-150 ${
                tab === value
                  ? "bg-accent text-coffee"
                  : "text-muted hover:bg-raised hover:text-ink"
              }`}
            >
              {value === "frame" ? "Frame" : "Asset"}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {versions.isError ? (
            <EmptyState
              title="History unavailable"
              body={
                versions.error instanceof Error
                  ? versions.error.message
                  : "The versions could not be loaded."
              }
            />
          ) : tab === "frame" ? (
            frameId === null ? (
              <EmptyState
                title="No frame selected"
                body="Pick a frame to see its timeline."
              />
            ) : frameRows.length === 0 ? (
              <EmptyState
                title="No versions yet"
                body="Edits, runs, and restores on this frame will land here."
              />
            ) : (
              <ul className="grid gap-1">{frameRows.map(entry)}</ul>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              title="No versions yet"
              body="Every change to this asset lands here, newest first."
            />
          ) : (
            <div className="grid gap-3">
              {runGroups.map((group) => (
                <section key={group.runId} className="grid gap-1">
                  <header className="flex items-baseline justify-between gap-2 border-b-2 border-line pb-1">
                    <span className="truncate text-pixel-mono uppercase tracking-[0.14em] text-accent">
                      {group.authorLabel}
                    </span>
                    <span className="shrink-0 text-pixel-mono text-muted">
                      {group.rows.length} frame{group.rows.length === 1 ? "" : "s"}
                    </span>
                  </header>
                  <ul className="grid gap-1">{group.rows.map(entry)}</ul>
                </section>
              ))}
              {assetRows.length > 0 ? (
                <section className="grid gap-1">
                  <header className="flex items-baseline justify-between gap-2 border-b-2 border-line pb-1">
                    <span className="text-pixel-mono uppercase tracking-[0.14em] text-muted">
                      Asset
                    </span>
                  </header>
                  <ul className="grid gap-1">{assetRows.map(entry)}</ul>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRestore(null);
        }}
        title="Restore this version?"
        description={
          pendingRestore
            ? `“${pendingRestore.label ?? pendingRestore.kindLabel}” from ${pendingRestore.relativeTime} replaces the current ${
                pendingRestore.scope === "frame" ? "frame" : "asset"
              } and is recorded as a new restore entry.`
            : ""
        }
        confirmLabel="Restore"
        onConfirm={() => {
          if (pendingRestore) restore.mutate(pendingRestore.id);
          setPendingRestore(null);
        }}
      />
    </Panel>
  );
}

function VersionEntry({
  row,
  snapshot,
  palette,
  width,
  height,
  previewing,
  editing,
  draft,
  busy,
  onDraft,
  onCommitEdit,
  onCancelEdit,
  onStartEdit,
  onPreview,
  onRestore,
}: {
  row: HistoryRow;
  snapshot: ReturnType<typeof frameSnapshotOf>;
  palette: string[];
  width: number;
  height: number;
  previewing: boolean;
  editing: boolean;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: () => void;
  onPreview: () => void;
  onRestore: () => void;
}) {
  return (
    <li
      className={`relative flex min-w-0 items-start gap-2 border-2 px-2 py-1.5 transition-colors duration-150 ${
        previewing
          ? "border-accent bg-raised"
          : "border-transparent hover:border-line hover:bg-raised"
      }`}
    >
      {snapshot ? (
        <FrameThumb
          frame={{ id: row.id, name: snapshot.name, index: 0, layers: snapshot.layers }}
          palette={palette}
          width={width}
          height={height}
          size={32}
        />
      ) : (
        <span
          aria-hidden
          className="dither-sm h-8 w-8 shrink-0 border-2 border-line bg-screen"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-pixel-mono tracking-[0.14em] text-muted uppercase">
          {row.kindLabel}
        </p>
        {editing ? (
          <input
            autoFocus
            value={draft}
            aria-label="Version label"
            placeholder="Add a label"
            className="mt-0.5 h-5 w-full min-w-0 border-0 bg-transparent p-0 text-[13px] text-ink outline-none placeholder:text-muted"
            onChange={(event) => onDraft(event.target.value)}
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") onCancelEdit();
            }}
          />
        ) : row.label ? (
          <p className="mt-0.5 truncate text-[13px] leading-5 text-ink">{row.label}</p>
        ) : null}
        <p className="mt-0.5 truncate text-[12px] text-muted">
          {row.authorLabel} · {row.relativeTime}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-0.5">
        <AnimatePresence initial={false} mode="popLayout">
          {editing ? (
            <motion.span
              key="save"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.12 }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <IconButton
                label={`Save label for ${row.kindLabel}`}
                onClick={onCommitEdit}
              >
                <Check />
              </IconButton>
            </motion.span>
          ) : (
            <motion.span
              key="actions"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.12 }}
              className="flex items-center gap-0.5"
            >
              <IconButton
                label={
                  previewing
                    ? `Stop previewing ${row.kindLabel}`
                    : `Preview ${row.kindLabel}`
                }
                hint="Onion diff over the current frame"
                subtle
                active={previewing}
                disabled={!snapshot}
                onClick={onPreview}
              >
                <Eye />
              </IconButton>
              <IconButton label={`Label ${row.kindLabel}`} onClick={onStartEdit}>
                <Pencil />
              </IconButton>
              <Menu label={`Actions for ${row.kindLabel} · ${row.relativeTime}`}>
                <MenuItem disabled={busy} onClick={onRestore}>
                  <Play /> Restore
                </MenuItem>
              </Menu>
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </li>
  );
}

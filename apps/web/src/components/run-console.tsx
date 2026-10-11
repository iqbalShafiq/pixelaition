import { StreamMarkdown } from "@anvia/react-ui/stream";
import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  Clipboard,
  Close,
  Eye,
  Flip,
  Folder,
  Palette,
  Pencil,
  Play,
  Select,
  Square,
  Wrench,
  type IconProps,
} from "./pixel-icons.js";
import { formatDuration, type RunRow } from "../lib/run-activity.js";

const toolIcons: Record<string, ComponentType<IconProps>> = {
  paint_stroke: Pencil,
  fill_rect: Square,
  set_palette: Palette,
  read_frame: Eye,
  read_region: Select,
  preview_frame: Eye,
  read_project: Folder,
  critique_frame: Clipboard,
  check_animation: Play,
  mirror_frame: Flip,
};

/** One earlier run, kept small: what was asked and what came back. */
export type HistoryRun = {
  id: string;
  status: string;
  prompt: string | null;
  answer: string | null;
  durationMs: number | null;
};

/**
 * The agent's work, one honest row at a time. Encrypted reasoning shows as a
 * timed phase; nothing is invented here.
 */
export function RunConsole({
  rows,
  running,
  open,
  onOpen,
  message,
  prompt = "",
  history = [],
  restoredMs = null,
}: {
  rows: RunRow[];
  running: boolean;
  open: boolean;
  onOpen: (next: boolean) => void;
  message: string;
  prompt?: string;
  history?: HistoryRun[];
  restoredMs?: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastRunMs, setLastRunMs] = useState<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setLastRunMs(null);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - (startedAt.current ?? Date.now()));
    }, 500);
    return () => {
      if (startedAt.current !== null) setLastRunMs(Date.now() - startedAt.current);
      window.clearInterval(timer);
    };
  }, [running]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows, follow, message]);

  const steps = rows.length;
  const lastStatus = [...rows].reverse().find((row) => row.kind === "status");
  const stateLabel = lastStatus?.kind === "status" ? lastStatus.label : "finished";
  const durationMs = running ? elapsed : (lastRunMs ?? restoredMs);
  const empty = !running && rows.length === 0 && !message && history.length === 0;
  const summary = running
    ? `working · ${formatDuration(elapsed)}`
    : empty
      ? "no activity yet"
      : steps === 0
        ? `${history.length} earlier run${history.length === 1 ? "" : "s"}`
        : `${steps} step${steps === 1 ? "" : "s"} · ${stateLabel}${
            durationMs !== null ? ` in ${formatDuration(durationMs)}` : ""
          }`;

  const rowIcon = (row: RunRow) => {
    if (row.kind === "phase") {
      return <Brain width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "tool") {
      const Icon = toolIcons[row.name] ?? Wrench;
      return (
        <Icon
          width={12}
          height={12}
          className={row.state === "error" ? "text-erase" : "text-muted"}
        />
      );
    }
    if (row.state === "completed")
      return <Check width={12} height={12} className="text-accent" />;
    if (row.state === "failed" || row.state === "cancelled") {
      return <Close width={12} height={12} className="text-erase" />;
    }
    return <span className="mt-[3px] inline-block h-1.5 w-1.5 animate-pulse bg-accent" />;
  };

  return (
    <section
      aria-label="Agent activity"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-panel"
      style={{ maxWidth: "40rem" }}
    >
      <button
        type="button"
        onClick={empty ? undefined : () => onOpen(!open)}
        disabled={empty}
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-pixel-mono tracking-[0.16em] text-muted uppercase ${
          empty ? "cursor-default" : "hover:text-ink"
        }`}
      >
        <span className={running ? "text-accent" : ""}>agent</span>
        <span>{summary}</span>
        {empty ? null : <span className="ml-auto">{open ? "▾" : "▴"}</span>}
      </button>
      {open && !empty ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-40 overflow-auto border-t-2 border-line p-2"
          aria-live="polite"
        >
          {prompt ? (
            <div className="mb-2 border-b-2 border-line pb-2">
              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                you
              </p>
              <p className="mt-1 text-pixel-body whitespace-pre-wrap text-ink">
                {prompt}
              </p>
            </div>
          ) : null}
          <ul className="grid gap-1">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-1.5 text-pixel-mono text-muted"
              >
                <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                  {rowIcon(row)}
                </span>
                {row.kind === "phase" ? (
                  <span className={row.state === "running" ? "text-ink" : ""}>
                    {row.label}
                    {row.state === "running" ? "…" : ""}
                  </span>
                ) : row.kind === "tool" ? (
                  <span className={row.state === "error" ? "text-erase" : "text-ink"}>
                    {row.name}
                    {row.summary ? ` · ${row.summary}` : ""}
                    {row.detail ? ` — ${row.detail}` : ""}
                  </span>
                ) : (
                  <span className={row.state === "failed" ? "text-erase" : "text-ink"}>
                    {row.label}
                    {row.detail ? ` — ${row.detail}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {message ? (
            <div className="mt-2 border-t-2 border-line pt-2 text-pixel-body text-ink">
              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                agent
              </p>
              <div className="mt-1">
                <StreamMarkdown content={message} />
              </div>
            </div>
          ) : null}
          {history.length > 0 ? (
            <div className="mt-2 border-t-2 border-line pt-2">
              <p className="text-pixel-mono tracking-[0.16em] text-muted uppercase">
                earlier
              </p>
              <ul className="mt-1 grid gap-1.5">
                {history.map((item) => (
                  <li key={item.id} className="text-pixel-mono">
                    <p className="truncate text-muted" title={item.prompt ?? ""}>
                      <span className="text-accent">you</span> {item.prompt ?? "—"}
                    </p>
                    <p className="truncate text-ink" title={item.answer ?? ""}>
                      <span className="text-accent">agent</span>{" "}
                      {item.answer ?? item.status}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

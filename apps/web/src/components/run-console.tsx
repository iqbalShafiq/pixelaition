import { StreamMarkdown } from "@anvia/react-ui/stream";
import { useEffect, useRef, useState } from "react";
import { formatDuration, type RunRow } from "../lib/run-activity.js";

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
}: {
  rows: RunRow[];
  running: boolean;
  open: boolean;
  onOpen: (next: boolean) => void;
  message: string;
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
  const summary = running
    ? `working · ${formatDuration(elapsed)}`
    : `${steps} steps · ${stateLabel}${lastRunMs !== null ? ` in ${formatDuration(lastRunMs)}` : ""}`;

  return (
    <section
      aria-label="Agent activity"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-panel"
      style={{ maxWidth: "40rem" }}
    >
      <button
        type="button"
        onClick={() => onOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[10px] tracking-[0.16em] text-muted uppercase hover:text-ink"
      >
        <span className={running ? "text-accent" : ""}>agent</span>
        <span>{summary}</span>
        <span className="ml-auto">{open ? "▾" : "▴"}</span>
      </button>
      {open ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-64 min-h-24 overflow-auto border-t-2 border-line p-2"
          aria-live="polite"
        >
          <ul className="grid gap-1">
            {rows.map((row) => (
              <li key={row.id} className="font-mono text-[10px] text-muted">
                {row.kind === "phase" ? (
                  <span>
                    {row.state === "running" ? "…" : "✓"} {row.label}
                  </span>
                ) : row.kind === "tool" ? (
                  <span className={row.state === "error" ? "text-erase" : "text-ink"}>
                    {row.state === "error" ? "✕" : row.state === "ok" ? "✓" : "…"}{" "}
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
            <div className="mt-2 border-t-2 border-line pt-2 text-xs text-ink">
              <StreamMarkdown content={message} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

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
  const startedAt = useRef<number>(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) startedAt.current = Date.now();
  }, [running]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows, follow, message]);

  const steps = rows.length;
  const summary = running
    ? `working · ${formatDuration(now - startedAt.current)}`
    : `${steps} steps · finished`;

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

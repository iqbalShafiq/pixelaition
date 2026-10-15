import { Link } from "@tanstack/react-router";
import { Card, ScrollArea } from "./ui.js";

export type RecentRunRailRow = {
  id: string;
  status: string;
  prompt: string | null;
  createdAt: string;
  assetId?: string;
  projectId?: string;
  assetName?: string;
};

function runStatusTone(status: string): string {
  if (status === "succeeded" || status === "completed" || status === "waiting") {
    return "text-accent";
  }
  if (status === "failed" || status === "cancelled") return "text-erase";
  return "text-muted";
}

/**
 * Compact relative time for an activity list ("3m ago"); the exact timestamp
 * stays on the title so nothing is lost. Falls back to the locale date once a
 * run is older than a week.
 */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Recent runs live in the home's right rail: a compact list that keeps every
 * finished run one click from its editor instead of crowding the page. Every
 * row is width-contained (`min-w-0` on the whole chain) so a long prompt
 * truncates instead of stretching the rail and the page sideways.
 */
export function RecentRunsRail({ runs }: { runs: RecentRunRailRow[] }) {
  return (
    <Card className="grid min-w-0 gap-2 overflow-hidden">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-pixel-title text-ink">Recent runs</h2>
        <span className="text-pixel-mono text-muted">
          {runs.length.toString().padStart(2, "0")}
        </span>
      </header>
      {runs.length === 0 ? (
        <p className="text-pixel-mono text-muted">nothing yet</p>
      ) : (
        <ScrollArea className="max-h-[22rem]">
          <ul className="grid min-w-0 gap-1.5 pr-1">
            {runs.map((run) => (
              <li
                key={run.id}
                className="grid min-w-0 gap-1 border-2 border-line bg-field px-2 py-1.5"
              >
                <p
                  className="line-clamp-2 min-w-0 text-pixel-label leading-snug text-ink"
                  title={run.prompt ?? undefined}
                >
                  {run.prompt ?? "(no prompt)"}
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-pixel-mono">
                  <span className={runStatusTone(run.status)}>{run.status}</span>
                  <span
                    className="text-muted"
                    title={new Date(run.createdAt).toLocaleString()}
                  >
                    {timeAgo(run.createdAt)}
                  </span>
                  {run.assetId !== undefined && run.projectId !== undefined ? (
                    <Link
                      to="/projects/$projectId/assets/$assetId"
                      params={{ projectId: run.projectId, assetId: run.assetId }}
                      className="min-w-0 max-w-full truncate text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      Open {run.assetName ?? "asset"}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Card>
  );
}

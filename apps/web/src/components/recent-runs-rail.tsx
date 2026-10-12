import { Link } from "@tanstack/react-router";
import { Card } from "./ui.js";

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
 * Recent runs live in the home's right rail: a compact list that keeps every
 * finished run one click from its editor instead of crowding the page.
 */
export function RecentRunsRail({ runs }: { runs: RecentRunRailRow[] }) {
  return (
    <Card className="grid gap-2">
      <header className="flex items-center justify-between">
        <h2 className="text-pixel-label text-accent">recent runs</h2>
        <span className="text-pixel-mono text-muted">{runs.length}</span>
      </header>
      {runs.length === 0 ? (
        <p className="text-pixel-mono text-muted">nothing yet</p>
      ) : (
        <ul className="grid gap-1.5">
          {runs.map((run) => (
            <li key={run.id} className="border-2 border-line bg-field px-2 py-1.5">
              <p className="truncate text-[13px] text-ink">
                {run.prompt ?? "(no prompt)"}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-pixel-mono">
                <span className={runStatusTone(run.status)}>{run.status}</span>
                <span className="text-muted">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
                {run.assetId !== undefined && run.projectId !== undefined ? (
                  <Link
                    to="/projects/$projectId/assets/$assetId"
                    params={{ projectId: run.projectId, assetId: run.assetId }}
                    className="text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    Open {run.assetName ?? "asset"}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

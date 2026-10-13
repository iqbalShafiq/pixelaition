import { agentLabel } from "../lib/agent-label.js";
import type { TaskWorkerState } from "../lib/task.js";

/**
 * The questions waiting for the user, one row per worker. Clicking a row
 * jumps to that worker's frame, where the question card is rendered.
 */
export function QuestionSummary({
  workers,
  onJump,
}: {
  workers: TaskWorkerState[];
  onJump: (frameId: string) => void;
}) {
  const waiting = workers.filter((worker) => worker.pendingInteraction !== undefined);
  if (waiting.length === 0) return null;
  return (
    <section
      aria-label="Questions waiting"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-accent bg-panel"
    >
      <header className="flex items-center gap-2 border-b-2 border-line px-2 py-1.5 text-pixel-mono tracking-[0.16em] text-accent uppercase">
        <span className="ask-pulse h-2 w-2 bg-accent" />
        {waiting.length} question{waiting.length === 1 ? "" : "s"} waiting
      </header>
      <ul className="grid gap-1 p-1.5">
        {waiting.map((worker) => {
          const frame = worker.frames[0];
          // An approval carries no questions; a question does. Both wait on
          // the user, so the row names whichever it is.
          const interaction = worker.pendingInteraction;
          const question = interaction?.questions?.[0];
          const label =
            question?.text ??
            (interaction?.type === "tool-approval"
              ? `needs your approval${interaction.toolName !== undefined ? ` · ${interaction.toolName}` : ""}`
              : "needs your answer");
          return (
            <li key={worker.key}>
              <button
                type="button"
                disabled={frame === undefined}
                onClick={() => {
                  if (frame !== undefined) onJump(frame.id);
                }}
                className="flex w-full items-center gap-2 border-2 border-line bg-field px-2 py-1.5 text-left text-pixel-mono text-ink transition-colors duration-150 hover:border-line-strong disabled:opacity-60"
              >
                <span className="text-accent">{agentLabel(worker.key)}</span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {frame !== undefined ? (
                  <span className="shrink-0 text-muted">{frame.name}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

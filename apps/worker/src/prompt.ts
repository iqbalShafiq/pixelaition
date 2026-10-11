/** One finished run, reduced to what the history block carries. */
export type RecentRun = { prompt: string | null; answer: string | null };

/** Each side of a history line is capped so old runs cannot crowd the prompt. */
const HISTORY_SIDE_LIMIT = 200;

/**
 * The prompt the drawing agent receives: the user's words, the asset's style
 * and origin frame, and the last finished runs on the asset so a follow-up can
 * build on what already happened. The history block is omitted when no run has
 * finished; there is nothing to say.
 */
export function buildRunPrompt(input: {
  prompt: string;
  style: unknown;
  frameName: string;
  recent: RecentRun[];
}): string {
  const base = `${input.prompt}\nStyle: ${JSON.stringify(input.style)}\nFrame: ${input.frameName}`;
  if (input.recent.length === 0) return base;
  const history = input.recent
    .map(
      (run) =>
        `${(run.prompt ?? "").slice(0, HISTORY_SIDE_LIMIT)} → ${(run.answer ?? "").slice(0, HISTORY_SIDE_LIMIT)}`,
    )
    .join("\n");
  return `${base}\nRecent runs:\n${history}`;
}

/** One finished run, reduced to what the history block carries. */
export type RecentRun = { prompt: string | null; answer: string | null };

/** Each side of a history line is capped so old runs cannot crowd the prompt. */
const HISTORY_SIDE_LIMIT = 200;

/**
 * The prompt the drawing agent receives: the user's words, the scope's style
 * and, for an asset run, the origin frame, plus the last finished runs in the
 * scope so a follow-up can build on what already happened. A workspace run has
 * no frame yet, so its line is omitted; the history block is omitted when no
 * run has finished, because there is nothing to say.
 */
export function buildRunPrompt(input: {
  prompt: string;
  style: unknown;
  frameName?: string;
  recent: RecentRun[];
}): string {
  const base = input.frameName
    ? `${input.prompt}\nStyle: ${JSON.stringify(input.style)}\nFrame: ${input.frameName}`
    : `${input.prompt}\nStyle: ${JSON.stringify(input.style)}`;
  if (input.recent.length === 0) return base;
  const history = input.recent
    .map(
      (run) =>
        `${(run.prompt ?? "").slice(0, HISTORY_SIDE_LIMIT)} → ${(run.answer ?? "").slice(0, HISTORY_SIDE_LIMIT)}`,
    )
    .join("\n");
  return `${base}\nRecent runs:\n${history}`;
}

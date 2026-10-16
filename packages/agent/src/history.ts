import { userRequestFromPrompt } from "./tasks/asset-draw.js";

/** The slice of a stored run a thread-history reader needs. */
export type ThreadRunRow = {
  role: string | null;
  prompt: string | null;
  answer: string | null;
};

/** One user turn recovered from the run log, in the order it happened. */
export type UserTurn = { prompt: string; answer?: string };

/**
 * The turns a person would recognise from a thread's run log, oldest first.
 * A role-null run's prompt is the user's own message; a plan run's prompt
 * embeds it and `userRequestFromPrompt` recovers it. Supervisor, worker,
 * review, and fix prompts are the machinery of an earlier drawing task —
 * reading them as conversation hides the user's words, which once turned an
 * edit request into a read-only ask.
 *
 * Rows arrive newest first (the way the queries order them) and turns leave
 * oldest first (the way a conversation reads).
 */
export function userTurnsFromRuns(rows: ThreadRunRow[], limit: number): UserTurn[] {
  const turns: UserTurn[] = [];
  for (const row of rows) {
    if (row.role !== null && row.role !== "plan") continue;
    const request =
      row.role === "plan"
        ? userRequestFromPrompt(row.role, row.prompt)
        : (row.prompt?.trim() ?? null);
    if (request === null || request.length === 0) continue;
    turns.push({
      prompt: request,
      ...(row.answer !== null && row.answer.length > 0 ? { answer: row.answer } : {}),
    });
    if (turns.length >= limit) break;
  }
  return turns.reverse();
}

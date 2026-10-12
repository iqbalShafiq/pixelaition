/** One finished run, reduced to what the history block carries. */
export type RecentRun = { prompt: string | null; answer: string | null };

/** Each side of a history line is capped so old runs cannot crowd the prompt. */
const HISTORY_SIDE_LIMIT = 200;

/**
 * The prompt the drawing agent receives: the user's words, the scope's style
 * and, for an asset run, the frame it draws on plus the whole frame list and
 * palette, so variants and recolors need no extra reads. Reference images that
 * ride with the message are counted so the model looks at them, and the last
 * finished runs in the scope follow so a follow-up can build on what already
 * happened. A workspace run has no frame yet, so its lines are omitted; every
 * block is omitted when empty, because there is nothing to say.
 */
export function buildRunPrompt(input: {
  prompt: string;
  style: unknown;
  frameName?: string;
  frames?: Array<{ name: string; current: boolean }>;
  palette?: string[];
  attachments?: number;
  recent: RecentRun[];
}): string {
  const lines = [input.prompt, `Style: ${JSON.stringify(input.style)}`];
  if (input.frameName !== undefined) lines.push(`Frame: ${input.frameName}`);
  if (input.frames !== undefined && input.frames.length > 0) {
    lines.push(
      `Frames: ${input.frames
        .map((frame) => (frame.current ? `${frame.name}*` : frame.name))
        .join(", ")} (* = current)`,
    );
  }
  if (input.palette !== undefined && input.palette.length > 0) {
    lines.push(`Palette: ${input.palette.join(", ")}`);
  }
  if (input.attachments !== undefined && input.attachments > 0) {
    lines.push(
      `Attachments: ${input.attachments} reference image${input.attachments === 1 ? "" : "s"} with this message — look at them before drawing.`,
    );
  }
  if (input.recent.length > 0) {
    const history = input.recent
      .map(
        (run) =>
          `${(run.prompt ?? "").slice(0, HISTORY_SIDE_LIMIT)} → ${(run.answer ?? "").slice(0, HISTORY_SIDE_LIMIT)}`,
      )
      .join("\n");
    lines.push("Recent runs:", history);
  }
  return lines.join("\n");
}

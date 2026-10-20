import { defaultStyle, type StyleGuide } from "@pixelaition/pixel";

/** One finished run, reduced to what the history block carries. */
export type RecentRun = { prompt: string | null; answer: string | null };

/**
 * The style line the run prompts carry: the StyleGuide fields only, so a
 * stale `maxColors` key from an older row never reaches a prompt.
 */
export function styleLine(style: unknown): string {
  const value = (style as StyleGuide | undefined) ?? defaultStyle;
  return JSON.stringify({
    defaultWidth: value.defaultWidth,
    defaultHeight: value.defaultHeight,
    outline: value.outline,
    shadowDirection: value.shadowDirection,
    notes: value.notes,
  });
}

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
  frames?: Array<{
    name: string;
    current: boolean;
    kind?: "sprite" | "social";
    presetId?: string | null;
  }>;
  palette?: string[];
  attachments?: number;
  projectSummary?: string;
  assetSummary?: string;
  frameSummary?: string;
  recent: RecentRun[];
}): string {
  const lines = [input.prompt, `Style: ${styleLine(input.style)}`];
  if (input.frameName !== undefined) lines.push(`Frame: ${input.frameName}`);
  if (input.projectSummary !== undefined && input.projectSummary.length > 0) {
    lines.push(`Project: ${input.projectSummary}`);
  }
  if (input.assetSummary !== undefined && input.assetSummary.length > 0) {
    lines.push(`Asset: ${input.assetSummary}`);
  }
  if (input.frameSummary !== undefined && input.frameSummary.length > 0) {
    lines.push(`Frame summary: ${input.frameSummary}`);
  }
  if (input.frames !== undefined && input.frames.length > 0) {
    lines.push(
      `Frames: ${input.frames
        .map(
          (frame) =>
            `${frame.name}${frame.current ? "*" : ""}${
              frame.kind === "social" ? ` [social ${frame.presetId ?? "artboard"}]` : ""
            }`,
        )
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

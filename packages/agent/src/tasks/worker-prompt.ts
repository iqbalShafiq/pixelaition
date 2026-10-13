/**
 * The prompt a worker receives. Task code assembles it from the validated
 * plan — the supervisor never writes free-form worker instructions — so every
 * worker sees the same shape of context: the request, the asset, its own
 * frames with the layers they must paint, the read-only neighbours, and the
 * references it may look at.
 */
export type WorkerPromptInput = {
  request: string;
  projectName: string;
  projectSummary?: string;
  assetName: string;
  assetSummary?: string;
  width: number;
  height: number;
  paletteSize: number;
  styleLines: string[];
  ownedFrames: Array<{ name: string; intent: string; layers: string[] }>;
  readOnlyFrames: string[];
  references: Array<{ url: string; note: string }>;
  attachments: number;
};

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const lines = [
    `Request: ${input.request}`,
    `Project: ${input.projectName}${input.projectSummary ? ` — ${input.projectSummary}` : ""}`,
    `Asset: ${input.assetName}${input.assetSummary ? ` — ${input.assetSummary}` : ""}`,
    `Canvas: ${input.width}×${input.height}. Palette: ${input.paletteSize} colours.`,
    `Style: ${input.styleLines.join("; ")}.`,
    "Paint only these frames, on the layers named for each:",
    ...input.ownedFrames.map(
      (frame) => `- ${frame.name}: ${frame.intent}. Layers: ${frame.layers.join(", ")}.`,
    ),
  ];
  if (input.readOnlyFrames.length > 0) {
    lines.push(
      `These frames are read-only for reference (never edit): ${input.readOnlyFrames.join(", ")}.`,
    );
  }
  if (input.references.length > 0) {
    lines.push("References you may view_image:");
    for (const reference of input.references) {
      lines.push(`- ${reference.url}${reference.note ? ` — ${reference.note}` : ""}`);
    }
  }
  lines.push(
    "The palette already carries every colour you need; do not add palette colours.",
    "Every frame you own must end with a clean critique and matching outlines across the frames you paint.",
  );
  if (input.attachments > 0) {
    lines.push(
      `The user attached ${input.attachments} reference image${input.attachments === 1 ? "" : "s"}; draw what they show within the palette.`,
    );
  }
  return lines.join("\n");
}

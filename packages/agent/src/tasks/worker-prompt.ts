import type { StyleGuide } from "@pixelaition/pixel";
import type { DrawPlan } from "./plan.js";

/**
 * The prompt a worker receives. Task code assembles it from the validated
 * plan — the supervisor never writes free-form worker instructions — so every
 * worker sees the same shape of context: the request, the asset, its own
 * frames with the layers they must paint, the read-only neighbours, the
 * palette it paints with, the plan it works under, and the sibling assets of
 * its project for style. Pixels never ride here: a role that wants them calls
 * read_frame, read_region or copy_region with the frame it needs.
 */
export type ProjectAssetBrief = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  summary: string;
  frames: string[];
};

export type WorkerPromptInput = {
  request: string;
  projectName: string;
  projectSummary?: string;
  assetId?: string;
  assetName: string;
  assetSummary?: string;
  width: number;
  height: number;
  /** How many colours the palette holds, for the one-line canvas summary. */
  paletteSize: number;
  /** The palette itself, as index:hex, so index 3 never has to be guessed. */
  palette?: readonly string[];
  /** The project's style guide, as the one-line summary prompts carry. */
  style?: StyleGuide;
  styleLines: string[];
  /** Every frame of this asset, in index order. */
  frames?: readonly string[];
  ownedFrames: Array<{
    name: string;
    intent: string;
    width?: number;
    height?: number;
    layers: string[];
  }>;
  readOnlyFrames: string[];
  /** Other assets in the same project, read-only evidence for style. */
  projectAssets?: ProjectAssetBrief[];
  /** The approved plan, so a worker knows what the other frames are for. */
  plan?: DrawPlan;
  references: Array<{ url: string; note: string }>;
  attachments: number;
};

/** `index:hex` pairs, the form a palette legend takes in every prompt. */
export function paletteLegend(palette: readonly string[]): string {
  return palette.map((hex, index) => `${index}:${hex}`).join(" ");
}

const DEFAULT_STYLE = {
  defaultWidth: 32,
  defaultHeight: 32,
  outline: "#0b0906",
  shadowDirection: "down",
  notes: "",
};

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const outline = input.style?.outline ?? DEFAULT_STYLE.outline;
  const palette = input.palette ?? [];
  const outlineNote = palette.some((hex) => hex.toLowerCase() === outline.toLowerCase())
    ? `Outline colour ${outline} is in this palette; pass it as hex.`
    : `The style guide's outline colour ${outline} is not a swatch; pass it as hex anyway, or pick a dark swatch.`;
  const lines = [
    `Request: ${input.request}`,
    `Project: ${input.projectName}${input.projectSummary ? ` — ${input.projectSummary}` : ""}`,
    `Asset: ${input.assetName}${input.assetId ? ` [${input.assetId}]` : ""}${input.assetSummary ? ` — ${input.assetSummary}` : ""}`,
    `Canvas: ${input.width}×${input.height}. Palette (${input.paletteSize} colours)${
      palette.length > 0 ? `: ${paletteLegend(palette)}` : ""
    }.`,
    `Style: ${input.styleLines.join("; ")}. ${outlineNote}`,
  ];
  if ((input.frames ?? []).length > 0) {
    lines.push(`This asset's frames: ${(input.frames ?? []).join(", ")}.`);
  }
  if (input.plan !== undefined) {
    lines.push(
      `Plan: ${JSON.stringify(
        input.plan.frames.map((frame) => ({
          name: frame.name,
          intent: frame.intent,
          width: frame.width,
          height: frame.height,
          layers: frame.layers,
        })),
      )}`,
    );
  }
  lines.push(
    "Paint only these frames, on the layers named for each:",
    ...input.ownedFrames.map(
      (frame) =>
        `- ${frame.name}${frame.width !== undefined && frame.height !== undefined ? ` (${frame.width}×${frame.height})` : ""}: ${frame.intent}. Layers: ${frame.layers.join(", ")}.`,
    ),
  );
  if (input.readOnlyFrames.length > 0) {
    lines.push(
      `These frames are read-only for reference (look, and copy from them; never edit): ${input.readOnlyFrames.join(", ")}.`,
    );
  }
  const projectAssets = input.projectAssets ?? [];
  if (projectAssets.length > 0) {
    lines.push(
      "Other assets in this project — same style family, read-only. Read or preview any frame with its assetId:",
      ...projectAssets.map(
        (asset) =>
          `- ${asset.name} [${asset.id}] ${asset.width}×${asset.height}: ${asset.frames.join(", ")}${asset.summary.length > 0 ? ` — ${asset.summary}` : ""}`,
      ),
    );
  }
  if (input.references.length > 0) {
    lines.push("References you may view_image:");
    for (const reference of input.references) {
      lines.push(`- ${reference.url}${reference.note ? ` — ${reference.note}` : ""}`);
    }
  }
  lines.push(
    "The palette already carries every colour you need; you cannot change it.",
    "Paint the frames you own, then save_frame and stop. Do not call critique_frame or check_animation, and do not shift or redraw finished pixels to chase a margin. The reviewer checks the work. End with one sentence.",
  );
  if (input.attachments > 0) {
    lines.push(
      `The user attached ${input.attachments} reference image${input.attachments === 1 ? "" : "s"}; draw what they show within the palette.`,
    );
  }
  return lines.join("\n");
}

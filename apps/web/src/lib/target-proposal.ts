/**
 * The home's confirmation payload: the app composes it from the card's state
 * and the API validates it again. Names travel only for entities that are
 * about to be created; agent mode defers the asset entirely.
 */

export type TargetProposal = {
  intent: "draw" | "edit" | "variant" | "ask";
  project: { id: string; name?: string; confidence: number };
  asset?: { id: string; name?: string; confidence: number };
  reason?: string;
};

export type ConfirmChoice = {
  projectId: string | "new";
  assetId?: string | "new" | null;
  projectName?: string;
  assetName?: string;
  mode: "generate" | "agent";
};

/**
 * A starting name for a new asset, taken from the request: the words after
 * "named"/"bernama"/"called" (quoted or not), else the first quoted phrase.
 * It is a suggestion the user edits, never a decision. The field used to
 * show "hero" as a placeholder, which read as a filled-in name.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "with",
  "and",
  "dan",
  "yang",
  "please",
  "tolong",
  "buat",
  "in",
  "di",
  "to",
  "untuk",
  "of",
  "dari",
  "pakai",
  "dengan",
]);

export function suggestName(request: string, limit = 40): string {
  const named =
    /(?:bernama|namanya|named|called|berjudul)\s+["“”']?([^"“”',.;:]+)/i.exec(request) ??
    /["“”']([^"“”']{2,})["“”']/.exec(request);
  const raw = (named?.[1] ?? "").trim();
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 3);
  return words.join("-").slice(0, limit);
}

export function buildConfirmPayload(
  proposalId: string,
  choice: ConfirmChoice,
): { proposalId: string; confirm: ConfirmChoice } {
  const projectName = choice.projectName?.trim() ?? "";
  if (choice.projectId === "new" && projectName.length === 0) {
    throw new Error("Give the new project a name.");
  }
  const assetName = choice.assetName?.trim() ?? "";
  if (choice.mode === "generate" && choice.assetId === "new" && assetName.length === 0) {
    throw new Error("Give the new asset a name.");
  }
  return {
    proposalId,
    confirm: {
      projectId: choice.projectId,
      ...(choice.mode === "generate" && choice.assetId !== undefined
        ? { assetId: choice.assetId }
        : {}),
      ...(choice.projectId === "new" ? { projectName } : {}),
      ...(choice.mode === "generate" && choice.assetId === "new" ? { assetName } : {}),
      mode: choice.mode,
    },
  };
}

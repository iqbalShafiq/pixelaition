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

import { useState } from "react";
import { suggestName } from "../lib/target-proposal.js";
import type { ConfirmChoice, TargetProposal } from "../lib/target-proposal.js";
import { Brain } from "./pixel-icons.js";
import { Button, Field, SelectControl, TextInput } from "./ui.js";

export type ConfirmProject = { id: string; name: string; summary: string };
export type ConfirmAsset = {
  id: string;
  projectId: string;
  name: string;
  summary: string;
};

/**
 * The always-shown confirmation for a home prompt: Jev's proposal is
 * pre-selected, the user confirms or overrides, and only then does a run
 * exist. "Let the agent choose" hands the asset decision to the running agent.
 */
export function ConfirmTargetCard({
  proposal,
  request,
  projects,
  assets,
  busy,
  onConfirm,
  onCancel,
  /** The lists the dropdowns need could not be fetched; offer another try. */
  onRetryLists,
}: {
  proposal: TargetProposal;
  /** The user's words; a new asset starts with a name suggested from them. */
  request?: string;
  projects: ConfirmProject[];
  assets: ConfirmAsset[];
  busy: boolean;
  onRetryLists?: () => void;
  onConfirm: (choice: ConfirmChoice) => void;
  onCancel: () => void;
}) {
  const [projectId, setProjectId] = useState(proposal.project.id);
  const [assetId, setAssetId] = useState<string | "new" | null>(
    proposal.asset?.id ?? null,
  );
  const [projectName, setProjectName] = useState("");
  const [assetName, setAssetName] = useState(() =>
    proposal.asset?.id === "new" || proposal.asset === undefined
      ? suggestName(request ?? "")
      : "",
  );

  const projectOptions = [
    ...projects.map((project) => ({ value: project.id, label: project.name })),
    { value: "new", label: "＋ New project" },
  ];
  const projectAssets =
    projectId === "new" ? [] : assets.filter((asset) => asset.projectId === projectId);
  const assetOptions = [
    ...projectAssets.map((asset) => ({ value: asset.id, label: asset.name })),
    { value: "new", label: "＋ New asset" },
    { value: "none", label: "No asset" },
  ];
  const chosenProject = projects.find((project) => project.id === projectId);
  const chosenAsset =
    assetId !== null && assetId !== "new"
      ? projectAssets.find((asset) => asset.id === assetId)
      : undefined;
  const certainty = proposal.project.confidence >= 0.7 ? "fairly sure" : "not sure yet";
  const target =
    projectId === "new" ? "a new project" : (chosenProject?.name ?? "this project");
  const assetPart =
    assetId === "new"
      ? "a new asset"
      : assetId === null || assetId === "none"
        ? "an asset the agent picks"
        : (chosenAsset?.name ?? "the chosen asset");
  const headline =
    proposal.intent === "ask"
      ? `I'll answer about ${target}.`
      : `I'll draw in ${target} · ${assetPart} (${certainty}).`;

  return (
    <section
      aria-label="Confirm target"
      className="pointer-events-auto pixel-window w-full bg-panel p-3"
      style={{ maxWidth: "40rem" }}
    >
      <header className="flex items-center gap-2 text-pixel-label text-accent">
        <Brain width={12} height={12} />
        confirm target
      </header>
      <p className="mt-2 text-pixel-body text-ink">{headline}</p>
      {projects.length === 0 && onRetryLists !== undefined ? (
        <div className="mt-2 flex items-center gap-2 border-2 border-line bg-field px-2 py-1.5">
          <span className="text-pixel-mono text-muted">
            the project list did not load
          </span>
          <Button tone="ghost" onClick={onRetryLists}>
            Try again
          </Button>
        </div>
      ) : null}
      {proposal.reason !== undefined ? (
        <p className="mt-1 text-pixel-mono text-muted">{proposal.reason}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <SelectControl
          label="Project"
          value={projectId}
          options={projectOptions}
          onChange={(value) => {
            setProjectId(value);
            setAssetId(value === "new" ? null : (proposal.asset?.id ?? null));
          }}
          className="max-w-[16rem]"
        />
        {projectId === "new" ? (
          <Field label="Project name" htmlFor="confirm-project-name">
            <TextInput
              id="confirm-project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="knights"
              className="max-w-[12rem]"
            />
          </Field>
        ) : null}
        {proposal.intent !== "ask" ? (
          <SelectControl
            label="Asset"
            value={assetId ?? "none"}
            options={assetOptions}
            onChange={(value) => setAssetId(value === "none" ? null : value)}
            className="max-w-[16rem]"
          />
        ) : null}
        {proposal.intent !== "ask" && assetId === "new" ? (
          <Field label="Asset name" htmlFor="confirm-asset-name">
            <TextInput
              id="confirm-asset-name"
              value={assetName}
              onChange={(event) => setAssetName(event.target.value)}
              placeholder="asset name"
              className="max-w-[12rem]"
            />
          </Field>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            onConfirm({
              projectId,
              assetId: proposal.intent === "ask" ? null : (assetId ?? null),
              projectName,
              assetName,
              mode: "generate",
            })
          }
        >
          {busy ? "Starting…" : "Generate"}
        </Button>
        <Button
          tone="ghost"
          disabled={busy}
          onClick={() =>
            onConfirm({
              projectId,
              projectName,
              assetId: null,
              mode: "agent",
            })
          }
        >
          Let the agent choose
        </Button>
        <Button tone="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

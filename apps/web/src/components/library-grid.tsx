import { Link } from "@tanstack/react-router";
import { Close } from "./pixel-icons.js";
import { Card, EmptyState, IconButton } from "./ui.js";
import { SpriteThumb } from "./sprite-thumb.js";
import type { LibraryResult } from "../lib/library.js";

/**
 * The home library: asset-first cards with real sprites, grouped either by
 * recency (one flat grid) or by project. Every card opens its editor.
 */
export function LibraryGrid({
  result,
  group,
  projectNames,
  onNewAsset,
  onDeleteAsset,
  onDeleteProject,
}: {
  result: LibraryResult;
  group: "recent" | "project";
  /** Project id to name, for the chips on asset cards. */
  projectNames: Record<string, string>;
  onNewAsset?: ((projectId: string) => void) | undefined;
  onDeleteAsset?: ((asset: { id: string; name: string }) => void) | undefined;
  onDeleteProject?:
    ((project: { id: string; name: string; assets: number }) => void) | undefined;
}) {
  if (group === "project") {
    if (result.projects.length === 0) {
      return <EmptyState title="Nothing matches" body="Try another search." />;
    }
    return (
      <div className="grid gap-4">
        {result.projects.map((project) => (
          <Card key={project.id} className="group grid gap-3">
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-[17px] leading-tight text-ink">
                  {project.name}
                </h3>
                {project.summary.length > 0 ? (
                  <p className="mt-1 text-pixel-mono text-muted">{project.summary}</p>
                ) : null}
                <p className="mt-1 text-pixel-mono text-muted">
                  {project.assets.length} asset{project.assets.length === 1 ? "" : "s"}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {onNewAsset !== undefined ? (
                  <button
                    type="button"
                    className="pixel-corners-sm border-2 border-line px-2.5 py-1.5 text-xs text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
                    onClick={() => onNewAsset(project.id)}
                  >
                    New asset
                  </button>
                ) : null}
                {onDeleteProject !== undefined ? (
                  <IconButton
                    tone="danger"
                    size="sm"
                    label={`Delete ${project.name}`}
                    className="opacity-0 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() =>
                      onDeleteProject({
                        id: project.id,
                        name: project.name,
                        assets: project.assets.length,
                      })
                    }
                  >
                    <Close width={12} height={12} />
                  </IconButton>
                ) : null}
              </span>
            </header>
            {project.assets.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {project.assets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    {...(onDeleteAsset !== undefined
                      ? { onDelete: () => onDeleteAsset(asset) }
                      : {})}
                  />
                ))}
              </div>
            ) : (
              <p className="text-pixel-mono text-muted">No assets yet.</p>
            )}
          </Card>
        ))}
      </div>
    );
  }
  if (result.assets.length === 0) {
    return <EmptyState title="Nothing matches" body="Try another search." />;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {result.assets.map((asset) => (
        <AssetCard
          key={asset.id}
          asset={asset}
          projectName={projectNames[asset.projectId]}
          {...(onDeleteAsset !== undefined
            ? { onDelete: () => onDeleteAsset(asset) }
            : {})}
        />
      ))}
    </div>
  );
}

function AssetCard({
  asset,
  projectName,
  onDelete,
}: {
  asset: {
    id: string;
    projectId: string;
    name: string;
    summary: string;
    width: number;
    height: number;
  };
  projectName?: string;
  onDelete?: (() => void) | undefined;
}) {
  return (
    <div className="group relative">
      <Link
        to="/projects/$projectId/assets/$assetId"
        params={{ projectId: asset.projectId, assetId: asset.id }}
        className="pixel-window grid gap-2 bg-raised p-2.5 transition-transform duration-150 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5"
      >
        <div className="grid place-items-center border-2 border-line bg-field p-2">
          <SpriteThumb assetId={asset.id} display={64} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] text-ink">{asset.name}</p>
          {asset.summary.length > 0 ? (
            <p className="mt-0.5 line-clamp-2 text-pixel-mono text-muted">
              {asset.summary}
            </p>
          ) : null}
          <p className="mt-1 flex items-center gap-1.5 text-pixel-mono text-muted">
            {projectName !== undefined ? (
              <span className="truncate text-accent">{projectName}</span>
            ) : null}
            <span>
              {asset.width}×{asset.height}
            </span>
          </p>
        </div>
      </Link>
      {onDelete !== undefined ? (
        // The X appears on hover, in the card's top-right corner, and rides
        // the card's own lift so the corner gaps stay equal.
        <IconButton
          tone="danger"
          size="sm"
          label={`Delete ${asset.name}`}
          className="absolute top-1 right-1 z-10 opacity-0 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onDelete}
        >
          <Close width={12} height={12} />
        </IconButton>
      ) : null}
    </div>
  );
}

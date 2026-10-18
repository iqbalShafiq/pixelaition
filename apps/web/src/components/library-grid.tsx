import { Close } from "./pixel-icons.js";
import { Card, EmptyState, IconButton } from "./ui.js";
import { SpriteThumb } from "./sprite-thumb.js";
import type { LibraryResult } from "../lib/library.js";

/** The asset a card stands for, as the card shows it. */
export type LibraryAsset = {
  id: string;
  projectId: string;
  name: string;
  summary: string;
  width: number;
  height: number;
};

/**
 * The home library: asset-first cards with real sprites, grouped either by
 * recency (one flat grid) or by project. Every card opens its editor.
 */
export function LibraryGrid({
  result,
  group,
  projectNames,
  onOpen,
  returnCardId,
  returnCardRef,
  onNewAsset,
  onDeleteAsset,
  onDeleteProject,
}: {
  result: LibraryResult;
  group: "recent" | "project";
  /** Project id to name, for the chips on asset cards. */
  projectNames: Record<string, string>;
  /** Opens the asset's editor; the card itself carries the flight. */
  onOpen?: ((asset: LibraryAsset, card: Element | null) => void) | undefined;
  /** The asset whose editor was just left: its thumbnail is where the canvas lands. */
  returnCardId?: string | undefined;
  /** That card's element, for the home to bring into view before the snapshot. */
  returnCardRef?: ((element: HTMLAnchorElement | null) => void) | undefined;
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
                <h3 className="truncate text-pixel-title text-ink">{project.name}</h3>
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
                    className="pixel-corners-sm border-2 border-line px-2.5 py-1.5 text-pixel-label text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
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
                    className="bg-paper opacity-100 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
                {project.assets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    {...(onOpen !== undefined ? { onOpen } : {})}
                    {...(returnCardId === asset.id && returnCardRef !== undefined
                      ? { returning: true, cardRef: returnCardRef }
                      : {})}
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
      {result.assets.map((asset) => (
        <AssetCard
          key={asset.id}
          asset={asset}
          projectName={projectNames[asset.projectId]}
          {...(onOpen !== undefined ? { onOpen } : {})}
          {...(returnCardId === asset.id && returnCardRef !== undefined
            ? { returning: true, cardRef: returnCardRef }
            : {})}
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
  onOpen,
  cardRef,
  returning = false,
  onDelete,
}: {
  asset: LibraryAsset;
  projectName?: string;
  onOpen?: ((asset: LibraryAsset, card: Element | null) => void) | undefined;
  cardRef?: ((element: HTMLAnchorElement | null) => void) | undefined;
  /** The canvas is flying here: the thumbnail takes the flight's name. */
  returning?: boolean;
  onDelete?: (() => void) | undefined;
}) {
  // The card is a real link for the browser (open in a new tab, middle click,
  // keyboard) and the click is handed to the router so it can play the
  // transition. The card marks itself first, so it is what flies.
  const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (onOpen === undefined) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(asset, event.currentTarget);
  };
  return (
    <div className="group relative">
      <a
        ref={cardRef}
        href={`/projects/${asset.projectId}/assets/${asset.id}`}
        onClick={open}
        className="pixel-window grid gap-2 bg-raised p-2 transition-transform duration-150 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5"
      >
        <div className="grid aspect-square place-items-center border-2 border-line bg-field p-2">
          {/* The artwork carries the flight's name during render, so the home's
              first paint already has the counterpart the sprite morphs into.
              Naming the canvas, not its well, keeps the card's dark frame out
              of the flight. */}
          <SpriteThumb assetId={asset.id} display={64} flight={returning} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-pixel-label text-ink">{asset.name}</p>
          {asset.summary.length > 0 ? (
            <p className="mt-0.5 line-clamp-2 text-pixel-mono text-muted">
              {asset.summary}
            </p>
          ) : null}
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-pixel-mono text-muted">
            {projectName !== undefined ? (
              <span className="truncate">{projectName}</span>
            ) : null}
            <span className="shrink-0">
              {asset.width}×{asset.height}
            </span>
          </p>
        </div>
      </a>
      {onDelete !== undefined ? (
        // The X appears on hover, in the card's top-right corner, and rides
        // the card's own lift so the corner gaps stay equal.
        <IconButton
          tone="danger"
          size="sm"
          label={`Delete ${asset.name}`}
          className="absolute top-1 right-1 z-10 bg-paper opacity-100 group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          onClick={onDelete}
        >
          <Close width={12} height={12} />
        </IconButton>
      ) : null}
    </div>
  );
}

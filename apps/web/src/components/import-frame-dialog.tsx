import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, Field, SelectControl } from "./ui.js";
import type { ProjectResourceAsset } from "../lib/artboard.js";

/** Reuse a frame from anywhere in the project, with palette mapping. */
export function ImportFrameDialog({
  open,
  onOpenChange,
  assets,
  currentAssetId,
  busy,
  mode = "frame",
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: ProjectResourceAsset[];
  currentAssetId: string;
  busy: boolean;
  mode?: "frame" | "background";
  onImport: (sourceAssetId: string, sourceFrameId: string) => void;
}) {
  const [sourceId, setSourceId] = useState(
    assets.find((asset) => asset.id === currentAssetId)?.id ?? assets[0]?.id ?? "",
  );
  const source = assets.find((asset) => asset.id === sourceId) ?? assets[0];
  useEffect(() => {
    if (!sourceId && assets[0]) setSourceId(assets[0].id);
  }, [assets, sourceId]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        mode === "background" ? "Copy a project background" : "Import a project frame"
      }
      description={
        mode === "background"
          ? "Use the background of another social frame. Colours map through this asset's palette."
          : "Copy a sprite or a social frame into this asset. Colours map through the palette."
      }
      width="44rem"
    >
      {assets.length === 0 ? (
        <EmptyState title="No project frames" body="Create an asset first." />
      ) : (
        <>
          <Field label="Source asset" htmlFor="import-frame-asset">
            <SelectControl
              id="import-frame-asset"
              label="Source asset"
              value={sourceId}
              options={assets.map((asset) => ({ value: asset.id, label: asset.name }))}
              onChange={setSourceId}
            />
          </Field>
          <div className="grid max-h-[55vh] gap-1 overflow-y-auto pr-1">
            {source?.frames
              .filter((frame) => mode === "frame" || frame.kind === "social")
              .map((frame) => (
                <button
                  key={frame.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onImport(source.id, frame.id)}
                  className="flex min-w-0 items-center justify-between gap-3 border-2 border-line px-2 py-1.5 text-left hover:border-accent disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-pixel-label text-ink">
                      {frame.name}
                    </span>
                    <span className="block font-mono text-[10px] text-muted">
                      {frame.kind === "social" ? "social" : "sprite"} ·{" "}
                      {frame.width ?? source.width}×{frame.height ?? source.height}
                      {frame.presetId ? ` · ${frame.presetId}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-accent">
                    {busy ? "…" : mode === "background" ? "use" : "import"}
                  </span>
                </button>
              ))}
            {source?.frames.length === 0 ? (
              <p className="text-pixel-body text-muted">This asset has no frames.</p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button tone="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import type { AssetDto } from "../lib/types.js";
import { Button, Callout, Dialog, DialogClose, Field, SelectControl } from "./ui.js";
import { api } from "../lib/api.js";

/**
 * Paste a command array and run it through the same applyCommand path as the
 * toolbar. The layer id is injected for commands that omit it.
 */
export function ScriptDialog({
  open,
  onOpenChange,
  assetId,
  frameId,
  layers,
  activeLayerId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  frameId: string;
  layers: Array<{ id: string; name: string }>;
  activeLayerId: string;
  onSaved: (asset: AssetDto) => void;
}) {
  const [layerId, setLayerId] = useState(activeLayerId || layers[0]?.id || "");
  const [source, setSource] = useState(
    '[\n  { "type": "fill", "x": 0, "y": 0, "color": 1 }\n]',
  );
  const [state, setState] = useState<{
    kind: "idle" | "busy" | "failed";
    message?: string;
  }>({
    kind: "idle",
  });

  useEffect(() => {
    if (!layers.some((layer) => layer.id === layerId)) {
      setLayerId(activeLayerId || layers[0]?.id || "");
    }
  }, [activeLayerId, layers, layerId]);

  async function run() {
    setState({ kind: "busy", message: "Running through applyCommand." });
    try {
      const commands = JSON.parse(source) as unknown;
      if (!Array.isArray(commands)) throw new Error("The script must be a JSON array.");
      const asset = await api<AssetDto>(`/api/assets/${assetId}/script`, {
        method: "POST",
        body: JSON.stringify({ frameId, layerId, commands }),
      });
      onSaved(asset);
      setState({ kind: "idle", message: "Script committed." });
    } catch (reason) {
      setState({
        kind: "failed",
        message: reason instanceof Error ? reason.message : "The script failed.",
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command script"
      description="Commands run through applyCommand; palette and bounds checks still apply."
    >
      <div className="grid gap-3">
        <Field label="Layer" htmlFor="script-layer">
          <SelectControl
            id="script-layer"
            label="Layer"
            value={layerId}
            options={layers.map((layer) => ({ value: layer.id, label: layer.name }))}
            onChange={setLayerId}
          />
        </Field>
        <Field label="Commands (JSON)" htmlFor="script-source">
          <textarea
            id="script-source"
            value={source}
            onChange={(event) => setSource(event.currentTarget.value)}
            rows={12}
            spellCheck={false}
            className="w-full border-2 border-line bg-field p-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
        </Field>
        {state.message ? (
          state.kind === "failed" ? (
            <Callout tone="danger">{state.message}</Callout>
          ) : (
            <p className="text-pixel-mono text-muted">{state.message}</p>
          )
        ) : null}
        <div className="flex items-center gap-2">
          <Button onClick={() => void run()} disabled={state.kind === "busy"}>
            {state.kind === "busy" ? "Running" : "Run script"}
          </Button>
          <DialogClose>Close</DialogClose>
        </div>
      </div>
    </Dialog>
  );
}

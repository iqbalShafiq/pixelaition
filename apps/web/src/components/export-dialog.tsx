import { useState } from "react";
import { Button, Dialog, DialogCloseButton, Field, ModelSelect } from "./ui.js";

const scopes = ["frame", "asset", "project"] as const;
type Scope = (typeof scopes)[number];

const formats = ["pxl", "png", "jpg", "svg", "zip"] as const;
type Format = (typeof formats)[number];

const scales = ["1", "2", "4", "8", "10"] as const;

export function ExportDialog({
  open,
  onOpenChange,
  projectId,
  assetId,
  frameId,
  frameName,
  assetName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  assetId: string;
  frameId: string;
  frameName: string;
  assetName: string;
}) {
  const [scope, setScope] = useState<Scope>("frame");
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState<string>("1");
  const [background, setBackground] = useState("#14120e");
  const [state, setState] = useState<{
    kind: "idle" | "busy" | "error";
    message?: string;
  }>({
    kind: "idle",
  });

  const pxlNeedsProject = format === "pxl" && scope !== "project";
  const available = formats.filter((item) => !(item === "pxl" && scope !== "project"));

  async function run() {
    setState({ kind: "busy", message: "Rendering the export on the server." });
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          projectId,
          assetId,
          frameId,
          format,
          scale: Number(scale),
          background,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName(response.headers.get("content-disposition"), format);
      link.click();
      URL.revokeObjectURL(url);
      setState({ kind: "idle", message: "Export downloaded." });
    } catch (reason) {
      setState({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Export failed.",
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export"
      description={`${assetName} · ${frameName}`}
    >
      <Field label="Scope">
        <ModelSelect
          label="Scope"
          value={scope}
          options={[...scopes]}
          onChange={(next) => setScope(next as Scope)}
        />
      </Field>
      <Field label="Format">
        <ModelSelect
          label="Format"
          value={available.includes(format) ? format : "png"}
          options={available}
          onChange={(next) => setFormat(next as Format)}
        />
      </Field>
      <Field label="Scale">
        <ModelSelect
          label="Scale"
          value={scale}
          options={[...scales]}
          onChange={setScale}
        />
      </Field>
      {format === "jpg" || format === "zip" ? (
        <Field label="Background">
          <input
            type="color"
            value={background}
            aria-label="Background color"
            onChange={(event) => setBackground(event.target.value)}
            className="h-8 w-20 rounded-md border border-line bg-paper"
          />
        </Field>
      ) : null}
      {pxlNeedsProject ? (
        <p className="text-xs text-muted">
          A .pxl document holds a whole project. Pick the project scope for it.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="text-sm text-erase">{state.message}</p>
      ) : null}
      {state.kind === "idle" && state.message ? (
        <p className="font-mono text-xs text-muted">{state.message}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={() => void run()} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Rendering" : "Download"}
        </Button>
        <DialogCloseButton>Close</DialogCloseButton>
      </div>
    </Dialog>
  );
}

function fileName(disposition: string | null, fallback: Format): string {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match?.[1] ?? `pixelaition.${fallback}`;
}

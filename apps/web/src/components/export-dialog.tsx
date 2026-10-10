import { useState } from "react";
import {
  Button,
  Callout,
  Dialog,
  DialogClose,
  Field,
  SelectControl,
  TextInput,
} from "./ui.js";

const scopes = [
  { id: "frame", label: "This frame" },
  { id: "asset", label: "This asset" },
  { id: "project", label: "The whole project" },
] as const;
type Scope = (typeof scopes)[number]["id"];

const formats = ["png", "jpg", "svg", "zip", "pxl"] as const;
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
  onBeforeExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  assetId: string;
  frameId: string;
  frameName: string;
  assetName: string;
  /** Writes any pending stroke before the server renders the export. */
  onBeforeExport: () => void;
}) {
  const [scope, setScope] = useState<Scope>("frame");
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState<string>("1");
  const [background, setBackground] = useState("#14120e");
  const [state, setState] = useState<{
    kind: "idle" | "busy" | "failed";
    message?: string;
  }>({ kind: "idle" });

  const pxlNeedsProject = format === "pxl" && scope !== "project";
  const available = formats.filter((item) => !(item === "pxl" && scope !== "project"));

  async function run() {
    setState({ kind: "busy", message: "Rendering on the server." });
    onBeforeExport();
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
      setState({ kind: "idle", message: "Saved to your downloads." });
    } catch (reason) {
      setState({
        kind: "failed",
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Scope" htmlFor="export-scope">
          <SelectControl
            id="export-scope"
            label="Scope"
            value={scope}
            options={scopes.map((item) => item.id)}
            onChange={(next) => setScope(next as Scope)}
          />
        </Field>
        <Field
          label="Format"
          htmlFor="export-format"
          hint={scope !== "project" ? ".pxl needs the project" : undefined}
        >
          <SelectControl
            id="export-format"
            label="Format"
            value={available.includes(format) ? format : "png"}
            options={available}
            onChange={(next) => setFormat(next as Format)}
          />
        </Field>
        <Field label="Scale" htmlFor="export-scale">
          <SelectControl
            id="export-scale"
            label="Scale"
            value={scale}
            options={[...scales]}
            onChange={setScale}
          />
        </Field>
        {format === "jpg" || format === "zip" ? (
          <Field label="Background" htmlFor="export-background">
            <TextInput
              id="export-background"
              type="color"
              value={background}
              className="h-9 w-20 p-0"
              onChange={(event) => setBackground(event.target.value)}
            />
          </Field>
        ) : null}
      </div>

      {pxlNeedsProject ? (
        <Callout>
          A .pxl document holds a whole project, so PNG, JPG, SVG, or ZIP is the right
          choice for one frame.
        </Callout>
      ) : null}
      {format === "zip" ? (
        <Callout>
          ZIP holds a PNG and an SVG for every frame in scope, at the chosen scale.
        </Callout>
      ) : null}
      {state.kind === "failed" ? (
        <Callout tone="danger">{state.message}</Callout>
      ) : state.message ? (
        <p className="text-pixel-mono text-muted">{state.message}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={() => void run()} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Rendering" : "Download"}
        </Button>
        <DialogClose>Close</DialogClose>
      </div>
    </Dialog>
  );
}

function fileName(disposition: string | null, fallback: Format): string {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match?.[1] ?? `pixelaition.${fallback}`;
}

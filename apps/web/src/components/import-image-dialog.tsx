import {
  quantizeToPalette,
  resizeRgbaNearest,
  sliceSheet,
  type RgbaImageData,
} from "@pixelaition/pixel";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Dialog, Field, SelectControl } from "./ui.js";
import { decodeImageFile } from "../lib/image-import.js";
import type { AssetDto, FrameDto } from "../lib/types.js";

type Mode = "frames" | "layers";
type Dither = "none" | "bayer4";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function toFrameBuffer(image: RgbaImageData, palette: string[], dither: Dither) {
  return quantizeToPalette(image, palette, { dither, alphaThreshold: 128 });
}

/**
 * Import an existing raster into the asset. Decoding and quantization happen
 * in the browser; the API re-validates every index and every canvas size.
 */
export function ImportImageDialog({
  open,
  onOpenChange,
  asset,
  frame,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetDto;
  frame: FrameDto | null;
  onImported: (asset: AssetDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<RgbaImageData | null>(null);
  const [mode, setMode] = useState<Mode>("frames");
  const [dither, setDither] = useState<Dither>("bayer4");
  const [columns, setColumns] = useState("1");
  const [rows, setRows] = useState("1");
  const [margin, setMargin] = useState("0");
  const [spacing, setSpacing] = useState("0");
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setImage(null);
    setBusy(false);
    setError(null);
    setSheet(false);
    setMode("frames");
  }, [open]);

  async function choose(next: File | null) {
    setFile(next);
    setError(null);
    setImage(null);
    if (!next) return;
    try {
      setImage(await decodeImageFile(next));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "That image could not be read.",
      );
    }
  }

  const grid = useMemo(() => {
    if (!image || !sheet) return null;
    try {
      const frames = sliceSheet(image, {
        columns: Math.max(1, Number(columns) || 1),
        rows: Math.max(1, Number(rows) || 1),
        margin: Math.max(0, Number(margin) || 0),
        spacing: Math.max(0, Number(spacing) || 0),
      });
      return frames;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That grid is invalid.");
      return null;
    }
  }, [image, sheet, columns, rows, margin, spacing]);

  async function submit() {
    if (!file || !image) return;
    setBusy(true);
    setError(null);
    try {
      const targetWidth = frame?.width ?? asset.width;
      const targetHeight = frame?.height ?? asset.height;
      const frames = sheet ? (grid ?? []) : [image];
      if (frames.length === 0) throw new Error("The sheet has no cells.");
      const payloadFrames = frames.map((sourceImage, index) => {
        const width = mode === "layers" ? targetWidth : sourceImage.width;
        const height = mode === "layers" ? targetHeight : sourceImage.height;
        const image =
          sourceImage.width === width && sourceImage.height === height
            ? sourceImage
            : resizeRgbaNearest(sourceImage, width, height);
        return {
          name:
            frames.length === 1
              ? file.name.replace(/\.[^.]+$/, "") || "imported"
              : `${file.name.replace(/\.[^.]+$/, "") || "imported"}-${index + 1}`,
          width,
          height,
          layers: [
            {
              name: "Imported",
              pixels: base64(toFrameBuffer(image, asset.palette, dither)),
            },
          ],
        };
      });
      const response = await fetch(`/api/assets/${asset.id}/import`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          palette: asset.palette,
          mode,
          ...(mode === "layers" && frame ? { targetFrameId: frame.id } : {}),
          frames: payloadFrames,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        AssetDto | { message?: string } | null;
      if (!response.ok) {
        throw new Error(
          (body as { message?: string } | null)?.message ??
            `Import failed (${response.status}).`,
        );
      }
      onImported(body as AssetDto);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import an image"
      description="PNG, JPEG, WebP or the first frame of a GIF. Colours map into this asset's palette; pixel art stays on its grid."
      width="46rem"
    >
      <input
        ref={inputRef}
        id="import-image-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        aria-label="Choose an image file"
        onChange={(event) => void choose(event.currentTarget.files?.[0] ?? null)}
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
        }}
        className="grid min-h-24 place-items-center border-2 border-dashed border-line-strong bg-field px-3 py-4 text-center"
      >
        <div>
          <p className="text-pixel-label text-ink">
            {file ? file.name : "Choose a file or drop it here"}
          </p>
          <p className="mt-1 text-pixel-mono text-muted">
            {image ? `${image.width}×${image.height} px` : "up to 4096×4096"}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Import as" htmlFor="import-mode">
          <SelectControl
            id="import-mode"
            label="Import as"
            value={mode}
            options={["frames", "layers"]}
            onChange={(next) => setMode(next as Mode)}
          />
        </Field>
        <Field label="Dither" htmlFor="import-dither">
          <SelectControl
            id="import-dither"
            label="Dither"
            value={dither}
            options={["none", "bayer4"]}
            onChange={(next) => setDither(next as Dither)}
          />
        </Field>
      </div>

      {mode === "layers" ? (
        <Callout>
          The image is resized to {frame?.width ?? asset.width}×
          {frame?.height ?? asset.height} and added as a new layer on the open frame.
        </Callout>
      ) : null}

      <label className="flex items-center gap-2 text-pixel-body text-ink">
        <input
          type="checkbox"
          checked={sheet}
          onChange={(event) => setSheet(event.currentTarget.checked)}
          className="h-4 w-4 accent-accent"
        />
        This image is a sprite sheet
      </label>

      {sheet ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Columns" htmlFor="sheet-columns">
            <input
              id="sheet-columns"
              type="number"
              min={1}
              max={64}
              value={columns}
              onChange={(event) => setColumns(event.currentTarget.value)}
              className="w-full border-2 border-line bg-field px-2 py-1.5 text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label="Rows" htmlFor="sheet-rows">
            <input
              id="sheet-rows"
              type="number"
              min={1}
              max={64}
              value={rows}
              onChange={(event) => setRows(event.currentTarget.value)}
              className="w-full border-2 border-line bg-field px-2 py-1.5 text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label="Margin" htmlFor="sheet-margin">
            <input
              id="sheet-margin"
              type="number"
              min={0}
              value={margin}
              onChange={(event) => setMargin(event.currentTarget.value)}
              className="w-full border-2 border-line bg-field px-2 py-1.5 text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label="Spacing" htmlFor="sheet-spacing">
            <input
              id="sheet-spacing"
              type="number"
              min={0}
              value={spacing}
              onChange={(event) => setSpacing(event.currentTarget.value)}
              className="w-full border-2 border-line bg-field px-2 py-1.5 text-ink outline-none focus:border-accent"
            />
          </Field>
        </div>
      ) : null}

      {sheet && grid ? (
        <p className="text-pixel-mono text-muted">
          {grid.length} frames · {grid[0]?.width ?? 0}×{grid[0]?.height ?? 0} each
        </p>
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}

      <div className="flex items-center gap-2">
        <Button
          onClick={() => void submit()}
          disabled={!image || busy || (sheet && !grid)}
        >
          {busy ? "Importing" : "Import"}
        </Button>
        <Button tone="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

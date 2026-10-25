import { renderFrameDocument, seamReport, type FrameBuffer } from "@pixelaition/pixel";
import { useEffect, useRef } from "react";
import { Dialog, DialogClose } from "./ui.js";

/**
 * Show the frame as a 3×3 repeat. The seam report measures the composited
 * pixels, so what the preview calls closed is also what a tiled export gets.
 */
export function TilePreviewDialog({
  open,
  onOpenChange,
  buffer,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buffer: FrameBuffer | null;
  name: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const report = buffer ? seamReport(buffer) : null;

  useEffect(() => {
    const element = canvas.current;
    if (!element || !buffer) return;
    const rendered = renderFrameDocument(buffer);
    const width = buffer.width * 3;
    const height = buffer.height * 3;
    element.width = width;
    element.height = height;
    const context = element.getContext("2d");
    if (!context) return;
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      const sourceY = y % buffer.height;
      for (let x = 0; x < width; x += 1) {
        const sourceX = x % buffer.width;
        const source = (sourceY * buffer.width + sourceX) * 4;
        const target = (y * width + x) * 4;
        image.data[target] = rendered.data[source] ?? 0;
        image.data[target + 1] = rendered.data[source + 1] ?? 0;
        image.data[target + 2] = rendered.data[source + 2] ?? 0;
        image.data[target + 3] = rendered.data[source + 3] ?? 0;
      }
    }
    context.putImageData(image, 0, 0);
  }, [buffer, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Tile preview"
      description={`${name} · 3×3 repeat`}
    >
      <div className="grid gap-3">
        <div className="grid place-items-center border-2 border-line bg-field p-2">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Tiled pixel preview"
            className="max-h-[55vh] w-auto max-w-full [image-rendering:pixelated]"
          />
        </div>
        {report ? (
          <div className="grid gap-1 font-mono text-[11px] text-muted">
            <span>
              Left/right seam: {report.leftRight.mismatches} of{" "}
              {report.leftRight.compared} rows differ
            </span>
            <span>
              Top/bottom seam: {report.topBottom.mismatches} of{" "}
              {report.topBottom.compared} columns differ
            </span>
            <span className={report.seamless ? "text-accent" : "text-erase"}>
              {report.seamless ? "Seamless." : "The edges do not meet yet."}
            </span>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <DialogClose>Close</DialogClose>
        </div>
      </div>
    </Dialog>
  );
}

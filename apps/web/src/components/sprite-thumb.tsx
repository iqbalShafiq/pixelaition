import { useQuery } from "@tanstack/react-query";
import { composite, frameToBuffer } from "@pixelaition/pixel";
import { useLayoutEffect, useRef } from "react";
import { api } from "../lib/api.js";
import { hexToRgba } from "../lib/color.js";
import type { AssetDto } from "../lib/types.js";

/**
 * Draws the first frame of an asset at 1:1 and lets CSS scale it with
 * `image-rendering: pixelated`, so the shelf shows real sprites rather than
 * placeholder art.
 */
export function SpriteThumb({
  assetId,
  display = 48,
  flight = false,
}: {
  assetId: string;
  display?: number;
  /** The canvas is flying here: the artwork carries the flight's name. */
  flight?: boolean;
}) {
  // The editor reads the same asset under the same key, so a thumbnail is
  // already painted when the canvas flies back into it.
  const asset = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
    staleTime: 60_000,
  });
  const ref = useRef<HTMLCanvasElement>(null);

  // Layout effect, not a passive one: the drawing has to be in the frame the
  // browser paints, or the return flight lands on an empty thumbnail.
  useLayoutEffect(() => {
    const canvas = ref.current;
    const data = asset.data;
    if (!canvas || !data) return;
    const frame = data.frames[0];
    if (!frame) return;
    const buffer = frameToBuffer(frame, data.width, data.height, data.palette);
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(buffer.width, buffer.height);
    const indexes = composite(buffer);
    for (let index = 0; index < indexes.length; index += 1) {
      const value = indexes[index] ?? 0;
      if (value === 0) continue;
      const [r, g, b, a] = hexToRgba(buffer.palette[value] ?? "#000000");
      const offset = index * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
    context.putImageData(image, 0, 0);
  }, [asset.data]);

  return (
    <span
      className="grid shrink-0 place-items-center border-2 border-line bg-screen"
      style={{ width: display, height: display }}
    >
      {asset.data ? (
        <canvas
          ref={ref}
          aria-hidden
          style={{
            width: display - 4,
            height: display - 4,
            imageRendering: "pixelated",
            ...(flight ? { viewTransitionName: "asset-flight" } : {}),
          }}
        />
      ) : (
        <span className="text-pixel-mono text-muted">{asset.isError ? "—" : "…"}</span>
      )}
    </span>
  );
}

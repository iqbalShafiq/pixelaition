import { useEffect, useMemo, useRef, useState } from "react";
import {
  elementBounds,
  type Artboard,
  type Element,
  type FormatPreset,
  type PaletteImage,
  type SpriteSource,
} from "@pixelaition/artboard";
import { drawPaletteImage, downsamplePalette, renderArtboard } from "../lib/artboard.js";
import type { AssetDto } from "../lib/types.js";

/**
 * The social stage: one shared renderer, one bitmap, no CSS-positioned text.
 * Zone guides are overlays in output-pixel space; they never enter the export.
 */
export function ArtboardCanvas({
  artboard,
  preset,
  asset,
  sprites,
  fit,
  showZones,
  selectedId,
  onSelect,
  onMove,
  locked = false,
  thumbnail = false,
}: {
  artboard: Artboard;
  preset: FormatPreset;
  asset: AssetDto;
  sprites: Map<string, SpriteSource>;
  fit: boolean;
  showZones: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, x: number, y: number) => void;
  locked?: boolean;
  thumbnail?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const image = useMemo<PaletteImage>(() => {
    const rendered = renderArtboard(artboard, preset, asset, sprites);
    return thumbnail ? downsamplePalette(rendered, 520) : rendered;
  }, [artboard.scene, artboard.id, preset, asset, sprites, thumbnail]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawPaletteImage(canvas, image);
  }, [image]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      const height = entry?.contentRect.height ?? 0;
      setCompact(width < 420);
      setStageSize({ width, height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const bounds = useMemo(() => {
    const map = new Map<string, ReturnType<typeof elementBounds>>();
    for (const element of artboard.scene.elements) {
      map.set(element.id, elementBounds(element, sprites));
    }
    return map;
  }, [artboard.scene.elements, sprites]);

  const selected = selectedId
    ? artboard.scene.elements.find((item) => item.id === selectedId)
    : undefined;
  const selectedBounds = selected ? bounds.get(selected.id) : undefined;
  const fitScale =
    stageSize.width > 0 && stageSize.height > 0
      ? Math.min(stageSize.width / image.width, stageSize.height / image.height)
      : 1;
  const scaleX = 100 / artboard.width;
  const scaleY = 100 / artboard.height;

  function pointInCanvas(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * artboard.width,
      y: ((event.clientY - rect.top) / rect.height) * artboard.height,
    };
  }

  function hitTest(x: number, y: number): Element | undefined {
    for (const element of [...artboard.scene.elements].reverse()) {
      const box = bounds.get(element.id);
      if (!box) continue;
      if (x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height) {
        return element;
      }
    }
    return undefined;
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (locked) return;
    const point = pointInCanvas(event);
    if (!point) return;
    const hit = hitTest(point.x, point.y);
    onSelect?.(hit?.id ?? null);
    if (!hit || !onMove) return;
    const box = bounds.get(hit.id);
    if (!box) return;
    dragRef.current = { id: hit.id, dx: point.x - box.x, dy: point.y - box.y };
    setDragging(hit.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || !onMove) return;
    const point = pointInCanvas(event);
    if (!point) return;
    onMove(
      drag.id,
      Math.max(0, Math.min(artboard.width, Math.round(point.x - drag.dx))),
      Math.max(0, Math.min(artboard.height, Math.round(point.y - drag.dy))),
    );
  }

  function endDrag() {
    dragRef.current = null;
    setDragging(null);
  }

  return (
    <div
      ref={stageRef}
      className={`relative ${fit ? "flex h-full w-full items-center justify-center" : "inline-block"}`}
      style={fit ? undefined : { width: image.width, height: image.height }}
    >
      <div
        className="relative"
        style={
          fit
            ? thumbnail
              ? {
                  width: "100%",
                  height: "100%",
                  visibility: stageSize.width > 0 ? "visible" : "hidden",
                }
              : {
                  width: Math.max(1, image.width * fitScale),
                  height: Math.max(1, image.height * fitScale),
                  visibility: stageSize.width > 0 ? "visible" : "hidden",
                }
            : { width: image.width, height: image.height }
        }
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${artboard.name} preview`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`block bg-field [image-rendering:pixelated] ${
            locked ? "cursor-progress" : onMove ? "cursor-crosshair touch-none" : ""
          }`}
          style={
            thumbnail
              ? { width: "100%", height: "100%", objectFit: "cover" }
              : fit
                ? { width: "100%", height: "100%" }
                : { width: image.width, height: image.height }
          }
        />
        {showZones ? (
          <div className="pointer-events-none absolute inset-0">
            {preset.safeZones.map((zone) => (
              <div
                key={`safe-${zone.id}`}
                className="absolute border border-dashed border-accent/70"
                style={{
                  left: `${zone.x * scaleX}%`,
                  top: `${zone.y * scaleY}%`,
                  width: `${zone.width * scaleX}%`,
                  height: `${zone.height * scaleY}%`,
                }}
              >
                {compact ? null : (
                  <span className="absolute -top-4 left-0 bg-paper/90 px-1 font-mono text-[9px] tracking-[0.12em] text-accent uppercase">
                    {zone.label}
                  </span>
                )}
              </div>
            ))}
            {preset.crops.map((crop) => (
              <div
                key={`crop-${crop.id}`}
                className="absolute border border-dashed border-muted/60"
                style={{
                  left: `${crop.x * scaleX}%`,
                  top: `${crop.y * scaleY}%`,
                  width: `${crop.width * scaleX}%`,
                  height: `${crop.height * scaleY}%`,
                }}
              >
                {compact ? null : (
                  <span className="absolute -bottom-4 left-0 bg-paper/90 px-1 font-mono text-[9px] text-muted">
                    {crop.label}
                  </span>
                )}
              </div>
            ))}
            {preset.exclusions.map((zone) => (
              <div
                key={`exclude-${zone.id}`}
                className="absolute border border-dashed border-erase/70 bg-erase/5"
                style={{
                  left: `${zone.x * scaleX}%`,
                  top: `${zone.y * scaleY}%`,
                  width: `${zone.width * scaleX}%`,
                  height: `${zone.height * scaleY}%`,
                }}
              >
                {compact ? null : (
                  <span className="absolute top-1 left-1 bg-paper/90 px-1 font-mono text-[9px] text-erase">
                    {zone.label}
                  </span>
                )}
              </div>
            ))}
            {preset.shape === "circle" ? (
              <div
                className="absolute rounded-full border-2 border-dashed border-accent/80"
                style={{ inset: "4%" }}
              />
            ) : null}
          </div>
        ) : null}
        {selected && selectedBounds ? (
          <div
            className="pointer-events-none absolute border-2 border-accent"
            style={{
              left: `${selectedBounds.x * scaleX}%`,
              top: `${selectedBounds.y * scaleY}%`,
              width: `${selectedBounds.width * scaleX}%`,
              height: `${selectedBounds.height * scaleY}%`,
              opacity: dragging === selected.id ? 0.6 : 1,
            }}
          >
            {compact ? null : (
              <span className="absolute -top-4 left-0 bg-accent px-1 font-mono text-[9px] text-coffee uppercase">
                {selected.kind}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

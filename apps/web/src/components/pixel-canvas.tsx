import {
  composite,
  stepZoom,
  zoomAt,
  type Camera,
  type FrameBuffer,
} from "@pixelaition/pixel";
import { useEffect, useRef } from "react";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type Tool =
  "select" | "pencil" | "eraser" | "fill" | "picker" | "line" | "rect" | "pan";

export type CanvasAction =
  | { kind: "paint"; points: Point[] }
  | { kind: "erase"; points: Point[] }
  | { kind: "fill"; point: Point }
  | { kind: "pick"; index: number }
  | { kind: "line"; from: Point; to: Point }
  | { kind: "rect"; from: Point; to: Point; filled: boolean }
  | { kind: "select"; rect: Rect | null };

type ShapePreview =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "rect"; from: Point; to: Point; filled: boolean };

type ScreenPoint = { clientX: number; clientY: number; currentTarget: HTMLCanvasElement };

type Props = {
  buffer: FrameBuffer;
  camera: Camera;
  tool: Tool;
  brushSize: number;
  grid: boolean;
  checker: boolean;
  onionSkin: FrameBuffer[];
  selection: Rect | null;
  locked: boolean;
  onAction: (action: CanvasAction) => void;
  onCamera: (camera: Camera) => void;
};

export function normalizeRect(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x) + 1,
    height: Math.abs(to.y - from.y) + 1,
  };
}

function brushPoints(point: Point, size: number): Point[] {
  if (size <= 1) return [point];
  const offsets = size === 2 ? [0, 1] : [-1, 0, 1];
  const points: Point[] = [];
  for (const dy of offsets) {
    for (const dx of offsets) points.push({ x: point.x + dx, y: point.y + dy });
  }
  return points;
}

function lineCells(from: Point, to: Point): Point[] {
  const points: Point[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    points.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

function rectCells(box: Rect, filled: boolean): Point[] {
  const cells: Point[] = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const edge =
        x === box.x ||
        y === box.y ||
        x === box.x + box.width - 1 ||
        y === box.y + box.height - 1;
      if (filled || edge) cells.push({ x, y });
    }
  }
  return cells;
}

export function PixelCanvas({
  buffer,
  camera,
  tool,
  brushSize,
  grid,
  checker,
  onionSkin,
  selection,
  locked,
  onAction,
  onCamera,
}: Props) {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const repaint = useRef<() => void>(() => undefined);
  const space = useRef(false);
  const pan = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const stroke = useRef<Point | null>(null);
  const drag = useRef<{ from: Point; to: Point } | null>(null);
  const preview = useRef<ShapePreview | null>(null);
  const marquee = useRef<Rect | null>(null);
  const hover = useRef<Point | null>(null);

  // Handlers read the latest props without re-binding listeners on every render.
  const latest = useRef({ camera, buffer, tool, brushSize, onAction, onCamera });
  latest.current = { camera, buffer, tool, brushSize, onAction, onCamera };

  useEffect(() => {
    function down(event: KeyboardEvent) {
      if (event.code === "Space") space.current = event.type === "keydown";
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", down);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", down);
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const context = view.getContext("2d");
    if (!context) return;

    const draw = () => {
      const rect = view.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ratio = devicePixelRatio;
      view.width = Math.floor(rect.width * ratio);
      view.height = Math.floor(rect.height * ratio);
      const cam = latest.current.camera;
      const doc = latest.current.buffer;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.imageSmoothingEnabled = false;
      context.fillStyle = "#14120e";
      context.fillRect(0, 0, rect.width, rect.height);

      const cell = cam.zoom;
      const originX = cam.x;
      const originY = cam.y;
      const docWidth = doc.width * cell;
      const docHeight = doc.height * cell;

      if (checker) {
        const tile = Math.max(6, Math.min(14, cell));
        context.save();
        context.beginPath();
        context.rect(originX, originY, docWidth, docHeight);
        context.clip();
        context.fillStyle = "rgba(244, 239, 228, 0.04)";
        const firstX = Math.floor(originX / tile);
        const firstY = Math.floor(originY / tile);
        const lastX = Math.ceil((originX + docWidth) / tile);
        const lastY = Math.ceil((originY + docHeight) / tile);
        for (let gy = firstY; gy < lastY; gy += 1) {
          for (let gx = firstX; gx < lastX; gx += 1) {
            if ((gx + gy) % 2 !== 0) continue;
            context.fillRect(gx * tile, gy * tile, tile, tile);
          }
        }
        context.restore();
      }

      context.strokeStyle = "rgba(244, 239, 228, 0.1)";
      context.lineWidth = 1;
      context.strokeRect(originX + 0.5, originY + 0.5, docWidth - 1, docHeight - 1);

      // Onion skin is display-only: neighbours sit under the frame being edited.
      context.globalAlpha = 0.28;
      for (const neighbor of onionSkin) {
        const indexes = composite(neighbor);
        for (let y = 0; y < doc.height; y += 1) {
          for (let x = 0; x < doc.width; x += 1) {
            const index = indexes[y * doc.width + x] ?? 0;
            if (index === 0) continue;
            context.fillStyle = doc.palette[index] ?? "#000";
            context.fillRect(originX + x * cell, originY + y * cell, cell, cell);
          }
        }
      }
      context.globalAlpha = 1;

      const indexes = composite(doc);
      for (let y = 0; y < doc.height; y += 1) {
        for (let x = 0; x < doc.width; x += 1) {
          const index = indexes[y * doc.width + x] ?? 0;
          if (index === 0) continue;
          context.fillStyle = doc.palette[index] ?? "#000";
          context.fillRect(originX + x * cell, originY + y * cell, cell, cell);
        }
      }

      if (grid && cell >= 8) {
        context.strokeStyle = "rgba(244, 239, 228, 0.08)";
        context.beginPath();
        for (let x = 1; x < doc.width; x += 1) {
          const px = Math.round(originX + x * cell) + 0.5;
          context.moveTo(px, originY);
          context.lineTo(px, originY + docHeight);
        }
        for (let y = 1; y < doc.height; y += 1) {
          const py = Math.round(originY + y * cell) + 0.5;
          context.moveTo(originX, py);
          context.lineTo(originX + docWidth, py);
        }
        context.stroke();
      }

      const shape = preview.current;
      if (shape) {
        const cells =
          shape.kind === "line"
            ? lineCells(shape.from, shape.to)
            : rectCells(normalizeRect(shape.from, shape.to), shape.filled);
        context.fillStyle = "rgba(232, 255, 106, 0.45)";
        for (const item of cells) {
          context.fillRect(originX + item.x * cell, originY + item.y * cell, cell, cell);
        }
      }

      const box = selection ?? marquee.current;
      if (box) {
        context.strokeStyle = "#e8ff6a";
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        context.strokeRect(
          originX + box.x * cell + 0.5,
          originY + box.y * cell + 0.5,
          box.width * cell - 1,
          box.height * cell - 1,
        );
        context.setLineDash([]);
      }

      const pointed = hover.current;
      if (pointed && !locked) {
        context.strokeStyle = "rgba(232, 255, 106, 0.6)";
        context.strokeRect(
          originX + pointed.x * cell + 0.5,
          originY + pointed.y * cell + 0.5,
          cell - 1,
          cell - 1,
        );
      }
    };

    repaint.current = draw;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(view);
    return () => observer.disconnect();
  }, [buffer, camera, grid, checker, onionSkin, selection, locked]);

  function screenPoint(event: ScreenPoint) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function localPoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const cam = latest.current.camera;
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - rect.left - cam.x) / cam.zoom),
      y: Math.floor((event.clientY - rect.top - cam.y) / cam.zoom),
    };
  }

  function inside(point: Point) {
    const doc = latest.current.buffer;
    return point.x >= 0 && point.y >= 0 && point.x < doc.width && point.y < doc.height;
  }

  function strokeCells(from: Point, to: Point): Point[] {
    const doc = latest.current.buffer;
    return lineCells(from, to)
      .flatMap((item) => brushPoints(item, latest.current.brushSize))
      .filter(inside)
      .map((item) => ({
        x: Math.min(item.x, doc.width - 1),
        y: Math.min(item.y, doc.height - 1),
      }));
  }

  return (
    <canvas
      ref={viewRef}
      className="h-full w-full touch-none"
      style={{
        cursor: tool === "pan" ? "grab" : tool === "picker" ? "copy" : "crosshair",
      }}
      onWheel={(event) => {
        event.preventDefault();
        const screen = screenPoint(event);
        const cam = latest.current.camera;
        const next = stepZoom(cam.zoom, event.deltaY < 0 ? 1 : -1);
        latest.current.onCamera(zoomAt(cam, screen.x, screen.y, next));
      }}
      onPointerDown={(event) => {
        const { tool: active, onAction: emit, buffer: doc } = latest.current;
        if (event.button === 1 || active === "pan" || space.current) {
          pan.current = {
            x: event.clientX,
            y: event.clientY,
            camera: latest.current.camera,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.button !== 0) return;
        const point = localPoint(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        if (active === "select") {
          drag.current = { from: point, to: point };
          marquee.current = normalizeRect(point, point);
          repaint.current();
          return;
        }
        if (active === "line" || active === "rect") {
          drag.current = { from: point, to: point };
          preview.current =
            active === "line"
              ? { kind: "line", from: point, to: point }
              : { kind: "rect", from: point, to: point, filled: false };
          repaint.current();
          return;
        }
        if (active === "picker") {
          if (!inside(point)) return;
          const index = composite(doc)[point.y * doc.width + point.x] ?? 0;
          emit({ kind: "pick", index });
          return;
        }
        if (active === "fill") {
          if (inside(point)) emit({ kind: "fill", point });
          return;
        }
        const points = brushPoints(point, latest.current.brushSize).filter(inside);
        stroke.current = point;
        if (points.length === 0) return;
        emit(active === "eraser" ? { kind: "erase", points } : { kind: "paint", points });
      }}
      onPointerMove={(event) => {
        if (pan.current) {
          const start = pan.current;
          latest.current.onCamera({
            ...start.camera,
            x: start.camera.x + event.clientX - start.x,
            y: start.camera.y + event.clientY - start.y,
          });
          return;
        }
        const point = localPoint(event);
        const start = drag.current;
        if (start) {
          start.to = point;
          if (marquee.current) marquee.current = normalizeRect(start.from, point);
          if (preview.current?.kind === "line") {
            preview.current = { kind: "line", from: preview.current.from, to: point };
          } else if (preview.current?.kind === "rect") {
            preview.current = {
              kind: "rect",
              from: preview.current.from,
              to: point,
              filled: preview.current.filled,
            };
          }
          repaint.current();
          return;
        }
        hover.current = point;
        const last = stroke.current;
        if (!last || event.buttons !== 1) {
          repaint.current();
          return;
        }
        if (last.x === point.x && last.y === point.y) return;
        stroke.current = point;
        const cells = strokeCells(last, point);
        if (cells.length === 0) return;
        latest.current.onAction(
          latest.current.tool === "eraser"
            ? { kind: "erase", points: cells }
            : { kind: "paint", points: cells },
        );
      }}
      onPointerUp={(event) => {
        const { onAction: emit } = latest.current;
        const start = drag.current;
        if (start) {
          if (marquee.current) {
            emit({ kind: "select", rect: normalizeRect(start.from, start.to) });
          } else if (preview.current?.kind === "line") {
            emit({ kind: "line", from: preview.current.from, to: preview.current.to });
          } else if (preview.current?.kind === "rect") {
            emit({
              kind: "rect",
              from: preview.current.from,
              to: preview.current.to,
              filled: preview.current.filled,
            });
          }
          drag.current = null;
          marquee.current = null;
          preview.current = null;
        }
        stroke.current = null;
        pan.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        repaint.current();
      }}
      onPointerLeave={() => {
        hover.current = null;
        repaint.current();
      }}
    />
  );
}

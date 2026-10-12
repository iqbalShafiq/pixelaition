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

/** A drag that starts in the margin still has to produce a usable selection. */
function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(rect.x, width - 1));
  const y = Math.max(0, Math.min(rect.y, height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, width - x)),
    height: Math.max(1, Math.min(rect.height, height - y)),
  };
}

/**
 * Palette entries are normalised hex, so a fixed-width parse is enough. Anything
 * unexpected is treated as opaque so a bad colour never silently erases a pixel.
 */
function rgba(hex: string): [number, number, number, number] {
  const value = hex.replace("#", "");
  if (value.length === 8) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      Number.parseInt(value.slice(6, 8), 16),
    ];
  }
  if (value.length === 6) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
      255,
    ];
  }
  return [0, 0, 0, 255];
}

const FIELD_DARK = "#1c2136";
const FIELD_LIGHT = "#262c45";

/**
 * The workspace texture is a checker of one square per document pixel, tiled
 * across the whole preview and anchored to the document origin.
 *
 * One square per pixel is what makes the hover cell and every drawn pixel line
 * up with exactly one square. A fixed screen-size checker is prettier in the
 * abstract but it drifts against the pixel grid, so a hover outline covers one
 * and a bit squares and nothing reads as a single pixel any more.
 */
function pixelCheckerPattern(
  context: CanvasRenderingContext2D,
  cell: number,
): CanvasPattern | null {
  const half = Math.max(1, Math.round(cell));
  const tile = document.createElement("canvas");
  tile.width = half * 2;
  tile.height = half * 2;
  const paint = tile.getContext("2d");
  if (!paint) return null;
  paint.fillStyle = FIELD_DARK;
  paint.fillRect(0, 0, half * 2, half * 2);
  paint.fillStyle = FIELD_LIGHT;
  paint.fillRect(0, 0, half, half);
  paint.fillRect(half, half, half, half);
  return context.createPattern(tile, "repeat");
}

/**
 * The frame is drawn once at 1:1 and then scaled, rather than one fillRect per
 * cell. Per-cell rects leave seams and shimmer once a cell is a single pixel,
 * which is exactly what zooming out exposes.
 */
function bitmapFor(doc: FrameBuffer, cache: WeakMap<FrameBuffer, HTMLCanvasElement>) {
  const cached = cache.get(doc);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = doc.width;
  canvas.height = doc.height;
  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(doc.width, doc.height);
    const indexes = composite(doc);
    for (let index = 0; index < indexes.length; index += 1) {
      const value = indexes[index] ?? 0;
      const offset = index * 4;
      // Transparent pixels stay transparent: the field pattern drawn behind the
      // bitmap is what shows through as the checker.
      if (value === 0) continue;
      const [r, g, b, a] = rgba(doc.palette[value] ?? "#000000");
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
    context.putImageData(image, 0, 0);
  }
  cache.set(doc, canvas);
  return canvas;
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
  // The workspace texture, cached per cell size because it scales with the zoom.
  const field = useRef(new Map<number, CanvasPattern | null>());
  // One 1:1 bitmap per buffer object, rebuilt only when the pixels change.
  const bitmaps = useRef(new WeakMap<FrameBuffer, HTMLCanvasElement>());

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

    // React attaches wheel passively at the root, so preventDefault there is a
    // no-op. The zoom has to own a non-passive listener to stop page scroll.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = view.getBoundingClientRect();
      const cam = latest.current.camera;
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const next = stepZoom(cam.zoom, event.deltaY < 0 ? 1 : -1);
      latest.current.onCamera(zoomAt(cam, screen.x, screen.y, next));
    };
    view.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(() => repaint.current());
    observer.observe(view);
    return () => {
      view.removeEventListener("wheel", onWheel);
      observer.disconnect();
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
      const cell = cam.zoom;
      // Snapped to whole pixels so every cell is exactly the same width. A
      // fractional origin makes nearest-neighbour scaling produce 16px and 17px
      // blocks in the same row.
      const originX = Math.round(cam.x);
      const originY = Math.round(cam.y);
      const docWidth = doc.width * cell;
      const docHeight = doc.height * cell;

      // One texture across the whole preview, anchored to the document grid, so
      // one square always equals one pixel. The document is not recoloured and
      // not outlined: nothing in the preview is a highlighted box.
      const tile = Math.max(1, Math.round(cell)) * 2;
      const offsetX = ((originX % tile) + tile) % tile;
      const offsetY = ((originY % tile) + tile) % tile;
      let pattern = field.current.get(cell);
      if (pattern === undefined) {
        pattern = pixelCheckerPattern(context, cell);
        field.current.set(cell, pattern);
      }
      context.save();
      context.translate(offsetX, offsetY);
      context.fillStyle = pattern ?? FIELD_DARK;
      context.fillRect(-offsetX, -offsetY, rect.width + offsetX, rect.height + offsetY);
      context.restore();

      // Onion skin is display-only: neighbours sit under the frame being edited,
      // with their transparent pixels left alone so the texture stays visible.
      context.globalAlpha = 0.3;
      for (const neighbor of onionSkin) {
        context.drawImage(
          bitmapFor(neighbor, bitmaps.current),
          originX,
          originY,
          docWidth,
          docHeight,
        );
      }
      context.globalAlpha = 1;

      context.drawImage(
        bitmapFor(doc, bitmaps.current),
        originX,
        originY,
        docWidth,
        docHeight,
      );

      // The grid only appears once a cell is wide enough that a boundary line
      // adds information. Below that it eats a pixel out of every cell, so an
      // 8px cell becomes 1px line plus 7px body, and over a two-tone checker the
      // line blends two different colours — three tones per cell, which reads as
      // texture rather than as a pixel grid. The checker already shows the grid
      // at those zooms.
      if (grid && cell >= 12) {
        context.strokeStyle = "rgba(148, 176, 194, 0.22)";
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
        context.fillStyle = "rgba(167, 240, 112, 0.55)";
        for (const item of cells) {
          context.fillRect(originX + item.x * cell, originY + item.y * cell, cell, cell);
        }
      }

      const box = selection ?? marquee.current;
      if (box) {
        context.strokeStyle = "#a7f070";
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
        context.strokeStyle = "rgba(167, 240, 112, 0.85)";
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
  }, [buffer, camera, grid, checker, onionSkin, selection, locked]);

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

  function resetGesture() {
    drag.current = null;
    marquee.current = null;
    preview.current = null;
    stroke.current = null;
    pan.current = null;
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
          const doc = latest.current.buffer;
          drag.current = { from: point, to: point };
          marquee.current = clampRect(normalizeRect(point, point), doc.width, doc.height);
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
          if (marquee.current) {
            const doc = latest.current.buffer;
            marquee.current = clampRect(
              normalizeRect(start.from, point),
              doc.width,
              doc.height,
            );
          }
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
            emit({ kind: "select", rect: marquee.current });
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
        }
        resetGesture();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        repaint.current();
      }}
      onPointerCancel={() => {
        // A cancelled gesture must not leave a phantom marquee behind.
        resetGesture();
        repaint.current();
      }}
      onLostPointerCapture={() => {
        resetGesture();
        repaint.current();
      }}
      onPointerLeave={() => {
        hover.current = null;
        repaint.current();
      }}
    />
  );
}

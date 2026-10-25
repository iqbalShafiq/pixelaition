import {
  composite,
  ellipsePoints,
  hexToRgba,
  stepZoom,
  zoomAt,
  type Camera,
  type FrameBuffer,
} from "@pixelaition/pixel";
import type { PaletteImage } from "@pixelaition/artboard";
import { useEffect, useRef, useState } from "react";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type Tool =
  | "select"
  | "pencil"
  | "eraser"
  | "fill"
  | "picker"
  | "line"
  | "rect"
  | "ellipse"
  | "pan";

export type CanvasAction =
  | { kind: "paint"; points: Point[] }
  | { kind: "erase"; points: Point[] }
  | { kind: "fill"; point: Point }
  | { kind: "pick"; index: number }
  | { kind: "line"; from: Point; to: Point }
  | { kind: "rect"; from: Point; to: Point; filled: boolean }
  | { kind: "ellipse"; from: Point; to: Point; filled: boolean }
  | { kind: "select"; rect: Rect | null };

type ShapePreview =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "rect"; from: Point; to: Point; filled: boolean }
  | { kind: "ellipse"; from: Point; to: Point; filled: boolean };

export type TextResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export type CanvasTextBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font size, so a corner drag can scale the text and its box together. */
  fontSize: number;
  rotation: number;
  originX: number;
  originY: number;
  baseWidth: number;
  baseHeight: number;
};

type Props = {
  buffer: FrameBuffer;
  camera: Camera;
  tool: Tool;
  brushSize: number;
  grid: boolean;
  checker: boolean;
  onionSkin: FrameBuffer[];
  /** A version shown over the current frame: the current dims, the version draws. */
  ghost?: FrameBuffer | null;
  selection: Rect | null;
  locked: boolean;
  /** Scene elements drawn over the pixel base, in document coordinates. */
  overlay?: PaletteImage | null;
  /** The cell the agent is about to ink. Drawn with the same border as a hover. */
  agentCursor?: Point | null;
  /** Editable text layers, in document coordinates, drawn as selection boxes. */
  textBoxes?: CanvasTextBox[];
  selectedTextBoxId?: string | null;
  onSelectText?: (id: string) => void;
  onTextDragStart?: (id: string) => void;
  onMoveText?: (id: string, x: number, y: number) => void;
  onResizeText?: (
    id: string,
    width: number,
    fontSize: number,
    x: number,
    y: number,
  ) => void;
  onRotateText?: (id: string, rotation: number) => void;
  onTextDragEnd?: () => void;
  /** Clear the layer/text selection when the blank canvas or margin is hit. */
  onDeselect?: () => void;
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

const FIELD_DARK = "#100f0e";
const FIELD_LIGHT = "#181715";

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
      const [r, g, b, a] = hexToRgba(doc.palette[value] ?? "#000000");
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

function overlayBitmapFor(
  image: PaletteImage,
  cache: WeakMap<PaletteImage, HTMLCanvasElement>,
) {
  const cached = cache.get(image);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (context) {
    const pixels = context.createImageData(image.width, image.height);
    for (let index = 0; index < image.indices.length; index += 1) {
      const value = image.indices[index] ?? 0;
      if (value === 0) continue;
      const [r, g, b, a] = hexToRgba(image.palette[value] ?? "#000000");
      const offset = index * 4;
      pixels.data[offset] = r;
      pixels.data[offset + 1] = g;
      pixels.data[offset + 2] = b;
      pixels.data[offset + 3] = a;
    }
    context.putImageData(pixels, 0, 0);
  }
  cache.set(image, canvas);
  return canvas;
}

function brushPoints(point: Point, size: number): Point[] {
  const side = Math.max(1, Math.min(32, Math.round(size)));
  if (side === 1) return [point];
  const start = -Math.floor((side - 1) / 2);
  const points: Point[] = [];
  for (let dy = 0; dy < side; dy += 1) {
    for (let dx = 0; dx < side; dx += 1) {
      points.push({ x: point.x + start + dx, y: point.y + start + dy });
    }
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

/**
 * The hover outline on one document cell. A coffee edge sits under the accent
 * so the border stays visible on a pixel of any colour, including the accent.
 */
function strokeCell(
  context: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  cell: number,
  point: Point,
) {
  context.lineWidth = 1;
  // A 1080px document can fit at well under one screen pixel per cell. The
  // cell itself then has no area to stroke, so mark its centre with a small
  // fixed-size target instead of letting the hover feedback disappear.
  if (cell < 4) {
    const centerX = originX + (point.x + 0.5) * cell;
    const centerY = originY + (point.y + 0.5) * cell;
    const radius = 4;
    context.strokeStyle = "#0b0906";
    context.strokeRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
    context.strokeStyle = "rgba(216, 166, 78, 0.95)";
    context.strokeRect(
      centerX - radius + 1,
      centerY - radius + 1,
      radius * 2 - 2,
      radius * 2 - 2,
    );
    return;
  }
  const x = originX + point.x * cell + 0.5;
  const y = originY + point.y * cell + 0.5;
  const size = Math.max(1, cell - 1);
  context.strokeStyle = "#0b0906";
  context.strokeRect(x, y, size, size);
  context.strokeStyle = "rgba(216, 166, 78, 0.95)";
  if (cell >= 8) {
    context.strokeRect(x + 1, y + 1, Math.max(0, size - 2), Math.max(0, size - 2));
  }
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
  ghost = null,
  selection,
  locked,
  agentCursor = null,
  overlay = null,
  textBoxes = [],
  selectedTextBoxId = null,
  onSelectText,
  onTextDragStart,
  onMoveText,
  onResizeText,
  onRotateText,
  onTextDragEnd,
  onDeselect,
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
  const hoverText = useRef<string | null>(null);
  const textDrag = useRef<{
    id: string;
    start: Point;
    origin: { x: number; y: number };
  } | null>(null);
  const textRotate = useRef<{
    id: string;
    startAngle: number;
    startRotation: number;
    center: Point;
  } | null>(null);
  const textResize = useRef<{
    id: string;
    direction: TextResizeDirection;
    start: Point;
    center: Point;
    rotation: number;
    originX: number;
    originY: number;
    width: number;
    height: number;
    fontSize: number;
  } | null>(null);
  // Pan is a ref because the gesture must not re-render; the cursor still has
  // to switch to grabbing, so the fact of panning is mirrored into state.
  const [panning, setPanning] = useState(false);
  // The workspace texture, cached per cell size because it scales with the zoom.
  const field = useRef(new Map<number, CanvasPattern | null>());
  // One 1:1 bitmap per buffer object, rebuilt only when the pixels change.
  const bitmaps = useRef(new WeakMap<FrameBuffer, HTMLCanvasElement>());
  const overlayBitmaps = useRef(new WeakMap<PaletteImage, HTMLCanvasElement>());

  // Handlers read the latest props without re-binding listeners on every render.
  const latest = useRef({
    camera,
    buffer,
    tool,
    brushSize,
    onAction,
    onCamera,
    ghost,
    overlay,
    locked,
    textBoxes,
    selectedTextBoxId,
    onSelectText,
    onTextDragStart,
    onMoveText,
    onResizeText,
    onRotateText,
    onTextDragEnd,
    onDeselect,
  });
  latest.current = {
    camera,
    buffer,
    tool,
    brushSize,
    onAction,
    onCamera,
    ghost,
    overlay,
    locked,
    textBoxes,
    selectedTextBoxId,
    onSelectText,
    onTextDragStart,
    onMoveText,
    onResizeText,
    onRotateText,
    onTextDragEnd,
    onDeselect,
  };

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
      // one square always equals one pixel.
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

      const ghost = latest.current.ghost;
      if (ghost) {
        // History preview: the current frame is dimmed to context and the
        // version draws over it at reduced alpha, so the difference between
        // the two reads as a shift in tone rather than two stacked sprites.
        context.globalAlpha = 0.3;
        context.drawImage(
          bitmapFor(doc, bitmaps.current),
          originX,
          originY,
          docWidth,
          docHeight,
        );
        context.globalAlpha = 0.75;
        context.drawImage(
          bitmapFor(ghost, bitmaps.current),
          originX,
          originY,
          docWidth,
          docHeight,
        );
        context.globalAlpha = 1;
      } else {
        context.drawImage(
          bitmapFor(doc, bitmaps.current),
          originX,
          originY,
          docWidth,
          docHeight,
        );
      }

      const sceneOverlay = latest.current.overlay;
      if (sceneOverlay) {
        context.drawImage(
          overlayBitmapFor(sceneOverlay, overlayBitmaps.current),
          originX,
          originY,
          docWidth,
          docHeight,
        );
      }

      // The writable area is the document: an accent border marks exactly the
      // region the tools and the agent may touch.
      const edge = 2;
      context.fillStyle = "#d8a64e";
      context.fillRect(originX - edge, originY - edge, docWidth + edge * 2, edge);
      context.fillRect(originX - edge, originY + docHeight, docWidth + edge * 2, edge);
      context.fillRect(originX - edge, originY, edge, docHeight);
      context.fillRect(originX + docWidth, originY, edge, docHeight);

      // Below one screen pixel per document cell a per-pixel grid turns into a
      // flat wash (or vanishes), which is why a native 1080px frame appeared to
      // ignore View Grid. Draw the finest power-of-two grid that still leaves
      // readable cells, so the same toggle shows a square grid at every zoom.
      if (grid) {
        let step = 1;
        while (step * cell < 8 && step < 4096) step *= 2;
        context.strokeStyle = "rgba(241, 239, 233, 0.18)";
        context.beginPath();
        for (let x = step; x < doc.width; x += step) {
          const px = Math.round(originX + x * cell) + 0.5;
          context.moveTo(px, originY);
          context.lineTo(px, originY + docHeight);
        }
        for (let y = step; y < doc.height; y += step) {
          const py = Math.round(originY + y * cell) + 0.5;
          context.moveTo(originX, py);
          context.lineTo(originX + docWidth, py);
        }
        context.stroke();
      }

      // Editable text boxes sit above the pixel document. The border is drawn
      // in the text's own rotated frame, so rotating the glyphs rotates the
      // selection and its handles with them.
      for (const box of latest.current.textBoxes) {
        const selected = box.id === latest.current.selectedTextBoxId;
        const hovered = box.id === hoverText.current;
        if (!selected && !hovered) continue;
        const centerX = originX + (box.x + box.width / 2) * cell;
        const centerY = originY + (box.y + box.height / 2) * cell;
        const radians = (box.rotation * Math.PI) / 180;
        const width = Math.max(1, box.baseWidth * cell);
        const height = Math.max(1, box.baseHeight * cell);
        context.save();
        context.translate(centerX, centerY);
        context.rotate(radians);
        context.lineWidth = selected ? 2 : 1;
        context.strokeStyle = selected ? "#d8a64e" : "rgba(216, 166, 78, 0.6)";
        context.setLineDash(selected ? [] : [4, 3]);
        context.strokeRect(-width / 2, -height / 2, width, height);
        if (selected) {
          context.setLineDash([]);
          context.fillStyle = "#d8a64e";
          const halfW = width / 2;
          const halfH = height / 2;
          const handle = 6;
          for (const [hx, hy] of [
            [-halfW, -halfH],
            [0, -halfH],
            [halfW, -halfH],
            [halfW, 0],
            [halfW, halfH],
            [0, halfH],
            [-halfW, halfH],
            [-halfW, 0],
          ] as const) {
            context.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
          }
          const rotateY = -halfH - 14;
          context.strokeStyle = "rgba(216, 166, 78, 0.8)";
          context.beginPath();
          context.moveTo(0, -halfH);
          context.lineTo(0, rotateY);
          context.stroke();
          context.beginPath();
          context.arc(0, rotateY, 4, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }

      const shape = preview.current;
      if (shape) {
        const cells =
          shape.kind === "line"
            ? lineCells(shape.from, shape.to)
            : shape.kind === "ellipse"
              ? (() => {
                  const box = normalizeRect(shape.from, shape.to);
                  return ellipsePoints(box.x, box.y, box.width, box.height, shape.filled);
                })()
              : rectCells(normalizeRect(shape.from, shape.to), shape.filled);
        context.fillStyle = "rgba(216, 166, 78, 0.55)";
        for (const item of cells) {
          context.fillRect(originX + item.x * cell, originY + item.y * cell, cell, cell);
        }
      }

      const box = selection ?? marquee.current;
      if (box) {
        context.strokeStyle = "#d8a64e";
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
      if (pointed && !locked) strokeCell(context, originX, originY, cell, pointed);
      // The agent's border leads the pixel: it sits on the cell, then the
      // pixel inks and the border steps to the next one.
      if (
        agentCursor &&
        agentCursor.x >= 0 &&
        agentCursor.y >= 0 &&
        agentCursor.x < doc.width &&
        agentCursor.y < doc.height &&
        (!pointed || locked || pointed.x !== agentCursor.x || pointed.y !== agentCursor.y)
      ) {
        strokeCell(context, originX, originY, cell, agentCursor);
      }
    };

    repaint.current = draw;
    draw();
  }, [
    buffer,
    camera,
    grid,
    checker,
    onionSkin,
    ghost,
    selection,
    locked,
    agentCursor,
    overlay,
    selectedTextBoxId,
    textBoxes,
  ]);

  function textCenter(box: CanvasTextBox): Point {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function textLocal(box: CanvasTextBox, point: Point): Point {
    const center = textCenter(box);
    const radians = (box.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  }

  function textHandleWorld(box: CanvasTextBox, localX: number, localY: number): Point {
    const center = textCenter(box);
    const radians = (box.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      x: center.x + localX * cos - localY * sin,
      y: center.y + localX * sin + localY * cos,
    };
  }

  function textAt(point: Point) {
    return latest.current.textBoxes.find((box) => {
      const local = textLocal(box, point);
      return (
        Math.abs(local.x) <= box.baseWidth / 2 && Math.abs(local.y) <= box.baseHeight / 2
      );
    });
  }

  function textRotateHandle(box: CanvasTextBox): Point {
    const zoom = latest.current.camera.zoom;
    return textHandleWorld(box, 0, -box.baseHeight / 2 - 14 / zoom);
  }

  function nearTextRotateHandle(box: CanvasTextBox, point: Point): boolean {
    const handle = textRotateHandle(box);
    const zoom = latest.current.camera.zoom;
    const pad = 10 / zoom;
    return Math.abs(point.x - handle.x) <= pad && Math.abs(point.y - handle.y) <= pad;
  }

  function textResizeDirection(
    box: CanvasTextBox,
    point: Point,
  ): TextResizeDirection | null {
    const local = textLocal(box, point);
    const pad = 10 / latest.current.camera.zoom;
    const hw = box.baseWidth / 2;
    const hh = box.baseHeight / 2;
    const nearLeft = Math.abs(local.x + hw) <= pad;
    const nearRight = Math.abs(local.x - hw) <= pad;
    const nearTop = Math.abs(local.y + hh) <= pad;
    const nearBottom = Math.abs(local.y - hh) <= pad;
    if (Math.abs(local.x) > hw + pad || Math.abs(local.y) > hh + pad) return null;
    if (nearTop && nearLeft) return "nw";
    if (nearTop && nearRight) return "ne";
    if (nearBottom && nearLeft) return "sw";
    if (nearBottom && nearRight) return "se";
    if (nearTop) return "n";
    if (nearBottom) return "s";
    if (nearLeft) return "w";
    if (nearRight) return "e";
    return null;
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

  function resetGesture() {
    drag.current = null;
    marquee.current = null;
    preview.current = null;
    stroke.current = null;
    pan.current = null;
    textDrag.current = null;
    textResize.current = null;
    textRotate.current = null;
    setPanning(false);
  }

  // The paint tools all share the pixel cross; pan and select keep the cursors
  // that say what they do. A pan started with space or the middle button shows
  // grabbing whatever tool is selected.
  const cursorClass = panning
    ? "cursor-grabbing"
    : tool === "pan"
      ? "cursor-grab"
      : tool === "select"
        ? "cursor-default"
        : "cursor-pixel-cross";

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
      role="img"
      aria-label={`Pixel canvas ${buffer.width} by ${buffer.height}`}
      className={`h-full w-full touch-none ${cursorClass}`}
      onPointerDown={(event) => {
        const { tool: active, onAction: emit, buffer: doc } = latest.current;
        if (event.button === 0 && !space.current) {
          const point = localPoint(event);
          // The rotate handle deliberately floats outside the text box, so it
          // must be hit-tested before the box itself.
          const rotateBox = latest.current.textBoxes.find((box) =>
            nearTextRotateHandle(box, point),
          );
          if (rotateBox && !latest.current.locked) {
            event.currentTarget.setPointerCapture(event.pointerId);
            const center = textCenter(rotateBox);
            textRotate.current = {
              id: rotateBox.id,
              startAngle: Math.atan2(point.y - center.y, point.x - center.x),
              startRotation: rotateBox.rotation,
              center,
            };
            hover.current = null;
            latest.current.onTextDragStart?.(rotateBox.id);
            latest.current.onSelectText?.(rotateBox.id);
            repaint.current();
            return;
          }
          const resizeBox = latest.current.textBoxes
            .map((box) => ({ box, direction: textResizeDirection(box, point) }))
            .find((entry) => entry.direction !== null);
          if (resizeBox?.direction && !latest.current.locked) {
            event.currentTarget.setPointerCapture(event.pointerId);
            textResize.current = {
              id: resizeBox.box.id,
              direction: resizeBox.direction,
              start: point,
              center: textCenter(resizeBox.box),
              rotation: resizeBox.box.rotation,
              originX: resizeBox.box.originX,
              originY: resizeBox.box.originY,
              width: resizeBox.box.baseWidth,
              height: resizeBox.box.baseHeight,
              fontSize: resizeBox.box.fontSize,
            };
            hover.current = null;
            latest.current.onTextDragStart?.(resizeBox.box.id);
            latest.current.onSelectText?.(resizeBox.box.id);
            repaint.current();
            return;
          }
          const text = textAt(point);
          if (text && !latest.current.locked) {
            event.currentTarget.setPointerCapture(event.pointerId);
            textDrag.current = {
              id: text.id,
              start: point,
              origin: { x: text.originX, y: text.originY },
            };
            hover.current = null;
            latest.current.onTextDragStart?.(text.id);
            latest.current.onSelectText?.(text.id);
            repaint.current();
            return;
          }
        }
        if (
          event.button === 0 &&
          (active === "select" || active === "pan") &&
          !space.current
        ) {
          latest.current.onDeselect?.();
        }
        if (event.button === 1 || active === "pan" || space.current) {
          pan.current = {
            x: event.clientX,
            y: event.clientY,
            camera: latest.current.camera,
          };
          setPanning(true);
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
        if (active === "line" || active === "rect" || active === "ellipse") {
          drag.current = { from: point, to: point };
          preview.current =
            active === "line"
              ? { kind: "line", from: point, to: point }
              : active === "ellipse"
                ? { kind: "ellipse", from: point, to: point, filled: false }
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
        if (textRotate.current) {
          const rotate = textRotate.current;
          const angle = Math.atan2(point.y - rotate.center.y, point.x - rotate.center.x);
          const degrees =
            rotate.startRotation + ((angle - rotate.startAngle) * 180) / Math.PI;
          latest.current.onRotateText?.(rotate.id, degrees);
          return;
        }
        if (textResize.current) {
          const resize = textResize.current;
          const radians = (resize.rotation * Math.PI) / 180;
          const cos = Math.cos(radians);
          const sin = Math.sin(radians);
          const startDx = resize.start.x - resize.center.x;
          const startDy = resize.start.y - resize.center.y;
          const dxPoint = point.x - resize.center.x;
          const dyPoint = point.y - resize.center.y;
          const startLocal = {
            x: startDx * cos + startDy * sin,
            y: -startDx * sin + startDy * cos,
          };
          const currentLocal = {
            x: dxPoint * cos + dyPoint * sin,
            y: -dxPoint * sin + dyPoint * cos,
          };
          const dx = currentLocal.x - startLocal.x;
          const dy = currentLocal.y - startLocal.y;
          const direction = resize.direction;
          let width = resize.width;
          let height = resize.height;
          if (direction.includes("e")) width += dx;
          if (direction.includes("w")) width -= dx;
          if (direction.includes("s")) height += dy;
          if (direction.includes("n")) height -= dy;
          width = Math.max(1, width);
          height = Math.max(1, height);
          const fontSize =
            direction === "n" ||
            direction === "s" ||
            direction === "ne" ||
            direction === "nw" ||
            direction === "se" ||
            direction === "sw"
              ? Math.max(1, Math.round(resize.fontSize * (height / resize.height)))
              : resize.fontSize;
          let x = resize.originX;
          let y = resize.originY;
          if (direction.includes("w")) {
            x += dx * cos;
            y += dx * sin;
          }
          if (direction.includes("n")) {
            x -= dy * sin;
            y += dy * cos;
          }
          latest.current.onResizeText?.(
            resize.id,
            Math.round(width),
            fontSize,
            Math.round(x),
            Math.round(y),
          );
          return;
        }
        if (textDrag.current) {
          const dragText = textDrag.current;
          latest.current.onMoveText?.(
            dragText.id,
            dragText.origin.x + point.x - dragText.start.x,
            dragText.origin.y + point.y - dragText.start.y,
          );
          return;
        }
        const hoveredText = textAt(point);
        hoverText.current = hoveredText?.id ?? null;
        const hoverDirection = hoveredText
          ? textResizeDirection(hoveredText, point)
          : null;
        event.currentTarget.style.cursor = hoveredText
          ? nearTextRotateHandle(hoveredText, point)
            ? "grab"
            : hoverDirection === "n" || hoverDirection === "s"
              ? "ns-resize"
              : hoverDirection === "e" || hoverDirection === "w"
                ? "ew-resize"
                : hoverDirection === "ne" || hoverDirection === "sw"
                  ? "nesw-resize"
                  : hoverDirection === "nw" || hoverDirection === "se"
                    ? "nwse-resize"
                    : "move"
          : "";
        if (hoveredText) {
          hover.current = null;
          repaint.current();
          return;
        }
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
          } else if (preview.current?.kind === "ellipse") {
            preview.current = {
              kind: "ellipse",
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
        if (textRotate.current) {
          textRotate.current = null;
          latest.current.onTextDragEnd?.();
          resetGesture();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          repaint.current();
          return;
        }
        if (textResize.current) {
          textResize.current = null;
          latest.current.onTextDragEnd?.();
          resetGesture();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          repaint.current();
          return;
        }
        if (textDrag.current) {
          textDrag.current = null;
          latest.current.onTextDragEnd?.();
          resetGesture();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          repaint.current();
          return;
        }
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
          } else if (preview.current?.kind === "ellipse") {
            emit({
              kind: "ellipse",
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
        hoverText.current = null;
        repaint.current();
      }}
    />
  );
}

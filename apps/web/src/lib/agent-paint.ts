import { composite, type FrameBuffer } from "@pixelaition/pixel";
import { base64ToBytes } from "./types.js";

export type Point = { x: number; y: number };

export type DecodedLayer = {
  id: string;
  name: string;
  visible: boolean;
  pixels: Uint8Array;
};

/** The frame currently on screen, before this stroke is revealed. */
export type FrameView = {
  width: number;
  height: number;
  layers: DecodedLayer[];
};

export type IncomingStroke = {
  frameId: string;
  layers: DecodedLayer[];
  points: Point[];
  palette?: string[];
};

export type FrameUpdate = {
  frameId: string;
  layers?: DecodedLayer[];
  /** Present when the agent cell moves. Null lifts the border. */
  cursor?: Point | null;
  palette?: string[];
};

/** One phase (hover, then ink). A cell spends two phases on screen. */
export const SLOW_STEP_MS = 36;
/**
 * More strokes than this in one chunk is a rejoin replay, not a live turn.
 * A live paint_stroke / fill_rect burst stays under it and walks in order.
 */
export const REPLAY_STROKES = 8;

export function stepMs(walked: number): number {
  // Fast enough that a fill still moves, slow enough that the border paints
  // before the next cell. Anything quicker gets skipped by the next frame.
  if (walked <= 48) return SLOW_STEP_MS;
  return 28;
}

type Job = {
  width: number;
  height: number;
  shown: DecodedLayer[];
  target: DecodedLayer[];
  cells: Point[];
  index: number;
  phase: "aim" | "ink";
  /** Hover and ink share this gap, fixed when the stroke starts. */
  step: number;
  nextAt: number;
  palette?: string[];
};

/**
 * Reveals an agent stroke one pixel at a time. The network still delivers the
 * whole stroke at once; this only paces what the canvas shows. Workers are
 * untouched: each frame has its own queue and a tick advances every due frame.
 */
export class AgentPaintSession {
  private jobs = new Map<string, Job>();
  /** Strokes waiting behind the one currently walking, per frame. */
  private upcoming = new Map<string, IncomingStroke[]>();
  private bucket: IncomingStroke[] = [];
  /** After the first flush, later tool calls queue instead of popping on screen. */
  private live = false;

  push(stroke: IncomingStroke): void {
    this.bucket.push(stroke);
  }

  /**
   * Take the strokes that arrived in this turn. A long replay snaps to the
   * latest. A live burst — several paint or fill calls in one chunk — walks
   * each stroke in order, on every frame at once.
   */
  flush(
    now: number,
    frameOf: (frameId: string) => FrameView | undefined,
    reducedMotion: boolean,
  ): FrameUpdate[] {
    const batch = this.bucket;
    this.bucket = [];
    const grouped = new Map<string, IncomingStroke[]>();
    for (const stroke of batch) {
      const list = grouped.get(stroke.frameId) ?? [];
      list.push(stroke);
      grouped.set(stroke.frameId, list);
    }
    const replay = !this.live;
    const updates: FrameUpdate[] = [];
    for (const [frameId, list] of grouped) {
      updates.push(
        ...this.enqueue(frameId, list, frameOf(frameId), now, reducedMotion, replay),
      );
    }
    this.live = true;
    return updates;
  }

  /** Advance every frame whose hover or ink is due. One frame never waits on another. */
  tick(now: number): FrameUpdate[] {
    const updates: FrameUpdate[] = [];
    for (const [frameId, job] of this.jobs) {
      if (now < job.nextAt) continue;
      updates.push(this.advance(frameId, job, now));
    }
    return updates;
  }

  nextAt(): number | null {
    let soonest: number | null = null;
    for (const job of this.jobs.values()) {
      if (soonest === null || job.nextAt < soonest) soonest = job.nextAt;
    }
    return soonest;
  }

  /** Drop the queues and return the full target of anything still walking. */
  finish(): FrameUpdate[] {
    this.bucket = [];
    const updates: FrameUpdate[] = [];
    const frames = new Set<string>([...this.jobs.keys(), ...this.upcoming.keys()]);
    for (const frameId of frames) {
      const queued = this.upcoming.get(frameId) ?? [];
      const job = this.jobs.get(frameId);
      const latest = queued[queued.length - 1];
      const layers = latest?.layers ?? job?.target;
      if (!layers) continue;
      updates.push({
        frameId,
        layers,
        cursor: null,
        ...(latest?.palette || job?.palette
          ? { palette: latest?.palette ?? job?.palette }
          : {}),
      });
    }
    this.jobs.clear();
    this.upcoming.clear();
    this.live = false;
    return updates;
  }

  /**
   * Keep the strokes the screen has not shown yet. A handful walk in order.
   * A long backlog is a rejoin, so the latest buffer lands at once.
   */
  private enqueue(
    frameId: string,
    list: IncomingStroke[],
    fallback: FrameView | undefined,
    now: number,
    reducedMotion: boolean,
    replay: boolean,
  ): FrameUpdate[] {
    const last = list[list.length - 1];
    if (!last) return [];
    const view = this.view(frameId, fallback);
    let start = 0;
    if (view) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const stroke = list[index];
        if (
          stroke &&
          sameComposite(view, stroke.layers) &&
          layersEqual(view.layers, stroke.layers)
        ) {
          start = index + 1;
          break;
        }
      }
    }
    const pending = list.slice(start);
    if (pending.length === 0) {
      return last.palette ? [{ frameId, palette: last.palette }] : [];
    }
    // A rejoin may dump the whole history in the first chunk. After that,
    // every tool call waits its turn, even when several arrive together,
    // and a walk that is already on screen is never replaced by a snap.
    const catchingUp =
      replay && !this.jobs.has(frameId) && pending.length > REPLAY_STROKES;
    if (!view || reducedMotion || catchingUp) {
      this.jobs.delete(frameId);
      this.upcoming.delete(frameId);
      return [
        {
          frameId,
          layers: last.layers,
          cursor: null,
          ...(last.palette ? { palette: last.palette } : {}),
        },
      ];
    }
    const queue = this.upcoming.get(frameId) ?? [];
    queue.push(...pending);
    this.upcoming.set(frameId, queue);
    if (this.jobs.has(frameId)) return [];
    return this.startNext(frameId, view, now);
  }

  /** Walk the next queued stroke. Skips a stroke that changes no visible cell. */
  private startNext(frameId: string, view: FrameView, now: number): FrameUpdate[] {
    const queue = this.upcoming.get(frameId) ?? [];
    let current = view;
    let trailing: FrameUpdate[] = [];
    while (queue.length > 0) {
      const stroke = queue.shift();
      if (!stroke) break;
      if (queue.length === 0) this.upcoming.delete(frameId);
      const updates = this.stage(frameId, current, stroke, now, false);
      if (this.jobs.has(frameId)) return updates;
      trailing = updates;
      const shown = updates.find((update) => update.layers)?.layers;
      if (shown) current = { ...current, layers: shown };
    }
    this.upcoming.delete(frameId);
    return trailing;
  }

  private view(frameId: string, fallback: FrameView | undefined): FrameView | undefined {
    const job = this.jobs.get(frameId);
    if (!job) return fallback;
    return { width: job.width, height: job.height, layers: job.shown };
  }

  private stage(
    frameId: string,
    view: FrameView,
    stroke: IncomingStroke,
    now: number,
    reducedMotion: boolean,
  ): FrameUpdate[] {
    const palette = stroke.palette;
    if (reducedMotion || !compatible(view, stroke.layers)) {
      this.jobs.delete(frameId);
      return [
        {
          frameId,
          layers: stroke.layers,
          cursor: null,
          ...(palette ? { palette } : {}),
        },
      ];
    }
    const before = compositeIndexes(view);
    const after = compositeIndexes({ ...view, layers: stroke.layers });
    const pending = this.pendingCells(frameId);
    const ordered = orderChangedCells(view.width, view.height, before, after, [
      ...pending,
      ...stroke.points,
    ]);
    if (ordered.length === 0) {
      this.jobs.delete(frameId);
      if (layersEqual(view.layers, stroke.layers) && !palette) return [];
      return [
        {
          frameId,
          layers: stroke.layers,
          cursor: null,
          ...(palette ? { palette } : {}),
        },
      ];
    }
    // Every changed cell walks, including a fill. Pace scales with the count
    // so a large rect still shows the border without holding the canvas for a minute.
    const walked = ordered;
    const shown = holdBack(view.layers, stroke.layers, view.width, walked);
    const step = stepMs(walked.length);
    const job: Job = {
      width: view.width,
      height: view.height,
      shown,
      target: stroke.layers,
      cells: walked,
      index: 0,
      phase: "aim",
      step,
      nextAt: now + step,
      ...(palette ? { palette } : {}),
    };
    this.jobs.set(frameId, job);
    const first = walked[0];
    return [
      {
        frameId,
        layers: shown,
        ...(first ? { cursor: first } : {}),
        ...(palette ? { palette } : {}),
      },
    ];
  }

  private pendingCells(frameId: string): Point[] {
    const job = this.jobs.get(frameId);
    if (!job || job.phase === "aim") return job ? job.cells.slice(job.index) : [];
    // The aimed cell is already painted during ink; keep the ones still ahead.
    return job.cells.slice(job.index + 1);
  }

  private advance(frameId: string, job: Job, now: number): FrameUpdate {
    const cell = job.cells[job.index];
    if (job.phase === "aim" && cell) {
      job.shown = paintCells(job.shown, job.target, [cell], job.width);
      job.phase = "ink";
      job.nextAt = now + job.step;
      return {
        frameId,
        layers: job.shown,
        cursor: cell,
        ...(job.palette ? { palette: job.palette } : {}),
      };
    }
    const next = job.cells[job.index + 1];
    if (next) {
      job.index += 1;
      job.phase = "aim";
      job.nextAt = now + job.step;
      return { frameId, cursor: next, ...(job.palette ? { palette: job.palette } : {}) };
    }
    const followed = this.startNext(
      frameId,
      { width: job.width, height: job.height, layers: job.target },
      now,
    );
    if (followed.length > 0) return followed[0] ?? { frameId, cursor: null };
    this.jobs.delete(frameId);
    return {
      frameId,
      layers: job.target,
      cursor: null,
      ...(job.palette ? { palette: job.palette } : {}),
    };
  }
}

export function orderChangedCells(
  width: number,
  height: number,
  before: Uint8Array,
  after: Uint8Array,
  hinted: Point[],
): Point[] {
  const changed = new Set<number>();
  const count = Math.min(before.length, after.length, width * height);
  for (let index = 0; index < count; index += 1) {
    if (before[index] !== after[index]) changed.add(index);
  }
  const ordered: Point[] = [];
  const seen = new Set<number>();
  for (const point of hinted) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const x = Math.trunc(point.x);
    const y = Math.trunc(point.y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    if (!changed.has(index) || seen.has(index)) continue;
    seen.add(index);
    ordered.push({ x, y });
  }
  for (let index = 0; index < count; index += 1) {
    if (!changed.has(index) || seen.has(index)) continue;
    ordered.push({ x: index % width, y: Math.floor(index / width) });
  }
  return ordered;
}

export function decodeStroke(
  raw: Record<string, unknown>,
  fallbackFrameId: string,
): IncomingStroke | null {
  const frameId =
    typeof raw.frameId === "string" && raw.frameId.length > 0
      ? raw.frameId
      : fallbackFrameId;
  if (!frameId || !Array.isArray(raw.layers)) return null;
  const layers: DecodedLayer[] = [];
  for (const layer of raw.layers) {
    if (!layer || typeof layer !== "object") return null;
    const item = layer as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.pixels !== "string") return null;
    layers.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : "layer",
      visible: item.visible !== false,
      pixels: base64ToBytes(item.pixels),
    });
  }
  const points: Point[] = [];
  if (Array.isArray(raw.points)) {
    for (const point of raw.points) {
      if (!point || typeof point !== "object") continue;
      const item = point as Record<string, unknown>;
      if (typeof item.x !== "number" || typeof item.y !== "number") continue;
      points.push({ x: item.x, y: item.y });
    }
  }
  const palette = Array.isArray(raw.palette)
    ? raw.palette.filter((color): color is string => typeof color === "string")
    : undefined;
  return {
    frameId,
    layers,
    points,
    ...(palette && palette.length > 0 ? { palette } : {}),
  };
}

function compositeIndexes(view: FrameView): Uint8Array {
  const buffer: FrameBuffer = {
    width: view.width,
    height: view.height,
    palette: ["#00000000"],
    layers: view.layers,
  };
  return composite(buffer);
}

function sameComposite(view: FrameView, layers: DecodedLayer[]): boolean {
  if (!compatible(view, layers)) return false;
  const before = compositeIndexes(view);
  const after = compositeIndexes({ ...view, layers });
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) return false;
  }
  return true;
}

function compatible(view: FrameView, layers: DecodedLayer[]): boolean {
  if (view.width <= 0 || view.height <= 0) return false;
  if (view.layers.length === 0 || view.layers.length !== layers.length) return false;
  const expected = view.width * view.height;
  return layers.every(
    (layer, index) =>
      layer.id === view.layers[index]?.id &&
      layer.pixels.length === expected &&
      view.layers[index]?.pixels.length === expected,
  );
}

function layersEqual(before: DecodedLayer[], after: DecodedLayer[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((layer, index) => {
    const other = after[index];
    if (!other) return false;
    if (
      layer.id !== other.id ||
      layer.name !== other.name ||
      layer.visible !== other.visible
    ) {
      return false;
    }
    if (layer.pixels.length !== other.pixels.length) return false;
    for (let pixel = 0; pixel < layer.pixels.length; pixel += 1) {
      if (layer.pixels[pixel] !== other.pixels[pixel]) return false;
    }
    return true;
  });
}

/** Target pixels everywhere except the cells the cursor has not reached. */
function holdBack(
  before: DecodedLayer[],
  after: DecodedLayer[],
  width: number,
  cells: Point[],
): DecodedLayer[] {
  const indexes = cells.map((cell) => cell.y * width + cell.x);
  return after.map((layer, index) => {
    const source = before[index];
    const pixels = new Uint8Array(layer.pixels);
    if (source) {
      for (const pixel of indexes) pixels[pixel] = source.pixels[pixel] ?? 0;
    }
    return { id: layer.id, name: layer.name, visible: layer.visible, pixels };
  });
}

function paintCells(
  shown: DecodedLayer[],
  target: DecodedLayer[],
  cells: Point[],
  width: number,
): DecodedLayer[] {
  const indexes = cells.map((cell) => cell.y * width + cell.x);
  let changed = false;
  const layers = shown.map((layer, index) => {
    const source = target[index];
    if (!source) return layer;
    let pixels: Uint8Array | null = null;
    for (const pixel of indexes) {
      const value = source.pixels[pixel] ?? 0;
      if ((layer.pixels[pixel] ?? 0) === value) continue;
      if (!pixels) pixels = new Uint8Array(layer.pixels);
      pixels[pixel] = value;
    }
    if (!pixels) return layer;
    changed = true;
    return { id: source.id, name: source.name, visible: source.visible, pixels };
  });
  return changed ? layers : shown;
}

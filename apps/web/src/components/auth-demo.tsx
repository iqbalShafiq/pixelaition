import { useEffect, useRef, useState } from "react";
import {
  assetCells,
  demoAssets,
  demoPalette,
  spriteBounds,
  type DemoAsset,
  type DemoCell,
} from "../lib/auth-demo.js";
import { Wordmark } from "./ui.js";

const tickMs = 36;
const cellsPerTick = 2;
const gridCell = 16;

// 4×4 Bayer. A smooth falloff posterized through this matrix becomes a pixel
// texture instead of a diagonal band or a hard ring.
const bayer4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/**
 * A broad pool of light sits in the bottom-right and breathes. The falloff is
 * round, then cut into four levels with ordered dither, which is how pixel
 * art hides banding. Borders stay put.
 */
function AuthGrid() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;

    const draw = (time: number) => {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.floor(width * dpr));
      const pixelHeight = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cols = Math.max(1, Math.ceil(width / gridCell));
      const rows = Math.max(1, Math.ceil(height / gridCell));
      const reach = Math.hypot(cols, rows);
      const breath = reduce
        ? 0.62
        : 0.38 + 0.62 * (0.5 - 0.5 * Math.cos((time / 2400) * Math.PI * 2));
      for (let y = 0; y < rows; y += 1) {
        const row = bayer4[y & 3]!;
        for (let x = 0; x < cols; x += 1) {
          const dist = Math.hypot(x + 0.5 - cols * 0.82, y + 0.5 - rows * 0.78) / reach;
          const light = Math.max(0, breath * (1 - dist * 1.35));
          const threshold = (row[x & 3]! + 0.5) / 16;
          const stepped = Math.min(
            3,
            Math.max(0, Math.floor((light + (threshold - 0.5) * 0.28) * 4)),
          );
          const level = stepped / 3;
          const px = x * gridCell;
          const py = y * gridCell;
          // Ink at low alpha: the field is atmosphere, not a checkerboard.
          ctx.fillStyle = `rgba(241, 239, 233, ${0.02 + level * 0.18})`;
          ctx.fillRect(px + 1, py + 1, gridCell - 1, gridCell - 1);
          ctx.fillStyle = "rgba(241, 239, 233, 0.15)";
          ctx.fillRect(px, py, gridCell, 1);
          ctx.fillRect(px, py, 1, gridCell);
          if (x === cols - 1) ctx.fillRect(px + gridCell - 1, py, 1, gridCell);
          if (y === rows - 1) ctx.fillRect(px, py + gridCell - 1, gridCell, 1);
        }
      }
    };

    const loop = (time: number) => {
      draw(time);
      raf = requestAnimationFrame(loop);
    };

    if (reduce) draw(0);
    else raf = requestAnimationFrame(loop);

    const observer = new ResizeObserver(() => {
      if (reduce) draw(0);
    });
    observer.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}

/**
 * Sky sits high, the cast stands on the ground. Positions are the picture,
 * not a toolbar.
 */
const spots: Array<{ name: string; cell: number; className: string }> = [
  { name: "Cloud", cell: 9, className: "top-[8%] right-[5%]" },
  { name: "Bird", cell: 8, className: "top-[24%] right-[22%]" },
  { name: "Knight", cell: 11, className: "right-[32%] bottom-[7%]" },
  { name: "Potion", cell: 8, className: "right-[16%] bottom-[10%]" },
  { name: "Slime", cell: 8, className: "right-[3%] bottom-[6%]" },
];

type Cursor = {
  phase: "build" | "hold" | "cycle" | "rest";
  asset: number;
  pose: number;
  layer: number;
  cell: number;
  wait: number;
  flips: number;
};

const startCursor = (): Cursor => ({
  phase: "build",
  asset: 0,
  pose: 0,
  layer: 0,
  cell: 0,
  wait: 0,
  flips: 0,
});

function stepCursor(cursor: Cursor): Cursor {
  const asset = demoAssets[cursor.asset];
  const pose = asset?.poses[cursor.pose];
  const part = pose?.layers[cursor.layer];

  if (cursor.phase === "build" && asset && pose && part) {
    const cell = cursor.cell + cellsPerTick;
    if (cell < part.cells.length) return { ...cursor, cell };
    const layer = cursor.layer + 1;
    if (layer < pose.layers.length) return { ...cursor, layer, cell: 0 };
    return { ...cursor, phase: "hold", wait: 16, cell: part.cells.length };
  }

  if (cursor.phase === "hold" && asset) {
    if (cursor.wait > 1) return { ...cursor, wait: cursor.wait - 1 };
    const poseIndex = cursor.pose + 1;
    if (poseIndex < asset.poses.length) {
      // Only the first pose is painted cell by cell. The rest appear whole.
      return { ...cursor, phase: "hold", pose: poseIndex, layer: 0, cell: 0, wait: 22 };
    }
    const next = cursor.asset + 1;
    if (next < demoAssets.length) {
      return {
        ...cursor,
        phase: "build",
        asset: next,
        pose: 0,
        layer: 0,
        cell: 0,
        wait: 0,
      };
    }
    return { ...cursor, phase: "cycle", pose: 0, wait: 22, flips: 0 };
  }

  if (cursor.phase === "cycle") {
    if (cursor.wait > 1) return { ...cursor, wait: cursor.wait - 1 };
    const flips = cursor.flips + 1;
    if (flips >= 4) return { ...cursor, phase: "rest", wait: 18, flips };
    return { ...cursor, pose: cursor.pose === 0 ? 1 : 0, wait: 22, flips };
  }

  if (cursor.wait > 1) return { ...cursor, wait: cursor.wait - 1 };
  return startCursor();
}

type Shown = {
  visible: boolean;
  pose: number;
  /** Layers finished in this pose. The next one may be partial. */
  layersDone: number;
  cell: number;
  drawing: boolean;
};

function shownFor(index: number, cursor: Cursor, asset: DemoAsset): Shown {
  const lastPose = asset.poses.length - 1;
  const full = (poseIndex: number): Shown => ({
    visible: true,
    pose: poseIndex,
    layersDone: asset.poses[poseIndex]?.layers.length ?? 0,
    cell: 0,
    drawing: false,
  });

  if (cursor.phase === "cycle" || cursor.phase === "rest") {
    const poseIndex = Math.min(cursor.pose, lastPose);
    return full(poseIndex);
  }
  if (index < cursor.asset) return full(lastPose);
  if (index > cursor.asset) {
    return { visible: false, pose: 0, layersDone: 0, cell: 0, drawing: false };
  }
  return {
    visible: cursor.cell > 0 || cursor.layer > 0 || cursor.phase === "hold",
    pose: cursor.pose,
    layersDone:
      cursor.phase === "hold"
        ? (asset.poses[cursor.pose]?.layers.length ?? 0)
        : cursor.layer,
    cell: cursor.phase === "hold" ? 0 : cursor.cell,
    drawing: cursor.phase === "build",
  };
}

function cellsFor(asset: DemoAsset, shown: Shown): DemoCell[] {
  const pose = asset.poses[shown.pose];
  if (!pose) return [];
  const painted: DemoCell[] = [];
  pose.layers.forEach((part, index) => {
    if (index < shown.layersDone) painted.push(...part.cells);
    else if (index === shown.layersDone && shown.cell > 0) {
      painted.push(...part.cells.slice(0, shown.cell));
    }
  });
  return painted;
}

function useCastPlayback() {
  const [cursor, setCursor] = useState<Cursor>(startCursor);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setCursor({ ...startCursor(), phase: "rest", pose: 1, wait: 0 });
      return;
    }
    const id = window.setInterval(() => {
      setCursor((current) => stepCursor(current));
    }, tickMs);
    return () => window.clearInterval(id);
  }, []);
  return cursor;
}

function LiveSprite({
  asset,
  shown,
  cell,
}: {
  asset: DemoAsset;
  shown: Shown;
  cell: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bounds = spriteBounds(assetCells(asset));
  const painted = cellsFor(asset, shown);
  const pose = asset.poses[shown.pose];
  const part = pose?.layers[shown.layersDone];
  const tip =
    shown.drawing && part
      ? part.cells[Math.min(shown.cell, part.cells.length) - 1]
      : undefined;

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    context.clearRect(0, 0, bounds.width, bounds.height);
    for (const pixel of painted) {
      context.fillStyle = demoPalette[pixel.color];
      context.fillRect(pixel.x - bounds.minX, pixel.y - bounds.minY, 1, 1);
    }
  }, [bounds.height, bounds.minX, bounds.minY, bounds.width, painted]);

  return (
    <div
      className="relative"
      style={{ width: bounds.width * cell, height: bounds.height * cell }}
    >
      <canvas
        ref={ref}
        aria-hidden
        className="h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
      {tip ? (
        <span
          aria-hidden
          className="pointer-events-none absolute border-2 border-accent"
          style={{
            width: cell,
            height: cell,
            left: (tip.x - bounds.minX) * cell,
            top: (tip.y - bounds.minY) * cell,
            transition: "left 90ms linear, top 90ms linear",
          }}
        />
      ) : null}
    </div>
  );
}

function Marks({
  count,
  current,
  filled,
  wide = false,
}: {
  count: number;
  /** The mark that is in progress. -1 when nothing is in progress. */
  current: number;
  /** How many marks are already complete. */
  filled: number;
  /** Layers are short bars. Poses stay squares. */
  wide?: boolean;
}) {
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={`inline-block ${wide ? "h-1 w-2" : "h-1.5 w-1.5"} ${
            index === current ? "bg-accent" : index < filled ? "bg-ink" : "bg-line"
          }`}
        />
      ))}
    </span>
  );
}

function Scene({ cursor, scale }: { cursor: Cursor; scale: number }) {
  return (
    <>
      {spots.map((spot) => {
        const index = demoAssets.findIndex((asset) => asset.name === spot.name);
        const asset = demoAssets[index];
        if (!asset || index < 0) return null;
        const shown = shownFor(index, cursor, asset);
        if (!shown.visible) return null;
        const pose = asset.poses[shown.pose];
        return (
          <div key={spot.name} className={`absolute ${spot.className}`}>
            <LiveSprite
              asset={asset}
              shown={shown}
              cell={Math.max(4, Math.round(spot.cell * scale))}
            />
            <p className="mt-1 flex items-center justify-center gap-1.5 text-pixel-mono text-muted">
              <span className={shown.drawing ? "text-accent" : "text-muted"}>
                {spot.name}
              </span>
              <span>{pose?.name}</span>
              <Marks
                count={asset.poses.length}
                current={shown.pose}
                filled={shown.pose}
              />
              <Marks
                count={pose?.layers.length ?? 0}
                current={shown.drawing ? shown.layersDone : -1}
                filled={shown.layersDone}
                wide
              />
            </p>
          </div>
        );
      })}
    </>
  );
}

/**
 * The signed-out slide. Branding stays on flat paper. The picture keeps the
 * grid, with each asset in a place that matches what it is.
 */
export function AuthDemo({ compact = false }: { compact?: boolean }) {
  const cursor = useCastPlayback();

  if (compact) {
    return (
      <aside
        aria-label="A cast of characters drawing themselves"
        className="bg-paper px-4 pt-4"
      >
        <Wordmark flight />
        <p className="mt-3 max-w-[28ch] text-pixel-body text-muted">
          One palette. A whole cast.
        </p>
        <div className="relative mt-2 h-60">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_top_left,black_0%,black_42%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_top_left,black_0%,black_42%,transparent_100%)]"
          >
            <AuthGrid />
          </div>
          <Scene cursor={cursor} scale={0.5} />
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="A cast of characters drawing themselves"
      className="relative h-dvh min-h-0 overflow-hidden bg-paper"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_top_left,black_0%,black_22%,transparent_68%)] [-webkit-mask-image:linear-gradient(to_top_left,black_0%,black_22%,transparent_68%)]"
      >
        <AuthGrid />
      </div>
      <div className="relative flex h-full flex-col px-8 py-8">
        {/* `self-start` keeps the wordmark's box the size of the mark and the
            label. A column flex item stretches to the full width by default,
            and that stretched box would be what the auth → home morph scales,
            dragging the glyphs sideways on the way to the bar. */}
        <div className="self-start">
          <Wordmark size="display" flight />
        </div>
        <div className="mt-10 max-w-md">
          <p className="text-pixel-mono text-accent">Sprite families</p>
          <p className="mt-3 max-w-[14ch] text-pixel-hero text-balance text-ink">
            One palette. A whole cast.
          </p>
          <p className="mt-4 max-w-[36ch] text-pixel-body text-muted">
            A project keeps its colours and its style guide together. Describe the knight,
            then the potion, then the walk. They still belong to each other.
          </p>
        </div>
      </div>
      <Scene cursor={cursor} scale={1} />
    </aside>
  );
}

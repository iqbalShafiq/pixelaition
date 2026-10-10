import {
  Eraser,
  Grid3X3,
  Hand,
  Layers,
  PaintBucket,
  Pencil,
  Pipette,
  Slash,
  Square,
  SquareDashed,
} from "lucide-react";
import type { ComponentType } from "react";
import type { Tool } from "./pixel-canvas.js";
import { Button, IconButton, Panel, Separator } from "./ui.js";

const stroke = 2;
const size = 16;

const tools: Array<{
  id: Tool;
  label: string;
  key: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { id: "select", label: "Select", key: "V", icon: SquareDashed },
  { id: "pencil", label: "Pencil", key: "B", icon: Pencil },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "fill", label: "Fill", key: "G", icon: PaintBucket },
  { id: "picker", label: "Eyedropper", key: "I", icon: Pipette },
  { id: "line", label: "Line", key: "L", icon: Slash },
  { id: "rect", label: "Rectangle", key: "R", icon: Square },
  { id: "pan", label: "Pan", key: "H", icon: Hand },
];

/** A pixel-art dot: round enough to read as a circle, drawn on a square grid. */
const dotMaps: Record<number, string[]> = {
  1: [".XXX.", "XXXXX", "XXXXX", "XXXXX", ".XXX."],
  2: ["..XXX..", ".XXXXX.", "XXXXXXX", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX.."],
  3: [
    "...XXX...",
    ".XXXXXXX.",
    ".XXXXXXX.",
    "XXXXXXXXX",
    "XXXXXXXXX",
    "XXXXXXXXX",
    ".XXXXXXX.",
    ".XXXXXXX.",
    "...XXX...",
  ],
};

function PixelDot({ level }: { level: number }) {
  const map = dotMaps[level] ?? dotMaps[1] ?? [];
  const n = map.length;
  return (
    <svg
      aria-hidden
      width={n * 2}
      height={n * 2}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
    >
      {map.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "X" ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill="currentColor"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function Toolbar({
  tool,
  brushSize,
  selectionActive,
  locked,
  onTool,
  onBrush,
  onSelectionFill,
  onSelectionClear,
  onDeselect,
}: {
  tool: Tool;
  brushSize: number;
  selectionActive: boolean;
  locked: boolean;
  onTool: (tool: Tool) => void;
  onBrush: (size: number) => void;
  onSelectionFill: () => void;
  onSelectionClear: () => void;
  onDeselect: () => void;
}) {
  return (
    <div className="relative flex items-center gap-1 overflow-x-auto bg-paper px-2 py-2">
      {tools.map((entry) => {
        const Icon = entry.icon;
        return (
          <IconButton
            key={entry.id}
            label={entry.label}
            hint={entry.key}
            active={tool === entry.id}
            onClick={() => onTool(entry.id)}
          >
            <Icon size={size} strokeWidth={stroke} />
          </IconButton>
        );
      })}

      {[1, 2, 3].map((value) => (
        <IconButton
          key={value}
          label={`Brush size ${value}`}
          hint="[ or ]"
          subtle
          active={brushSize === value}
          onClick={() => onBrush(value)}
        >
          <PixelDot level={value} />
        </IconButton>
      ))}

      {selectionActive ? (
        <>
          <Separator vertical />
          <Button
            tone="ghost"
            className="px-2 py-1.5 text-[11px]"
            disabled={locked}
            onClick={onSelectionFill}
          >
            Fill
          </Button>
          <Button
            tone="ghost"
            className="px-2 py-1.5 text-[11px]"
            disabled={locked}
            onClick={onSelectionClear}
          >
            Clear
          </Button>
          <Button tone="quiet" className="px-2 py-1.5 text-[11px]" onClick={onDeselect}>
            Deselect
          </Button>
        </>
      ) : null}
    </div>
  );
}
/** Display switches live in the right rail, the way editors separate them. */
export function ViewPanel({
  grid,
  checker,
  onion,
  onGrid,
  onChecker,
  onOnion,
}: {
  grid: boolean;
  checker: boolean;
  onion: boolean;
  onGrid: (next: boolean) => void;
  onChecker: (next: boolean) => void;
  onOnion: (next: boolean) => void;
}) {
  return (
    <Panel title="View">
      <div className="flex items-center gap-1">
        <IconButton label="Grid" active={grid} onClick={() => onGrid(!grid)}>
          <Grid3X3 size={15} strokeWidth={2} />
        </IconButton>
        <IconButton
          label="Transparency"
          active={checker}
          onClick={() => onChecker(!checker)}
        >
          <SquareDashed size={15} strokeWidth={2} />
        </IconButton>
        <IconButton label="Onion skin" active={onion} onClick={() => onOnion(!onion)}>
          <Layers size={15} strokeWidth={2} />
        </IconButton>
      </div>
    </Panel>
  );
}

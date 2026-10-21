import type { ComponentType } from "react";
import type { Tool } from "./pixel-canvas.js";
import {
  Eraser,
  Fill,
  Grid,
  Hand,
  Layers,
  Line,
  Pencil,
  Picker,
  Select,
  Square,
  Text,
  Transparency,
  type IconProps,
} from "./pixel-icons.js";
import { Button, IconButton, Panel, Separator } from "./ui.js";

const tools: Array<{
  id: Tool;
  label: string;
  key: string;
  icon: ComponentType<IconProps>;
}> = [
  { id: "select", label: "Select", key: "V", icon: Select },
  { id: "pencil", label: "Pencil", key: "B", icon: Pencil },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "fill", label: "Fill", key: "G", icon: Fill },
  { id: "picker", label: "Eyedropper", key: "I", icon: Picker },
  { id: "line", label: "Line", key: "L", icon: Line },
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
  onAddText,
  addTextDisabled,
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
  onAddText?: () => void;
  addTextDisabled?: boolean;
}) {
  return (
    <div className="relative flex min-w-0 items-center gap-1 overflow-x-auto bg-panel">
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
            <Icon />
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

      {onAddText ? (
        <>
          <Separator vertical />
          <IconButton label="Add text" disabled={addTextDisabled} onClick={onAddText}>
            <Text />
          </IconButton>
        </>
      ) : null}

      {selectionActive ? (
        <>
          <Separator vertical />
          <Button
            tone="ghost"
            className="px-2 py-1.5 text-pixel-label"
            disabled={locked}
            onClick={onSelectionFill}
          >
            Fill
          </Button>
          <Button
            tone="ghost"
            className="px-2 py-1.5 text-pixel-label"
            disabled={locked}
            onClick={onSelectionClear}
          >
            Clear
          </Button>
          <Button
            tone="quiet"
            className="px-2 py-1.5 text-pixel-label"
            onClick={onDeselect}
          >
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
  zones,
  onZones,
}: {
  grid: boolean;
  checker: boolean;
  onion: boolean;
  onGrid: (next: boolean) => void;
  onChecker: (next: boolean) => void;
  onOnion: (next: boolean) => void;
  /** Scene-backed frames show safe-zone visibility instead of pixel layers. */
  zones?: boolean;
  onZones?: (next: boolean) => void;
}) {
  if (onZones) {
    return (
      <Panel title="View">
        <div className="flex items-center gap-1">
          <Button
            tone={zones ? "solid" : "ghost"}
            className="px-2 py-1 text-pixel-label"
            onClick={() => onZones(!zones)}
          >
            Safe zones
          </Button>
          <span className="text-pixel-mono text-muted">guides only</span>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="View">
      <div className="flex items-center gap-1">
        <IconButton label="Grid" active={grid} onClick={() => onGrid(!grid)}>
          <Grid />
        </IconButton>
        <IconButton
          label="Transparency"
          active={checker}
          onClick={() => onChecker(!checker)}
        >
          <Transparency />
        </IconButton>
        <IconButton label="Onion skin" active={onion} onClick={() => onOnion(!onion)}>
          <Layers />
        </IconButton>
      </div>
    </Panel>
  );
}

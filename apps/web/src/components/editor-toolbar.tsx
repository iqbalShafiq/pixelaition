import {
  Eraser,
  Hand,
  Minus,
  PaintBucket,
  Pencil,
  Pipette,
  Plus,
  Slash,
  Square,
  SquareDashed,
} from "lucide-react";
import type { ComponentType } from "react";
import type { Tool } from "./pixel-canvas.js";
import { Button, IconButton, Separator, Toggle } from "./ui.js";

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

export function Toolbar({
  tool,
  brushSize,
  zoom,
  grid,
  checker,
  onion,
  selectionActive,
  locked,
  onTool,
  onBrush,
  onZoom,
  onFit,
  onActualSize,
  onGrid,
  onChecker,
  onOnion,
  onSelectionFill,
  onSelectionClear,
  onDeselect,
}: {
  tool: Tool;
  brushSize: number;
  zoom: number;
  grid: boolean;
  checker: boolean;
  onion: boolean;
  selectionActive: boolean;
  locked: boolean;
  onTool: (tool: Tool) => void;
  onBrush: (size: number) => void;
  onZoom: (direction: 1 | -1) => void;
  onFit: () => void;
  onActualSize: () => void;
  onGrid: (next: boolean) => void;
  onChecker: (next: boolean) => void;
  onOnion: (next: boolean) => void;
  onSelectionFill: () => void;
  onSelectionClear: () => void;
  onDeselect: () => void;
}) {
  return (
    <div className="relative flex items-center gap-1 overflow-x-auto border-b-2 border-line bg-paper px-2 py-2">
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

      <Separator vertical />

      {[1, 2, 3].map((value) => (
        <IconButton
          key={value}
          label={`Brush size ${value}`}
          subtle
          active={brushSize === value}
          onClick={() => onBrush(value)}
        >
          <span className="font-mono text-[11px]">{value}</span>
        </IconButton>
      ))}

      <Separator vertical />

      <IconButton label="Zoom out" onClick={() => onZoom(-1)}>
        <Minus size={size} strokeWidth={stroke} />
      </IconButton>
      <span className="w-14 shrink-0 border-2 border-line bg-field py-1 text-center font-mono text-[11px] text-muted">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onClick={() => onZoom(1)}>
        <Plus size={size} strokeWidth={stroke} />
      </IconButton>
      <Button
        tone="ghost"
        className="px-2 py-1.5 text-[11px]"
        aria-label="Fit to view"
        title="Fit to view (Ctrl+0)"
        onClick={onFit}
      >
        Fit
      </Button>
      <Button
        tone="ghost"
        className="px-2 py-1.5 text-[11px]"
        aria-label="Actual size"
        title="Actual size (Ctrl+1)"
        onClick={onActualSize}
      >
        1:1
      </Button>

      <Separator vertical />

      <Toggle label="Grid" checked={grid} onChange={onGrid} />
      <Toggle label="Checker" checked={checker} onChange={onChecker} />
      <Toggle label="Onion" checked={onion} onChange={onOnion} />

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

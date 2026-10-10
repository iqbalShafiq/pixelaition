import type { ComponentType, SVGProps } from "react";
import type { Tool } from "./pixel-canvas.js";
import {
  EraserIcon,
  FillIcon,
  LineIcon,
  PanIcon,
  PencilIcon,
  PickerIcon,
  RectIcon,
  SelectIcon,
} from "./tool-icons.js";
import { Button, IconButton, Separator, Toggle } from "./ui.js";

const tools: Array<{
  id: Tool;
  label: string;
  key: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { id: "select", label: "Select", key: "V", icon: SelectIcon },
  { id: "pencil", label: "Pencil", key: "B", icon: PencilIcon },
  { id: "eraser", label: "Eraser", key: "E", icon: EraserIcon },
  { id: "fill", label: "Fill", key: "G", icon: FillIcon },
  { id: "picker", label: "Eyedropper", key: "I", icon: PickerIcon },
  { id: "line", label: "Line", key: "L", icon: LineIcon },
  { id: "rect", label: "Rectangle", key: "R", icon: RectIcon },
  { id: "pan", label: "Pan", key: "H", icon: PanIcon },
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
    <div className="relative flex items-center gap-0.5 overflow-x-auto border-b border-line bg-paper px-2 py-1.5">
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

      <Separator vertical />

      <span className="shrink-0 px-1 font-mono text-[10px] text-muted">brush</span>
      {[1, 2, 3].map((size) => (
        <IconButton
          key={size}
          label={`Brush size ${size}`}
          subtle
          active={brushSize === size}
          onClick={() => onBrush(size)}
        >
          <span className="text-[11px]">{size}</span>
        </IconButton>
      ))}

      <Separator vertical />

      <IconButton label="Zoom out" onClick={() => onZoom(-1)}>
        −
      </IconButton>
      <span className="w-12 shrink-0 text-center font-mono text-[11px] text-muted">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onClick={() => onZoom(1)}>
        +
      </IconButton>
      <IconButton label="Fit to view" hint="Ctrl+0" onClick={onFit}>
        Fit
      </IconButton>
      <IconButton label="Actual size" hint="Ctrl+1" onClick={onActualSize}>
        1:1
      </IconButton>

      <Separator vertical />

      <Toggle label="Grid" checked={grid} onChange={onGrid} />
      <Toggle label="Checker" checked={checker} onChange={onChecker} />
      <Toggle label="Onion" checked={onion} onChange={onOnion} />

      {selectionActive ? (
        <>
          <Separator vertical />
          <Button
            tone="ghost"
            className="px-2 py-1 text-xs"
            disabled={locked}
            onClick={onSelectionFill}
          >
            Fill selection
          </Button>
          <Button
            tone="ghost"
            className="px-2 py-1 text-xs"
            disabled={locked}
            onClick={onSelectionClear}
          >
            Clear
          </Button>
          <Button
            tone="quiet"
            className="px-2 py-1 text-xs text-muted"
            onClick={onDeselect}
          >
            Deselect
          </Button>
        </>
      ) : null}
    </div>
  );
}

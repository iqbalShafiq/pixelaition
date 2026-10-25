import type { ComponentType } from "react";
import type { BrushShape, Tool } from "./pixel-canvas.js";
import {
  Check,
  Circle,
  Clipboard,
  Close,
  Copy,
  Eraser,
  Eye,
  Fill,
  Grid,
  Hand,
  Layers,
  Line,
  Pencil,
  Picker,
  Redo,
  Search,
  Select,
  Square,
  Text,
  Transparency,
  Trash,
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
  { id: "lasso", label: "Lasso", key: "Q", icon: Select },
  { id: "wand", label: "Magic wand", key: "W", icon: Search },
  { id: "tile", label: "Tile stamp", key: "T", icon: Grid },
  { id: "pencil", label: "Pencil", key: "B", icon: Pencil },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "fill", label: "Fill", key: "G", icon: Fill },
  { id: "picker", label: "Eyedropper", key: "I", icon: Picker },
  { id: "line", label: "Line", key: "L", icon: Line },
  { id: "rect", label: "Rectangle", key: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { id: "pan", label: "Pan", key: "H", icon: Hand },
];

export function Toolbar({
  tool,
  brushSize,
  brushShape = "square",
  pixelPerfect = false,
  dynamics = false,
  jitter = false,
  selectionActive,
  clipboardReady,
  locked,
  onTool,
  onBrush,
  onBrushShape,
  onPixelPerfect,
  onDynamics,
  onJitter,
  onSelectionFill,
  onSelectionClear,
  onSelectionBrush,
  brushActive = false,
  onSelectionCopy,
  onSelectionCut,
  onSelectionPaste,
  onSelectionFlip,
  onSelectionRotate,
  onSelectAll,
  onDeselect,
  onAddText,
  addTextDisabled,
}: {
  tool: Tool;
  brushSize: number;
  brushShape?: BrushShape;
  pixelPerfect?: boolean;
  dynamics?: boolean;
  jitter?: boolean;
  selectionActive: boolean;
  clipboardReady: boolean;
  locked: boolean;
  onTool: (tool: Tool) => void;
  onBrush: (size: number) => void;
  onBrushShape?: (shape: BrushShape) => void;
  onPixelPerfect?: (next: boolean) => void;
  onDynamics?: (next: boolean) => void;
  onJitter?: (next: boolean) => void;
  onSelectionFill: () => void;
  onSelectionClear: () => void;
  onSelectionBrush?: () => void;
  brushActive?: boolean;
  onSelectionCopy?: () => void;
  onSelectionCut?: () => void;
  onSelectionPaste?: () => void;
  onSelectionFlip?: (axis: "horizontal" | "vertical") => void;
  onSelectionRotate?: () => void;
  onSelectAll?: () => void;
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

      <div
        className="flex h-9 items-end gap-1 border-2 border-line bg-field px-1.5 py-1"
        role="group"
        aria-label="Brush level"
      >
        <Pencil className="mb-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
        <div className="flex h-full items-end gap-0.5">
          {[1, 2, 3, 4, 6, 8].map((value, index) => {
            const height = 4 + index * 3;
            const active = brushSize >= value;
            return (
              <button
                key={value}
                type="button"
                aria-label={`Brush level ${value}`}
                aria-pressed={brushSize === value}
                title={`Brush level ${value} · [ or ]`}
                onClick={() => onBrush(value)}
                className={`w-2 border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent ${
                  active
                    ? index === 5
                      ? "border-accent bg-erase"
                      : "border-accent bg-accent"
                    : "border-line bg-raised hover:border-line-strong hover:bg-accent/30"
                } ${brushSize === value ? "ring-1 ring-accent ring-offset-1 ring-offset-field" : ""}`}
                style={{ height }}
              />
            );
          })}
        </div>
        <span className="mb-0.5 w-4 text-right text-pixel-mono text-[9px] text-muted">
          {brushSize}
        </span>
      </div>
      {onBrushShape ? (
        <>
          <IconButton
            label="Square brush"
            subtle
            active={brushShape === "square"}
            onClick={() => onBrushShape("square")}
          >
            <Square />
          </IconButton>
          <IconButton
            label="Round brush"
            subtle
            active={brushShape === "circle"}
            onClick={() => onBrushShape("circle")}
          >
            <Circle />
          </IconButton>
          <IconButton
            label="Spray brush"
            subtle
            active={brushShape === "spray"}
            onClick={() => onBrushShape("spray")}
          >
            <Grid />
          </IconButton>
        </>
      ) : null}
      {onPixelPerfect ? (
        <IconButton
          label="Pixel-perfect strokes"
          hint="Trim L-shaped corners as you draw"
          subtle
          active={pixelPerfect}
          onClick={() => onPixelPerfect(!pixelPerfect)}
        >
          <Check />
        </IconButton>
      ) : null}

      {onDynamics ? (
        <IconButton
          label="Pen pressure"
          hint="Vary the brush size with a pen's pressure"
          subtle
          active={dynamics}
          onClick={() => onDynamics(!dynamics)}
        >
          <Pencil />
        </IconButton>
      ) : null}

      {onJitter ? (
        <IconButton
          label="Brush jitter"
          hint="Scatter stroke cells by one pixel"
          subtle
          active={jitter}
          onClick={() => onJitter(!jitter)}
        >
          <Transparency />
        </IconButton>
      ) : null}

      {onAddText ? (
        <>
          <Separator vertical />
          <IconButton label="Add text" disabled={addTextDisabled} onClick={onAddText}>
            <Text />
          </IconButton>
        </>
      ) : null}

      <Separator vertical />
      <IconButton
        label="Select all"
        hint="Ctrl+A"
        disabled={locked}
        onClick={onSelectAll}
      >
        <Select />
      </IconButton>
      {selectionActive ? (
        <>
          <IconButton label="Fill selection" disabled={locked} onClick={onSelectionFill}>
            <Fill />
          </IconButton>
          <IconButton
            label="Clear selection"
            disabled={locked}
            onClick={onSelectionClear}
          >
            <Eraser />
          </IconButton>
          {onSelectionBrush ? (
            <IconButton
              label={brushActive ? "Stop painting on selection" : "Paint on selection"}
              active={brushActive}
              disabled={locked}
              onClick={onSelectionBrush}
            >
              <Pencil />
            </IconButton>
          ) : null}
          <IconButton label="Copy selection" disabled={locked} onClick={onSelectionCopy}>
            <Copy />
          </IconButton>
          <IconButton label="Cut selection" disabled={locked} onClick={onSelectionCut}>
            <Trash />
          </IconButton>
          <IconButton
            label="Paste at selection"
            disabled={locked || !clipboardReady}
            onClick={onSelectionPaste}
          >
            <Clipboard />
          </IconButton>
          <IconButton
            label="Flip selection horizontally"
            disabled={locked}
            onClick={() => onSelectionFlip?.("horizontal")}
          >
            <Square />
          </IconButton>
          <IconButton
            label="Flip selection vertically"
            disabled={locked}
            onClick={() => onSelectionFlip?.("vertical")}
          >
            <Square />
          </IconButton>
          <IconButton
            label="Rotate selection"
            disabled={locked}
            onClick={onSelectionRotate}
          >
            <Redo />
          </IconButton>
          <IconButton label="Deselect" onClick={onDeselect}>
            <Close />
          </IconButton>
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
  symmetry = "none",
  onGrid,
  onChecker,
  onOnion,
  onSymmetry,
  zones,
  onZones,
  onTile,
  onReference,
  onClearReference,
  referenceActive = false,
}: {
  grid: boolean;
  checker: boolean;
  onion: boolean;
  symmetry?: "none" | "x" | "y";
  onGrid: (next: boolean) => void;
  onChecker: (next: boolean) => void;
  onOnion: (next: boolean) => void;
  onSymmetry?: (next: "none" | "x" | "y") => void;
  /** Scene-backed frames show safe-zone visibility instead of pixel layers. */
  zones?: boolean;
  onZones?: (next: boolean) => void;
  onTile?: () => void;
  onReference?: () => void;
  onClearReference?: () => void;
  referenceActive?: boolean;
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
        {onTile ? (
          <IconButton label="Tile preview" subtle onClick={onTile}>
            <Grid />
          </IconButton>
        ) : null}
        {onReference ? (
          <IconButton
            label={referenceActive ? "Clear reference" : "Reference image"}
            subtle
            active={referenceActive}
            onClick={referenceActive ? onClearReference : onReference}
          >
            <Eye />
          </IconButton>
        ) : null}
      </div>
      {onSymmetry ? (
        <div className="mt-1 flex items-center gap-1">
          <span className="text-pixel-mono text-muted">Mirror</span>
          {(["none", "x", "y"] as const).map((axis) => (
            <Button
              key={axis}
              tone={symmetry === axis ? "solid" : "ghost"}
              className="px-2 py-1 text-pixel-mono"
              onClick={() => onSymmetry(axis)}
            >
              {axis === "none" ? "Off" : axis.toUpperCase()}
            </Button>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

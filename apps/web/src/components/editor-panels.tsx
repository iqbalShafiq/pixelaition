import type { FrameBuffer } from "@pixelaition/pixel";
import { IconButton, Panel, TextInput } from "./ui.js";
import type { FrameDto } from "../lib/types.js";

export function FrameList({
  frames,
  activeId,
  playing,
  onSelect,
  onTogglePlay,
  onAdd,
  onDuplicate,
  onRename,
  onDelete,
}: {
  frames: FrameDto[];
  activeId: string | null;
  playing: boolean;
  onSelect: (frameId: string) => void;
  onTogglePlay: () => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onRename: (frameId: string, name: string) => void;
  onDelete: () => void;
}) {
  const active = frames.find((frame) => frame.id === activeId);
  return (
    <Panel
      title="Frames"
      action={
        <div className="flex gap-1">
          <IconButton label="Add frame" onClick={onAdd}>
            +
          </IconButton>
          <IconButton label="Duplicate frame" onClick={onDuplicate} disabled={!active}>
            ⧉
          </IconButton>
          <IconButton label="Delete frame" onClick={onDelete} disabled={!active}>
            −
          </IconButton>
        </div>
      }
    >
      <ul className="max-h-48 overflow-auto">
        {frames.map((frame) => (
          <li key={frame.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(frame.id)}
              aria-current={frame.id === activeId}
              className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
                frame.id === activeId ? "bg-paper text-accent" : "text-ink hover:bg-paper"
              }`}
            >
              {frame.name}
            </button>
          </li>
        ))}
      </ul>
      {active ? (
        <TextInput
          value={active.name}
          aria-label="Rename frame"
          onChange={(event) => onRename(active.id, event.target.value)}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <IconButton
          label={playing ? "Stop playback" : "Play frames"}
          onClick={onTogglePlay}
        >
          {playing ? "■" : "▶"}
        </IconButton>
        <span className="font-mono text-[11px] text-muted">
          {frames.length} frame{frames.length === 1 ? "" : "s"}
        </span>
      </div>
    </Panel>
  );
}

export function LayerList({
  buffer,
  activeId,
  onSelect,
  onToggleVisible,
  onAdd,
  onRename,
  onDelete,
}: {
  buffer: FrameBuffer | undefined;
  activeId: string;
  onSelect: (layerId: string) => void;
  onToggleVisible: (layerId: string, visible: boolean) => void;
  onAdd: () => void;
  onRename: (layerId: string, name: string) => void;
  onDelete: () => void;
}) {
  const layers = buffer?.layers ?? [];
  const active = layers.find((layer) => layer.id === activeId);
  return (
    <Panel
      title="Layers"
      action={
        <IconButton label="Add layer" onClick={onAdd} disabled={layers.length >= 4}>
          +
        </IconButton>
      }
    >
      <ul className="max-h-32 overflow-auto">
        {layers.map((layer) => (
          <li key={layer.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={layer.visible}
              aria-label={`Show ${layer.name}`}
              onChange={(event) => onToggleVisible(layer.id, event.target.checked)}
              className="ml-1 h-3.5 w-3.5 accent-[#e8ff6a]"
            />
            <button
              type="button"
              onClick={() => onSelect(layer.id)}
              aria-current={layer.id === activeId}
              className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
                layer.id === activeId ? "bg-paper text-accent" : "text-ink hover:bg-paper"
              }`}
            >
              {layer.name}
            </button>
          </li>
        ))}
      </ul>
      {active ? (
        <TextInput
          value={active.name}
          aria-label="Rename layer"
          onChange={(event) => onRename(active.id, event.target.value)}
        />
      ) : null}
      <div>
        <IconButton label="Delete layer" onClick={onDelete} disabled={layers.length <= 1}>
          −
        </IconButton>
      </div>
    </Panel>
  );
}

export function PalettePanel({
  palette,
  color,
  usedColors,
  onPick,
  onAdd,
  onResize,
  width,
  height,
}: {
  palette: string[];
  color: number;
  usedColors: number;
  onPick: (index: number) => void;
  onAdd: (hex: string) => void;
  onResize: (width: number, height: number) => void;
  width: number;
  height: number;
}) {
  return (
    <Panel title="Palette">
      <div className="flex flex-wrap gap-1.5">
        {palette.map((swatch, index) => (
          <button
            key={`${swatch}-${index}`}
            type="button"
            aria-label={`Color ${index}`}
            aria-pressed={color === index}
            onClick={() => onPick(index)}
            className={`h-7 w-7 rounded border-2 ${
              color === index ? "border-accent" : "border-line"
            } ${index === 0 ? "checkerboard" : ""}`}
            style={index === 0 ? undefined : { background: swatch }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Add color"
          onChange={(event) => onAdd(event.target.value)}
          className="h-7 w-7 rounded border border-line bg-paper"
        />
        <span className="font-mono text-[11px] text-muted">{usedColors} used</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={8}
          max={128}
          value={width}
          aria-label="Canvas width"
          onChange={(event) => onResize(Number(event.target.value) || width, height)}
          className="w-16 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs"
        />
        <span className="text-muted">×</span>
        <input
          type="number"
          min={8}
          max={128}
          value={height}
          aria-label="Canvas height"
          onChange={(event) => onResize(width, Number(event.target.value) || height)}
          className="w-16 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs"
        />
      </div>
    </Panel>
  );
}

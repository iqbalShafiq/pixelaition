import type { FrameBuffer, StyleGuide } from "@pixelaition/pixel";
import { Check, Copy, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Panel,
  TextInput,
} from "./ui.js";
import type { FrameDto } from "../lib/types.js";

/**
 * Text that writes through on every keystroke issues a request per character and
 * lets responses land out of order. Commit on blur or Enter instead.
 */
export function CommitInput({
  value,
  label,
  inputMode,
  className,
  onCommit,
}: {
  value: string;
  label: string;
  inputMode?: "numeric" | "text";
  className?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  function commit() {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  }
  return (
    <label className="grid gap-1">
      <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
        {label}
      </span>
      <TextInput
        value={draft}
        inputMode={inputMode}
        placeholder={label}
        className={className}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(value);
        }}
      />
    </label>
  );
}

/* ------------------------------------------------------------------ frames */

export function FramePanel({
  frames,
  activeId,
  playing,
  locked,
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
  locked: boolean;
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
        <IconButton label="Add frame" size="sm" disabled={locked} onClick={onAdd}>
          <Plus size={14} strokeWidth={2.5} />
        </IconButton>
      }
    >
      {frames.length === 0 ? (
        <EmptyState
          title="No frames"
          body="A frame holds the pixels for one state of this asset."
        />
      ) : (
        <ul className="grid gap-1">
          {frames.map((frame, index) => {
            const current = frame.id === activeId;
            return (
              <li key={frame.id}>
                <button
                  type="button"
                  onClick={() => onSelect(frame.id)}
                  aria-current={current}
                  className={`flex w-full items-center gap-2 border-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                    current
                      ? "border-accent bg-raised text-accent"
                      : "border-transparent text-ink hover:border-line hover:bg-raised"
                  }`}
                >
                  <span className="font-mono text-[10px] text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="truncate">{frame.name}</span>
                  {current && locked ? (
                    <span className="ml-auto font-mono text-[10px]">drawing</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {active && !locked ? (
        <CommitInput
          value={active.name}
          label="Rename frame"
          onCommit={(name) => onRename(active.id, name)}
        />
      ) : null}

      <div className="flex items-center gap-1">
        <IconButton
          label={playing ? "Stop playback" : "Play frames"}
          size="sm"
          disabled={frames.length < 2}
          onClick={onTogglePlay}
        >
          {playing ? (
            <Square size={13} strokeWidth={2.5} />
          ) : (
            <Play size={13} strokeWidth={2.5} />
          )}
        </IconButton>
        <span className="font-mono text-[10px] text-muted">
          {frames.length} frame{frames.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto">
          <Menu label="Frame actions">
            <MenuItem disabled={locked || !active} onClick={onDuplicate}>
              <Copy size={13} strokeWidth={2} /> Duplicate
            </MenuItem>
            <MenuSeparator className="my-1 h-0.5 bg-line" />
            <MenuItem disabled={locked || !active} onClick={onDelete}>
              <Trash2 size={13} strokeWidth={2} /> Delete
            </MenuItem>
          </Menu>
        </span>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ layers */

export function LayerPanel({
  buffer,
  activeId,
  locked,
  onSelect,
  onToggleVisible,
  onAdd,
  onRename,
  onDelete,
}: {
  buffer: FrameBuffer | undefined;
  activeId: string;
  locked: boolean;
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
        <IconButton
          label="Add layer"
          size="sm"
          disabled={locked || layers.length >= 4}
          onClick={onAdd}
        >
          <Plus size={14} strokeWidth={2.5} />
        </IconButton>
      }
    >
      <ul className="grid gap-1">
        {layers.map((layer) => {
          const current = layer.id === activeId;
          return (
            <li key={layer.id} className="flex items-center gap-2">
              <Checkbox
                label={`Show ${layer.name}`}
                hideLabel
                checked={layer.visible}
                disabled={locked}
                onChange={(next) => onToggleVisible(layer.id, next)}
              />
              <button
                type="button"
                onClick={() => onSelect(layer.id)}
                aria-current={current}
                aria-label={`Select layer ${layer.name}`}
                className={`min-w-0 flex-1 truncate border-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                  current
                    ? "border-accent bg-raised text-accent"
                    : "border-transparent text-ink hover:border-line hover:bg-raised"
                } ${layer.visible ? "" : "opacity-55"}`}
              >
                {layer.name}
              </button>
            </li>
          );
        })}
      </ul>
      {active && !locked ? (
        <CommitInput
          value={active.name}
          label="Rename layer"
          onCommit={(name) => onRename(active.id, name)}
        />
      ) : null}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted">
          {layers.length} of 4 layers
        </span>
        <Menu label="Layer actions">
          <MenuItem disabled={locked || layers.length <= 1} onClick={onDelete}>
            <Trash2 size={13} strokeWidth={2} /> Delete layer
          </MenuItem>
        </Menu>
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------------------- palette */

export function PalettePanel({
  palette,
  color,
  usedColors,
  maxColors,
  onPick,
  onAdd,
}: {
  palette: string[];
  color: number;
  usedColors: number;
  maxColors: number;
  onPick: (index: number) => void;
  onAdd: (hex: string) => void;
}) {
  const [draft, setDraft] = useState("#a7f070");
  const over = usedColors > maxColors;
  return (
    <Panel title="Palette">
      <div className="grid grid-cols-8 gap-1">
        {palette.map((swatch, index) => (
          <button
            key={`${swatch}-${index}`}
            type="button"
            aria-label={`Color ${index} ${index === 0 ? "transparent" : swatch}`}
            aria-pressed={color === index}
            onClick={() => onPick(index)}
            className={`aspect-square border-2 transition-colors duration-150 ${
              color === index ? "border-accent" : "border-line hover:border-line-strong"
            } ${index === 0 ? "checkerboard" : ""}`}
            style={index === 0 ? undefined : { background: swatch }}
          />
        ))}
      </div>
      <p className={`font-mono text-[10px] ${over ? "text-erase" : "text-muted"}`}>
        {usedColors} of {maxColors} colors used
        {over ? " · over the limit" : ""}
      </p>
      <Field label="Add color" htmlFor="palette-new-color">
        <div className="flex gap-1.5">
          <input
            id="palette-new-color"
            type="color"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-10 w-12 shrink-0 border-2 border-line bg-field"
          />
          <Button
            tone="ghost"
            className="flex-1 px-2 py-1.5 text-[11px]"
            disabled={palette.length >= 33 || palette.includes(draft)}
            onClick={() => onAdd(draft)}
          >
            {palette.includes(draft) ? (
              <>
                <Check size={13} strokeWidth={2.5} /> In palette
              </>
            ) : (
              "Add"
            )}
          </Button>
        </div>
      </Field>
    </Panel>
  );
}

/* ------------------------------------------------------------------- style */

export function StylePanel({
  style,
  width,
  height,
  onResize,
}: {
  style: StyleGuide;
  width: number;
  height: number;
  onResize: (width: number, height: number) => void;
}) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => setW(String(width)), [width]);
  useEffect(() => setH(String(height)), [height]);
  return (
    <Panel title="Style guide">
      <dl className="grid gap-1 font-mono text-[10px]">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted">max colors</dt>
          <dd className="text-ink">{style.maxColors}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted">outline</dt>
          <dd className="flex items-center gap-1.5 text-ink">
            {style.outline}
            <span
              aria-hidden
              className="h-3 w-3 border-2 border-line"
              style={{ background: style.outline }}
            />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted">shadow</dt>
          <dd className="text-ink">{style.shadowDirection}</dd>
        </div>
      </dl>
      {style.notes ? <p className="text-[12px] text-muted">{style.notes}</p> : null}

      <Field label="Canvas size" htmlFor="canvas-width" hint="8 to 128">
        <div className="flex items-center gap-1.5">
          <TextInput
            id="canvas-width"
            value={w}
            inputMode="numeric"
            aria-label="Canvas width"
            placeholder="32"
            className="font-mono text-[13px]"
            onChange={(event) => setW(event.target.value)}
            onBlur={() => {
              const next = Number(w);
              if (next !== width) onResize(next, height);
              else setW(String(width));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setW(String(width));
            }}
          />
          <span className="font-mono text-muted">×</span>
          <TextInput
            id="canvas-height"
            value={h}
            inputMode="numeric"
            aria-label="Canvas height"
            placeholder="32"
            className="font-mono text-[13px]"
            onChange={(event) => setH(event.target.value)}
            onBlur={() => {
              const next = Number(h);
              if (next !== height) onResize(width, next);
              else setH(String(height));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setH(String(height));
            }}
          />
        </div>
      </Field>
      <p className="text-[11px] text-muted">
        The style guide belongs to the project, so every asset in it stays related.
      </p>
    </Panel>
  );
}

import type { FrameBuffer, StyleGuide } from "@pixelaition/pixel";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import {
  Button,
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
      <span className="font-mono text-[9px] tracking-[0.14em] text-muted uppercase">
        {label}
      </span>
      <TextInput
        value={draft}
        inputMode={inputMode}
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
          +
        </IconButton>
      }
    >
      {frames.length === 0 ? (
        <EmptyState
          title="No frames yet"
          body="A frame holds the pixels for one state of this asset."
        />
      ) : (
        <ul className="grid gap-0.5">
          {frames.map((frame, index) => {
            const current = frame.id === activeId;
            return (
              <li key={frame.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect(frame.id)}
                  aria-current={current}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                    current ? "bg-paper text-accent" : "text-ink hover:bg-paper"
                  }`}
                >
                  <span className="font-mono text-[10px] text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="truncate">{frame.name}</span>
                  {current && locked ? (
                    <span className="ml-auto font-mono text-[10px] text-accent">
                      drawing
                    </span>
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
          {playing ? "■" : "▶"}
        </IconButton>
        <span className="font-mono text-[10px] text-muted">
          {frames.length} frame{frames.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto">
          <Menu label="Frame actions">
            <MenuItem disabled={locked || !active} onClick={onDuplicate}>
              Duplicate frame
            </MenuItem>
            <MenuSeparator className="my-1 h-px bg-line" />
            <MenuItem disabled={locked || !active} onClick={onDelete}>
              Delete frame
            </MenuItem>
          </Menu>
        </span>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ layers */

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="1.8" />
      {!open ? <path d="M2.5 13.5l11-11" /> : null}
    </svg>
  );
}

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
          +
        </IconButton>
      }
    >
      <ul className="grid gap-0.5">
        {layers.map((layer) => {
          const current = layer.id === activeId;
          return (
            <li key={layer.id} className="flex items-center gap-1">
              <IconButton
                label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
                size="sm"
                disabled={locked}
                onClick={() => onToggleVisible(layer.id, !layer.visible)}
              >
                <EyeIcon open={layer.visible} />
              </IconButton>
              <button
                type="button"
                onClick={() => onSelect(layer.id)}
                aria-current={current}
                className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
                  current ? "bg-paper text-accent" : "text-ink hover:bg-paper"
                } ${layer.visible ? "" : "opacity-50"}`}
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
            Delete layer
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
  const [draft, setDraft] = useState("#e8ff6a");
  const over = usedColors > maxColors;
  return (
    <Panel title="Palette">
      <div className="grid grid-cols-8 gap-1">
        {palette.map((swatch, index) => {
          const style: CSSProperties = index === 0 ? {} : { background: swatch };
          return (
            <button
              key={`${swatch}-${index}`}
              type="button"
              aria-label={`Color ${index} ${index === 0 ? "transparent" : swatch}`}
              aria-pressed={color === index}
              onClick={() => onPick(index)}
              className={`aspect-square rounded border-2 ${
                color === index ? "border-accent" : "border-line"
              } ${index === 0 ? "checkerboard" : ""}`}
              style={style}
            />
          );
        })}
      </div>
      <p className={`font-mono text-[10px] ${over ? "text-erase" : "text-muted"}`}>
        {usedColors} of {maxColors} colors used
        {over ? " · over the style guide limit" : ""}
      </p>
      <Field label="Add a color" htmlFor="palette-new-color">
        <div className="flex gap-1">
          <input
            id="palette-new-color"
            type="color"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-9 w-11 shrink-0 rounded-md border border-line-strong bg-field"
          />
          <Button
            tone="ghost"
            className="px-2 py-1 text-xs"
            disabled={palette.length >= 33 || palette.includes(draft)}
            onClick={() => onAdd(draft)}
          >
            {palette.includes(draft) ? "Already in" : "Add"}
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
      <dl className="grid gap-1 font-mono text-[10px] text-muted">
        <div className="flex items-baseline justify-between gap-2">
          <dt>max colors</dt>
          <dd className="text-ink">{style.maxColors}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt>outline</dt>
          <dd className="flex items-center gap-1 text-ink">
            {style.outline}
            <span
              aria-hidden
              className="h-3 w-3 rounded-sm border border-line"
              style={{ background: style.outline }}
            />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt>shadow</dt>
          <dd className="text-ink">{style.shadowDirection}</dd>
        </div>
      </dl>
      {style.notes ? <p className="text-[11px] text-muted">{style.notes}</p> : null}
      <Field label="Canvas size" htmlFor="canvas-width" hint="8 to 128">
        <div className="flex items-center gap-1.5">
          <TextInput
            id="canvas-width"
            value={w}
            inputMode="numeric"
            aria-label="Canvas width"
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
          <span className="text-muted">×</span>
          <TextInput
            value={h}
            inputMode="numeric"
            aria-label="Canvas height"
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
      <p className="text-[10px] text-muted">
        The style guide belongs to the project, so every asset in it stays related.
      </p>
    </Panel>
  );
}

import type { FrameBuffer, StyleGuide } from "@pixelaition/pixel";
import { Copy, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
  Popover,
  TextInput,
} from "./ui.js";
import { hexToRgba } from "../lib/color.js";
import { hexToHsv, hsvToHex } from "../lib/hsv.js";
import { base64ToBytes, type FrameDto } from "../lib/types.js";

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

function FrameThumb({
  frame,
  palette,
  size = 36,
}: {
  frame: FrameDto;
  palette: string[];
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const layer = frame.layers.find((item) => item.visible) ?? frame.layers[0];
    if (!layer) return;
    const pixels = base64ToBytes(layer.pixels);
    const width = Math.sqrt(pixels.length);
    if (!Number.isInteger(width)) return;
    canvas.width = width;
    canvas.height = width;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(width, width);
    for (let index = 0; index < pixels.length; index += 1) {
      const value = pixels[index] ?? 0;
      if (value === 0) continue;
      const [r, g, b, a] = hexToRgba(palette[value] ?? "#000000");
      image.data.set([r, g, b, a], index * 4);
    }
    context.putImageData(image, 0, 0);
  }, [frame, palette]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0 border-2 border-line bg-screen"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}

export function FramePanel({
  frames,
  palette,
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
  palette: string[];
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
                  <FrameThumb frame={frame} palette={palette} />
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
  const [hsv, setHsv] = useState(() => hexToHsv("#a7f070"));
  const over = usedColors > maxColors;
  const valid = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(draft);
  const exists = palette.includes(draft.toLowerCase());

  const sweetie16 = [
    "#1a1c2c",
    "#5d275d",
    "#b13e53",
    "#ef7d57",
    "#ffcd75",
    "#a7f070",
    "#38b764",
    "#257179",
    "#29366f",
    "#3b5dc9",
    "#41a6f6",
    "#73eff7",
    "#f4f4f4",
    "#94b0c2",
    "#566c86",
    "#333c57",
  ];

  function setFromHex(hex: string) {
    setDraft(hex);
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setHsv(hexToHsv(hex));
  }
  function setFromHsv(next: { h: number; s: number; v: number }) {
    setHsv(next);
    setDraft(hsvToHex(next.h, next.s, next.v));
  }
  function squareHandlers(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setFromHsv({ ...hsv, s, v });
  }

  return (
    <Panel
      title="Palette"
      action={
        <span className={`font-mono text-[10px] ${over ? "text-erase" : "text-muted"}`}>
          {usedColors}/{maxColors}
        </span>
      }
    >
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
        <Popover
          label="Add a color"
          trigger={
            <span className="grid aspect-square place-items-center font-mono text-[13px]">
              +
            </span>
          }
        >
          <div className="grid gap-2">
            <div
              role="slider"
              aria-label="Saturation and brightness"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={Math.round(hsv.s * 100) / 100}
              aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
              tabIndex={0}
              className="relative h-24 cursor-pointer border-2 border-line-strong"
              style={{
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})`,
              }}
              onKeyDown={(event) => {
                const step = 0.05;
                if (event.key === "ArrowLeft")
                  setFromHsv({ ...hsv, s: Math.max(0, hsv.s - step) });
                else if (event.key === "ArrowRight")
                  setFromHsv({ ...hsv, s: Math.min(1, hsv.s + step) });
                else if (event.key === "ArrowUp")
                  setFromHsv({ ...hsv, v: Math.min(1, hsv.v + step) });
                else if (event.key === "ArrowDown")
                  setFromHsv({ ...hsv, v: Math.max(0, hsv.v - step) });
                else return;
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                squareHandlers(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) squareHandlers(event);
              }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute h-2 w-2 border-2 border-ink"
                style={{
                  left: `calc(${hsv.s * 100}% - 4px)`,
                  top: `calc(${(1 - hsv.v) * 100}% - 4px)`,
                }}
              />
            </div>
            <input
              aria-label="Hue"
              type="range"
              min={0}
              max={359}
              value={Math.round(hsv.h)}
              onChange={(event) => setFromHsv({ ...hsv, h: Number(event.target.value) })}
              className="hue-strip w-full border-2 border-line-strong bg-transparent"
            />
            <div className="grid grid-cols-8 gap-1">
              {sweetie16.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Preset ${preset}`}
                  onClick={() => setFromHex(preset)}
                  className="aspect-square border-2 border-line hover:border-line-strong"
                  style={{ background: preset }}
                />
              ))}
            </div>
            <TextInput
              value={draft}
              aria-label="Hex color"
              className="font-mono text-[13px]"
              onChange={(event) => setFromHex(event.target.value)}
            />
            <Button
              tone="solid"
              disabled={!valid || exists || palette.length >= 33}
              onClick={() => onAdd(draft.toLowerCase())}
            >
              {exists ? "In palette" : "Add color"}
            </Button>
          </div>
        </Popover>
      </div>
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

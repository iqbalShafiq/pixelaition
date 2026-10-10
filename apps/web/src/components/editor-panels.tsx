import type { FrameBuffer, StyleGuide } from "@pixelaition/pixel";
import {
  Check,
  Copy,
  Menu as MenuIcon,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MenuItem,
  Panel,
  Popover,
  TextInput,
} from "./ui.js";
import { hexToRgba } from "../lib/color.js";
import { hexToHsv, hsvToHex } from "../lib/hsv.js";
import { base64ToBytes, type FrameDto } from "../lib/types.js";

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

function frameRowClass(current: boolean, editing = false) {
  if (editing) {
    return "flex w-full items-center gap-2 border-2 border-line bg-field px-2 py-1.5 text-left text-[13px] transition-colors duration-150 focus-within:border-accent";
  }
  return `flex w-full items-center gap-2 border-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
    current
      ? "border-accent bg-raised text-accent"
      : "border-transparent text-ink hover:border-line hover:bg-raised"
  }`;
}

function FrameRow({
  frame,
  index,
  count,
  palette,
  current,
  locked,
  editing,
  draft,
  onDraft,
  onCommit,
  onCancel,
  onSelect,
  onStartEdit,
  onDuplicate,
  onDelete,
  onKeyboardMove,
  onDragFinished,
}: {
  frame: FrameDto;
  index: number;
  count: number;
  palette: string[];
  current: boolean;
  locked: boolean;
  editing: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onSelect: () => void;
  onStartEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onKeyboardMove: (toIndex: number) => void;
  onDragFinished: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={frame}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragFinished}
      whileDrag={{ zIndex: 2 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="relative flex min-w-0 items-center gap-1"
    >
      <div className={`${frameRowClass(current, editing)} relative min-w-0 flex-1`}>
        <button
          type="button"
          onClick={onSelect}
          disabled={editing}
          aria-current={current}
          aria-label={`Select ${frame.name}`}
          title={frame.name}
          className="absolute -inset-0.5 z-0"
        />
        <motion.span
          initial={false}
          animate={{
            width: editing ? 0 : 36,
            marginRight: editing ? -8 : 0,
            opacity: editing ? 0 : 1,
          }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="pointer-events-none shrink-0 overflow-hidden"
          style={{ height: 36 }}
        >
          <FrameThumb frame={frame} palette={palette} />
        </motion.span>
        {editing ? (
          <motion.span
            key="rename"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12 }}
            className="relative z-10 flex min-w-0 flex-1"
          >
            <input
              autoFocus
              value={draft}
              aria-label="Frame name"
              className="h-5 w-full min-w-0 border-0 bg-transparent p-0 text-ink outline-none"
              onChange={(event) => onDraft(event.target.value)}
              onBlur={onCommit}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") onCancel();
              }}
            />
          </motion.span>
        ) : (
          <span className="pointer-events-none min-w-0 flex-1 truncate leading-5">
            {frame.name}
          </span>
        )}
        {current && locked ? (
          <span className="pointer-events-none text-pixel-mono">drawing</span>
        ) : null}
        <span className="relative z-10 ml-auto flex w-[58px] shrink-0 items-center justify-end gap-0.5">
          <AnimatePresence initial={false} mode="popLayout">
            {editing ? (
              <motion.span
                key="save"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.12 }}
                onMouseDown={(event) => event.preventDefault()}
              >
                <IconButton label={`Save ${frame.name}`} size="sm" onClick={onCommit}>
                  <Check size={13} strokeWidth={2.5} />
                </IconButton>
              </motion.span>
            ) : (
              <motion.span
                key="actions"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.12 }}
                className="flex items-center gap-0.5"
              >
                <IconButton
                  label={`Rename ${frame.name}`}
                  size="sm"
                  disabled={locked}
                  onClick={onStartEdit}
                >
                  <Pencil size={13} strokeWidth={2} />
                </IconButton>
                <Menu label={`Actions for ${frame.name}`}>
                  <MenuItem disabled={locked} onClick={onDuplicate}>
                    <Copy size={13} strokeWidth={2} /> Duplicate
                  </MenuItem>
                  <MenuItem disabled={locked} onClick={onDelete}>
                    <Trash2 size={13} strokeWidth={2} /> Delete
                  </MenuItem>
                </Menu>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>
      <button
        type="button"
        disabled={locked}
        aria-label={`Reorder ${frame.name}`}
        title="Drag to reorder, or use the arrow keys"
        onPointerDown={(event) => {
          if (locked) return;
          event.preventDefault();
          controls.start(event);
        }}
        onKeyDown={(event) => {
          if (locked) return;
          if (event.key === "ArrowUp" && index > 0) {
            event.preventDefault();
            onKeyboardMove(index - 1);
          }
          if (event.key === "ArrowDown" && index < count - 1) {
            event.preventDefault();
            onKeyboardMove(index + 1);
          }
        }}
        className="grid h-6 w-5 shrink-0 cursor-grab place-items-center text-muted hover:text-ink disabled:cursor-default disabled:opacity-50"
      >
        <MenuIcon size={14} strokeWidth={2} />
      </button>
    </Reorder.Item>
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
  onReorder,
}: {
  frames: FrameDto[];
  palette: string[];
  activeId: string | null;
  playing: boolean;
  locked: boolean;
  onSelect: (frameId: string) => void;
  onTogglePlay: () => void;
  onAdd: () => void;
  onDuplicate: (frameId: string) => void;
  onRename: (frameId: string, name: string) => void;
  onDelete: (frameId: string) => void;
  onReorder: (frameId: string, toIndex: number) => Promise<boolean>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<FrameDto | null>(null);
  const [orderDraft, setOrderDraft] = useState<FrameDto[] | null>(null);
  const draftOrderRef = useRef<FrameDto[] | null>(null);
  const list = orderDraft ?? frames;

  function startEdit(frame: FrameDto) {
    setEditingId(frame.id);
    setDraft(frame.name);
  }
  function commitEdit() {
    const next = draft.trim();
    const original = frames.find((frame) => frame.id === editingId)?.name;
    if (editingId && next && next !== original) onRename(editingId, next);
    setEditingId(null);
  }

  // Live preview while dragging: the list shows the new order immediately and
  // falls back to the server order once the reorder is stored (or instantly
  // when the drag ends where it started).
  function previewOrder(next: FrameDto[]) {
    const caughtUp =
      next.length === frames.length &&
      next.every((frame, index) => frame.id === frames[index]?.id);
    if (caughtUp) {
      draftOrderRef.current = null;
      setOrderDraft(null);
      return;
    }
    draftOrderRef.current = next;
    setOrderDraft(next);
  }

  useEffect(() => {
    if (!orderDraft) return;
    const caughtUp =
      frames.length === orderDraft.length &&
      frames.every((frame, index) => frame.id === orderDraft[index]?.id);
    if (caughtUp) {
      draftOrderRef.current = null;
      setOrderDraft(null);
    }
  }, [frames, orderDraft]);

  function persistOrder(id: string) {
    // Only a drag that actually moved something has a preview to store; a drag
    // that ended where it started must not write anything.
    const next = draftOrderRef.current;
    draftOrderRef.current = null;
    if (!next) return;
    const index = next.findIndex((frame) => frame.id === id);
    if (index === -1) return;
    void onReorder(id, index).then((ok) => {
      if (!ok) setOrderDraft(null);
    });
  }

  return (
    <Panel
      title={`${frames.length} frame${frames.length === 1 ? "" : "s"}`}
      action={
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
          <IconButton label="Add frame" size="sm" disabled={locked} onClick={onAdd}>
            <Plus size={14} strokeWidth={2.5} />
          </IconButton>
        </div>
      }
    >
      {frames.length === 0 ? (
        <EmptyState
          title="No frames"
          body="A frame holds the pixels for one state of this asset."
        />
      ) : (
        <Reorder.Group
          axis="y"
          values={list}
          onReorder={previewOrder}
          className="grid gap-1"
        >
          {list.map((frame, index) => {
            const current = frame.id === activeId;
            return (
              <FrameRow
                key={frame.id}
                frame={frame}
                index={index}
                count={list.length}
                palette={palette}
                current={current}
                locked={locked}
                editing={editingId === frame.id}
                draft={draft}
                onDraft={setDraft}
                onCommit={commitEdit}
                onCancel={() => setEditingId(null)}
                onSelect={() => onSelect(frame.id)}
                onStartEdit={() => startEdit(frame)}
                onDuplicate={() => onDuplicate(frame.id)}
                onDelete={() => setPendingDelete(frame)}
                onKeyboardMove={(to) => void onReorder(frame.id, to)}
                onDragFinished={() => persistOrder(frame.id)}
              />
            );
          })}
        </Reorder.Group>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Delete this frame?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” and its pixels will be removed. This cannot be undone.`
            : ""
        }
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
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
  onDelete: (layerId: string) => void;
}) {
  const layers = buffer?.layers ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null,
  );

  function startEdit(layerId: string, name: string) {
    setEditingId(layerId);
    setDraft(name);
  }
  function commitEdit() {
    const next = draft.trim();
    const original = layers.find((layer) => layer.id === editingId)?.name;
    if (editingId && next && next !== original) onRename(editingId, next);
    setEditingId(null);
  }

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
            <li
              key={layer.id}
              className={`relative flex min-w-0 items-center gap-2 border-2 px-2 py-1.5 transition-colors duration-150 ${
                current
                  ? "border-accent bg-raised"
                  : "border-transparent hover:border-line hover:bg-raised"
              } ${layer.visible ? "" : "opacity-55"}`}
            >
              <button
                type="button"
                onClick={() => onSelect(layer.id)}
                disabled={editingId === layer.id}
                aria-current={current}
                aria-label={`Select layer ${layer.name}`}
                className="absolute -inset-0.5 z-0"
              />
              <motion.span
                initial={false}
                animate={{
                  width: editingId === layer.id ? 0 : 18,
                  marginRight: editingId === layer.id ? -8 : 0,
                  opacity: editingId === layer.id ? 0 : 1,
                }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                inert={editingId === layer.id ? true : undefined}
                className={`relative z-10 shrink-0 overflow-hidden ${
                  editingId === layer.id ? "pointer-events-none" : ""
                }`}
                style={{ height: 18 }}
              >
                <Checkbox
                  label={`Show ${layer.name}`}
                  hideLabel
                  checked={layer.visible}
                  disabled={locked}
                  onChange={(next) => onToggleVisible(layer.id, next)}
                />
              </motion.span>
              {editingId === layer.id ? (
                <motion.span
                  key="rename"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.12 }}
                  className="relative z-10 flex min-w-0 flex-1"
                >
                  <input
                    autoFocus
                    value={draft}
                    aria-label="Layer name"
                    className="h-5 w-full min-w-0 border-0 bg-transparent p-0 text-ink outline-none"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                </motion.span>
              ) : (
                <span
                  className={`pointer-events-none min-w-0 flex-1 truncate text-[13px] leading-5 ${
                    current ? "text-accent" : "text-ink"
                  }`}
                >
                  {layer.name}
                </span>
              )}
              <span className="relative z-10 ml-auto flex w-[58px] shrink-0 items-center justify-end gap-0.5">
                <AnimatePresence initial={false} mode="popLayout">
                  {editingId === layer.id ? (
                    <motion.span
                      key="save"
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85 }}
                      transition={{ duration: 0.12 }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <IconButton
                        label={`Save ${layer.name}`}
                        size="sm"
                        onClick={commitEdit}
                      >
                        <Check size={13} strokeWidth={2.5} />
                      </IconButton>
                    </motion.span>
                  ) : (
                    <motion.span
                      key="actions"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.12 }}
                      className="flex items-center gap-0.5"
                    >
                      <IconButton
                        label={`Rename ${layer.name}`}
                        size="sm"
                        disabled={locked}
                        onClick={() => startEdit(layer.id, layer.name)}
                      >
                        <Pencil size={13} strokeWidth={2} />
                      </IconButton>
                      <Menu label={`Actions for ${layer.name}`}>
                        <MenuItem
                          disabled={locked || layers.length <= 1}
                          onClick={() =>
                            setPendingDelete({ id: layer.id, name: layer.name })
                          }
                        >
                          <Trash2 size={13} strokeWidth={2} /> Delete
                        </MenuItem>
                      </Menu>
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-pixel-mono text-muted">{layers.length} of 4 layers</span>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Delete this layer?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” and its pixels will be removed. This cannot be undone.`
            : ""
        }
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
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
        <span className={`text-pixel-mono ${over ? "text-erase" : "text-muted"}`}>
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
            <span className="grid aspect-square place-items-center text-pixel-mono">
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
      <dl className="grid gap-1 text-pixel-mono">
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
          <span className="text-pixel-mono text-muted">×</span>
          <TextInput
            id="canvas-height"
            value={h}
            inputMode="numeric"
            aria-label="Canvas height"
            placeholder="32"
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
      <p className="text-xs text-muted">
        The style guide belongs to the project, so every asset in it stays related.
      </p>
    </Panel>
  );
}

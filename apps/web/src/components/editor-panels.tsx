import {
  blendModes,
  colorModes,
  frameToBuffer,
  type FrameBuffer,
  type Layer,
  type StyleGuide,
  type TextLayerSpec,
} from "@pixelaition/pixel";
import { FrameStatus, type FrameTaskState } from "./frame-status.js";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import {
  getPreset,
  presetAspect,
  type Element,
  type SpriteSource,
} from "@pixelaition/artboard";
import { ArtboardCanvas } from "./artboard-canvas.js";
import { artboardForFrame } from "../lib/artboard.js";
import type { AssetDto } from "../lib/types.js";
import type { PaletteAction } from "../lib/palette.js";
import { decodeImageFile } from "../lib/image-import.js";
import {
  colorToHex,
  hexToColor,
  paletteFromImage,
  renderFrameDocument,
} from "@pixelaition/pixel";
import {
  Check,
  Copy,
  Folder,
  Grid,
  Lock,
  Menu as MenuIcon,
  Minus,
  Pencil,
  Wrench,
  Play,
  Plus,
  Stop,
  Trash,
  Unlock,
} from "./pixel-icons.js";
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
  SelectControl,
  TextInput,
} from "./ui.js";
import { hexToHsv, hsvToHex } from "../lib/hsv.js";
import { base64ToBytes, type FrameDto } from "../lib/types.js";

/* ------------------------------------------------------------------ frames */

/** Stack every visible layer. The first layer alone is often just the shadow. */
function thumbBuffer(
  frame: FrameDto | undefined,
  palette: string[],
  width: number | undefined,
  height: number | undefined,
  live: FrameBuffer | undefined,
): FrameBuffer | null {
  if (live) return live;
  if (!frame) return null;
  const side = (() => {
    if (width && height) return { width, height };
    const encoded = frame.layers[0]?.pixels;
    if (!encoded) return null;
    try {
      const length = base64ToBytes(encoded).length;
      const square = Math.sqrt(length);
      if (!Number.isInteger(square) || square < 1) return null;
      return { width: square, height: square };
    } catch {
      return null;
    }
  })();
  if (!side) return null;
  try {
    return frameToBuffer(frame, side.width, side.height, palette);
  } catch {
    return null;
  }
}

function paintThumb(canvas: HTMLCanvasElement, buffer: FrameBuffer) {
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(buffer.width, buffer.height);
  image.data.set(renderFrameDocument(buffer).data);
  context.putImageData(image, 0, 0);
}

export function FrameThumb({
  frame,
  palette,
  assetId,
  size = 36,
  width,
  height,
  live,
}: {
  frame: FrameDto;
  palette: string[];
  /** Set on the lazy summary rail: the frame's layers are not loaded yet. */
  assetId?: string;
  size?: number;
  /** Document size. Without it a square frame is inferred from its pixels. */
  width?: number;
  height?: number;
  /** The editor's live buffer, so the thumb follows a stroke as it lands. */
  live?: FrameBuffer;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const buffer = thumbBuffer(frame, palette, width, height, live);
    if (!buffer) return;
    paintThumb(canvas, buffer);
  }, [frame, palette, width, height, live]);
  // A summary frame has no layers to paint locally. Its PNG is one small
  // request and keeps the rail honest without decoding every layer.
  if (
    assetId !== undefined &&
    live === undefined &&
    frame.kind !== "social" &&
    frame.layers.length === 0
  ) {
    const version = frame.updatedAt ?? String(frame.version ?? 0);
    return (
      <img
        src={`/api/assets/${assetId}/frames/${frame.id}/thumbnail?v=${encodeURIComponent(version)}`}
        alt=""
        loading="lazy"
        decoding="async"
        className="shrink-0 border-2 border-line bg-screen object-contain"
        style={{
          width: size,
          height: size,
          imageRendering: "pixelated",
        }}
      />
    );
  }
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0 border-2 border-line bg-screen"
      style={{
        width: size,
        height: size,
        imageRendering: "pixelated",
        objectFit: "contain",
      }}
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
  pixelWidth,
  pixelHeight,
  live,
  asset,
  sprites,
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
  onVariant,
  onDelete,
  onKeyboardMove,
  onDragFinished,
  taskState,
}: {
  frame: FrameDto;
  taskState?: FrameTaskState;
  index: number;
  count: number;
  palette: string[];
  pixelWidth?: number;
  pixelHeight?: number;
  live?: FrameBuffer;
  asset?: AssetDto;
  sprites?: Map<string, SpriteSource>;
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
  onVariant?: (mirror: "horizontal" | "vertical") => void;
  onDelete: () => void;
  onKeyboardMove: (toIndex: number) => void;
  onDragFinished: () => void;
}) {
  const controls = useDragControls();
  const frameWidth = frame.width ?? pixelWidth;
  const frameHeight = frame.height ?? pixelHeight;
  const dimensions = frameWidth && frameHeight ? `${frameWidth}×${frameHeight}` : null;
  return (
    <Reorder.Item
      data-frame-row={frame.id}
      value={frame}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragFinished}
      whileDrag={{ zIndex: 2 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="relative flex min-w-0 items-center gap-1"
    >
      <div
        className={`${frameRowClass(current, editing)} relative min-w-0 flex-1 ${
          taskState?.painting === true ? "agent-paint-ring" : ""
        }`}
      >
        {taskState?.painting === true ? (
          // The whole card glints while an agent paints it: pixel by pixel,
          // corner by corner, so the working frame reads from across the panel.
          <span aria-hidden className="card-sparkle pointer-events-none absolute inset-0">
            <span className="glint" />
            <span className="glint" />
            <span className="glint" />
            <span className="glint" />
          </span>
        ) : null}
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
          className="pointer-events-none relative shrink-0 overflow-hidden"
          style={{ height: 36 }}
        >
          {frame.kind === "social" && asset && frame.presetId && frame.scene ? (
            <span className="grid h-9 w-9 place-items-center overflow-hidden border-2 border-line bg-screen">
              <ArtboardCanvas
                artboard={artboardForFrame(asset, frame)!}
                preset={getPreset(frame.presetId)}
                asset={asset}
                sprites={sprites ?? new Map()}
                fit
                showZones={false}
                thumbnail
              />
            </span>
          ) : (
            <FrameThumb
              frame={frame}
              palette={live?.palette ?? palette}
              assetId={asset?.id}
              width={frame.width ?? pixelWidth}
              height={frame.height ?? pixelHeight}
              live={live}
            />
          )}
          {taskState?.painting === true ? (
            // The agent's own cursor, painting inside this frame's square.
            <span aria-hidden className="agent-cursor">
              <span className="agent-cursor-tip" />
            </span>
          ) : null}
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
          <span className="pointer-events-none flex min-w-0 flex-1 flex-col justify-center leading-5">
            <span className="truncate">{frame.name}</span>
            <span className="flex min-w-0 items-center gap-1">
              {taskState !== undefined ? (
                <FrameStatus state={taskState} />
              ) : current && locked ? (
                <span className="text-pixel-mono">drawing</span>
              ) : null}
              {dimensions !== null ? (
                <span className="shrink-0 font-mono text-[9px] text-muted">
                  {frame.kind === "social" && frame.presetId
                    ? `${dimensions} · ${presetAspect(getPreset(frame.presetId))}`
                    : dimensions}
                </span>
              ) : null}
            </span>
          </span>
        )}
        <span
          className={`relative z-10 ml-auto shrink-0 items-center justify-end gap-0.5 ${
            locked ? "hidden" : "flex w-[74px]"
          }`}
        >
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
                <IconButton label={`Save ${frame.name}`} onClick={onCommit}>
                  <Check />
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
                  disabled={locked}
                  onClick={onStartEdit}
                >
                  <Pencil />
                </IconButton>
                <Menu label={`Actions for ${frame.name}`}>
                  <MenuItem disabled={locked} onClick={onDuplicate}>
                    <Copy /> Duplicate
                  </MenuItem>
                  {onVariant ? (
                    <>
                      <MenuItem disabled={locked} onClick={() => onVariant("horizontal")}>
                        <Copy /> Mirror variant H
                      </MenuItem>
                      <MenuItem disabled={locked} onClick={() => onVariant("vertical")}>
                        <Copy /> Mirror variant V
                      </MenuItem>
                    </>
                  ) : null}
                  <MenuItem disabled={locked} onClick={onDelete}>
                    <Trash /> Delete
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
        className={`${
          locked ? "hidden" : "grid"
        } h-9 w-9 shrink-0 cursor-grab place-items-center border-2 border-transparent text-muted transition-colors duration-150 hover:border-line hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-50`}
      >
        <MenuIcon width={14} height={14} />
      </button>
    </Reorder.Item>
  );
}

/* ------------------------------------------------------------------ frames */

/**
 * Five frame rows stay visible before the list scrolls on its own: each row
 * is a 36px thumbnail plus py-1.5 and a 2px border (52px), and the grid gap
 * is 4. Local scroll keeps the panel header and the layer list in place; the
 * whole left column must not scroll to reach a frame.
 */
const FRAME_LIST_VISIBLE = 5;
const FRAME_ROW_HEIGHT = 52;
const FRAME_LIST_MAX_HEIGHT =
  FRAME_ROW_HEIGHT * FRAME_LIST_VISIBLE + 4 * (FRAME_LIST_VISIBLE - 1);

export function FramePanel({
  frames,
  palette,
  pixelWidth,
  pixelHeight,
  liveFrames,
  activeId,
  playing,
  locked,
  activity,
  taskFrames,
  asset,
  sprites,
  onSelect,
  onTogglePlay,
  onAdd,
  onImport,
  onImportImage,
  onImportAseprite,
  onDuplicate,
  onVariant,
  onRename,
  onDelete,
  onReorder,
}: {
  frames: FrameDto[];
  palette: string[];
  pixelWidth?: number;
  pixelHeight?: number;
  /** Drafts the editor is showing, keyed by frame id. */
  liveFrames?: Record<string, FrameBuffer>;
  activeId: string | null;
  playing: boolean;
  locked: boolean;
  /** Planning, Generating, or Reviewing. Sits under the frame count. */
  activity?: string;
  /** Per-frame task state, keyed by frame id, while a task runs. */
  taskFrames?: Map<string, FrameTaskState>;
  asset?: AssetDto;
  sprites?: Map<string, SpriteSource>;
  onSelect: (frameId: string) => void;
  onTogglePlay: () => void;
  onAdd: () => void;
  onImport?: () => void;
  onImportImage?: () => void;
  onImportAseprite?: () => void;
  onDuplicate: (frameId: string) => void;
  onVariant?: (frameId: string, mirror: "horizontal" | "vertical") => void;
  onRename: (frameId: string, name: string) => void;
  onDelete: (frameId: string) => void;
  onReorder: (frameId: string, toIndex: number) => Promise<boolean>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<FrameDto | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Playback (and any selection) keeps the active row on screen without
  // yanking the list when it already is.
  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-frame-row="${activeId}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
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
      subtitle={activity}
      action={
        <div className="flex items-center gap-1">
          <IconButton
            label={playing ? "Stop playback" : "Play frames"}
            disabled={frames.length < 2}
            onClick={onTogglePlay}
          >
            {playing ? <Stop /> : <Play />}
          </IconButton>
          <IconButton label="Add frame" disabled={locked} onClick={onAdd}>
            <Plus />
          </IconButton>
        </div>
      }
    >
      {frames.length === 0 ? (
        <EmptyState
          title="No frames"
          body="A frame holds one image state of this asset."
        />
      ) : (
        <div
          ref={listRef}
          className="overflow-y-auto overscroll-contain pr-0.5"
          style={{ maxHeight: FRAME_LIST_MAX_HEIGHT }}
        >
          {/* Up to five rows are visible; a longer list scrolls locally so the
              layer list below never moves. */}
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
                  pixelWidth={pixelWidth}
                  pixelHeight={pixelHeight}
                  live={liveFrames?.[frame.id]}
                  asset={asset}
                  sprites={sprites}
                  current={current}
                  {...(taskFrames?.get(frame.id) !== undefined
                    ? { taskState: taskFrames.get(frame.id) }
                    : {})}
                  locked={locked}
                  editing={editingId === frame.id}
                  draft={draft}
                  onDraft={setDraft}
                  onCommit={commitEdit}
                  onCancel={() => setEditingId(null)}
                  onSelect={() => onSelect(frame.id)}
                  onStartEdit={() => startEdit(frame)}
                  onDuplicate={() => onDuplicate(frame.id)}
                  {...(onVariant
                    ? { onVariant: (mirror) => onVariant(frame.id, mirror) }
                    : {})}
                  onDelete={() => setPendingDelete(frame)}
                  onKeyboardMove={(to) => void onReorder(frame.id, to)}
                  onDragFinished={() => persistOrder(frame.id)}
                />
              );
            })}
          </Reorder.Group>
        </div>
      )}

      {onImport ? (
        <Button
          tone="ghost"
          className="mt-1 justify-start px-2 py-1 text-pixel-label"
          onClick={onImport}
          disabled={locked}
        >
          Import project frame
        </Button>
      ) : null}
      {onImportImage ? (
        <Button
          tone="ghost"
          className="mt-1 justify-start px-2 py-1 text-pixel-label"
          onClick={onImportImage}
          disabled={locked}
        >
          Import image
        </Button>
      ) : null}
      {onImportAseprite ? (
        <Button
          tone="ghost"
          className="mt-1 justify-start px-2 py-1 text-pixel-label"
          onClick={onImportAseprite}
          disabled={locked}
        >
          Import Aseprite
        </Button>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Delete this frame?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” and its content will be removed. This cannot be undone.`
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

/* ------------------------------------------------------------------ inspector */

export function FrameHeaderPanel({
  name,
  width,
  height,
  meta,
  detail,
  disabled,
  onRename,
}: {
  name: string;
  width: number;
  height: number;
  meta?: string;
  detail?: string;
  disabled?: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);

  useEffect(() => setDraft(name), [name]);

  function commit() {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
  }

  return (
    <Panel
      title="Frame"
      action={
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {width}×{height}
        </span>
      }
    >
      <Field label="Name" htmlFor="frame-header-name">
        <TextInput
          id="frame-header-name"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(name);
              event.currentTarget.blur();
            }
          }}
        />
      </Field>
      {meta ? <p className="text-pixel-mono text-muted">{meta}</p> : null}
      {detail ? <p className="text-pixel-mono text-accent">{detail}</p> : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ layers */

export function LayerPanel({
  buffer,
  elements = [],
  selectedElementId = null,
  activeId,
  locked,
  onSelect,
  onToggleVisible,
  onOpacity,
  onBlend,
  onLock,
  onDuplicate,
  onRemoveBackground,
  onLink,
  onAdd,
  onAddGroup,
  onAddTilemap,
  onToggleGroup,
  onRemoveGroup,
  onMoveGroup,
  onRename,
  onDelete,
  onSelectElement,
  onToggleElement,
  background,
  onSelectBackground,
  onToggleBackground,
  onDeleteElement,
}: {
  buffer: FrameBuffer | undefined;
  /** Scene content sits in the same list as the pixel layers. */
  elements?: Element[];
  selectedElementId?: string | null;
  activeId: string;
  locked: boolean;
  onSelect: (layerId: string) => void;
  onToggleVisible: (layerId: string, visible: boolean) => void;
  onOpacity?: (layerId: string, opacity: number) => void;
  onBlend?: (layerId: string, blend: (typeof blendModes)[number]) => void;
  onLock?: (layerId: string, locked: boolean) => void;
  onDuplicate?: (layerId: string) => void;
  onRemoveBackground?: (layerId: string) => void;
  onLink?: (layerId: string) => void;
  onAdd?: () => void;
  onAddGroup?: () => void;
  onAddTilemap?: () => void;
  onToggleGroup?: (groupId: string, visible: boolean) => void;
  onRemoveGroup?: (groupId: string) => void;
  onMoveGroup?: (layerId: string, groupId: string | null) => void;
  onRename: (layerId: string, name: string) => void;
  onDelete: (layerId: string) => void;
  onSelectElement?: (id: string) => void;
  onToggleElement?: (id: string, visible: boolean) => void;
  background?: { visible: boolean };
  onSelectBackground?: () => void;
  onToggleBackground?: () => void;
  onDeleteElement?: (id: string) => void;
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
      className="min-h-0 flex-1"
      title="Layers"
      action={
        buffer && (onAdd || onAddGroup) ? (
          <span className="flex items-center gap-1">
            {onAddGroup ? (
              <IconButton label="Add layer group" disabled={locked} onClick={onAddGroup}>
                <Folder />
              </IconButton>
            ) : null}
            {onAddTilemap ? (
              <IconButton
                label="Add tilemap layer"
                disabled={locked}
                onClick={onAddTilemap}
              >
                <Grid />
              </IconButton>
            ) : null}
            {onAdd ? (
              <IconButton label="Add layer" disabled={locked} onClick={onAdd}>
                <Plus />
              </IconButton>
            ) : null}
          </span>
        ) : undefined
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
        {/* The layer list fills what is left and scrolls on its own, apart
            from the frame list. */}
        <ul className="grid gap-1">
          {background ? (
            <li
              className={`flex min-w-0 items-center gap-2 border-2 px-2 py-1.5 transition-colors duration-150 ${
                background.visible
                  ? "border-transparent hover:border-line hover:bg-raised"
                  : "border-transparent opacity-55"
              }`}
            >
              <Checkbox
                label="Show background"
                hideLabel
                checked={background.visible}
                disabled={locked}
                onChange={() => onToggleBackground?.()}
              />
              <button
                type="button"
                disabled={locked}
                onClick={() => onSelectBackground?.()}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
              >
                <span className="truncate font-mono text-[11px]">Background</span>
                <span className="shrink-0 font-mono text-[9px] text-muted">layer 1</span>
              </button>
              <IconButton
                label="Edit background"
                disabled={locked}
                onClick={() => onSelectBackground?.()}
              >
                <Pencil />
              </IconButton>
            </li>
          ) : null}
          {(buffer?.groups ?? []).map((group) => (
            <li
              key={group.id}
              className="flex min-w-0 items-center gap-2 border-2 border-line/60 bg-raised/40 px-2 py-1.5"
            >
              <Checkbox
                label={`Show ${group.name}`}
                hideLabel
                checked={group.visible}
                disabled={locked}
                onChange={() => onToggleGroup?.(group.id, !group.visible)}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-accent">
                {group.name}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-muted">group</span>
              {onRemoveGroup ? (
                <IconButton
                  label={`Remove ${group.name}`}
                  disabled={locked}
                  onClick={() => onRemoveGroup(group.id)}
                >
                  <Trash />
                </IconButton>
              ) : null}
            </li>
          ))}
          {elements.map((element) => {
            const visible = element.visible !== false;
            const current = selectedElementId === element.id;
            return (
              <li
                key={element.id}
                className={`flex min-w-0 items-center gap-2 border-2 px-2 py-1.5 transition-colors duration-150 ${
                  current
                    ? "border-accent bg-raised"
                    : "border-transparent hover:border-line hover:bg-raised"
                } ${visible ? "" : "opacity-55"}`}
              >
                <Checkbox
                  label={`Show ${elementLabel(element)}`}
                  hideLabel
                  checked={visible}
                  disabled={locked}
                  onChange={(next) => onToggleElement?.(element.id, next)}
                />
                <button
                  type="button"
                  aria-current={current}
                  disabled={locked}
                  onClick={() => onSelectElement?.(element.id)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                >
                  <span className="truncate font-mono text-[11px]">
                    {elementLabel(element)}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted">
                    {element.id.slice(0, 8)}
                  </span>
                </button>
                <IconButton
                  label={`Edit ${elementLabel(element)}`}
                  disabled={locked}
                  onClick={() => onSelectElement?.(element.id)}
                >
                  <Pencil />
                </IconButton>
                <Menu label={`Actions for ${elementLabel(element)}`}>
                  <MenuItem
                    disabled={locked}
                    onClick={() => onDeleteElement?.(element.id)}
                  >
                    <Trash /> Delete
                  </MenuItem>
                </Menu>
              </li>
            );
          })}
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
                    {layer.text ? (
                      <span className="ml-1 text-pixel-mono text-[8px] text-accent">
                        TEXT
                      </span>
                    ) : null}
                    {layer.locked ? (
                      <span className="ml-1 text-pixel-mono text-[8px] text-erase">
                        LOCK
                      </span>
                    ) : null}
                    {layer.linkId ? (
                      <span className="ml-1 text-pixel-mono text-[8px] text-accent">
                        LINK
                      </span>
                    ) : null}
                    {layer.tilemap ? (
                      <span className="ml-1 text-pixel-mono text-[8px] text-accent">
                        TILEMAP
                      </span>
                    ) : null}
                    {(layer.opacity ?? 1) < 1 ? (
                      <span className="ml-1 text-pixel-mono text-[8px] text-muted">
                        {Math.round((layer.opacity ?? 1) * 100)}%
                      </span>
                    ) : null}
                  </span>
                )}
                <span className="relative z-10 ml-auto flex w-[74px] shrink-0 items-center justify-end gap-0.5">
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
                        <IconButton label={`Save ${layer.name}`} onClick={commitEdit}>
                          <Check />
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
                          label={
                            layer.text
                              ? `Edit text ${layer.name}`
                              : `Rename ${layer.name}`
                          }
                          disabled={locked}
                          onClick={() =>
                            layer.text
                              ? onSelect(layer.id)
                              : startEdit(layer.id, layer.name)
                          }
                        >
                          <Pencil />
                        </IconButton>
                        {onOpacity || onBlend || onLock ? (
                          <Popover
                            label={`Settings for ${layer.name}`}
                            trigger={<Wrench />}
                            triggerClassName="grid h-7 w-7 shrink-0 place-items-center border-2 border-line text-muted shadow-pixel-sm transition-colors duration-150 hover:border-line-strong hover:bg-raised hover:text-ink data-[popup-open]:border-accent data-[popup-open]:text-accent"
                          >
                            <div className="grid min-w-48 gap-2">
                              <Field label="Opacity" htmlFor={`opacity-${layer.id}`}>
                                <input
                                  id={`opacity-${layer.id}`}
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={Math.round((layer.opacity ?? 1) * 100)}
                                  disabled={locked || !onOpacity}
                                  onChange={(event) =>
                                    onOpacity?.(
                                      layer.id,
                                      Number(event.currentTarget.value) / 100,
                                    )
                                  }
                                  className="w-full accent-accent"
                                />
                              </Field>
                              <Field label="Blend" htmlFor={`blend-${layer.id}`}>
                                <SelectControl
                                  id={`blend-${layer.id}`}
                                  label="Blend"
                                  value={layer.blend ?? "normal"}
                                  options={[...blendModes]}
                                  onChange={(next) =>
                                    onBlend?.(
                                      layer.id,
                                      next as (typeof blendModes)[number],
                                    )
                                  }
                                />
                              </Field>
                              {onMoveGroup ? (
                                <Field label="Group" htmlFor={`group-${layer.id}`}>
                                  <SelectControl
                                    id={`group-${layer.id}`}
                                    label="Group"
                                    value={layer.parentGroupId ?? ""}
                                    options={[
                                      { value: "", label: "No group" },
                                      ...(buffer?.groups ?? []).map((group) => ({
                                        value: group.id,
                                        label: group.name,
                                      })),
                                    ]}
                                    onChange={(next) =>
                                      onMoveGroup(layer.id, next || null)
                                    }
                                  />
                                </Field>
                              ) : null}
                              {onLink ? (
                                <Button
                                  tone="ghost"
                                  className="justify-start px-2 py-1 text-pixel-label"
                                  onClick={() => onLink(layer.id)}
                                >
                                  {layer.linkId ? "Unlink layer" : "Link across frames"}
                                </Button>
                              ) : null}
                              {onRemoveBackground ? (
                                <Button
                                  tone="ghost"
                                  className="justify-start px-2 py-1 text-pixel-label"
                                  disabled={locked || layer.locked}
                                  onClick={() => onRemoveBackground(layer.id)}
                                >
                                  Remove background
                                </Button>
                              ) : null}
                            </div>
                          </Popover>
                        ) : null}
                        <Menu label={`Actions for ${layer.name}`}>
                          {layer.text ? (
                            <MenuItem
                              disabled={locked}
                              onClick={() => startEdit(layer.id, layer.name)}
                            >
                              <Pencil /> Rename layer
                            </MenuItem>
                          ) : null}
                          {onDuplicate ? (
                            <MenuItem
                              disabled={locked}
                              onClick={() => onDuplicate(layer.id)}
                            >
                              <Copy /> Duplicate
                            </MenuItem>
                          ) : null}
                          {onLock ? (
                            <MenuItem onClick={() => onLock(layer.id, !layer.locked)}>
                              <Wrench /> {layer.locked ? "Unlock" : "Lock"}
                            </MenuItem>
                          ) : null}
                          <MenuItem
                            disabled={locked || layers.length <= 1}
                            onClick={() =>
                              setPendingDelete({ id: layer.id, name: layer.name })
                            }
                          >
                            <Trash /> Delete
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
      </div>
      <div className="flex items-center justify-between">
        <span className="text-pixel-mono text-muted">
          {layers.length + elements.length}{" "}
          {layers.length + elements.length === 1 ? "layer" : "layers"}
        </span>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Delete this layer?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” and its content will be removed. This cannot be undone.`
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

/* ----------------------------------------------------------------- elements */

function elementLabel(element: Element): string {
  if (element.kind === "text") return `“${element.text.slice(0, 22)}”`;
  if (element.kind === "sprite") return "image";
  if (element.kind === "rect") return "block";
  return element.kind;
}

/**
 * The left rail's layer list for a native-size frame. Scene elements are the
 * layers here: selecting one drives the same element editor as the canvas.
 */
export function ElementLayerPanel({
  elements,
  selectedId,
  disabled,
  onSelect,
  onToggle,
}: {
  elements: Element[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <Panel
      className="min-h-0 flex-1"
      title="Layers"
      action={
        <span className="text-pixel-mono text-muted">
          {elements.length} {elements.length === 1 ? "layer" : "layers"}
        </span>
      }
    >
      {elements.length === 0 ? (
        <EmptyState
          title="No layers"
          body="Add text, a block, or a pattern from the top bar."
        />
      ) : (
        <ul className="grid gap-1">
          {elements.map((element) => {
            const current = selectedId === element.id;
            const visible = element.visible !== false;
            return (
              <li
                key={element.id}
                className={`flex min-w-0 items-center gap-2 border-2 px-2 py-1.5 transition-colors duration-150 ${
                  current
                    ? "border-accent bg-raised"
                    : "border-transparent hover:border-line hover:bg-raised"
                } ${visible ? "" : "opacity-55"}`}
              >
                <Checkbox
                  label={`Show ${elementLabel(element)}`}
                  hideLabel
                  checked={visible}
                  disabled={disabled}
                  onChange={(next) => onToggle(element.id, next)}
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(element.id)}
                  aria-current={current}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                >
                  <span className="truncate font-mono text-[11px]">
                    {elementLabel(element)}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted">
                    {element.id.slice(0, 8)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- palette */

const palettePresets = [
  {
    name: "Sweetie 16",
    colors: [
      "#00000000",
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
    ],
  },
  {
    name: "DB32",
    colors: [
      "#00000000",
      "#000000",
      "#222034",
      "#45283c",
      "#663931",
      "#8f563b",
      "#df7126",
      "#d9a066",
      "#eec39a",
      "#fbf236",
      "#99e550",
      "#6abe30",
      "#37946e",
      "#4b692f",
      "#524b24",
      "#323c39",
      "#3f3f74",
      "#306082",
      "#5b6ee1",
      "#639bff",
      "#5fcde4",
      "#cbdbfc",
      "#ffffff",
      "#9badb7",
      "#847e87",
      "#696a6a",
      "#595652",
      "#76428a",
      "#ac3232",
      "#d95763",
      "#d77bba",
      "#8f974a",
      "#8a6f30",
    ],
  },
  {
    name: "PICO-8",
    colors: [
      "#00000000",
      "#000000",
      "#1d2b53",
      "#7e2553",
      "#008751",
      "#ab5236",
      "#5f574f",
      "#c2c3c7",
      "#fff1e8",
      "#ff004d",
      "#ffa300",
      "#ffec27",
      "#00e436",
      "#29adff",
      "#83769c",
      "#ff77a8",
      "#ffccaa",
    ],
  },
  {
    name: "Game Boy",
    colors: ["#00000000", "#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  },
];

/**
 * One lock affordance for the two things the right panel can pin. The icon
 * shows the current state (closed = locked) while the label names the action,
 * so the same button never says "Lock" when it is already locked.
 */
function LockToggle({
  locked,
  subject,
  hint,
  onToggle,
  disabled = false,
}: {
  locked: boolean;
  subject: "palette" | "style guide";
  hint: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <IconButton
      label={locked ? `Unlock ${subject}` : `Lock ${subject}`}
      hint={hint}
      active={locked}
      subtle
      size="sm"
      disabled={disabled}
      onClick={onToggle}
    >
      {locked ? <Lock /> : <Unlock />}
    </IconButton>
  );
}

export function PalettePanel({
  palette,
  color,
  usedColors,
  locked = false,
  onPick,
  onAdd,
  onPalette,
  onImportPalette,
}: {
  palette: string[];
  color: number;
  usedColors: number;
  locked?: boolean;
  onPick: (hex: string) => void;
  onAdd: (hex: string) => void;
  onPalette?: (action: PaletteAction) => void;
  onImportPalette?: () => void;
}) {
  const [draft, setDraft] = useState("#d8a64e");
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const [pendingPalette, setPendingPalette] = useState<string[] | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [hsv, setHsv] = useState(() => hexToHsv("#d8a64e"));
  const valid = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(draft);
  const exists = palette.includes(draft.toLowerCase());

  // The art preset, not the chrome: the drawing palette belongs to the
  // artist, while the interface stays on the Atelier ramp.
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
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-pixel-mono text-muted">{usedColors} colors used</span>
          {onPalette ? (
            <LockToggle
              locked={locked}
              subject="palette"
              hint={
                locked
                  ? "Palette colors are fixed for this asset."
                  : "Allow adding, removing, or replacing colors."
              }
              onToggle={() => onPalette({ action: "lock", locked: !locked })}
            />
          ) : null}
        </span>
      }
    >
      <p className={`text-pixel-mono ${locked ? "text-accent" : "text-muted"}`}>
        {locked
          ? "Locked — palette colors cannot be added, removed, or replaced."
          : "Unlocked — colors can be edited."}
      </p>
      <div className="grid grid-cols-8 gap-1">
        {palette.map((swatch, index) => (
          <button
            key={`${swatch}-${index}`}
            type="button"
            aria-label={`Color ${index} ${index === 0 ? "transparent" : swatch}`}
            aria-pressed={colorToHex(color) === swatch}
            onClick={() => onPick(swatch)}
            className={`aspect-square border-2 transition-colors duration-150 ${
              colorToHex(color) === swatch
                ? "border-accent"
                : "border-line hover:border-line-strong"
            } ${index === 0 ? "checkerboard" : ""}`}
            style={index === 0 ? undefined : { background: swatch }}
          />
        ))}
        {!locked ? (
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
                onChange={(event) =>
                  setFromHsv({ ...hsv, h: Number(event.target.value) })
                }
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
                disabled={!valid || exists}
                onClick={() => onAdd(draft.toLowerCase())}
              >
                {exists ? "In palette" : "Add color"}
              </Button>
            </div>
          </Popover>
        ) : null}
      </div>
      {onPalette ? (
        <Popover
          label="Manage palette"
          disabled={locked}
          trigger={<span className="text-left">Manage colors</span>}
          triggerClassName="inline-flex items-center justify-start border-2 border-line-strong bg-panel px-2 py-1 text-pixel-label text-ink shadow-pixel-stone transition-colors duration-150 hover:bg-raised data-[popup-open]:border-accent"
        >
          <div className="grid max-h-64 gap-1 overflow-y-auto pr-1">
            {palette.map((swatch, index) =>
              index === 0 ? null : (
                <div key={`${index}-${swatch}`} className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="h-5 w-5 shrink-0 border-2 border-line"
                    style={{ background: swatch }}
                  />
                  <TextInput
                    aria-label={`Color ${index} hex`}
                    defaultValue={swatch}
                    disabled={locked}
                    className="min-w-0 flex-1 px-1.5 py-1 font-mono text-[11px]"
                    onBlur={(event) => {
                      const value = event.currentTarget.value.trim().toLowerCase();
                      if (
                        /^#([0-9a-f]{6}|[0-9a-f]{8})$/.test(value) &&
                        value !== swatch
                      ) {
                        onPalette({ action: "edit", index, color: value });
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Move color ${index} up`}
                    disabled={locked || index <= 1}
                    className="grid h-7 w-7 place-items-center border-2 border-line text-muted disabled:opacity-30"
                    onClick={() => {
                      const order = palette.map((_, position) => position);
                      [order[index - 1], order[index]] = [
                        order[index]!,
                        order[index - 1]!,
                      ];
                      onPalette({ action: "reorder", order });
                    }}
                  >
                    <Minus />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move color ${index} down`}
                    disabled={locked || index >= palette.length - 1}
                    className="grid h-7 w-7 place-items-center border-2 border-line text-muted disabled:opacity-30"
                    onClick={() => {
                      const order = palette.map((_, position) => position);
                      [order[index + 1], order[index]] = [
                        order[index]!,
                        order[index + 1]!,
                      ];
                      onPalette({ action: "reorder", order });
                    }}
                  >
                    <Plus />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove color ${index}`}
                    disabled={locked}
                    className="grid h-7 w-7 place-items-center border-2 border-line text-muted hover:border-erase hover:text-erase disabled:opacity-30"
                    onClick={() => setPendingRemove(index)}
                  >
                    <Trash />
                  </button>
                </div>
              ),
            )}
          </div>
          <div className="mt-2 border-t-2 border-line pt-2">
            <p className="mb-1 text-pixel-mono text-muted">Merge a preset</p>
            <div className="flex flex-wrap gap-1">
              {palettePresets.map((preset) => (
                <Button
                  key={preset.name}
                  tone="ghost"
                  disabled={locked}
                  className="px-1.5 py-1 text-pixel-mono"
                  onClick={() =>
                    onPalette({ action: "import", palette: preset.colors, mode: "merge" })
                  }
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 border-t-2 border-line pt-2">
            <Button
              tone="ghost"
              disabled={locked}
              className="px-1.5 py-1 text-pixel-mono"
              onClick={() => imageInput.current?.click()}
            >
              Palette from image
            </Button>
            <input
              ref={imageInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              aria-label="Choose a palette image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                void decodeImageFile(file)
                  .then((image) => {
                    const next = paletteFromImage(image, 32);
                    if (next.length < 2) throw new Error("That image has no colours.");
                    setPendingPalette(next);
                  })
                  .catch(() => setPendingPalette(null));
              }}
            />
          </div>
        </Popover>
      ) : null}
      {onImportPalette ? (
        <Button
          tone="ghost"
          disabled={locked}
          className="justify-start px-2 py-1 text-pixel-label"
          onClick={onImportPalette}
        >
          Import project palette
        </Button>
      ) : null}

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(null);
        }}
        title="Remove this colour?"
        description="Pixels that use it become transparent. This is one undoable version, and the palette stays shared by every frame."
        confirmLabel="Remove colour"
        onConfirm={() => {
          if (pendingRemove !== null) {
            onPalette?.({ action: "remove", index: pendingRemove, remapTo: 0 });
          }
          setPendingRemove(null);
        }}
      />
      <ConfirmDialog
        open={pendingPalette !== null}
        onOpenChange={(next) => {
          if (!next) setPendingPalette(null);
        }}
        title="Use this image's colours?"
        description="The palette is replaced and every existing pixel and scene is remapped to the nearest new colour."
        confirmLabel="Replace palette"
        onConfirm={() => {
          if (pendingPalette) onPalette?.({ action: "replace", palette: pendingPalette });
          setPendingPalette(null);
        }}
      />
    </Panel>
  );
}

/* ------------------------------------------------------------------- style */

export function StylePanel({
  style,
  width,
  height,
  colorMode = "indexed",
  styleLocked = false,
  onResize,
  onColorMode,
  onStyleLock,
  readOnly = false,
}: {
  style: StyleGuide;
  width: number;
  height: number;
  colorMode?: (typeof colorModes)[number];
  styleLocked?: boolean;
  onResize?: (width: number, height: number) => void;
  onColorMode?: (mode: (typeof colorModes)[number]) => void;
  onStyleLock?: (locked: boolean) => void;
  /** Native-size frames show their real output size and cannot be resized. */
  readOnly?: boolean;
}) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => setW(String(width)), [width]);
  useEffect(() => setH(String(height)), [height]);
  return (
    <Panel
      title="Style guide"
      action={
        onStyleLock ? (
          <LockToggle
            locked={styleLocked}
            subject="style guide"
            hint={
              styleLocked
                ? "Marked final for this asset. Click to reopen."
                : "Mark the guide final for this asset."
            }
            onToggle={() => onStyleLock(!styleLocked)}
          />
        ) : undefined
      }
    >
      <dl className="grid gap-1 text-pixel-mono">
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
      {onColorMode ? (
        <Field label="Color mode" htmlFor="asset-color-mode">
          <SelectControl
            id="asset-color-mode"
            label="Color mode"
            value={colorMode}
            options={[...colorModes]}
            onChange={(next) => onColorMode(next as (typeof colorModes)[number])}
          />
        </Field>
      ) : null}

      {readOnly ? (
        <div className="flex items-baseline justify-between gap-2 border-t-2 border-line pt-1.5 text-pixel-mono">
          <span className="text-muted">canvas</span>
          <span className="text-ink">
            {width}×{height}
          </span>
        </div>
      ) : (
        <Field label="Canvas size" htmlFor="canvas-width" hint="8 to 4096">
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
                if (next !== width) onResize?.(next, height);
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
                if (next !== height) onResize?.(width, next);
                else setH(String(height));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setH(String(height));
              }}
            />
          </div>
        </Field>
      )}
      <p className="text-xs text-muted">
        {styleLocked
          ? "Marked final for this asset; the project guide stays the source."
          : "The style guide belongs to the project, so every asset in it stays related."}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------- text */

/**
 * A text layer keeps its layout while its pixels stay palette-indexed. The
 * panel edits the spec; the canvas rasterizes it again, so text never leaves
 * the pixel document.
 */
export function TextPanel({
  layer,
  palette,
  locked,
  onChange,
  onRemove,
}: {
  layer: Layer;
  palette: string[];
  locked: boolean;
  onChange: (patch: Partial<TextLayerSpec>) => void;
  onRemove: () => void;
}) {
  const spec = layer.text;
  const contentRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    contentRef.current?.focus();
    contentRef.current?.select();
  }, [layer.id]);
  if (!spec) return null;
  return (
    <Panel
      title="Text"
      className="shrink-0"
      action={
        <IconButton label="Delete text" disabled={locked} onClick={onRemove}>
          <Trash />
        </IconButton>
      }
    >
      <div className="grid gap-2">
        <Field label="Content" htmlFor="text-content">
          <textarea
            ref={contentRef}
            id="text-content"
            value={spec.text}
            disabled={locked}
            rows={2}
            onChange={(event) => onChange({ text: event.target.value })}
            className="w-full resize-y border-2 border-line bg-field px-2 py-1.5 text-pixel-body text-ink outline-none focus-visible:border-accent disabled:opacity-50"
          />
        </Field>
        <Field label="Size" htmlFor="text-size">
          <div className="flex items-stretch border-2 border-line bg-field focus-within:border-accent">
            <input
              id="text-size"
              type="number"
              min={1}
              max={4096}
              step={1}
              value={spec.size}
              disabled={locked}
              aria-label="Text size"
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(next) && next >= 1 && next <= 4096) {
                  onChange({ size: next });
                }
              }}
              className="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-[13px] text-ink outline-none disabled:opacity-50"
            />
            <div className="flex w-7 shrink-0 flex-col border-l-2 border-line">
              <button
                type="button"
                aria-label="Increase text size"
                disabled={locked || spec.size >= 4096}
                onClick={() => onChange({ size: Math.min(4096, spec.size + 1) })}
                className="flex flex-1 items-center justify-center border-b-2 border-line text-[11px] leading-none text-muted hover:text-ink disabled:opacity-40"
              >
                +
              </button>
              <button
                type="button"
                aria-label="Decrease text size"
                disabled={locked || spec.size <= 1}
                onClick={() => onChange({ size: Math.max(1, spec.size - 1) })}
                className="flex flex-1 items-center justify-center text-[11px] leading-none text-muted hover:text-ink disabled:opacity-40"
              >
                −
              </button>
            </div>
          </div>
        </Field>
        <Field label="Colour" htmlFor="text-color">
          <div id="text-color" className="flex flex-wrap gap-1">
            {palette.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`Text colour ${hex}`}
                aria-pressed={colorToHex(spec.color) === hex}
                disabled={locked}
                onClick={() => onChange({ color: hexToColor(hex) ?? 0 })}
                className={`h-5 w-5 border-2 ${
                  colorToHex(spec.color) === hex ? "border-accent" : "border-line"
                } disabled:opacity-50`}
                style={{ background: hex }}
              />
            ))}
          </div>
        </Field>
        <p className="text-[11px] leading-snug text-muted">
          Click the text on the canvas to select it, then drag to move it. Every edit is
          rasterized back into this pixel layer.
        </p>
      </div>
    </Panel>
  );
}

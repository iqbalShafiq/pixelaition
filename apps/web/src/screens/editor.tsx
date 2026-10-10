import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import {
  applyCommand,
  centerCamera,
  createHistory,
  fitZoom,
  frameToBuffer,
  linePoints,
  pushHistory,
  redoHistory,
  stepZoom,
  undoHistory,
  usedColorCount,
  type Camera,
  type Command,
  type FrameBuffer,
  type History,
} from "@pixelaition/pixel";
import { Composer, type ActivityLine } from "../components/composer.js";
import { ExportDialog } from "../components/export-dialog.js";
import { FrameList, LayerList, PalettePanel } from "../components/editor-panels.js";
import {
  normalizeRect,
  PixelCanvas,
  type CanvasAction,
  type Point,
  type Rect,
  type Tool,
} from "../components/pixel-canvas.js";
import {
  EraserIcon,
  FillIcon,
  LineIcon,
  PanIcon,
  PencilIcon,
  PickerIcon,
  RectIcon,
  SelectIcon,
} from "../components/tool-icons.js";
import { Button, IconButton, Toggle } from "../components/ui.js";
import { api } from "../lib/api.js";
import {
  base64ToBytes,
  bytesToBase64,
  type AssetDto,
  type FrameDto,
} from "../lib/types.js";

const toolList: Array<{
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

const toolByKey = new Map(toolList.map((item) => [item.key.toLowerCase(), item.id]));

export function EditorScreen() {
  const { assetId } = useParams({ from: "/projects/$projectId/assets/$assetId" });
  const client = useQueryClient();
  const asset = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
  });
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () =>
      api<{ lastModelId: string | null; lastReasoningEffort: string | null }>(
        "/api/preferences",
      ),
  });
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      api<{
        models: Array<{ id: string }>;
        modelReady: boolean;
        reasoningEfforts: string[];
      }>("/api/models"),
  });

  const [frameId, setFrameId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, History>>({});
  const [tool, setTool] = useState<Tool>("pencil");
  const [brushSize, setBrushSize] = useState(1);
  const [color, setColor] = useState(1);
  const [activeLayerId, setActiveLayerId] = useState("");
  const [camera, setCamera] = useState<Camera>({ x: 40, y: 40, zoom: 16 });
  const [selection, setSelection] = useState<Rect | null>(null);
  const [grid, setGrid] = useState(true);
  const [checker, setChecker] = useState(true);
  const [onion, setOnion] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const frames = asset.data?.frames ?? [];
  const frame = frames.find((item) => item.id === frameId) ?? null;
  const history = frameId ? drafts[frameId] : undefined;
  const buffer = history?.present;
  const running = runId !== null;
  // Live values for handlers that must not capture a stale render.
  const bufferRef = useRef<FrameBuffer | undefined>(buffer);
  bufferRef.current = buffer;

  // Seed a draft for every frame the server knows about, keeping local edits intact.
  useEffect(() => {
    if (!asset.data) return;
    const data = asset.data;
    setDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of data.frames) {
        if (next[item.id]) continue;
        next[item.id] = createHistory(
          frameToBuffer(item, data.width, data.height, data.palette),
        );
        changed = true;
      }
      return changed ? next : current;
    });
    setFrameId((current) => current ?? data.frames[0]?.id ?? null);
  }, [asset.data]);

  useEffect(() => {
    if (preferences.data?.lastModelId) setModelId(preferences.data.lastModelId);
    if (preferences.data?.lastReasoningEffort) {
      setEffort(preferences.data.lastReasoningEffort);
    }
  }, [preferences.data]);

  // The active layer follows the frame so switching frames never draws on a stale id.
  useEffect(() => {
    const layers = buffer?.layers ?? [];
    if (layers.length === 0) {
      setActiveLayerId("");
      return;
    }
    if (!layers.some((layer) => layer.id === activeLayerId)) {
      setActiveLayerId(layers[0]?.id ?? "");
    }
  }, [buffer, activeLayerId]);

  const onionSkin = useMemo(() => {
    if (!onion || !asset.data || !frame) return [];
    const index = asset.data.frames.findIndex((item) => item.id === frame.id);
    const neighbors: FrameBuffer[] = [];
    for (const offset of [-1, 1]) {
      const item = asset.data.frames[index + offset];
      if (item)
        neighbors.push(
          frameToBuffer(item, asset.data.width, asset.data.height, asset.data.palette),
        );
    }
    return neighbors;
  }, [onion, asset.data, frame]);

  const update = useCallback((frameKey: string, next: History) => {
    setDrafts((current) => ({ ...current, [frameKey]: next }));
  }, []);

  const edit = useCallback(
    (frameKey: string, current: History | undefined, command: Command) => {
      if (!current) return;
      const result = applyCommand(current.present, command);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      update(frameKey, pushHistory(current, result.buffer));
    },
    [update],
  );

  const save = useMutation({
    mutationFn: async (input: { frameId: string; buffer: FrameBuffer }) => {
      await api(`/api/assets/${assetId}/frames/${input.frameId}`, {
        method: "PUT",
        body: JSON.stringify({
          layers: input.buffer.layers.map((layer) => ({
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            pixels: bytesToBase64(layer.pixels),
          })),
        }),
      });
    },
  });

  const present = history?.present;
  // A frame the user just left keeps its unsaved buffer in `pending`, so the
  // debounce can restart without dropping the edit.
  const pending = useRef(new Map<string, FrameBuffer>());
  const debounce = useRef<number | null>(null);
  // The mutation result is a fresh object every render, so it must not be a
  // dependency of the effects below or they re-arm forever.
  const mutate = useRef(save.mutateAsync);
  mutate.current = save.mutateAsync;

  const flush = useCallback(() => {
    if (debounce.current !== null) {
      window.clearTimeout(debounce.current);
      debounce.current = null;
    }
    const batch = [...pending.current.entries()];
    pending.current.clear();
    for (const [id, buffer] of batch) {
      void mutate.current({ frameId: id, buffer });
    }
  }, []);

  useEffect(() => {
    if (!present || !frameId) return;
    pending.current.set(frameId, present);
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      debounce.current = null;
      flush();
    }, 500);
    return () => undefined;
    // Saving follows the frame's buffer, not the whole history object.
  }, [present, frameId, flush]);

  // Leaving the editor must not strand a dirty frame.
  useEffect(() => () => flush(), [flush]);

  function fit() {
    const rect = viewRef.current?.getBoundingClientRect();
    const doc = bufferRef.current;
    if (!rect || !doc) return;
    const zoom = fitZoom(rect.width, rect.height, doc.width, doc.height);
    setCamera(centerCamera(rect.width, rect.height, doc.width, doc.height, zoom));
  }

  function actualSize() {
    const rect = viewRef.current?.getBoundingClientRect();
    const doc = bufferRef.current;
    if (!rect || !doc) return;
    setCamera(centerCamera(rect.width, rect.height, doc.width, doc.height, 1));
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        event.preventDefault();
        if (running) return;
        if (frameId) {
          setDrafts((current) => {
            const entry = current[frameId];
            if (!entry) return current;
            return {
              ...current,
              [frameId]: event.shiftKey ? redoHistory(entry) : undoHistory(entry),
            };
          });
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        fit();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "1") {
        event.preventDefault();
        actualSize();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const next = toolByKey.get(event.key.toLowerCase());
      if (next) {
        setTool(next);
        return;
      }
      if (event.key === "Escape") setSelection(null);
      if (event.key === "[" || event.key === "]") {
        setBrushSize((size) =>
          event.key === "]" ? Math.min(3, size + 1) : Math.max(1, size - 1),
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // fit and actualSize read the live camera and buffer through refs below.
  }, [frameId, running]);

  // Playback walks the frame list on an interval and stops on the last frame.
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      setSelection(null);
      setFrameId((current) => {
        const index = frames.findIndex((item) => item.id === current);
        const nextIndex = (index + 1) % frames.length;
        return frames[nextIndex]?.id ?? current;
      });
    }, 220);
    return () => window.clearInterval(timer);
  }, [playing, frames]);

  const log = useCallback((text: string) => {
    setActivity((current) => [...current.slice(-6), { id: crypto.randomUUID(), text }]);
  }, []);

  const listen = useCallback(
    (id: string, fallbackFrameId: string) => {
      sourceRef.current?.close();
      const source = new EventSource(`/api/runs/${id}/stream`);
      sourceRef.current = source;
      source.onmessage = (event) => {
        const body = JSON.parse(event.data) as { type: string; data: unknown };
        if (body.type === "canvas-stroke") {
          const data = body.data as { frameId?: string; layers?: FrameDto["layers"] };
          // The payload names the frame being drawn. On a refresh the editor has no
          // frame yet when the stream attaches, so trusting the captured id would
          // drop every stroke.
          const target = data.frameId ?? fallbackFrameId;
          if (data.layers && target) {
            const layers = data.layers.map((layer) => ({
              ...layer,
              pixels: base64ToBytes(layer.pixels),
            }));
            setDrafts((current) => {
              const entry = current[target];
              if (!entry) return current;
              return {
                ...current,
                [target]: { ...entry, present: { ...entry.present, layers } },
              };
            });
            log("Drawing on the canvas");
          }
          return;
        }
        if (body.type === "tool_call") {
          const data = body.data as { name?: string };
          log(data.name ? `Using ${data.name.replaceAll("_", " ")}` : "Using a tool");
          return;
        }
        if (body.type === "model_delta") {
          log("Thinking it through");
          return;
        }
        if (body.type === "done") {
          const data = body.data as { status?: string };
          setMessage(
            data.status === "completed"
              ? "The frame is ready."
              : `Run ${data.status ?? "finished"}.`,
          );
          source.close();
          sourceRef.current = null;
          setRunId(null);
          void client.invalidateQueries({ queryKey: ["asset", assetId] });
          return;
        }
        log(body.type.replaceAll("_", " "));
      };
      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        setRunId(null);
      };
    },
    [assetId, client, log, update],
  );

  // Rejoin a run that is still going, which is what a page refresh needs.
  useEffect(() => {
    let cancelled = false;
    void api<{ run: { id: string; status: string } | null }>(
      `/api/assets/${assetId}/active-run`,
    )
      .then((result) => {
        if (cancelled || !result.run) return;
        setRunId(result.run.id);
        // The frame id arrives with each stroke, so the stream does not need one yet.
        listen(result.run.id, "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Runs are picked up once per asset.
  }, [assetId]);

  useEffect(() => () => sourceRef.current?.close(), []);

  function onAction(action: CanvasAction) {
    if (!frameId) return;
    if (action.kind === "pick") {
      setColor(action.index);
      setTool("pencil");
      return;
    }
    if (action.kind === "select") {
      setSelection(action.rect);
      return;
    }
    if (running) return;
    const current = drafts[frameId];
    if (!current || !activeLayerId) return;
    if (selection && "points" in action) {
      const kept = action.points.filter((point) => insideSelection(selection, point));
      if (kept.length === 0) return;
      edit(
        frameId,
        current,
        action.kind === "erase"
          ? { type: "erase", layerId: activeLayerId, points: kept }
          : {
              type: "paint",
              layerId: activeLayerId,
              points: kept.map((point) => ({ ...point, color })),
            },
      );
      return;
    }
    switch (action.kind) {
      case "paint":
        edit(frameId, current, {
          type: "paint",
          layerId: activeLayerId,
          points: action.points.map((point) => ({ ...point, color })),
        });
        return;
      case "erase":
        edit(frameId, current, {
          type: "erase",
          layerId: activeLayerId,
          points: action.points,
        });
        return;
      case "fill": {
        // With a selection active the flood seeds from the click, clamped into the
        // rectangle. Seeding from the rectangle's corner made the fill a no-op
        // whenever that corner already held the fill colour.
        const seed = selection
          ? {
              x: Math.min(
                Math.max(action.point.x, selection.x),
                selection.x + selection.width - 1,
              ),
              y: Math.min(
                Math.max(action.point.y, selection.y),
                selection.y + selection.height - 1,
              ),
            }
          : action.point;
        edit(
          frameId,
          current,
          selection
            ? {
                type: "region",
                layerId: activeLayerId,
                ...selection,
                color,
                mode: "flood",
              }
            : { type: "fill", layerId: activeLayerId, ...seed, color },
        );
        return;
      }
      case "line": {
        // An active selection constrains every tool, so the line is emitted as the
        // clipped cells rather than the whole drag.
        if (selection) {
          const cells = linePoints(action.from.x, action.from.y, action.to.x, action.to.y)
            .filter((point) => insideSelection(selection, point))
            .map((point) => ({ ...point, color }));
          if (cells.length === 0) return;
          edit(frameId, current, {
            type: "paint",
            layerId: activeLayerId,
            points: cells,
          });
          return;
        }
        edit(frameId, current, {
          type: "line",
          layerId: activeLayerId,
          x0: action.from.x,
          y0: action.from.y,
          x1: action.to.x,
          y1: action.to.y,
          color,
        });
        return;
      }
      case "rect": {
        const box = normalizeRect(action.from, action.to);
        const shape = selection ? intersect(box, selection) : box;
        if (shape.width < 1 || shape.height < 1) return;
        edit(frameId, current, {
          type: "rect",
          layerId: activeLayerId,
          ...shape,
          color,
          filled: action.filled,
        });
        return;
      }
      default:
        return;
    }
  }

  function selectionCommand(mode: "fill" | "clear") {
    if (running) return;
    if (!frameId || !selection || !activeLayerId) return;
    edit(frameId, drafts[frameId], {
      type: "region",
      layerId: activeLayerId,
      ...selection,
      color,
      mode,
    });
  }

  const refresh = () => client.invalidateQueries({ queryKey: ["asset", assetId] });

  async function frameAction(
    kind: "add" | "duplicate" | "rename" | "delete",
    value?: string,
  ) {
    if (!frameId) return;
    try {
      if (kind === "add") {
        await api(`/api/assets/${assetId}/frames`, {
          method: "POST",
          body: JSON.stringify({ name: value ?? "" }),
        });
      } else if (kind === "duplicate") {
        await api(`/api/assets/${assetId}/frames/${frameId}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ name: value }),
        });
      } else if (kind === "rename" && value !== undefined) {
        await api(`/api/assets/${assetId}/frames/${frameId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: value }),
        });
      } else if (kind === "delete") {
        await api(`/api/assets/${assetId}/frames/${frameId}`, { method: "DELETE" });
        // The draft for a deleted frame keeps up to 101 buffers alive and would
        // keep autosaving to a frame that no longer exists.
        flush();
        setDrafts((current) => {
          const next = { ...current };
          delete next[frameId];
          return next;
        });
        const fallback = frames.find((item) => item.id !== frameId);
        setFrameId(fallback?.id ?? null);
        setSelection(null);
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That frame change failed.");
    }
  }

  async function updateAsset(input: {
    name?: string;
    width?: number;
    height?: number;
    palette?: string[];
  }) {
    if (
      (input.width !== undefined && (input.width < 8 || input.width > 128)) ||
      (input.height !== undefined && (input.height < 8 || input.height > 128))
    ) {
      setError("Canvas size must be a whole number from 8 to 128.");
      return;
    }
    try {
      flush();
      await api(`/api/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      // Size and palette changed under the drafts, so every frame is re-seeded
      // from the server instead of being autosaved back at the old dimensions.
      setDrafts({});
      setSelection(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That asset change failed.");
    }
  }

  async function generate() {
    if (!frameId) return;
    setError(null);
    setMessage("");
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
      });
      const started = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          assetId,
          frameId,
          prompt,
          modelId,
          reasoningEffort: effort,
        }),
      });
      setRunId(started.runId);
      listen(started.runId, frameId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Generation failed.");
    }
  }

  async function stop() {
    if (!runId) return;
    try {
      await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    } finally {
      setRunId(null);
      sourceRef.current?.close();
      sourceRef.current = null;
    }
  }

  const usedColors = buffer ? usedColorCount(buffer) : 0;
  const models = catalog.data?.models.map((item) => item.id) ?? [];
  const efforts = catalog.data?.reasoningEfforts ?? [];

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] bg-paper">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <a href="/projects" className="font-mono text-xs tracking-[0.18em] text-accent">
          PIXELAITION
        </a>
        <p className="truncate text-sm text-muted">
          {asset.data
            ? `${asset.data.projectName} / ${asset.data.name}`
            : "Loading asset"}
        </p>
        <div className="flex items-center gap-2">
          {running ? (
            <span className="font-mono text-[11px] text-accent">
              {frame ? `Drawing ${frame.name}` : "Drawing"}
            </span>
          ) : null}
          <Button
            tone="ghost"
            onClick={() => {
              // Export renders server state, so a stroke still inside the debounce
              // window has to be written first.
              flush();
              setExportOpen(true);
            }}
            disabled={!asset.data}
          >
            Export
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 lg:grid-cols-[240px_1fr_260px]">
        <aside className="hidden min-h-0 gap-5 overflow-auto border-r border-line p-3 lg:flex lg:flex-col">
          <FrameList
            frames={frames}
            activeId={frameId}
            playing={playing}
            onSelect={(id) => {
              setFrameId(id);
              setSelection(null);
            }}
            onTogglePlay={() => setPlaying((value) => !value)}
            onAdd={() => void frameAction("add")}
            onDuplicate={() => void frameAction("duplicate")}
            onRename={(_id, name) => void frameAction("rename", name)}
            onDelete={() => void frameAction("delete")}
          />
          <LayerList
            buffer={buffer}
            activeId={activeLayerId}
            locked={running}
            onSelect={setActiveLayerId}
            onToggleVisible={(layerId, visible) =>
              frameId &&
              edit(frameId, drafts[frameId], {
                type: "setLayerVisible",
                layerId,
                visible,
              })
            }
            onAdd={() =>
              frameId &&
              edit(frameId, drafts[frameId], {
                type: "addLayer",
                id: crypto.randomUUID(),
                name: `layer-${(buffer?.layers.length ?? 0) + 1}`,
              })
            }
            onRename={(layerId, name) =>
              frameId &&
              edit(frameId, drafts[frameId], { type: "renameLayer", layerId, name })
            }
            onDelete={() =>
              frameId &&
              edit(frameId, drafts[frameId], {
                type: "removeLayer",
                layerId: activeLayerId,
              })
            }
          />
        </aside>

        <div className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
            {toolList.map((item) => {
              const Icon = item.icon;
              return (
                <IconButton
                  key={item.id}
                  label={`${item.label} (${item.key})`}
                  active={tool === item.id}
                  onClick={() => setTool(item.id)}
                >
                  <Icon />
                </IconButton>
              );
            })}
            <span className="mx-1 h-5 w-px bg-line" />
            <IconButton
              label="Brush size 1"
              active={brushSize === 1}
              onClick={() => setBrushSize(1)}
            >
              <span className="text-[10px]">1</span>
            </IconButton>
            <IconButton
              label="Brush size 2"
              active={brushSize === 2}
              onClick={() => setBrushSize(2)}
            >
              <span className="text-[10px]">2</span>
            </IconButton>
            <IconButton
              label="Brush size 3"
              active={brushSize === 3}
              onClick={() => setBrushSize(3)}
            >
              <span className="text-[10px]">3</span>
            </IconButton>
            <span className="mx-1 h-5 w-px bg-line" />
            <IconButton
              label="Zoom out"
              onClick={() => setCamera({ ...camera, zoom: stepZoom(camera.zoom, -1) })}
            >
              −
            </IconButton>
            <span className="w-12 text-center font-mono text-[11px] text-muted">
              {Math.round(camera.zoom * 100)}%
            </span>
            <IconButton
              label="Zoom in"
              onClick={() => setCamera({ ...camera, zoom: stepZoom(camera.zoom, 1) })}
            >
              +
            </IconButton>
            <IconButton label="Fit to view" onClick={fit}>
              Fit
            </IconButton>
            <IconButton label="Actual size" onClick={actualSize}>
              1:1
            </IconButton>
            <span className="mx-1 h-5 w-px bg-line" />
            <Toggle label="Grid" checked={grid} onChange={setGrid} />
            <Toggle label="Checker" checked={checker} onChange={setChecker} />
            <Toggle label="Onion skin" checked={onion} onChange={setOnion} />
            {selection ? (
              <>
                <span className="mx-1 h-5 w-px bg-line" />
                <Button tone="ghost" onClick={() => selectionCommand("fill")}>
                  Fill
                </Button>
                <Button tone="ghost" onClick={() => selectionCommand("clear")}>
                  Clear
                </Button>
                <Button tone="ghost" onClick={() => setSelection(null)}>
                  Deselect
                </Button>
              </>
            ) : null}
          </div>
          <div ref={viewRef} className="relative min-h-0 flex-1">
            <PixelCanvas
              buffer={buffer ?? FALLBACK_BUFFER}
              camera={camera}
              tool={tool}
              brushSize={brushSize}
              grid={grid}
              checker={checker}
              onionSkin={onionSkin}
              selection={selection}
              locked={running}
              onAction={onAction}
              onCamera={setCamera}
            />
          </div>
        </div>

        <aside className="hidden min-h-0 gap-5 overflow-auto border-l border-line p-3 lg:flex lg:flex-col">
          <PalettePanel
            palette={buffer?.palette ?? []}
            color={color}
            usedColors={usedColors}
            width={asset.data?.width ?? 32}
            height={asset.data?.height ?? 32}
            onPick={setColor}
            onAdd={(hex) => {
              if (!frameId || !buffer) return;
              if (buffer.palette.includes(hex)) {
                setColor(buffer.palette.indexOf(hex));
                return;
              }
              void updateAsset({ palette: [...buffer.palette, hex] });
            }}
            onResize={(width, height) => void updateAsset({ width, height })}
          />
        </aside>
      </div>

      <footer className="border-t border-line p-3">
        <Composer
          prompt={prompt}
          onPrompt={setPrompt}
          modelId={modelId}
          models={models}
          onModel={setModelId}
          effort={effort}
          efforts={efforts}
          onEffort={setEffort}
          running={running}
          modelReady={catalog.data?.modelReady ?? false}
          activity={activity}
          message={message}
          error={error}
          onGenerate={() => void generate()}
          onStop={() => void stop()}
        />
      </footer>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        projectId={asset.data?.projectId ?? ""}
        assetId={assetId}
        frameId={frameId ?? ""}
        frameName={frame?.name ?? ""}
        assetName={asset.data?.name ?? ""}
      />
    </div>
  );
}

function insideSelection(box: Rect, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.y >= box.y &&
    point.x < box.x + box.width &&
    point.y < box.y + box.height
  );
}

function intersect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const far = Math.min(left.x + left.width, right.x + right.width);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  return { x, y, width: far - x, height: bottom - y };
}

// One shared placeholder, so the canvas bitmap cache does not fill with a new
// offscreen canvas on every render while the asset query is in flight.
const FALLBACK_BUFFER: FrameBuffer = {
  width: 8,
  height: 8,
  palette: ["#00000000"],
  layers: [{ id: "empty", name: "pixels", visible: true, pixels: new Uint8Array(64) }],
};

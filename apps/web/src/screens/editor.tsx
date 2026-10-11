import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type StyleGuide,
} from "@pixelaition/pixel";
import { Composer } from "../components/composer.js";
import { PixelLoader } from "../components/pixel-loader.js";
import { RunConsole, type HistoryRun } from "../components/run-console.js";
import {
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "../components/interaction-card.js";
import { applyRunEvent, type RunRow } from "../lib/run-activity.js";
import { ExportDialog } from "../components/export-dialog.js";
import {
  FramePanel,
  LayerPanel,
  PalettePanel,
  StylePanel,
} from "../components/editor-panels.js";
import { Toolbar, ViewPanel } from "../components/editor-toolbar.js";
import { Minus, Plus } from "../components/pixel-icons.js";
import {
  normalizeRect,
  PixelCanvas,
  type CanvasAction,
  type Point,
  type Rect,
  type Tool,
} from "../components/pixel-canvas.js";
import {
  Button,
  Callout,
  EmptyState,
  IconButton,
  PixelMark,
  Sheet,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useMediaQuery } from "../lib/use-media.js";
import {
  base64ToBytes,
  bytesToBase64,
  type AssetDto,
  type FrameDto,
} from "../lib/types.js";

const toolByKey = new Map<string, Tool>([
  ["v", "select"],
  ["b", "pencil"],
  ["e", "eraser"],
  ["g", "fill"],
  ["i", "picker"],
  ["l", "line"],
  ["r", "rect"],
  ["h", "pan"],
]);

const fallbackStyle: StyleGuide = {
  defaultWidth: 32,
  defaultHeight: 32,
  maxColors: 8,
  outline: "#1a1c2c",
  shadowDirection: "down",
  notes: "",
};

// One shared placeholder, so the canvas bitmap cache does not collect a new
// offscreen canvas on every render while the asset query is in flight.
const fallbackBuffer: FrameBuffer = {
  width: 8,
  height: 8,
  palette: ["#00000000"],
  layers: [{ id: "empty", name: "pixels", visible: true, pixels: new Uint8Array(64) }],
};

type ActiveRunResponse = {
  run: { id: string; status: string } | null;
  /** The pending card of a waiting run; null when the run is not waiting. */
  interaction: PendingInteraction | null;
  lastRun: {
    id: string;
    status: string;
    prompt: string | null;
    events: Array<{ sequence: number; type: string; data: unknown }>;
    text: string;
    durationMs: number | null;
  } | null;
  history: HistoryRun[];
};

export function EditorScreen() {
  const { assetId } = useParams({ from: "/projects/$projectId/assets/$assetId" });
  const client = useQueryClient();
  const notify = useToast();

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
        models: Array<{ id: string; efforts: string[] }>;
        modelReady: boolean;
      }>("/api/models"),
  });

  const [frameId, setFrameId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, History>>({});
  const [tool, setTool] = useState<Tool>("pan");
  const [brushSize, setBrushSize] = useState(1);
  const [color, setColor] = useState(1);
  const [activeLayerId, setActiveLayerId] = useState("");
  const [camera, setCamera] = useState<Camera>({ x: 40, y: 40, zoom: 16 });
  const [viewMode, setViewMode] = useState<"fit" | "actual" | "free">("fit");
  const [selection, setSelection] = useState<Rect | null>(null);
  const [grid, setGrid] = useState(false);
  const [checker, setChecker] = useState(true);
  const [onion, setOnion] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [rows, setRows] = useState<RunRow[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runFrameId, setRunFrameId] = useState<string | null>(null);
  const runFrameIdRef = useRef<string | null>(null);
  runFrameIdRef.current = runFrameId;
  const displayedRunIdRef = useRef<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(
    null,
  );
  // The ids this session already answered, so a replayed interaction event
  // cannot bring an answered card back before its resolved marker arrives.
  const answeredIdsRef = useRef<Set<string>>(new Set());
  const [restoredMs, setRestoredMs] = useState<number | null>(null);
  const [runPrompt, setRunPrompt] = useState("");
  const [runHistory, setRunHistory] = useState<HistoryRun[]>([]);
  const [leftSheet, setLeftSheet] = useState(false);
  const [rightSheet, setRightSheet] = useState(false);
  // Below lg the columns become sheets. Keeping them mounted at desktop widths
  // strands Base UI's exit animation and its inert overlay blocks the page.
  const wide = useMediaQuery("(min-width: 1024px)");
  useEffect(() => {
    if (!wide) return;
    setLeftSheet(false);
    setRightSheet(false);
  }, [wide]);
  const viewRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const fitted = useRef<string | null>(null);

  const frames = asset.data?.frames ?? [];
  const frame = frames.find((item) => item.id === frameId) ?? null;
  const history = frameId ? drafts[frameId] : undefined;
  const buffer = history?.present;
  // While playback cycles frames, the layer selection must not blink: fall back
  // to the first layer of whichever frame the panel is showing.
  const panelLayerId =
    buffer && buffer.layers.some((layer) => layer.id === activeLayerId)
      ? activeLayerId
      : (buffer?.layers[0]?.id ?? "");
  const running = runId !== null;
  const style = (asset.data?.style as StyleGuide | undefined) ?? fallbackStyle;
  // A live run can touch every frame of the asset, so the editor locks all of
  // them; runFrameId still marks the frame the agent is painting on.
  const locked = running;
  const drawingHere = running && runFrameId === frameId;
  const bufferRef = useRef<FrameBuffer | undefined>(buffer);
  bufferRef.current = buffer;

  const fit = useCallback(() => {
    const rect = viewRef.current?.getBoundingClientRect();
    const doc = bufferRef.current;
    if (!rect || !doc || rect.width === 0) return;
    const zoom = fitZoom(rect.width, rect.height, doc.width, doc.height);
    setCamera(centerCamera(rect.width, rect.height, doc.width, doc.height, zoom));
  }, []);

  // Opening an asset should show the whole sprite, not a corner of it.
  useEffect(() => {
    const key = asset.data ? `${assetId}:${asset.data.width}x${asset.data.height}` : null;
    if (!key || !buffer || fitted.current === key) return;
    const rect = viewRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    fitted.current = key;
    fit();
    setViewMode("fit");
  }, [assetId, asset.data, buffer, fit]);

  // Seed a draft for every frame the server knows about, keeping local edits.
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

  // A stored preference can name a model or effort that is no longer offered;
  // the composer must always show a selectable pair.
  useEffect(() => {
    const options = catalog.data?.models ?? [];
    if (options.length === 0) return;
    if (!options.some((item) => item.id === modelId)) setModelId(options[0]?.id ?? "");
  }, [catalog.data, modelId]);

  useEffect(() => {
    const options =
      catalog.data?.models.find((item) => item.id === modelId)?.efforts ?? [];
    if (options.length > 0 && !options.includes(effort)) setEffort(options[0] ?? "");
  }, [catalog.data, modelId, effort]);

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
      if (item) {
        neighbors.push(
          frameToBuffer(item, asset.data.width, asset.data.height, asset.data.palette),
        );
      }
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
        notify({ title: "That edit was refused", description: result.message });
        return;
      }
      setError(null);
      update(frameKey, pushHistory(current, result.buffer));
    },
    [notify, update],
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
  const pending = useRef(new Map<string, FrameBuffer>());
  const debounce = useRef<number | null>(null);
  // The mutation result is a fresh object every render, so it must not be a
  // dependency of the effects below or they re-arm forever.
  const mutate = useRef(save.mutateAsync);
  mutate.current = save.mutateAsync;

  const flush = useCallback(async () => {
    if (debounce.current !== null) {
      window.clearTimeout(debounce.current);
      debounce.current = null;
    }
    const batch = [...pending.current.entries()];
    pending.current.clear();
    await Promise.all(
      batch.map(([id, buffer]) =>
        mutate.current({ frameId: id, buffer }).catch((reason: unknown) =>
          notify({
            title: "A frame did not save",
            description: reason instanceof Error ? reason.message : "Unknown error",
          }),
        ),
      ),
    );
  }, [notify]);

  useEffect(() => {
    // The agent owns the frame while a run is live: the editor never writes a
    // stale buffer over the streamed strokes, and any armed debounce is
    // cancelled so a pre-run edit cannot slip through mid-run.
    if (running) {
      if (debounce.current !== null) {
        window.clearTimeout(debounce.current);
        debounce.current = null;
      }
      return;
    }
    if (!present || !frameId) return;
    pending.current.set(frameId, present);
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      debounce.current = null;
      void flush();
    }, 500);
    return () => undefined;
  }, [present, frameId, flush, running]);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (running || !frameId) return;
        setDrafts((current) => {
          const entry = current[frameId];
          if (!entry) return current;
          return {
            ...current,
            [frameId]: event.shiftKey ? redoHistory(entry) : undoHistory(entry),
          };
        });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        event.preventDefault();
        fit();
        setViewMode("fit");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "1") {
        event.preventDefault();
        const rect = viewRef.current?.getBoundingClientRect();
        const doc = bufferRef.current;
        if (rect && doc) {
          setCamera(centerCamera(rect.width, rect.height, doc.width, doc.height, 1));
        }
        setViewMode("actual");
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
  }, [fit, frameId, running]);

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
    setRows((current) => [
      ...current.slice(-120),
      { id: crypto.randomUUID(), kind: "status", label: text, state: "running" },
    ]);
  }, []);

  const listen = useCallback(
    (id: string, fallbackFrameId: string, after = 0) => {
      sourceRef.current?.close();
      const source = new EventSource(`/api/runs/${id}/stream?after=${after}`);
      sourceRef.current = source;
      source.onmessage = (event) => {
        const body = JSON.parse(event.data) as {
          type: string;
          data: unknown;
          sequence: number;
        };
        setRows((current) => applyRunEvent(current, body.sequence, body.type, body.data));
        if (body.type === "canvas-stroke") {
          const data = body.data as { frameId?: string; layers?: FrameDto["layers"] };
          const target = data.frameId ?? fallbackFrameId;
          if (data.layers && target) {
            setRunFrameId(target);
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
          }
          return;
        }
        if (body.type === "status") {
          const data = body.data as { status?: string; outcome?: { text?: string } };
          if (data.status === "completed" && typeof data.outcome?.text === "string") {
            setMessage(data.outcome.text);
          }
          return;
        }
        if (body.type === "interaction") {
          // The card is the run's next move, not a step row; open the console
          // so it is visible even if the user had collapsed it. A replayed
          // interaction the run already answered must not resurrect.
          const data = body.data as PendingInteraction;
          if (!answeredIdsRef.current.has(data.id)) {
            setPendingInteraction(data);
            setConsoleOpen(true);
          }
          return;
        }
        if (body.type === "interaction-resolved") {
          // The worker retires an answered card by id; a replay from 0 ends
          // with the card cleared instead of re-showing it.
          const data = body.data as { id?: string };
          if (typeof data.id === "string") {
            answeredIdsRef.current.add(data.id);
            setPendingInteraction((current) =>
              current?.id === data.id ? null : current,
            );
          }
          return;
        }
        if (body.type === "done") {
          const data = body.data as { status?: string; error?: string };
          setMessage(
            data.status === "completed"
              ? ""
              : (data.error ?? `The run ${data.status ?? "finished"}.`),
          );
          setPendingInteraction(null);
          source.close();
          sourceRef.current = null;
          setRunId(null);
          setRunFrameId(null);
          // Drop the local draft for the drawn frame so the reloaded pixels
          // from the server become the truth.
          const target = runFrameIdRef.current;
          if (target) {
            pending.current.delete(target);
            setDrafts((current) => {
              if (!current[target]) return current;
              const next = { ...current };
              delete next[target];
              return next;
            });
          }
          void client.invalidateQueries({ queryKey: ["asset", assetId] });
          // The finished run is on screen already; only the earlier list needs
          // a refresh, and it is scoped to the frame the agent painted.
          const shown = runFrameIdRef.current;
          if (shown) {
            void api<ActiveRunResponse>(
              `/api/assets/${assetId}/active-run?frameId=${encodeURIComponent(shown)}`,
            )
              .catch(() => null)
              .then((result) => {
                if (!result || sourceRef.current) return;
                setRunHistory(
                  result.history.filter((item) => item.id !== result.lastRun?.id),
                );
              });
          }
          return;
        }
        // Other events are already reflected in the row list above.
      };
      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        // A dropped stream does not mean the run stopped: ask the server. The
        // answer carries the pending card too, so a waiting run restores it
        // even when the replayed stream no longer retains the interaction.
        void api<ActiveRunResponse>(`/api/assets/${assetId}/active-run`)
          .catch(() => ({ run: null, interaction: null }))
          .then((result) => {
            if (result.run) {
              setRunId(result.run.id);
              setPendingInteraction(result.interaction);
              log("The stream dropped; rejoining the running agent");
              listen(result.run.id, "", 0);
              return;
            }
            setRunId(null);
            setRunFrameId(null);
            setPendingInteraction(null);
            log("The activity stream closed");
          });
      };
    },
    [assetId, client, log],
  );

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const result = await api<ActiveRunResponse>(
        `/api/assets/${assetId}/active-run`,
      ).catch(() => ({ run: null, interaction: null, lastRun: null, history: [] }));
      if (cancelled || sourceRef.current) return;
      if (result.run) {
        setRunId(result.run.id);
        setConsoleOpen(true);
        // A waiting run restores its card straight from the row's stored
        // events; the stream alone cannot be trusted to retain it.
        setPendingInteraction(result.interaction);
        log("Rejoined a run that was still going");
        listen(result.run.id, "", 0);
        return;
      }
      setPendingInteraction(null);
    }
    void check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [assetId, listen, log]);

  // Switching frames rewinds the console to that frame's story: its last run's
  // steps and answer, plus the prompts and answers of the runs before it.
  useEffect(() => {
    if (!frameId) return;
    let cancelled = false;
    void (async () => {
      const result = await api<ActiveRunResponse>(
        `/api/assets/${assetId}/active-run?frameId=${encodeURIComponent(frameId)}`,
      ).catch(() => null);
      if (cancelled || !result || sourceRef.current || result.run) return;
      const latest = result.lastRun;
      setRunHistory(result.history.filter((item) => item.id !== latest?.id));
      if (latest?.id === displayedRunIdRef.current) return;
      let restored: RunRow[] = [];
      for (const event of latest?.events ?? []) {
        restored = applyRunEvent(restored, event.sequence, event.type, event.data);
      }
      setRows(restored);
      setMessage(latest?.text ?? "");
      setRestoredMs(latest?.durationMs ?? null);
      setRunPrompt(latest?.prompt ?? "");
      displayedRunIdRef.current = latest?.id ?? null;
    })();
    return () => {
      cancelled = true;
    };
  }, [frameId, assetId]);

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
    targetId?: string,
  ) {
    if (running) return;
    if (!frameId) return;
    const target = targetId ?? frameId;
    try {
      if (kind === "add") {
        await api(`/api/assets/${assetId}/frames`, {
          method: "POST",
          body: JSON.stringify({ name: value ?? "" }),
        });
      } else if (kind === "duplicate") {
        await api(`/api/assets/${assetId}/frames/${target}/duplicate`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      } else if (kind === "rename" && value !== undefined) {
        await api(`/api/assets/${assetId}/frames/${target}`, {
          method: "PATCH",
          body: JSON.stringify({ name: value }),
        });
      } else if (kind === "delete") {
        await api(`/api/assets/${assetId}/frames/${target}`, { method: "DELETE" });
        flush();
        setDrafts((current) => {
          const next = { ...current };
          delete next[target];
          return next;
        });
        const fallback = frames.find((item) => item.id !== target);
        setFrameId(fallback?.id ?? null);
        setSelection(null);
      }
      await refresh();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "That change failed.";
      setError(text);
      notify({ title: "Frame change failed", description: text });
    }
  }

  async function frameReorder(id: string, index: number): Promise<boolean> {
    if (running) return false;
    try {
      await api(`/api/assets/${assetId}/frames/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ index }),
      });
      await refresh();
      return true;
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "That change failed.";
      setError(text);
      notify({ title: "Frame change failed", description: text });
      return false;
    }
  }

  async function updateAsset(input: {
    name?: string;
    width?: number;
    height?: number;
    palette?: string[];
  }) {
    if (running) return;
    if (
      (input.width !== undefined && (input.width < 8 || input.width > 128)) ||
      (input.height !== undefined && (input.height < 8 || input.height > 128))
    ) {
      const text = "Canvas size must be a whole number from 8 to 128.";
      setError(text);
      notify({ title: "Size refused", description: text });
      return;
    }
    try {
      flush();
      await api(`/api/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      setDrafts({});
      fitted.current = null;
      setSelection(null);
      await refresh();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "That change failed.";
      setError(text);
      notify({ title: "Asset change failed", description: text });
    }
  }

  async function generate() {
    if (!frameId || running) return;
    setError(null);
    setMessage("");
    setRows([]);
    setConsoleOpen(true);
    setRestoredMs(null);
    setRunPrompt(prompt);
    setRunHistory([]);
    try {
      // Local edits made before the run must land before the agent starts.
      await flush();
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
      displayedRunIdRef.current = started.runId;
      setRunFrameId(frameId);
      log(`Run ${started.runId.slice(0, 8)} started`);
      listen(started.runId, frameId);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "Generation failed.";
      setError(text);
      notify({ title: "Could not start the run", description: text });
    }
  }

  async function stop() {
    if (!runId) return;
    try {
      await api(`/api/runs/${runId}/cancel`, { method: "POST" });
      log("Stopped; waiting for the agent to acknowledge");
      // The stream stays open: the worker's cancelled status and done event
      // clear the run state and reload the frame.
    } catch (reason) {
      notify({
        title: "Could not stop the run",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    }
  }

  function focusComposer() {
    composerRef.current?.querySelector("textarea")?.focus();
  }

  /**
   * Answers the pending card. A plan-scope edit is staged against the very
   * interaction it answers before the response travels, in that order; a
   * failed call leaves the card up and names the cause in a toast.
   */
  async function respondToInteraction(
    response: InteractionResponse,
    stagedFrames?: StagedPlanFrame[],
  ) {
    if (!runId || !pendingInteraction) return;
    try {
      if (stagedFrames) {
        await api(`/api/runs/${runId}/stage-override`, {
          method: "POST",
          body: JSON.stringify({
            interactionId: pendingInteraction.id,
            frames: stagedFrames,
          }),
        });
      }
      await api(`/api/runs/${runId}/respond`, {
        method: "POST",
        body: JSON.stringify({ interactionId: pendingInteraction.id, response }),
      });
      answeredIdsRef.current.add(pendingInteraction.id);
      setPendingInteraction(null);
      setConsoleOpen(true);
    } catch (reason) {
      notify({
        title: "The answer did not reach the agent",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
      // The card owns its busy state; a rejection re-arms its buttons.
      throw reason;
    }
  }

  const usedColors = buffer ? usedColorCount(buffer) : 0;
  const models = catalog.data?.models.map((item) => item.id) ?? [];
  const efforts = catalog.data?.models.find((item) => item.id === modelId)?.efforts ?? [];

  const leftPanels = (
    <>
      <FramePanel
        frames={frames}
        palette={buffer?.palette ?? asset.data?.palette ?? []}
        activeId={frameId}
        playing={playing}
        locked={running}
        onSelect={(id) => {
          setFrameId(id);
          setSelection(null);
        }}
        onTogglePlay={() => setPlaying((value) => !value)}
        onAdd={() => void frameAction("add")}
        onDuplicate={(id) => void frameAction("duplicate", undefined, id)}
        onRename={(id, name) => void frameAction("rename", name, id)}
        onDelete={(id) => void frameAction("delete", undefined, id)}
        onReorder={(id, index) => frameReorder(id, index)}
      />
      <LayerPanel
        buffer={buffer}
        activeId={panelLayerId}
        locked={locked}
        onSelect={setActiveLayerId}
        onToggleVisible={(layerId, visible) =>
          frameId &&
          edit(frameId, drafts[frameId], { type: "setLayerVisible", layerId, visible })
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
        onDelete={(layerId) =>
          frameId &&
          edit(frameId, drafts[frameId], {
            type: "removeLayer",
            layerId,
          })
        }
      />
    </>
  );

  const rightPanels = (
    <>
      <PalettePanel
        palette={buffer?.palette ?? []}
        color={color}
        usedColors={usedColors}
        maxColors={style.maxColors}
        onPick={setColor}
        onAdd={(hex) => {
          if (!buffer) return;
          if (buffer.palette.includes(hex)) {
            setColor(buffer.palette.indexOf(hex));
            return;
          }
          void updateAsset({ palette: [...buffer.palette, hex] });
        }}
      />
      <ViewPanel
        grid={grid}
        checker={checker}
        onion={onion}
        onGrid={setGrid}
        onChecker={setChecker}
        onOnion={setOnion}
      />
      <StylePanel
        style={style}
        width={asset.data?.width ?? 32}
        height={asset.data?.height ?? 32}
        onResize={(width, height) => void updateAsset({ width, height })}
      />
    </>
  );

  return (
    <main
      id="content"
      className="grid h-dvh min-h-0 grid-rows-[auto_1fr] overflow-hidden bg-paper"
    >
      <header className="flex min-w-0 items-center gap-3 px-3 py-2">
        <a
          href="/projects"
          className="flex items-center gap-2.5 text-pixel-display text-accent whitespace-nowrap"
        >
          <PixelMark />
          PIXELAITION
        </a>
        <p className="min-w-0 truncate text-sm text-muted">
          {asset.data ? (
            <>
              <span className="text-ink">{asset.data.name}</span>
              <span className="mx-1.5">/</span>
              {asset.data.projectName}
            </>
          ) : (
            "Loading asset"
          )}
        </p>
        <span className="ml-auto flex items-center gap-1.5">
          {running ? (
            <span className="hidden items-center gap-1.5 text-pixel-mono text-accent sm:flex">
              <PixelLoader size={12} />
              drawing
            </span>
          ) : null}
          <IconButton
            label="Frames and layers"
            className="lg:hidden"
            onClick={() => setLeftSheet(true)}
          >
            ☰
          </IconButton>
          <IconButton
            label="Palette and style"
            className="lg:hidden"
            onClick={() => setRightSheet(true)}
          >
            ◨
          </IconButton>
          <Button
            tone="ghost"
            className="px-2.5 py-1.5 text-xs"
            disabled={!asset.data}
            onClick={() => {
              flush();
              setExportOpen(true);
            }}
          >
            Export
          </Button>
        </span>
      </header>

      <div className="grid min-h-0 min-w-0 grid-rows-[1fr]">
        <div className="grid min-h-0 min-w-0 lg:grid-cols-[280px_1fr_300px]">
          <aside className="hidden min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-3 lg:flex">
            {leftPanels}
          </aside>

          <div className="relative flex min-h-0 min-w-0 flex-col">
            <div className="order-2 min-w-0 sm:order-1">
              <Toolbar
                tool={tool}
                brushSize={brushSize}
                selectionActive={selection !== null}
                locked={locked}
                onTool={setTool}
                onBrush={setBrushSize}
                onSelectionFill={() => selectionCommand("fill")}
                onSelectionClear={() => selectionCommand("clear")}
                onDeselect={() => setSelection(null)}
              />
            </div>
            <div
              ref={viewRef}
              className="relative order-1 min-h-0 min-w-0 flex-1 sm:order-2"
            >
              {asset.isPending ? (
                <Centered>
                  <p className="text-sm text-muted">Loading the asset from the server.</p>
                </Centered>
              ) : asset.isError ? (
                <Centered>
                  <div className="grid max-w-sm gap-3">
                    <Callout tone="danger">
                      {asset.error instanceof Error
                        ? asset.error.message
                        : "The asset could not be loaded."}
                    </Callout>
                    <Button tone="ghost" onClick={() => void asset.refetch()}>
                      Try again
                    </Button>
                  </div>
                </Centered>
              ) : frames.length === 0 ? (
                <Centered>
                  <div className="max-w-sm">
                    <EmptyState
                      title="This asset has no frames"
                      body="Add a frame on the left to start drawing."
                      action={
                        <Button
                          tone="ghost"
                          className="lg:hidden"
                          onClick={() => setLeftSheet(true)}
                        >
                          Open frames
                        </Button>
                      }
                    />
                  </div>
                </Centered>
              ) : (
                <PixelCanvas
                  buffer={buffer ?? fallbackBuffer}
                  camera={camera}
                  tool={tool}
                  brushSize={brushSize}
                  grid={grid}
                  checker={checker}
                  onionSkin={onionSkin}
                  selection={selection}
                  locked={locked}
                  onAction={onAction}
                  onCamera={(next) => {
                    setViewMode((mode) => (next.zoom !== camera.zoom ? "free" : mode));
                    setCamera(next);
                  }}
                />
              )}
              {drawingHere ? (
                <p className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border-2 border-accent bg-paper px-2 py-1 text-pixel-mono text-accent">
                  the agent is drawing on this frame
                </p>
              ) : null}
              <div className="absolute right-3 bottom-3 z-30 flex w-11 flex-col items-center gap-1 border-2 border-line-strong bg-panel p-1">
                <span className="w-full text-center text-pixel-mono text-muted">
                  {Math.round(camera.zoom * 100)}%
                </span>
                <IconButton
                  label="Zoom out"
                  size="sm"
                  onClick={() => {
                    setViewMode("free");
                    setCamera((current) => ({
                      ...current,
                      zoom: stepZoom(current.zoom, -1),
                    }));
                  }}
                >
                  <Minus />
                </IconButton>
                <IconButton
                  label="Zoom in"
                  size="sm"
                  onClick={() => {
                    setViewMode("free");
                    setCamera((current) => ({
                      ...current,
                      zoom: stepZoom(current.zoom, 1),
                    }));
                  }}
                >
                  <Plus />
                </IconButton>
                <span className="my-0.5 h-px w-7 bg-line" aria-hidden />
                <button
                  type="button"
                  aria-label="Fit to view"
                  aria-pressed={viewMode === "fit"}
                  title="Fit to view (Ctrl+0)"
                  onClick={() => {
                    fit();
                    setViewMode("fit");
                  }}
                  className={`flex h-7 w-7 items-center justify-center border-2 text-pixel-mono transition-colors duration-150 ${
                    viewMode === "fit"
                      ? "border-accent text-accent"
                      : "border-line text-muted hover:text-ink"
                  }`}
                >
                  Fit
                </button>
                <button
                  type="button"
                  aria-label="Actual size"
                  aria-pressed={viewMode === "actual"}
                  title="Actual size (Ctrl+1)"
                  onClick={() => {
                    const rect = viewRef.current?.getBoundingClientRect();
                    const doc = bufferRef.current;
                    if (rect && doc) {
                      setCamera(
                        centerCamera(rect.width, rect.height, doc.width, doc.height, 1),
                      );
                    }
                    setViewMode("actual");
                  }}
                  className={`flex h-7 w-7 items-center justify-center border-2 text-pixel-mono transition-colors duration-150 ${
                    viewMode === "actual"
                      ? "border-accent text-accent"
                      : "border-line text-muted hover:text-ink"
                  }`}
                >
                  1:1
                </button>
              </div>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex max-h-[calc(100%-1.5rem)] flex-col items-center gap-2 overflow-y-auto px-3">
              <RunConsole
                rows={rows}
                running={running}
                open={consoleOpen}
                onOpen={setConsoleOpen}
                message={message || (error ?? "")}
                prompt={runPrompt}
                history={runHistory}
                restoredMs={restoredMs}
                interaction={pendingInteraction}
                frames={frames}
                palette={buffer?.palette ?? asset.data?.palette ?? []}
                onRespond={respondToInteraction}
                onEscape={focusComposer}
              />
              {/* The ref hands Escape a real target: focus lands on the
                  composer's prompt field, not on a guess from the DOM. */}
              <div ref={composerRef} className="w-full" style={{ maxWidth: "40rem" }}>
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
                  onGenerate={() => void generate()}
                  onStop={() => void stop()}
                />
              </div>
            </div>
          </div>

          <aside className="hidden min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-3 lg:flex">
            {rightPanels}
          </aside>
        </div>
      </div>

      {wide ? null : (
        <>
          <Sheet
            open={leftSheet}
            onOpenChange={setLeftSheet}
            title="Frames and layers"
            side="left"
          >
            <div className="grid gap-4">{leftPanels}</div>
          </Sheet>
          <Sheet
            open={rightSheet}
            onOpenChange={setRightSheet}
            title="Palette and style"
            side="right"
          >
            <div className="grid gap-4">{rightPanels}</div>
          </Sheet>
        </>
      )}

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        projectId={asset.data?.projectId ?? ""}
        assetId={assetId}
        frameId={frameId ?? ""}
        frameName={frame?.name ?? ""}
        assetName={asset.data?.name ?? ""}
        onBeforeExport={flush}
      />
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-screen p-6">
      {children}
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

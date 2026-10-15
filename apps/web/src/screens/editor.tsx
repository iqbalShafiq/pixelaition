import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  startTransition,
} from "react";
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
import {
  applyRunEvent,
  rowsFromTaskLog,
  type RunRow,
  type TaskLogRun,
} from "../lib/run-activity.js";
import { markTaskSeen, taskSeen } from "../lib/seen-task.js";
import { useRejoinPacer, useRunStream } from "../lib/run-stream.js";
import { useTaskSnapshot, useTaskStream, type TaskSnapshot } from "../lib/task.js";
import { ExportDialog } from "../components/export-dialog.js";
import { HistoryPanel, type VersionPreview } from "../components/history-panel.js";
import { QueueDock } from "../components/queue-dock.js";
import { QuestionSummary } from "../components/question-summary.js";
import {
  addQueuedRun,
  nextQueuedRun,
  readQueue,
  removeQueuedRun,
  removeQueuedRuns,
  reorderQueuedRun,
  writeQueue,
  type QueuedRun,
} from "../lib/run-queue.js";
import {
  FramePanel,
  LayerPanel,
  PalettePanel,
  StylePanel,
} from "../components/editor-panels.js";
import { Toolbar, ViewPanel } from "../components/editor-toolbar.js";
import { Minus, Plus, Trash } from "../components/pixel-icons.js";
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
  ConfirmDialog,
  IconButton,
  PixelMark,
  Sheet,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAttachments } from "../lib/use-attachments.js";
import { useMediaQuery } from "../lib/use-media.js";
import { useAgentPaint } from "../lib/use-agent-paint.js";
import { bytesToBase64, type AssetDto } from "../lib/types.js";

/** The frame panel's second line. The title stays "4 Frames". */
function activityLabel(phase: string | undefined): string {
  if (phase === "plan") return "Planning";
  if (phase === "review") return "Reviewing";
  return "Generating";
}

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
  run: { id: string; status: string; modelId?: string } | null;
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
  const navigate = useNavigate();
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
        models: Array<{ id: string; efforts: string[]; vision: boolean }>;
        modelReady: boolean;
      }>("/api/models"),
  });

  const [frameId, setFrameId] = useState<string | null>(null);
  const viewedFrameRef = useRef(frameId);
  viewedFrameRef.current = frameId;
  // The interaction card's target questions render live dropdowns; the editor
  // needs the same library the home uses.
  const libraryProjects = useQuery({
    queryKey: ["projects"],
    queryFn: () =>
      api<{ projects: Array<{ id: string; name: string }> }>("/api/projects"),
  });
  const libraryAssets = useQuery({
    queryKey: ["assets"],
    queryFn: () =>
      api<{
        assets: Array<{ id: string; projectId: string; name: string }>;
      }>("/api/assets"),
  });
  const [drafts, setDrafts] = useState<Record<string, History>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const {
    receive: receiveStroke,
    stop: stopStroke,
    cursors: agentCursors,
  } = useAgentPaint(draftsRef, setDrafts);
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
  const attachments = useAttachments();
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [rows, setRows] = useState<RunRow[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // A drawing run is one durable task; its id drives the task stream while
  // each worker's own stream feeds that frame's canvas.
  const [taskId, setTaskId] = useState<string | null>(null);
  // When on, the next message is about the frame in view: it steers that
  // frame's worker instead of starting a new run.
  const [frameContextOn, setFrameContextOn] = useState(false);
  // "Done" is a nudge, not a permanent label: it clears once the user has
  // opened that frame, and it never lingers after the task ends.
  const viewedFrames = useRef(new Set<string>());
  const [unseenDone, setUnseenDone] = useState<Map<string, string>>(new Map());
  // Set once this visit has streamed the task, so a later terminal snapshot
  // does not replace the live transcript with the stored log.
  const sawLiveTask = useRef<string | null>(null);
  const loadedTaskLog = useRef<string | null>(null);
  // Strict mode unmounts once on mount. The mark waits a tick so that
  // simulated unmount can be cancelled by the remount.
  const seenMarkTimer = useRef<number | null>(null);
  // Free-form steering the router could not place: the user picks the frame.
  const [clarify, setClarify] = useState<{
    message: string;
    candidates: string[];
  } | null>(null);
  const [runFrameId, setRunFrameId] = useState<string | null>(null);
  // The models of runs this session started or rejoined, so the history panel
  // can badge a version `Agent · <model>` instead of a bare `Agent`. The
  // versions API stores the run id only, not the model.
  const [runModels, setRunModels] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const runFrameIdRef = useRef<string | null>(null);
  runFrameIdRef.current = runFrameId;
  const displayedRunIdRef = useRef<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const removeAsset = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/api/assets/${assetId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["assets"] });
      await client.invalidateQueries({ queryKey: ["projects"] });
      await client.invalidateQueries({ queryKey: ["recent-runs"] });
      void navigate({ to: "/" });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not delete the asset",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });
  const [consoleOpen, setConsoleOpen] = useState(false);
  // The run that owns the pending interaction: a task child asks through its
  // own run id, so answering goes to that run, not the task.
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
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
  const { sourceRef, open: openStream, close: closeStream } = useRunStream();
  const taskStream = useTaskStream();
  const task = useTaskSnapshot(assetId, true);
  const { pace: paceRejoin, reset: resetRejoin, cancel: cancelRejoin } = useRejoinPacer();
  const fitted = useRef<string | null>(null);
  // Follow-ups typed while a run works; persisted per asset, drained one by
  // one as runs finish, and steerable into the live run on demand.
  const [queue, setQueue] = useState<QueuedRun[]>(() => readQueue(assetId));
  const queueRef = useRef(queue);
  const queueAssetRef = useRef(assetId);
  useEffect(() => {
    if (queueAssetRef.current === assetId) {
      writeQueue(assetId, queue);
      return;
    }
    // A different asset: load its queue instead of writing this one's into it.
    queueAssetRef.current = assetId;
    setQueue(readQueue(assetId));
  }, [assetId, queue]);
  queueRef.current = queue;
  // Optimistic overlays: the UI reacts the moment the user acts, and each
  // overlay reverts by itself when the action fails (the base state is only
  // updated on success).
  const [optimisticStart, setOptimisticStart] = useOptimistic<string | null>(null);
  const [optimisticStopping, setOptimisticStopping] = useOptimistic(false);
  const [optimisticQueue, setOptimisticQueue] = useOptimistic(
    queue,
    (current: QueuedRun[], sentIds: ReadonlySet<string>) =>
      current.filter((item) => !sentIds.has(item.id)),
  );
  const steering = optimisticQueue !== queue;

  const frames = asset.data?.frames ?? [];
  const liveFrames = useMemo(() => {
    const next: Record<string, FrameBuffer> = {};
    for (const [id, history] of Object.entries(drafts)) next[id] = history.present;
    return next;
  }, [drafts]);
  const frame = frames.find((item) => item.id === frameId) ?? null;
  const history = frameId ? drafts[frameId] : undefined;
  const buffer = history?.present;
  // While playback cycles frames, the layer selection must not blink: fall back
  // to the first layer of whichever frame the panel is showing.
  const panelLayerId =
    buffer && buffer.layers.some((layer) => layer.id === activeLayerId)
      ? activeLayerId
      : (buffer?.layers[0]?.id ?? "");
  const taskActive =
    task.data?.task !== null &&
    task.data?.task !== undefined &&
    ["queued", "running", "waiting"].includes(task.data.task.status);
  // A reload may have rejoined through a child run; the snapshot's own task
  // id keeps questions, badges, and frame-context steering wired either way.
  const activeTaskId = taskId ?? (taskActive ? (task.data?.task?.id ?? null) : null);
  const running = runId !== null || taskActive;
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

  const rememberRunModel = useCallback((id: string, model: string | undefined) => {
    if (!model) return;
    setRunModels((current) =>
      current[id] === model ? current : { ...current, [id]: model },
    );
  }, []);

  /** A worker's stroke lands in its frame's draft; the viewed frame follows. */
  // A stroke that lands on the frame in view says so on the canvas itself:
  // the agent is painting here, right now.
  const [agentPulse, setAgentPulse] = useState(0);
  /** The frame the most recent agent stroke landed on. */
  const [lastStrokeFrame, setLastStrokeFrame] = useState<string | null>(null);
  /** The frame each worker is painting right now. Other owned frames stay quiet. */
  const [activePaint, setActivePaint] = useState<Record<string, string>>({});
  /** The user picked a frame themselves: stop following the agent. */
  const manualPickRef = useRef(false);
  useEffect(() => {
    if (agentPulse === 0) return;
    const timer = window.setTimeout(() => setAgentPulse(0), 1100);
    return () => window.clearTimeout(timer);
  }, [agentPulse]);

  const applyStroke = useCallback(
    (raw: Record<string, unknown>, fallbackFrameId: string) => {
      const data = raw as { frameId?: string };
      const target =
        typeof data.frameId === "string" && data.frameId.length > 0
          ? data.frameId
          : fallbackFrameId;
      if (target) {
        setLastStrokeFrame(target);
        if (target === viewedFrameRef.current) setAgentPulse(Date.now());
        setRunFrameId(target);
      }
      // The stroke's pixels arrive whole. The painter reveals them one cell
      // at a time and parks the hover border on the cell the agent is inking.
      receiveStroke(raw, fallbackFrameId);
    },
    [receiveStroke],
  );

  /** The task stream drives the console tree; only task-complete ends it. */
  const listenTask = useCallback(
    (id: string, fallbackFrameId: string) => {
      sawLiveTask.current = id;
      taskStream.open(id, {
        onMessage: (body) => {
          resetRejoin();
          setRows((current) =>
            applyRunEvent(current, body.sequence, body.type, body.data),
          );
          if (body.type === "canvas-stroke") {
            applyStroke(body.data as Record<string, unknown>, fallbackFrameId);
            return;
          }
          if (body.type !== "canvas-stroke" && body.type !== "usage") {
            // The plan and the workers create frames mid-run; the list must
            // follow them, not wait for the task to end.
            void client.invalidateQueries({ queryKey: ["asset", assetId] });
          }
          if (body.type === "task-complete") {
            stopStroke();
            setTaskId(null);
            taskStream.close();
            void task.refetch();
            void client.invalidateQueries({ queryKey: ["asset", assetId] });
            void client.invalidateQueries({ queryKey: ["versions", assetId] });
            log("The task finished");
          }
        },
        onDrop: () => {
          // A dropped task stream is not a stopped task: the snapshot decides.
          void api<{ task: { status?: string } | null }>(`/api/assets/${assetId}/task`)
            .catch(() => ({ task: null }))
            .then((result) => {
              const status = result.task?.status;
              if (
                status !== undefined &&
                ["queued", "running", "waiting"].includes(status)
              ) {
                const firstDrop = paceRejoin(() => listenTask(id, ""));
                if (firstDrop) log("The task stream dropped; rejoining the agent");
                return;
              }
              stopStroke();
              setTaskId(null);
              setRunId(null);
              setRunFrameId(null);
              log("The task stream closed");
            });
        },
      });
    },
    [
      applyStroke,
      assetId,
      client,
      log,
      paceRejoin,
      resetRejoin,
      stopStroke,
      task,
      taskStream,
    ],
  );

  const listen = useCallback(
    (id: string, fallbackFrameId: string, after = 0) => {
      openStream(id, {
        after,
        onMessage: (body) => {
          resetRejoin();
          setRows((current) =>
            applyRunEvent(current, body.sequence, body.type, body.data),
          );
          if (body.type === "canvas-stroke") {
            applyStroke(body.data as Record<string, unknown>, fallbackFrameId);
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
                : (data.error ??
                    (data.status === "cancelled"
                      ? "The run was cancelled."
                      : `The run ${data.status ?? "finished"}.`)),
            );
            setPendingInteraction(null);
            cancelRejoin();
            closeStream();
            stopStroke();
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
            void client.invalidateQueries({ queryKey: ["versions", assetId] });
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
            // A queued follow-up starts the moment the run lands: the queue
            // drains itself, one prompt per finished run. The effect below
            // starts it once the running state has actually cleared.
            const next = nextQueuedRun(queueRef.current);
            if (next) {
              setQueue((current) => removeQueuedRun(current, next.item.id));
              log("Starting the next queued prompt");
              autoFlushRef.current = next.item.text;
            }
            return;
          }
          // Other events are already reflected in the row list above.
        },
        onDrop: () => {
          // A dropped stream does not mean the run stopped: ask the server. The
          // answer carries the pending card too, so a waiting run restores it
          // even when the replayed stream no longer retains the interaction.
          // Rejoins are paced: an unreachable worker must not spin the console.
          void api<ActiveRunResponse>(`/api/assets/${assetId}/active-run`)
            .catch(() => ({ run: null, interaction: null }))
            .then((result) => {
              if (result.run) {
                setRunId(result.run.id);
                rememberRunModel(result.run.id, result.run.modelId);
                setPendingInteraction(result.interaction);
                const runId = result.run.id;
                const firstDrop = paceRejoin(() => listen(runId, "", 0));
                if (firstDrop) log("The stream dropped; rejoining the running agent");
                return;
              }
              stopStroke();
              setRunId(null);
              setRunFrameId(null);
              setPendingInteraction(null);
              log("The activity stream closed");
            });
        },
      });
    },
    [
      assetId,
      client,
      closeStream,
      log,
      openStream,
      paceRejoin,
      rememberRunModel,
      resetRejoin,
      sourceRef,
      stopStroke,
    ],
  );

  // A refresh can miss the in-memory task log. The snapshot still knows who
  // is working, so the console is never only the rejoin line.
  useEffect(() => {
    if (taskActive) return;
    setActivePaint({});
  }, [taskActive]);

  useEffect(() => {
    if (!taskActive || !task.data?.task) return;
    setRows((current) => {
      if (
        current.some(
          (row) =>
            row.kind === "worker" || row.kind === "tool" || row.kind === "task-phase",
        )
      ) {
        return current;
      }
      let next = applyRunEvent(current, 0, "task-phase", {
        phase: task.data?.task?.phase ?? "execute",
        status: task.data?.task?.status ?? "running",
      });
      for (const worker of task.data?.workers ?? []) {
        if (worker.superseded === true) continue;
        next = applyRunEvent(next, 0, "worker-status", {
          workerKey: worker.key,
          status: worker.status,
          frames: worker.frames.map((frame) => frame.name),
        });
      }
      return next;
    });
  }, [taskActive, task.data]);

  useEffect(() => {
    viewedFrames.current = new Set();
    setUnseenDone(new Map());
    loadedTaskLog.current = null;
  }, [assetId]);

  const seenTaskId = task.data?.task?.id;
  const seenTaskStatus = task.data?.task?.status;
  useEffect(() => {
    const terminal =
      seenTaskStatus !== undefined &&
      !["queued", "running", "waiting"].includes(seenTaskStatus);
    // The first visit after the task finishes may show "done". Leaving that
    // visit stores the flag, so the next open stays quiet.
    if (!terminal || seenTaskId === undefined) return;
    if (seenMarkTimer.current !== null) {
      window.clearTimeout(seenMarkTimer.current);
      seenMarkTimer.current = null;
    }
    const mark = () => markTaskSeen(seenTaskId);
    window.addEventListener("pagehide", mark);
    return () => {
      window.removeEventListener("pagehide", mark);
      seenMarkTimer.current = window.setTimeout(() => {
        seenMarkTimer.current = null;
        markTaskSeen(seenTaskId);
      }, 0);
    };
  }, [seenTaskId, seenTaskStatus]);

  useEffect(() => {
    const record = task.data?.task;
    const terminal =
      record !== null &&
      record !== undefined &&
      !["queued", "running", "waiting"].includes(record.status);
    if (terminal && record !== null && record !== undefined && taskSeen(record.id)) {
      setUnseenDone((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const workers = task.data?.workers ?? [];
    if (workers.length === 0) return;
    setUnseenDone((current) => {
      let next = current;
      for (const worker of workers) {
        if (worker.superseded === true) continue;
        if (!/^(w\d+|fix-)/.test(worker.key)) continue;
        for (const frame of worker.frames) {
          const finished = frame.status === "done" || frame.status === "failed";
          if (finished && !viewedFrames.current.has(frame.id) && !next.has(frame.id)) {
            next = new Map(next);
            next.set(frame.id, worker.key);
          }
        }
      }
      return next;
    });
  }, [task.data]);

  useEffect(() => {
    if (frameId === null) return;
    viewedFrames.current.add(frameId);
    setUnseenDone((current) => {
      if (!current.has(frameId)) return current;
      const next = new Map(current);
      next.delete(frameId);
      return next;
    });
  }, [frameId]);

  // A worker's question surfaces when the user opens its frame; the frame
  // list badge and the counter near the composer point the way.
  useEffect(() => {
    if (activeTaskId === null) return;
    const workers = task.data?.workers ?? [];
    // A supervisor question (plan/review) matters whatever frame is open; a
    // worker question surfaces when its frame is the one in view.
    const supervisor = workers.find(
      (candidate) =>
        (candidate.key === "plan" || candidate.key.startsWith("review")) &&
        candidate.pendingInteraction !== undefined,
    );
    const onFrame = workers.find(
      (candidate) =>
        frameId !== null &&
        candidate.frames.some((frame) => frame.id === frameId) &&
        candidate.pendingInteraction !== undefined,
    );
    const chosen = supervisor ?? onFrame;
    const interaction = chosen?.pendingInteraction;
    if (interaction === undefined || chosen?.runId === undefined) return;
    if (answeredIdsRef.current.has(interaction.id)) return;
    setPendingInteraction((current) =>
      current?.id === interaction.id ? current : (interaction as PendingInteraction),
    );
    setPendingRunId(chosen.runId);
  }, [activeTaskId, frameId, task.data]);

  // Only the painters that are still running get a stroke stream. Opening one
  // for every finished child (plan, review, both workers) held the browser's
  // connection limit and made the next fetch fail. A new painter is added;
  // the ones already open are left alone, so a live stroke is not replayed.
  const painters = (task.data?.workers ?? []).filter(
    (worker) =>
      worker.runId !== undefined &&
      worker.superseded !== true &&
      /^(w\d+|fix-)/.test(worker.key) &&
      !["succeeded", "completed", "failed", "cancelled"].includes(worker.status),
  );
  const painterKey = painters.map((worker) => worker.runId).join(",");
  const painterByRun = useRef(new Map<string, string>());
  painterByRun.current = new Map(
    painters.flatMap((worker) =>
      worker.runId ? [[worker.runId, worker.key] as const] : [],
    ),
  );
  const strokeStreams = useRef(new Map<string, EventSource>());
  const applyStrokeRef = useRef(applyStroke);
  applyStrokeRef.current = applyStroke;
  useEffect(() => {
    const open = strokeStreams.current;
    if (activeTaskId === null) {
      for (const source of open.values()) source.close();
      open.clear();
      return;
    }
    const wanted = new Set(painterKey.length === 0 ? [] : painterKey.split(","));
    for (const [id, source] of open) {
      if (wanted.has(id)) continue;
      source.close();
      open.delete(id);
    }
    for (const id of wanted) {
      if (open.has(id)) continue;
      const source = new EventSource(`/api/runs/${id}/stream?after=0`);
      source.onmessage = (event) => {
        const body = JSON.parse(event.data) as { type: string; data: unknown };
        if (body.type !== "canvas-stroke") return;
        const data = body.data as Record<string, unknown>;
        const paintedFrame = typeof data.frameId === "string" ? data.frameId : "";
        const workerKey = painterByRun.current.get(id);
        if (workerKey && paintedFrame) {
          setActivePaint((current) =>
            current[workerKey] === paintedFrame
              ? current
              : { ...current, [workerKey]: paintedFrame },
          );
        }
        applyStrokeRef.current(data, "");
      };
      open.set(id, source);
    }
  }, [activeTaskId, painterKey]);
  useEffect(
    () => () => {
      for (const source of strokeStreams.current.values()) source.close();
      strokeStreams.current.clear();
    },
    [assetId],
  );

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const result = await api<ActiveRunResponse>(
        `/api/assets/${assetId}/active-run`,
      ).catch(() => ({ run: null, interaction: null, lastRun: null, history: [] }));
      if (cancelled || sourceRef.current) return;
      // A drawing run is a task: rejoin it first so the console is the whole
      // supervisor tree (the per-child streams keep each canvas live).
      const snapshot = await api<{ task: { id: string; status: string } | null }>(
        `/api/assets/${assetId}/task`,
      ).catch(() => ({ task: null }));
      const active =
        snapshot.task !== null &&
        ["queued", "running", "waiting"].includes(snapshot.task.status);
      if (active && snapshot.task !== null) {
        setTaskId(snapshot.task.id);
        setRunId(snapshot.task.id);
        setConsoleOpen(true);
        setPendingInteraction(result.interaction);
        listenTask(snapshot.task.id, "");
        void task.refetch();
        log("Rejoined the supervisor task that was still going");
        return;
      }
      if (result.run) {
        setRunId(result.run.id);
        rememberRunModel(result.run.id, result.run.modelId);
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
  }, [assetId, listen, log, rememberRunModel]);

  // A finished drawing task keeps the whole transcript. A refresh has no live
  // stream, so the stored children are the same steps the console showed
  // while the agents were working.
  useEffect(() => {
    const record = task.data?.task;
    if (record === null || record === undefined) return;
    const terminal = !["queued", "running", "waiting"].includes(record.status);
    if (
      !terminal ||
      sawLiveTask.current === record.id ||
      loadedTaskLog.current === record.id
    ) {
      return;
    }
    const id = record.id;
    let cancelled = false;
    void api<{ prompt: string | null; plan?: unknown; runs: TaskLogRun[] }>(
      `/api/assets/${assetId}/task/log`,
    )
      .catch(() => null)
      .then((result) => {
        if (cancelled || result === null || sawLiveTask.current === id) return;
        loadedTaskLog.current = id;
        setRows(rowsFromTaskLog(result.runs, result.plan));
        if (result.prompt) setRunPrompt(result.prompt);
        setMessage("");
        setRunHistory([]);
        displayedRunIdRef.current = `task:${id}`;
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, task.data?.task?.id, task.data?.task?.status]);

  // Switching frames rewinds the console to that frame's story: its last run's
  // steps and answer, plus the prompts and answers of the runs before it.
  // A drawing task owns the console instead, across every frame.
  useEffect(() => {
    if (!frameId || task.data?.task) return;
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
  }, [frameId, assetId, task.data?.task?.id]);

  function onAction(action: CanvasAction) {
    if (!frameId) return;
    if (preview) return;
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

  // The run console is the supervisor's stage: open it while a task is live,
  // and keep the frame list following frames that appear mid-run.
  useEffect(() => {
    if (taskActive) setConsoleOpen(true);
    const timer = window.setInterval(() => {
      void client.invalidateQueries({ queryKey: ["asset", assetId] });
      void api<ActiveRunResponse>(`/api/assets/${assetId}/active-run`)
        .then((result) => {
          const card = result.interaction;
          if (card === null || card === undefined) return;
          if (answeredIdsRef.current.has(card.id)) return;
          setPendingInteraction((current) => current ?? card);
          const owner = result.run?.id;
          if (typeof owner === "string") setPendingRunId(owner);
        })
        .catch(() => undefined);
      // The plan child waits for the user too; the snapshot carries it even
      // when the run's own stream never reached this tab.
      void api<TaskSnapshot>(`/api/assets/${assetId}/task`)
        .then((snapshot) => {
          if (snapshot.task !== null)
            setTaskId((current) => current ?? snapshot.task?.id ?? null);
          const waiting = snapshot.workers.find(
            (worker) => worker.pendingInteraction !== undefined,
          );
          const card = waiting?.pendingInteraction;
          if (card === undefined || answeredIdsRef.current.has(card.id)) return;
          if (card.type === undefined) return;
          const pending = {
            id: card.id,
            type: card.type,
            toolName: card.toolName ?? "tool",
            ...(card.questions === undefined ? {} : { questions: card.questions }),
          };
          setPendingInteraction((current) => current ?? pending);
          if (typeof waiting?.runId === "string") setPendingRunId(waiting.runId);
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [assetId, client, taskActive]);

  // While a task runs the editor follows the frame being painted; a manual
  // pick wins until the next run.
  useEffect(() => {
    manualPickRef.current = false;
  }, [taskId]);

  useEffect(() => {
    if (!taskActive || lastStrokeFrame === null) return;
    if (manualPickRef.current) return;
    if (lastStrokeFrame === frameId) return;
    setFrameId(lastStrokeFrame);
  }, [frameId, lastStrokeFrame, taskActive]);

  const refresh = () => client.invalidateQueries({ queryKey: ["asset", assetId] });

  /**
   * A restore rewrote the server's pixels; the drafts are dropped so the
   * reloaded frame seeds a fresh buffer instead of the stale local one.
   */
  function reloadAfterRestore() {
    setPreview(null);
    setDrafts({});
    void client.invalidateQueries({ queryKey: ["asset", assetId] });
    void client.invalidateQueries({ queryKey: ["versions", assetId] });
  }

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

  function generate(textOverride?: string, withAttachments = true) {
    const text = (textOverride ?? prompt).trim();
    // Frame context with a live task: the message steers that frame's worker
    // through the task endpoint instead of starting another run.
    if (frameContextOn && activeTaskId !== null && text.length > 0) {
      const frameName = frames.find((frame) => frame.id === frameId)?.name;
      if (textOverride === undefined) setPrompt("");
      startTransition(async () => {
        try {
          const result = await api<{ routed: string; candidates?: string[] }>(
            `/api/tasks/${activeTaskId}/steer`,
            {
              method: "POST",
              body: JSON.stringify({
                prompt: text,
                ...(frameName !== undefined ? { frameName } : {}),
              }),
            },
          );
          if (result.routed === "clarify") {
            setClarify({ message: text, candidates: result.candidates ?? [] });
            log("Which frame is this about?");
          } else {
            log(`Steering queued (${result.routed})`);
          }
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "Steering failed.";
          setError(message);
          notify({ title: "Could not steer the task", description: message });
        }
      });
      return;
    }
    if (!frameId || running || optimisticStart !== null || text.length === 0) return;
    // Reference images belong to a fresh manual message, never to a queued
    // follow-up that arrives while a run is live.
    const staged = withAttachments ? attachments.items : [];
    // Urgent updates: the console and the composer react before any await.
    setError(null);
    setMessage("");
    setRows([]);
    setConsoleOpen(true);
    setRestoredMs(null);
    setRunPrompt(text);
    setRunHistory([]);
    // A history preview must not sit over the strokes the agent is about to draw.
    setPreview(null);
    if (textOverride === undefined) setPrompt("");
    startTransition(async () => {
      // The optimistic marker shows "starting…" until the run exists; on a
      // failure the base state never changes, so it reverts by itself.
      setOptimisticStart(text);
      try {
        // Local edits made before the run must land before the agent starts.
        await flush();
        await api("/api/preferences", {
          method: "PATCH",
          body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
        });
        const started = await api<{ runId: string; kind?: "task" | "run" }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            assetId,
            frameId,
            prompt: text,
            modelId,
            reasoningEffort: effort,
            ...(staged.length > 0
              ? {
                  attachments: staged.map(({ mediaType, data }) => ({
                    mediaType,
                    data,
                  })),
                }
              : {}),
          }),
        });
        if (staged.length > 0) attachments.clear();
        setRunId(started.runId);
        rememberRunModel(started.runId, modelId);
        displayedRunIdRef.current = started.runId;
        setRunFrameId(frameId);
        log(`Run ${started.runId.slice(0, 8)} started`);
        if (started.kind === "task") {
          setTaskId(started.runId);
          listenTask(started.runId, frameId);
        } else {
          listen(started.runId, frameId);
        }
      } catch (reason) {
        // Nothing was lost: the prompt comes back for a retry.
        if (textOverride === undefined) setPrompt(text);
        const message = reason instanceof Error ? reason.message : "Generation failed.";
        setError(message);
        notify({ title: "Could not start the run", description: message });
      }
    });
  }

  // The SSE handlers keep a stable identity, so the auto-flush reaches the
  // latest generate through a ref instead of a stale closure.
  const generateRef = useRef(generate);
  generateRef.current = generate;
  const autoFlushRef = useRef<string | null>(null);
  // A finished run clears `running` on the next render; the queued follow-up
  // starts here, after that render, not inside the done handler where the old
  // run still reads as running.
  useEffect(() => {
    if (running) return;
    const text = autoFlushRef.current;
    if (text === null) return;
    autoFlushRef.current = null;
    void generateRef.current(text, false);
  }, [running]);

  function queuePrompt() {
    const text = prompt.trim();
    if (text.length === 0) return;
    setQueue((current) => addQueuedRun(current, text));
    setPrompt("");
    setConsoleOpen(true);
  }

  function sendQueuedNow() {
    const pending = queueRef.current;
    if (pending.length === 0 || runId === null || steering) return;
    const ids = new Set(pending.map((item) => item.id));
    startTransition(async () => {
      // The dock empties immediately; a failure restores the items because
      // the base queue only changes on success.
      setOptimisticQueue(ids);
      try {
        await api(`/api/runs/${runId}/steer`, {
          method: "POST",
          body: JSON.stringify({
            // One message per entry: the runtime applies them one per turn,
            // FIFO, and the item id dedupes a retried batch.
            messages: pending.map((item) => ({ text: item.text, requestId: item.id })),
          }),
        });
        setQueue((current) => removeQueuedRuns(current, ids));
        log(`Follow-up${pending.length === 1 ? "" : "s"} sent to the running agent`);
      } catch (reason) {
        notify({
          title: "The follow-up was not accepted",
          description: reason instanceof Error ? reason.message : "Unknown error",
        });
      }
    });
  }

  function recallQueued(id: string) {
    const item = queueRef.current.find((entry) => entry.id === id);
    if (!item) return;
    setPrompt((current) =>
      current.trim().length > 0 ? `${current}\n${item.text}` : item.text,
    );
    setQueue((current) => removeQueuedRun(current, id));
  }

  function stop() {
    if (!runId || optimisticStopping) return;
    startTransition(async () => {
      // The button says "Stopping…" the moment it is clicked; a refused
      // cancel reverts it and names the cause.
      setOptimisticStopping(true);
      try {
        const taskId = task.data?.task?.id;
        await Promise.all([
          api(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined),
          ...(taskId === undefined
            ? []
            : [
                api(`/api/tasks/${taskId}/cancel`, { method: "POST" }).catch(
                  () => undefined,
                ),
              ]),
        ]);
        log("Stopped; waiting for the agent to acknowledge");
        // The stream stays open: the worker's cancelled status and done event
        // clear the run state and reload the frame.
      } catch (reason) {
        notify({
          title: "Could not stop the run",
          description: reason instanceof Error ? reason.message : "Unknown error",
        });
      }
    });
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
    const owner = pendingRunId ?? runId;
    if (!owner || !pendingInteraction) return;
    try {
      if (stagedFrames) {
        await api(`/api/runs/${owner}/stage-override`, {
          method: "POST",
          body: JSON.stringify({
            interactionId: pendingInteraction.id,
            frames: stagedFrames,
          }),
        });
      }
      await api(`/api/runs/${owner}/respond`, {
        method: "POST",
        body: JSON.stringify({ interactionId: pendingInteraction.id, response }),
      });
      if (response.type === "tool-approval" && response.approved === false) {
        // A denied plan is a decision to stop, not just to close the card.
        const stopTask = task.data?.task?.id;
        await Promise.all([
          api(`/api/runs/${owner}/cancel`, { method: "POST" }).catch(() => undefined),
          ...(stopTask === undefined
            ? []
            : [
                api(`/api/tasks/${stopTask}/cancel`, { method: "POST" }).catch(
                  () => undefined,
                ),
              ]),
        ]);
      }
      answeredIdsRef.current.add(pendingInteraction.id);
      setPendingInteraction(null);
      setPendingRunId(null);
      void task.refetch();
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
  // Attached pixels need a model that can see; the API refuses the run, so the
  // composer names the cause before anything is spent.
  const selectedModel = catalog.data?.models.find((item) => item.id === modelId);
  const attachmentIssue =
    attachments.items.length > 0 &&
    selectedModel !== undefined &&
    selectedModel.vision !== true
      ? `${selectedModel.id} cannot read attached images — pick a vision model or remove them.`
      : undefined;
  const runModelMap = useMemo(() => new Map(Object.entries(runModels)), [runModels]);
  const ghost = preview && preview.frameId === frameId ? preview.buffer : null;

  const leftPanels = (
    <>
      <FramePanel
        frames={frames}
        palette={buffer?.palette ?? asset.data?.palette ?? []}
        pixelWidth={asset.data?.width}
        pixelHeight={asset.data?.height}
        liveFrames={liveFrames}
        activeId={frameId}
        playing={playing}
        locked={running}
        activity={taskActive ? activityLabel(task.data?.task?.phase) : undefined}
        taskFrames={(() => {
          // Every frame a worker does not own is explicitly untouched, so no
          // frame in a running task is ever without a state.
          const map = new Map([
            ...(taskActive
              ? (task.data?.workers ?? [])
                  .filter(
                    (worker) =>
                      /^(w\d+|fix-)/.test(worker.key) && worker.superseded !== true,
                  )
                  .flatMap((worker) =>
                    worker.frames.map(
                      (frame) =>
                        [
                          frame.id,
                          {
                            status:
                              frame.status === "working" && worker.retrying === true
                                ? "retrying"
                                : frame.status,
                            workerKey: worker.key,
                            painting: activePaint[worker.key] === frame.id,
                            // A frame already looked at keeps a quiet tick, so
                            // the panel still names who painted it.
                            seen:
                              frame.status === "done" &&
                              viewedFrames.current.has(frame.id),
                          },
                        ] as const,
                    ),
                  )
              : []),
            ...[...unseenDone.entries()]
              .filter(([id]) => !taskActive || !viewedFrames.current.has(id))
              .map(
                ([id, workerKey]) =>
                  [
                    id,
                    { status: "done" as const, workerKey, seen: false, painting: false },
                  ] as const,
              ),
          ]);
          if (taskActive) {
            for (const frame of frames) {
              if (!map.has(frame.id)) {
                map.set(frame.id, {
                  status: "untouched",
                  workerKey: "",
                } as unknown as typeof map extends Map<string, infer V> ? V : never);
              }
            }
          }
          return map;
        })()}
        onSelect={(id) => {
          manualPickRef.current = true;
          setFrameId(id);
          setSelection(null);
          setPreview(null);
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

  // The upper panels keep their height; only the history list scrolls, so the
  // desktop column never turns into one long scroll surface.
  const topPanels = (
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

  const historyPanel = (className?: string) => (
    <HistoryPanel
      className={className}
      assetId={assetId}
      frameId={frameId}
      palette={buffer?.palette ?? asset.data?.palette ?? []}
      width={asset.data?.width ?? buffer?.width ?? 32}
      height={asset.data?.height ?? buffer?.height ?? 32}
      runModels={runModelMap}
      previewingId={preview?.versionId ?? null}
      onPreview={setPreview}
      onRestore={reloadAfterRestore}
    />
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
            label="Palette, style, and history"
            className="lg:hidden"
            onClick={() => setRightSheet(true)}
          >
            ◨
          </IconButton>
          <IconButton
            tone="danger"
            label="Delete asset"
            disabled={!asset.data || running}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash width={14} height={14} />
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
          <aside className="hidden min-h-0 min-w-0 flex-col gap-4 p-3 lg:flex">
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
              className="relative order-1 min-h-0 min-w-0 flex-1 [view-transition-name:asset-flight] sm:order-2"
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
                <div
                  key={frameId ?? "none"}
                  className={`frame-crossfade contents ${
                    agentPulse > 0 ? "agent-canvas-pulse" : ""
                  }`}
                >
                  <PixelCanvas
                    buffer={buffer ?? fallbackBuffer}
                    camera={camera}
                    tool={tool}
                    brushSize={brushSize}
                    grid={grid}
                    checker={checker}
                    onionSkin={onionSkin}
                    ghost={ghost}
                    selection={selection}
                    locked={locked || preview !== null}
                    agentCursor={frameId ? (agentCursors[frameId] ?? null) : null}
                    onAction={onAction}
                    onCamera={(next) => {
                      setViewMode((mode) => (next.zoom !== camera.zoom ? "free" : mode));
                      setCamera(next);
                    }}
                  />
                </div>
              )}
              {drawingHere ? (
                <p className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border-2 border-accent bg-paper px-2 py-1 text-pixel-mono text-accent">
                  the agent is drawing on this frame
                </p>
              ) : null}
              {preview && !running ? (
                <div className="absolute top-2 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 border-2 border-accent bg-paper px-2 py-1">
                  <span className="whitespace-nowrap text-pixel-mono text-accent">
                    previewing an older version
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="whitespace-nowrap text-pixel-mono text-ink underline decoration-dotted underline-offset-2 hover:text-accent"
                  >
                    exit preview
                  </button>
                </div>
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
            <div className="pointer-events-none absolute inset-x-0 top-3 bottom-3 z-20 flex flex-col items-center justify-end overflow-hidden px-3">
              {/* One 40rem column holds the console, the queue, and the
                  composer — the same dock geometry the home page uses, so
                  every part lines up on the same edges. */}
              <div
                className="flex min-h-0 w-full flex-col gap-2"
                style={{ maxWidth: "40rem" }}
              >
                {clarify !== null ? (
                  <section
                    aria-label="Which frame"
                    className="pointer-events-auto pixel-corners-sm w-full border-2 border-accent bg-panel"
                  >
                    <header className="border-b-2 border-line px-2 py-1.5 text-pixel-mono tracking-[0.16em] text-accent uppercase">
                      which frame is this about?
                    </header>
                    <div className="flex flex-wrap gap-1 p-1.5">
                      {clarify.candidates.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="pixel-corners-sm border-2 border-line px-2 py-1 text-pixel-mono text-ink transition-colors duration-150 hover:border-accent hover:text-accent"
                          onClick={() => {
                            const message = clarify.message;
                            setClarify(null);
                            startTransition(async () => {
                              if (activeTaskId === null) return;
                              await api(`/api/tasks/${activeTaskId}/steer`, {
                                method: "POST",
                                body: JSON.stringify({
                                  prompt: message,
                                  frameName: name,
                                }),
                              }).catch((reason: unknown) => {
                                const text =
                                  reason instanceof Error
                                    ? reason.message
                                    : "Steering failed.";
                                setError(text);
                                notify({
                                  title: "Could not steer the task",
                                  description: text,
                                });
                              });
                            });
                          }}
                        >
                          {name}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="pixel-corners-sm border-2 border-line px-2 py-1 text-pixel-mono text-muted transition-colors duration-150 hover:text-ink"
                        onClick={() => setClarify(null)}
                      >
                        whole asset
                      </button>
                    </div>
                  </section>
                ) : null}
                <div className="shrink-0">
                  <QuestionSummary
                    workers={task.data?.workers ?? []}
                    onJump={(id) => {
                      setFrameId(id);
                      setSelection(null);
                      setPreview(null);
                    }}
                  />
                </div>
                <div className="w-full shrink-0 [view-transition-name:console-flight]">
                  <RunConsole
                    taskProgress={
                      task.data?.task !== null && task.data?.task !== undefined
                        ? {
                            phase: task.data.task.phase,
                            done: (task.data.workers ?? []).filter(
                              (worker) =>
                                worker.status === "succeeded" ||
                                worker.status === "failed",
                            ).length,
                            total: (task.data.workers ?? []).length,
                          }
                        : undefined
                    }
                    rows={rows}
                    running={running || optimisticStart !== null}
                    open={consoleOpen}
                    onOpen={setConsoleOpen}
                    message={message || (error ?? "")}
                    prompt={runPrompt}
                    history={runHistory}
                    restoredMs={restoredMs}
                    interaction={pendingInteraction}
                    frames={frames}
                    palette={buffer?.palette ?? asset.data?.palette ?? []}
                    projects={libraryProjects.data?.projects ?? []}
                    assets={libraryAssets.data?.assets ?? []}
                    onRespond={respondToInteraction}
                    onEscape={focusComposer}
                  />
                </div>
                <div className="shrink-0">
                  <QueueDock
                    items={optimisticQueue}
                    canSteer={runId !== null}
                    busy={steering}
                    onSendNow={sendQueuedNow}
                    onRemove={(id) => setQueue((current) => removeQueuedRun(current, id))}
                    onReorder={(from, to) =>
                      setQueue((current) => reorderQueuedRun(current, from, to))
                    }
                    onRecall={recallQueued}
                  />
                </div>
                {/* The ref hands Escape a real target: focus lands on the
                    composer's prompt field, not on a guess from the DOM. */}
                <div
                  ref={composerRef}
                  className="w-full shrink-0 [view-transition-name:composer-flight]"
                >
                  <Composer
                    frameContext={
                      frameId !== null
                        ? {
                            name:
                              frames.find((frame) => frame.id === frameId)?.name ??
                              "frame",
                            enabled: frameContextOn,
                            onToggle: () => setFrameContextOn((value) => !value),
                          }
                        : undefined
                    }
                    prompt={prompt}
                    onPrompt={setPrompt}
                    modelId={modelId}
                    models={models}
                    onModel={setModelId}
                    effort={effort}
                    efforts={efforts}
                    onEffort={setEffort}
                    running={running}
                    starting={optimisticStart !== null}
                    stopping={optimisticStopping}
                    modelReady={catalog.data?.modelReady ?? false}
                    onGenerate={() => generate()}
                    onStop={stop}
                    onQueue={queuePrompt}
                    attachments={attachments.items}
                    attachmentError={attachments.error}
                    attachmentIssue={attachmentIssue}
                    onAttach={attachments.add}
                    onRemoveAttachment={attachments.remove}
                  />
                </div>
              </div>
            </div>
          </div>

          <aside className="hidden min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-3 lg:flex">
            <div className="flex shrink-0 flex-col gap-4">{topPanels}</div>
            {historyPanel("min-h-0 flex-1")}
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
            title="Palette, style, and history"
            side="right"
          >
            <div className="grid gap-4">
              {topPanels}
              {historyPanel()}
            </div>
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
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${asset.data?.name ?? "this asset"}”?`}
        description={`Its ${frames.length} frames, versions, and run history go with it. This cannot be undone.`}
        onConfirm={() => removeAsset.mutate()}
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

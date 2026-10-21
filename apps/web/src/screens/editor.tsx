import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
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
import {
  buildTemplateScene,
  checkScene,
  fitTextToSlot,
  getPreset,
  paletteRoles,
  summarizeChecks,
  syncCopyScene,
  type Artboard,
  type ArtboardCheck,
  type ArtboardScene,
  type CopyDeck,
  type CopyOverride,
  type Element,
  type TemplateId,
} from "@pixelaition/artboard";
import { ArtboardCanvas } from "../components/artboard-canvas.js";
import {
  artboardForFrame,
  emptyScene,
  presetForFrame,
  renderArtboard,
  type ProjectResourceAsset,
  sceneSpritesReady,
  spritesForAsset,
  spritesForResources,
} from "../lib/artboard.js";
import { FormatPicker, Inspector } from "../components/artboard-panels.js";
import { ImportFrameDialog } from "../components/import-frame-dialog.js";
import { Composer } from "../components/composer.js";
import { RunConsole, type HistoryRun } from "../components/run-console.js";
import { sessionTotalsFrom, type LiveTurn, type TurnMeta } from "../lib/run-usage.js";
import {
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "../components/interaction-card.js";
import {
  applyRunEvent,
  consoleTurns,
  noteRow,
  recordFollowUp,
  turnsFromAssetLog,
  type AssetLogTask,
  type ConsoleTurn,
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
  FrameHeaderPanel,
  FramePanel,
  LayerPanel,
  PalettePanel,
  StylePanel,
} from "../components/editor-panels.js";
import { Toolbar, ViewPanel } from "../components/editor-toolbar.js";
import {
  Grid,
  Minus,
  Plus,
  Square,
  Text as TextIcon,
} from "../components/pixel-icons.js";
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
  Dialog,
  Field,
  IconButton,
  SelectControl,
  Sheet,
  Wordmark,
  useToast,
  useToastCloser,
} from "../components/ui.js";
import { ApiError, api } from "../lib/api.js";
import { useAttachments } from "../lib/use-attachments.js";
import { useMediaQuery } from "../lib/use-media.js";
import { useAgentPaint } from "../lib/use-agent-paint.js";
import { bytesToBase64, type AssetDto } from "../lib/types.js";
import { FLIGHT_BACK_TYPE, navigateTyped } from "../lib/transition.js";
import { paintedBounds, spriteCanvas } from "../lib/sprite-flight.js";

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
  outline: "#0b0906",
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
  run: {
    id: string;
    status: string;
    modelId?: string;
    reasoningEffort?: string;
    prompt: string | null;
    createdAt?: string;
  } | null;
  /** The pending card of a waiting run; null when the run is not waiting. */
  interaction: PendingInteraction | null;
  lastRun: {
    id: string;
    status: string;
    prompt: string | null;
    modelId?: string;
    reasoningEffort?: string;
    createdAt?: string;
    events: Array<{ sequence: number; type: string; data: unknown }>;
    text: string;
    usage?: unknown;
    durationMs: number | null;
  } | null;
  history: HistoryRun[];
  /** The settled session totals; the live turn is composed on the client. */
  session?: unknown;
};

/** The task steer answer, shaped for the console's "you" line. */
function steerOutcome(
  routed: string,
  extras: { frameName?: string; requestId?: string } = {},
): {
  routed: string;
  delivery: "clarify" | "held" | "relayed";
  frameName?: string;
  requestId?: string;
} {
  const relayed = routed !== "clarify" && routed !== "queued";
  return {
    routed: relayed ? routed : "supervisor",
    delivery: routed === "clarify" ? "clarify" : relayed ? "relayed" : "held",
    ...(extras.frameName !== undefined ? { frameName: extras.frameName } : {}),
    ...(extras.requestId !== undefined ? { requestId: extras.requestId } : {}),
  };
}

const SOCIAL_ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

function stepSocialZoom(value: number, direction: 1 | -1): number {
  if (direction > 0) {
    return (
      SOCIAL_ZOOM_STEPS.find((step) => step > value) ?? SOCIAL_ZOOM_STEPS.at(-1) ?? value
    );
  }
  return (
    [...SOCIAL_ZOOM_STEPS].reverse().find((step) => step < value) ??
    SOCIAL_ZOOM_STEPS[0] ??
    value
  );
}

export function EditorScreen() {
  const { assetId } = useParams({ from: "/projects/$projectId/assets/$assetId" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const notify = useToast();
  const closeToast = useToastCloser();

  const asset = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
  });
  const resources = useQuery({
    queryKey: ["project-resources", asset.data?.projectId ?? ""],
    enabled: Boolean(asset.data?.projectId),
    queryFn: () =>
      api<{ assets: ProjectResourceAsset[] }>(
        `/api/projects/${asset.data?.projectId}/resources`,
      ),
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
        models: Array<{
          id: string;
          displayName: string;
          efforts: string[];
          vision: boolean;
          userImages: boolean;
          contextWindow: number | null;
        }>;
        modelReady: boolean;
      }>("/api/models"),
  });

  // The catalog's display names: the composer, the header, the turn metas, and
  // the history badges read these, never the provider slug.
  const modelNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const item of catalog.data?.models ?? []) names[item.id] = item.displayName;
    return names;
  }, [catalog.data]);

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
  /** The task stream this tab is already attached to. Focus must not rejoin it. */
  const taskListenRef = useRef<string | null>(null);
  const loadedTaskLog = useRef<string | null>(null);
  // Strict mode unmounts once on mount. The mark waits a tick so that
  // simulated unmount can be cancelled by the remount.
  const seenMarkTimer = useRef<number | null>(null);
  // Free-form steering the router could not place: the user picks the frame.
  const [clarify, setClarify] = useState<{
    message: string;
    candidates: string[];
    requestId?: string;
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
  // The live run of this render, readable from async callbacks that must not
  // treat a stored transcript as the console's owner.
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;
  // Set once the mount-time rejoin has decided what the console shows: a live
  // run or task owns it, and the stored transcript must not race in ahead.
  const [rejoinDecided, setRejoinDecided] = useState(false);
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
  // The live turn the header adds on top of the settled session totals, plus
  // the same turn's per-chat meta. `settling` holds the live contribution
  // until the session aggregate has folded the just-finished turn in, so the
  // header's totals never dip when a run lands.
  const [liveStartedAt, setLiveStartedAt] = useState<number | null>(null);
  const [liveRunInfo, setLiveRunInfo] = useState<{
    modelId: string | null;
    effort: string | null;
  } | null>(null);
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const [settling, setSettling] = useState(false);
  const settleBaseRef = useRef<{ cost: number; elapsedMs: number } | null>(null);
  const wasRunningRef = useRef(false);
  // The meta of a transcript restored from the server: the turn is not live
  // in this session, but its usage/model/timing came with the log.
  const [restoredMeta, setRestoredMeta] = useState<TurnMeta | null>(null);
  const [runPrompt, setRunPrompt] = useState("");
  // Every settled request of this asset's conversation, oldest first, as the
  // server's log carries it: drawing tasks and ask-only runs alike. The turn
  // on screen is placed among them by `consoleTurns`, never appended after a
  // separate "earlier" list.
  const [logTurns, setLogTurns] = useState<AssetLogTask[]>([]);
  // Finished requests stay above the live one. Each turn keeps its own prompt
  // so the console can pin that prompt with that turn's tabs.
  const [earlierTurns, setEarlierTurns] = useState<ConsoleTurn[]>([]);
  const [leftSheet, setLeftSheet] = useState(false);
  const [rightSheet, setRightSheet] = useState(false);
  const [socialTab, setSocialTab] = useState<"layout" | "copy" | "checks">("layout");
  const [inspectorTab, setInspectorTab] = useState<"frame" | "content" | "history">(
    "frame",
  );
  const [socialElementId, setSocialElementId] = useState<string | null>(null);
  const [socialFit, setSocialFit] = useState(true);
  const [socialZoom, setSocialZoom] = useState(1);
  const [socialPickerOpen, setSocialPickerOpen] = useState(false);
  const [importFrameOpen, setImportFrameOpen] = useState(false);
  const [paletteImportOpen, setPaletteImportOpen] = useState(false);
  const [backgroundImportOpen, setBackgroundImportOpen] = useState(false);
  const [paletteSourceId, setPaletteSourceId] = useState("");
  const socialSaveTimers = useRef(new Map<string, number>());
  const socialSaveChains = useRef(new Map<string, Promise<void>>());
  // Below lg the columns become sheets. Keeping them mounted at desktop widths
  // strands Base UI's exit animation and its inert overlay blocks the page.
  const wide = useMediaQuery("(min-width: 1024px)");
  // At this width the header keeps the wordmark's label, so the brand can morph
  // between the home bar and this one; below it, the label is hidden and the
  // bar's own cross-fade carries the change without squashing the text.
  const brandMorphs = useMediaQuery("(min-width: 640px)");
  useEffect(() => {
    if (!wide) return;
    setLeftSheet(false);
    setRightSheet(false);
  }, [wide]);
  const viewRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const { sourceRef, open: openStream, close: closeStream } = useRunStream();
  const taskStream = useTaskStream();
  const task = useTaskSnapshot(assetId, true);
  // The asset conversation's settled spend. It refreshes on focus and when a
  // turn settles; the live turn rides on the client's own stream.
  const session = useQuery({
    queryKey: ["asset-session", assetId],
    queryFn: () => api<{ session: unknown }>(`/api/assets/${assetId}/session`),
    select: (data) => sessionTotalsFrom(data.session),
  });
  // Follow-ups typed while a run works; persisted per asset, drained one by
  // one as runs finish, and steerable into the live run on demand.
  const [queue, setQueue] = useState<QueuedRun[]>(() => readQueue(assetId));
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
  const taskActive =
    task.data?.task !== null &&
    task.data?.task !== undefined &&
    ["queued", "running", "waiting"].includes(task.data.task.status);
  // A reload may have rejoined through a child run; the snapshot's own task
  // id keeps questions, badges, and frame-context steering wired either way.
  const activeTaskId = taskId ?? (taskActive ? (task.data?.task?.id ?? null) : null);
  const running = runId !== null || taskActive;
  const consoleRunning = running || optimisticStart !== null;
  const { pace: paceRejoin, reset: resetRejoin, cancel: cancelRejoin } = useRejoinPacer();
  const fitted = useRef<string | null>(null);
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

  // Switching assets must not carry the previous conversation's live turn.
  useEffect(() => {
    setLiveStartedAt(null);
    setLiveRunInfo(null);
    setSettledAt(null);
    setSettling(false);
    settleBaseRef.current = null;
    wasRunningRef.current = false;
    setRestoredMeta(null);
  }, [assetId]);

  // The live task's own start and model: the snapshot carries them, so a
  // reload's elapsed and meta restart from the server's start, not from zero.
  useEffect(() => {
    const record = task.data?.task;
    if (record === null || record === undefined) return;
    if (!["queued", "running", "waiting"].includes(record.status)) return;
    const started =
      record.createdAt === undefined ? Number.NaN : Date.parse(record.createdAt);
    if (!Number.isNaN(started)) setLiveStartedAt(started);
    if (record.modelId != null || record.effort != null) {
      const modelId = record.modelId ?? null;
      const effort = record.effort ?? null;
      setLiveRunInfo({ modelId, effort });
    }
  }, [
    task.data?.task?.id,
    task.data?.task?.status,
    task.data?.task?.createdAt,
    task.data?.task?.modelId,
    task.data?.task?.effort,
  ]);

  // A turn settling must not make the header's totals dip: the live
  // contribution holds until the session aggregate has grown past the
  // snapshot taken when the turn landed.
  useEffect(() => {
    if (consoleRunning) {
      wasRunningRef.current = true;
      if (settling) setSettling(false);
      settleBaseRef.current = null;
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;
    if (liveStartedAt === null) return;
    settleBaseRef.current = session.data
      ? { cost: session.data.cost, elapsedMs: session.data.elapsedMs }
      : null;
    setSettledAt(Date.now());
    setSettling(true);
    void session.refetch();
  }, [consoleRunning, settling, liveStartedAt, session]);
  useEffect(() => {
    if (!settling) return;
    const base = settleBaseRef.current;
    const current = session.data;
    const grew =
      current != null &&
      (base === null || current.cost > base.cost || current.elapsedMs > base.elapsedMs);
    if (grew) setSettling(false);
  }, [settling, session.data]);
  // Settling has a bounded life: a fetch that raced the settle returns stale
  // data, so one retry runs, and a deadline keeps the live contribution from
  // holding forever.
  useEffect(() => {
    if (!settling) return;
    const retry = window.setTimeout(() => {
      void session.refetch();
    }, 1200);
    const deadline = window.setTimeout(() => setSettling(false), 6000);
    return () => {
      window.clearTimeout(retry);
      window.clearTimeout(deadline);
    };
  }, [settling, session.refetch]);

  // The turn on screen: its usage comes from the streamed usage row, its
  // model and effort from the task snapshot or the send, and its start from
  // the server's own run/task timestamp.
  const usageRow = useMemo(
    () => [...rows].reverse().find((row) => row.kind === "usage"),
    [rows],
  );
  const liveTurnMeta = useMemo<TurnMeta | null>(() => {
    if (liveStartedAt === null && usageRow === undefined) return null;
    // The turn's own run wins: an ask run has no task snapshot, so the
    // asset's last task would otherwise label this turn with the wrong model.
    const modelId =
      liveRunInfo?.modelId ??
      task.data?.task?.modelId ??
      usageRow?.context?.model.modelId ??
      null;
    const effort = liveRunInfo?.effort ?? task.data?.task?.effort ?? null;
    return {
      usage: usageRow
        ? {
            input: usageRow.input,
            cached: usageRow.cached,
            output: usageRow.output,
            cost: usageRow.cost,
          }
        : null,
      modelId,
      effort,
      startedAt: liveStartedAt === null ? null : new Date(liveStartedAt).toISOString(),
      durationMs:
        settledAt !== null && liveStartedAt !== null
          ? settledAt - liveStartedAt
          : consoleRunning
            ? null
            : (restoredMs ?? null),
    };
  }, [
    liveStartedAt,
    usageRow,
    task.data?.task?.modelId,
    task.data?.task?.effort,
    liveRunInfo,
    settledAt,
    consoleRunning,
    restoredMs,
  ]);
  // A transcript restored from the log carries its own exact meta; the live
  // turn outranks it as soon as this session watched the turn happen.
  const currentTurnMeta =
    liveStartedAt !== null ? liveTurnMeta : (restoredMeta ?? liveTurnMeta);
  const liveContribution: LiveTurn | null =
    consoleRunning || settling
      ? {
          startedAtMs: liveStartedAt,
          cost: usageRow?.cost ?? 0,
          input: usageRow?.input ?? 0,
          cached: usageRow?.cached ?? 0,
          output: usageRow?.output ?? 0,
          context: usageRow?.context ?? null,
        }
      : null;

  const frames = asset.data?.frames ?? [];
  const liveFrames = useMemo(() => {
    const next: Record<string, FrameBuffer> = {};
    for (const [id, history] of Object.entries(drafts)) next[id] = history.present;
    return next;
  }, [drafts]);
  const frame = frames.find((item) => item.id === frameId) ?? null;
  const socialFrame = frame?.kind === "social" ? frame : null;
  const socialPreset = socialFrame?.presetId
    ? getPreset(socialFrame.presetId)
    : undefined;
  const socialArtboard =
    asset.data && socialFrame ? artboardForFrame(asset.data, socialFrame) : null;
  const sceneFrame = frame;
  const scenePreset = asset.data && frame ? presetForFrame(asset.data, frame) : undefined;
  const sceneArtboard = asset.data && frame ? artboardForFrame(asset.data, frame) : null;
  const socialSprites = useMemo(() => {
    if (resources.data && resources.data.assets.length > 0) {
      return spritesForResources(resources.data.assets);
    }
    return asset.data ? spritesForAsset(asset.data) : new Map();
  }, [asset.data, resources.data]);
  const sceneOverlay = useMemo(() => {
    if (!asset.data || !sceneArtboard || !scenePreset) return null;
    if (
      sceneArtboard.scene.elements.length === 0 &&
      sceneArtboard.scene.background.kind === "transparent"
    )
      return null;
    return renderArtboard(sceneArtboard, scenePreset, asset.data, socialSprites);
  }, [asset.data, sceneArtboard, scenePreset, socialSprites]);

  const spriteChoices = useMemo(
    () =>
      (resources.data?.assets ?? []).flatMap((item) =>
        item.frames
          .filter((frame) => frame.kind === "sprite")
          .map((frame) => ({
            assetId: item.id,
            assetName: item.name,
            frameId: frame.id,
            frameName: frame.name,
          })),
      ),
    [resources.data],
  );
  const socialCopy = (asset.data?.copy ?? {}) as CopyDeck;
  const socialChecks = useMemo<ArtboardCheck[]>(() => {
    if (!asset.data || !sceneFrame || !scenePreset || !sceneArtboard) return [];
    if (!sceneSpritesReady(sceneArtboard.scene, socialSprites)) return [];
    return checkScene({
      scene: sceneArtboard.scene,
      preset: scenePreset,
      palette: asset.data.palette,
      sprites: socialSprites,
    });
  }, [asset.data, sceneFrame, scenePreset, sceneArtboard, socialSprites]);
  useEffect(() => {
    if (!running || !socialFrame) return;
    const timer = window.setInterval(() => {
      void asset.refetch();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, socialFrame?.id, asset.refetch]);

  const history = frameId ? drafts[frameId] : undefined;
  const buffer = history?.present;
  // While playback cycles frames, the layer selection must not blink: fall back
  // to the first layer of whichever frame the panel is showing.
  const panelLayerId =
    buffer && buffer.layers.some((layer) => layer.id === activeLayerId)
      ? activeLayerId
      : (buffer?.layers[0]?.id ?? "");
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
        if (next[item.id] || item.kind === "social") continue;
        next[item.id] = createHistory(
          frameToBuffer(
            item,
            item.width ?? data.width,
            item.height ?? data.height,
            data.palette,
          ),
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
      if (item && item.kind !== "social") {
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

  function cachedAsset(): AssetDto | undefined {
    return client.getQueryData<AssetDto>(["asset", assetId]) ?? asset.data;
  }

  function patchCachedFrame(
    id: string,
    patch: Partial<AssetDto["frames"][number]>,
  ): void {
    client.setQueryData(["asset", assetId], (current: AssetDto | undefined) =>
      current
        ? {
            ...current,
            frames: current.frames.map((item) =>
              item.id === id ? { ...item, ...patch } : item,
            ),
          }
        : current,
    );
  }

  function socialFrameNow(id: string) {
    return cachedAsset()?.frames.find((item) => item.id === id);
  }

  function flushSocialSave(id: string): void {
    const timer = socialSaveTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      socialSaveTimers.current.delete(id);
    }
    const previous = socialSaveChains.current.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = socialFrameNow(id);
        if (!current?.scene) return;
        if (running) return;
        const sentScene = current.scene;
        try {
          const updated = await api<AssetDto>(
            `/api/assets/${assetId}/frames/${id}/scene`,
            {
              method: "PATCH",
              body: JSON.stringify({
                version: current.version ?? 1,
                scene: current.scene,
                copyOverride: current.copyOverride ?? {},
                status: current.status ?? "draft",
                name: current.name,
              }),
            },
          );
          const serverFrame = updated.frames.find((item) => item.id === id);
          if (!serverFrame) return;
          client.setQueryData(["asset", assetId], (live: AssetDto | undefined) => {
            if (!live) return updated;
            return {
              ...live,
              copy: updated.copy ?? live.copy,
              frames: live.frames.map((item) => {
                if (item.id !== id) return item;
                const sceneChanged =
                  JSON.stringify(item.scene) !== JSON.stringify(sentScene);
                return {
                  ...item,
                  version: serverFrame.version,
                  status: serverFrame.status,
                  updatedAt: serverFrame.updatedAt,
                  ...(sceneChanged
                    ? {}
                    : {
                        scene: serverFrame.scene,
                        copyOverride: serverFrame.copyOverride,
                        name: serverFrame.name,
                      }),
                };
              }),
            };
          });
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 409) {
            void asset.refetch();
            notify({
              title: "That frame changed elsewhere",
              description: "Reloaded the latest version.",
            });
          } else {
            notify({
              title: "Could not save the frame",
              description: reason instanceof Error ? reason.message : "Unknown error",
            });
          }
        }
      });
    socialSaveChains.current.set(id, next);
  }

  function queueSocialSave(id: string): void {
    const previous = socialSaveTimers.current.get(id);
    if (previous !== undefined) window.clearTimeout(previous);
    socialSaveTimers.current.set(
      id,
      window.setTimeout(() => flushSocialSave(id), 500),
    );
  }

  function updateSocialScene(scene: ArtboardScene): void {
    if (!sceneFrame) return;
    patchCachedFrame(sceneFrame.id, { scene });
    queueSocialSave(sceneFrame.id);
  }

  function updateSocialElement(elementId: string, patch: Partial<Element>): void {
    if (!sceneFrame) return;
    const current = socialFrameNow(sceneFrame.id);
    if (!current?.scene) return;
    patchCachedFrame(current.id, {
      scene: {
        ...current.scene,
        elements: current.scene.elements.map((element) =>
          element.id === elementId ? ({ ...element, ...patch } as Element) : element,
        ),
      },
    });
    queueSocialSave(current.id);
  }

  function setSocialText(elementId: string, text: string, key?: keyof CopyDeck): void {
    if (!sceneFrame?.scene) return;
    const override: CopyOverride = { ...(sceneFrame.copyOverride ?? {}) };
    if (key !== undefined) {
      if (text.trim() === (socialCopy[key] ?? "").trim()) delete override[key];
      else override[key] = text;
    }
    const elements = sceneFrame.scene.elements.map((element) => {
      if (element.id !== elementId || element.kind !== "text") return element;
      const nextTextY = sceneFrame.scene?.elements
        .filter(
          (candidate) =>
            candidate.kind === "text" &&
            candidate.id !== element.id &&
            candidate.y > element.y &&
            candidate.x < element.x + element.width &&
            candidate.x + candidate.width > element.x,
        )
        .sort((a, b) => a.y - b.y)[0]?.y;
      return fitTextToSlot(
        { ...element, text },
        nextTextY !== undefined ? Math.max(8, nextTextY - element.y - 2) : undefined,
      );
    });
    patchCachedFrame(sceneFrame.id, {
      scene: { ...sceneFrame.scene, elements },
      copyOverride: override,
    });
    queueSocialSave(sceneFrame.id);
  }

  function applySocialTemplate(template: TemplateId): void {
    if (!sceneFrame || !scenePreset || !asset.data) return;
    const source =
      [...socialSprites.values()].find((item) => item.assetId === asset.data.id) ??
      [...socialSprites.values()][0];
    const scene = buildTemplateScene({
      preset: scenePreset,
      template,
      copy: socialCopy,
      palette: asset.data.palette,
      ...(source ? { sprite: source } : {}),
    });
    patchCachedFrame(sceneFrame.id, {
      scene,
      copyOverride: {},
      status: "draft",
    });
    setSocialTab("layout");
    queueSocialSave(sceneFrame.id);
  }

  function addSocialText(): void {
    if (!sceneFrame || !asset.data) return;
    const baseScene = sceneFrame.scene ?? emptyScene();
    const roles = paletteRoles(asset.data.palette);
    const id = `text-${crypto.randomUUID().slice(0, 8)}`;
    const element: Element = {
      id,
      kind: "text",
      text: (sceneFrame.width ?? 1080) <= 64 ? "Aa" : "Your words",
      face: "silkscreen",
      weight: 700,
      size: [16, 24, 32, 48, 64, 96, 120].reduce(
        (best, size) =>
          Math.abs(size - (sceneFrame.height ?? 1080) * 0.06) <
          Math.abs(best - (sceneFrame.height ?? 1080) * 0.06)
            ? size
            : best,
        16,
      ),
      color: roles.ink,
      x: Math.round((sceneFrame.width ?? 1080) * 0.06),
      y: Math.round((sceneFrame.height ?? 1080) * 0.12),
      width: Math.round((sceneFrame.width ?? 1080) * 0.8),
      height: Math.max(16, Math.round((sceneFrame.height ?? 1080) * 0.35)),
      align: "left",
      maxLines: 3,
    };
    updateSocialScene({
      ...baseScene,
      elements: [...baseScene.elements, element],
    });
    setSocialElementId(id);
  }

  function addSocialElement(kind: "rect" | "pattern" | "frame"): void {
    if (!sceneFrame || !asset.data) return;
    const baseScene = sceneFrame.scene ?? emptyScene();
    const roles = paletteRoles(asset.data.palette);
    const width = sceneFrame.width ?? scenePreset?.width ?? 1080;
    const height = sceneFrame.height ?? scenePreset?.height ?? 1080;
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const element: Element =
      kind === "rect"
        ? {
            id,
            kind: "rect",
            x: 0,
            y: 0,
            width,
            height: Math.max(4, Math.round(height * 0.12)),
            color: roles.accent,
          }
        : kind === "pattern"
          ? {
              id,
              kind: "pattern",
              x: 0,
              y: 0,
              width,
              height,
              colorA: roles.background,
              colorB: roles.muted,
              unit: scenePreset?.pixelUnit ?? 4,
              mode: "checker",
            }
          : {
              id,
              kind: "frame",
              x: 0,
              y: 0,
              width,
              height,
              thickness: Math.max(2, (scenePreset?.pixelUnit ?? 4) * 2),
              color: roles.accent,
            };
    updateSocialScene({
      ...baseScene,
      elements: [...baseScene.elements, element],
    });
    setSocialElementId(id);
  }

  function removeSocialElement(elementId: string): void {
    if (!sceneFrame?.scene) return;
    updateSocialScene({
      ...sceneFrame.scene,
      elements: sceneFrame.scene.elements.filter((element) => element.id !== elementId),
    });
    if (socialElementId === elementId) setSocialElementId(null);
  }

  async function applySocialCopy(copy: CopyDeck): Promise<void> {
    try {
      await flushSocialSaves();
      const updated = await api<AssetDto>(`/api/assets/${assetId}/copy`, {
        method: "PATCH",
        body: JSON.stringify({ copy }),
      });
      client.setQueryData(["asset", assetId], updated);
      notify({
        title: "Copy applied",
        description: "Every frame that did not override it.",
      });
    } catch (reason) {
      notify({
        title: "Could not update the copy",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    }
  }

  function clearSocialOverrides(): void {
    if (!sceneFrame?.scene) return;
    updateSocialScene(syncCopyScene(sceneFrame.scene, socialCopy, {}));
    patchCachedFrame(sceneFrame.id, { copyOverride: {} });
    queueSocialSave(sceneFrame.id);
  }

  async function flushSocialSaves(): Promise<void> {
    for (const id of [...socialSaveTimers.current.keys()]) flushSocialSave(id);
    await Promise.all([...socialSaveChains.current.values()]);
  }

  const addSocialFrame = useMutation({
    mutationFn: (presetId: string) =>
      api<AssetDto>(`/api/assets/${assetId}/frames`, {
        method: "POST",
        body: JSON.stringify({ kind: "social", presetId }),
      }),
    onSuccess: (data) => {
      const previous = new Set(asset.data?.frames.map((item) => item.id) ?? []);
      const created = data.frames.find((item) => !previous.has(item.id));
      client.setQueryData(["asset", assetId], data);
      if (created) {
        setFrameId(created.id);
        setSocialElementId(null);
        setSocialTab("layout");
      }
      setSocialPickerOpen(false);
      notify({
        title: "Frame added",
        description: "Native size and safe areas are ready.",
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not add the frame",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const importFrame = useMutation({
    mutationFn: (input: { sourceAssetId: string; sourceFrameId: string }) =>
      api<{ asset: AssetDto; frameId: string }>(`/api/assets/${assetId}/frames/import`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      client.setQueryData(["asset", assetId], data.asset);
      setImportFrameOpen(false);
      if (data.frameId) {
        setFrameId(data.frameId);
        setSocialElementId(null);
      }
      notify({ title: "Frame imported", description: "Palette colours were mapped." });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not import the frame",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const importPalette = useMutation({
    mutationFn: (sourceAssetId: string) =>
      api<AssetDto>(`/api/assets/${assetId}/palette/import`, {
        method: "POST",
        body: JSON.stringify({ sourceAssetId }),
      }),
    onSuccess: (data) => {
      client.setQueryData(["asset", assetId], data);
      setDrafts({});
      setPaletteImportOpen(false);
      notify({
        title: "Palette imported",
        description: "Frame pixels and scenes were remapped.",
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not import the palette",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const copyBackground = useMutation({
    mutationFn: (input: { sourceAssetId: string; sourceFrameId: string }) => {
      if (!socialFrame) throw new Error("Open a frame first.");
      return api<AssetDto>(`/api/assets/${assetId}/frames/${socialFrame.id}/background`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: (data) => {
      client.setQueryData(["asset", assetId], data);
      setBackgroundImportOpen(false);
      notify({
        title: "Background copied",
        description: "Colours mapped through the palette.",
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not copy the background",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const present = history?.present;
  /** Saves the run guard refused ("the agent owns this asset right now"). */
  const refusedSaves = useRef(new Map<string, FrameBuffer>());
  const pending = useRef(new Map<string, FrameBuffer>());
  const debounce = useRef<number | null>(null);
  // The mutation result is a fresh object every render, so it must not be a
  // dependency of the effects below or they re-arm forever.
  const mutate = useRef(save.mutateAsync);
  mutate.current = save.mutateAsync;

  const persistFrame = useCallback(
    (frameId: string, buffer: FrameBuffer) =>
      mutate.current({ frameId, buffer }).then(
        () => true,
        (reason: unknown) => {
          // A live run owns the asset: the API answers RUN_IN_PROGRESS. The
          // edit is the user's own and the agent will never write it, so the
          // save waits for the run to release the asset instead of surfacing
          // "A frame did not save" over a run that is working exactly as told.
          if (
            reason instanceof ApiError &&
            (reason.status === 409 || reason.code === "RUN_IN_PROGRESS")
          ) {
            refusedSaves.current.set(frameId, buffer);
            return false;
          }
          notify({
            id: "frame-save",
            title: "A frame did not save",
            description: reason instanceof Error ? reason.message : "Unknown error",
          });
          return false;
        },
      ),
    [notify],
  );

  const flush = useCallback(async () => {
    if (debounce.current !== null) {
      window.clearTimeout(debounce.current);
      debounce.current = null;
    }
    const batch = [...pending.current.entries()];
    pending.current.clear();
    await Promise.all(batch.map(([id, buffer]) => persistFrame(id, buffer)));
  }, [persistFrame]);

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

  useEffect(() => {
    if (running) return;
    // The task is over: holds nothing, so the edits it refused land now.
    const held = [...refusedSaves.current.entries()];
    if (held.length === 0) return;
    refusedSaves.current.clear();
    void Promise.all(held.map(([id, buffer]) => persistFrame(id, buffer)));
  }, [running, persistFrame]);

  // Once a run owns the asset again, a save failure from an earlier moment is
  // stale: the agent's own persistence supersedes it, so the notice goes.
  useEffect(() => {
    if (running) closeToast("frame-save");
  }, [running, closeToast]);

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
    setRows((current) => [...current.slice(-120), noteRow(crypto.randomUUID(), text)]);
  }, []);

  // The follow-up is a chat line in the agent steps the moment the API
  // answers, including the case where nothing was signaled yet.
  const noteFollowUp = useCallback(
    (
      message: string,
      outcome: {
        routed: string;
        delivery: "clarify" | "queued" | "held" | "relayed";
        frameName?: string;
        requestId?: string;
      },
    ) => {
      const relayed = outcome.delivery === "relayed";
      setRows((current) =>
        recordFollowUp(current, {
          id: outcome.requestId ?? `you-${crypto.randomUUID()}`,
          kind: "steering",
          routed: outcome.routed,
          message,
          delivery: outcome.delivery,
          ...(outcome.frameName !== undefined ? { frameName: outcome.frameName } : {}),
          ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}),
          ...(relayed ? { relayed: true } : {}),
        }),
      );
      setConsoleOpen(true);
    },
    [],
  );

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
  /** Follow the frame the agent is working on: the console, the canvas, the focus. */
  const focusAgentFrame = useCallback((target: string) => {
    setLastStrokeFrame(target);
    if (target === viewedFrameRef.current) setAgentPulse(Date.now());
    setRunFrameId(target);
  }, []);

  const applyStroke = useCallback(
    (raw: Record<string, unknown>, fallbackFrameId: string) => {
      const data = raw as { frameId?: string };
      const target =
        typeof data.frameId === "string" && data.frameId.length > 0
          ? data.frameId
          : fallbackFrameId;
      if (target) focusAgentFrame(target);
      // The stroke's pixels arrive whole. The painter reveals them one cell
      // at a time and parks the hover border on the cell the agent is inking.
      receiveStroke(raw, fallbackFrameId);
    },
    [focusAgentFrame, receiveStroke],
  );

  /**
   * A finished task used to drop every draft at once. The canvas and the
   * layer list read those drafts, and the asset query often still holds the
   * pre-paint snapshot, so the sprite vanished until a full reload. Keep
   * what is already on screen and only fill frames the stream never drafted,
   * from a fresh read of the asset.
   */
  const adoptFinishedFrames = useCallback(() => {
    void client
      .fetchQuery({
        queryKey: ["asset", assetId],
        queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
      })
      .then((data) => {
        client.setQueryData(["asset", assetId], data);
        setDrafts((current) => {
          let changed = false;
          const next = { ...current };
          for (const item of data.frames) {
            if (next[item.id] || item.kind === "social") continue;
            next[item.id] = createHistory(
              frameToBuffer(
                item,
                item.width ?? data.width,
                item.height ?? data.height,
                data.palette,
              ),
            );
            changed = true;
          }
          return changed ? next : current;
        });
        setFrameId((current) =>
          current !== null && data.frames.some((frame) => frame.id === current)
            ? current
            : (data.frames[0]?.id ?? current),
        );
      })
      .catch(() => undefined);
  }, [assetId, client]);

  /**
   * The reviewer's closing judgement as one console line. A finished run whose
   * reviewer still had notes is a finished run with an opinion — never a failed
   * save — so the line says what was decided and what remains.
   */
  function reviewNote(review: unknown): string | null {
    if (review === null || typeof review !== "object") return null;
    const verdict = review as { ok?: unknown; summary?: unknown; notes?: unknown };
    const summary =
      typeof verdict.summary === "string" && verdict.summary.length > 0
        ? ` — ${verdict.summary}`
        : "";
    if (verdict.ok === true) return `The reviewer passed the work${summary}`;
    const notes = Array.isArray(verdict.notes)
      ? verdict.notes.filter((note) => typeof note === "string")
      : [];
    if (notes.length === 0) return `The reviewer stopped with an open verdict${summary}`;
    return `The reviewer finished with ${notes.length} open note${notes.length === 1 ? "" : "s"}${summary}: ${notes.join("; ")}`;
  }

  /** The task stream drives the console tree; only task-complete ends it. */
  const listenTask = useCallback(
    (id: string, fallbackFrameId: string) => {
      sawLiveTask.current = id;
      taskListenRef.current = id;
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
          if (body.type === "frame-focus") {
            // A fix that moves to another owned frame names it; the console
            // and the canvas follow that frame instead of the run's first.
            const data = body.data as { frameId?: unknown };
            if (typeof data.frameId === "string" && data.frameId.length > 0) {
              focusAgentFrame(data.frameId);
            }
            return;
          }
          if (body.type !== "canvas-stroke" && body.type !== "usage") {
            // The plan and the workers create frames mid-run; the list must
            // follow them, not wait for the task to end.
            void client.invalidateQueries({ queryKey: ["asset", assetId] });
          }
          if (body.type === "task-complete") {
            const verdict = (body.data as { review?: unknown }).review;
            const note = reviewNote(verdict);
            if (note !== null) log(note);
            stopStroke();
            taskListenRef.current = null;
            setTaskId(null);
            setRunId(null);
            setRunFrameId(null);
            pending.current.clear();
            taskStream.close();
            void task.refetch();
            adoptFinishedFrames();
            void client.invalidateQueries({ queryKey: ["versions", assetId] });
            log("The task finished");
          }
        },
        onDrop: () => {
          taskListenRef.current = null;
          // A dropped task stream is not a stopped task: the snapshot decides.
          // A snapshot that cannot be read (a worker restart, an API blip)
          // proves nothing — treating it as "closed" marked the editor idle
          // while the agent still owned the asset, and the autosave then hit
          // the run guard with a toast every time. Unreachable retries instead.
          void api<{ task: TaskSnapshot["task"] }>(`/api/assets/${assetId}/task`)
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
            })
            .catch(() => {
              const firstDrop = paceRejoin(() => listenTask(id, ""));
              if (firstDrop)
                log("The task stream dropped; the server is unreachable — retrying");
            });
        },
      });
    },
    [
      adoptFinishedFrames,
      applyStroke,
      assetId,
      client,
      focusAgentFrame,
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
          if (body.type === "frame-focus") {
            const data = body.data as { frameId?: unknown };
            if (typeof data.frameId === "string" && data.frameId.length > 0) {
              focusAgentFrame(data.frameId);
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
            const target = runFrameIdRef.current;
            if (target) pending.current.delete(target);
            // The pixels on screen stay. A fresh read fills any frame the
            // stream never drafted, instead of blanking the one the user
            // was just looking at.
            adoptFinishedFrames();
            void client.invalidateQueries({ queryKey: ["versions", assetId] });
            // The finished run is on screen already. An ask-only run is one
            // more turn of the asset log; the session query re-reads its spend.
            void client.invalidateQueries({ queryKey: ["asset-session", assetId] });
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
          // A fetch that fails proves nothing, so the session stays live and
          // the paced rejoin retries instead of clearing the run.
          void api<ActiveRunResponse>(`/api/assets/${assetId}/active-run`)
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
            })
            .catch(() => {
              const runId = runIdRef.current;
              if (runId === null) return;
              const firstDrop = paceRejoin(() => listen(runId, "", 0));
              if (firstDrop)
                log("The stream dropped; the server is unreachable — retrying");
            });
        },
      });
    },
    [
      adoptFinishedFrames,
      applyStroke,
      assetId,
      client,
      closeStream,
      focusAgentFrame,
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
    setLogTurns([]);
    setEarlierTurns([]);
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
  const sceneStream = useRef<EventSource | null>(null);
  useEffect(() => {
    sceneStream.current?.close();
    sceneStream.current = null;
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/stream?after=0`);
    source.onmessage = (event) => {
      const body = JSON.parse(event.data) as { type: string; data: unknown };
      if (body.type === "frame-deleted") {
        const frameId = (body.data as { frameId?: unknown }).frameId;
        if (typeof frameId !== "string") return;
        client.setQueryData(["asset", assetId], (current: AssetDto | undefined) => {
          if (!current) return current;
          return {
            ...current,
            frames: current.frames.filter((item) => item.id !== frameId),
          };
        });
        setFrameId((active) => (active === frameId ? null : active));
        return;
      }
      if (body.type !== "frame-scene") return;
      const incoming = (body.data as { artboard?: Artboard }).artboard;
      if (!incoming) return;
      client.setQueryData(["asset", assetId], (current: AssetDto | undefined) => {
        if (!current) return current;
        const existing = current.frames.find((item) => item.id === incoming.id);
        if (existing) {
          return {
            ...current,
            frames: current.frames.map((item) =>
              item.id === incoming.id
                ? {
                    ...item,
                    name: incoming.name,
                    scene: incoming.scene,
                    copyOverride: incoming.copyOverride,
                    status: incoming.status,
                    version: incoming.version,
                    updatedAt: incoming.updatedAt,
                  }
                : item,
            ),
          };
        }
        return {
          ...current,
          frames: [
            ...current.frames,
            {
              id: incoming.id,
              name: incoming.name,
              index: current.frames.length,
              layers: [],
              kind: "social",
              width: incoming.width,
              height: incoming.height,
              presetId: incoming.presetId,
              scene: incoming.scene,
              copyOverride: incoming.copyOverride,
              status: incoming.status,
              version: incoming.version,
              updatedAt: incoming.updatedAt,
            },
          ],
        };
      });
      setFrameId((active) => active ?? incoming.id);
    };
    sceneStream.current = source;
    return () => {
      source.close();
      if (sceneStream.current === source) sceneStream.current = null;
    };
  }, [assetId, client, runId]);

  // task-complete is the live signal. A missed event still leaves the row
  // completed, and a run id that outlives that row keeps the editor locked
  // on Stop. Settle from the snapshot too.
  useEffect(() => {
    const record = task.data?.task;
    if (record === null || record === undefined) return;
    if (["queued", "running", "waiting"].includes(record.status)) return;
    const watching =
      taskId === record.id || runId === record.id || taskListenRef.current === record.id;
    if (!watching) return;
    taskListenRef.current = null;
    setTaskId((current) => (current === record.id ? null : current));
    setRunId((current) => (current === record.id ? null : current));
    setRunFrameId(null);
    pending.current.clear();
    taskStream.close();
    stopStroke();
    // The live drafts are the sprite the user just watched. Fill only the
    // frames they do not already hold, once this task has settled.
    adoptFinishedFrames();
  }, [adoptFinishedFrames, runId, stopStroke, task.data?.task, taskId, taskStream]);

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
        // Switching back to this tab is not a new event. The console already
        // has the live tree, so a second attach only repeats itself.
        if (taskListenRef.current === snapshot.task.id) return;
        setTaskId(snapshot.task.id);
        setRunId(snapshot.task.id);
        setConsoleOpen(true);
        setPendingInteraction(result.interaction);
        listenTask(snapshot.task.id, "");
        void task.refetch();
        return;
      }
      if (result.run) {
        const liveId = result.run.id;
        setRunId(liveId);
        rememberRunModel(liveId, result.run.modelId);
        setConsoleOpen(true);
        // A waiting run restores its card straight from the row's stored
        // events; the stream alone cannot be trusted to retain it.
        setPendingInteraction(result.interaction);
        setRestoredMeta(null);
        const started =
          result.run.createdAt === undefined
            ? Number.NaN
            : Date.parse(result.run.createdAt);
        if (!Number.isNaN(started)) setLiveStartedAt(started);
        setLiveRunInfo({
          modelId: result.run.modelId ?? null,
          effort: result.run.reasoningEffort ?? null,
        });
        if (displayedRunIdRef.current !== liveId) {
          // The console still shows an earlier turn. The live run takes it
          // over, and the row's prompt names the turn from the first paint.
          setRows([]);
          setMessage("");
          setRestoredMs(null);
          setRunPrompt(result.run.prompt ?? "");
          displayedRunIdRef.current = liveId;
        }
        log("Rejoined a run that was still going");
        listen(liveId, "", 0);
        return;
      }
      setPendingInteraction(null);
    }
    setRejoinDecided(false);
    void check().finally(() => {
      if (!cancelled) setRejoinDecided(true);
    });
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [assetId, listen, log, rememberRunModel]);

  // The asset conversation's log: every request of this asset — a drawing
  // task or an ask-only run — with the steps the console showed while it ran.
  // A refresh has no live stream, so this log is how each request is re-found
  // in the same place it was shown.
  useEffect(() => {
    // Rejoining is decided first: a live run or task owns the console, and
    // this fill must not race in and overwrite the live turn.
    if (!rejoinDecided) return;
    let cancelled = false;
    void api<{
      task: { id: string; status: string; phase: string } | null;
      prompt: string | null;
      plan?: unknown;
      runs: TaskLogRun[];
      usage?: unknown;
      modelId?: string | null;
      effort?: string | null;
      createdAt?: string | null;
      finishedAt?: string | null;
      earlier?: AssetLogTask[];
    }>(`/api/assets/${assetId}/task/log`)
      .catch(() => null)
      .then((result) => {
        if (cancelled || result === null) return;
        const earlier = result.earlier ?? [];
        // The server sends the newest entry as the top-level fields and the
        // rest before it, oldest first.
        const newest: AssetLogTask | null =
          result.createdAt != null || result.prompt !== null || result.runs.length > 0
            ? {
                id: result.task?.id ?? `log-${result.createdAt ?? "newest"}`,
                prompt: result.prompt,
                plan: result.plan,
                runs: result.runs,
                usage: result.usage ?? null,
                modelId: result.modelId ?? null,
                effort: result.effort ?? null,
                createdAt: result.createdAt ?? null,
                finishedAt: result.finishedAt ?? null,
              }
            : null;
        setLogTurns(newest !== null ? [...earlier, newest] : earlier);
        // Without a drawing task the run stories are the whole console; there
        // is no task transcript to replace.
        const record = result.task;
        if (record === null) return;
        const id = record.id;
        const terminal = !["queued", "running", "waiting"].includes(record.status);
        const replaceTranscript =
          newest !== null &&
          terminal &&
          runIdRef.current === null &&
          sawLiveTask.current !== id &&
          loadedTaskLog.current !== id;
        // A live task still needs the prompts before it. The streaming rows stay.
        if (!replaceTranscript) return;
        // The rejoin landed while this fetch was in flight: the stream owns
        // the turn now.
        if (sawLiveTask.current === id) return;
        loadedTaskLog.current = id;
        const turns = turnsFromAssetLog(newest, earlier);
        const last = turns.at(-1);
        setEarlierTurns(turns.slice(0, -1));
        setRows(last?.rows ?? []);
        setRunPrompt(last?.prompt ?? "");
        setMessage("");
        // The transcript is not live in this session; its exact meta came
        // with the log.
        setRestoredMeta(last?.meta ?? null);
        setLiveStartedAt(null);
        setLiveRunInfo(null);
        setSettledAt(null);
        displayedRunIdRef.current = `task:${id}`;
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, rejoinDecided, task.data?.task?.id, task.data?.task?.status]);

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
      if (latest?.id === displayedRunIdRef.current) return;
      let restored: RunRow[] = [];
      for (const event of latest?.events ?? []) {
        restored = applyRunEvent(restored, event.sequence, event.type, event.data);
      }
      setRows(restored);
      setMessage(latest?.text ?? "");
      setRestoredMs(latest?.durationMs ?? null);
      setRunPrompt(latest?.prompt ?? "");
      setRestoredMeta(null);
      const started =
        latest?.createdAt === undefined ? Number.NaN : Date.parse(latest.createdAt);
      setLiveStartedAt(Number.isNaN(started) ? null : started);
      setLiveRunInfo({
        modelId: latest?.modelId ?? null,
        effort: latest?.reasoningEffort ?? null,
      });
      setSettledAt(null);
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
          if (
            snapshot.task !== null &&
            ["queued", "running", "waiting"].includes(snapshot.task.status)
          ) {
            setTaskId((current) => current ?? snapshot.task?.id ?? null);
          }
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
        const timer = socialSaveTimers.current.get(target);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          socialSaveTimers.current.delete(target);
        }
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
          const requestId = crypto.randomUUID();
          const result = await api<{ routed: string; candidates?: string[] }>(
            `/api/tasks/${activeTaskId}/steer`,
            {
              method: "POST",
              body: JSON.stringify({
                prompt: text,
                requestId,
                ...(frameName !== undefined ? { frameName } : {}),
              }),
            },
          );
          if (result.routed === "clarify") {
            setClarify({
              message: text,
              candidates: result.candidates ?? [],
              requestId,
            });
          }
          noteFollowUp(text, steerOutcome(result.routed, { frameName, requestId }));
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
    const snapshotEarlier = earlierTurns;
    const snapshotRows = rows;
    const snapshotPrompt = runPrompt;
    const snapshotMeta = currentTurnMeta;
    if (snapshotPrompt.trim().length > 0 || snapshotRows.length > 0) {
      const snapshotId = displayedRunIdRef.current ?? `turn-${crypto.randomUUID()}`;
      setEarlierTurns((current) => [
        ...current.filter((turn) => turn.id !== snapshotId),
        {
          id: snapshotId,
          prompt: snapshotPrompt,
          rows: snapshotRows,
          ...(snapshotMeta !== null ? { meta: snapshotMeta } : {}),
        },
      ]);
    }
    // Urgent updates: the console and the composer react before any await.
    setError(null);
    setMessage("");
    setRows([]);
    setConsoleOpen(true);
    setRestoredMs(null);
    setRunPrompt(text);
    setRestoredMeta(null);
    setLiveStartedAt(Date.now());
    setLiveRunInfo({ modelId, effort });
    setSettledAt(null);
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
        await flushSocialSaves();
        await api("/api/preferences", {
          method: "PATCH",
          body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
        });
        const social = frame?.kind === "social";
        const started = await api<{ runId: string; kind?: "task" | "run" }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            assetId,
            frameId,
            prompt: text,
            modelId,
            reasoningEffort: effort,
            ...(social ? { social: true } : {}),
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
        // Nothing was lost: the prompt comes back for a retry, and the
        // previous turn goes back to being the live one.
        setEarlierTurns(snapshotEarlier);
        setRows(snapshotRows);
        setRunPrompt(snapshotPrompt);
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
    // A drawing run's id in the composer is the task id. Steering that id
    // through the single-run endpoint answers "that run is not available",
    // because the task row is not a generation run.
    const taskTarget = activeTaskId;
    if (pending.length === 0 || steering) return;
    if (taskTarget === null && runId === null) return;
    const ids = new Set(pending.map((item) => item.id));
    const anchored =
      frameContextOn && taskTarget !== null
        ? frames.find((frame) => frame.id === frameId)?.name
        : undefined;
    startTransition(async () => {
      // The dock empties immediately; a failure restores the items the
      // agent has not accepted yet.
      setOptimisticQueue(ids);
      const sent = new Set<string>();
      try {
        if (taskTarget !== null) {
          for (const item of pending) {
            const result = await api<{ routed: string; candidates?: string[] }>(
              `/api/tasks/${taskTarget}/steer`,
              {
                method: "POST",
                body: JSON.stringify({
                  prompt: item.text,
                  requestId: item.id,
                  ...(anchored !== undefined ? { frameName: anchored } : {}),
                }),
              },
            );
            if (result.routed === "clarify") {
              // Not delivered. The card owns this one; earlier items already landed.
              const owned = new Set(sent);
              owned.add(item.id);
              setQueue((current) => removeQueuedRuns(current, owned));
              setClarify({
                message: item.text,
                candidates: result.candidates ?? [],
                requestId: item.id,
              });
              noteFollowUp(
                item.text,
                steerOutcome("clarify", { frameName: anchored, requestId: item.id }),
              );
              return;
            }
            sent.add(item.id);
            noteFollowUp(
              item.text,
              steerOutcome(result.routed, { frameName: anchored, requestId: item.id }),
            );
          }
        } else if (runId !== null) {
          await api(`/api/runs/${runId}/steer`, {
            method: "POST",
            body: JSON.stringify({
              // One message per entry: the runtime applies them one per turn,
              // FIFO, and the item id dedupes a retried batch.
              messages: pending.map((item) => ({ text: item.text, requestId: item.id })),
            }),
          });
          for (const item of pending) {
            noteFollowUp(item.text, {
              routed: "supervisor",
              delivery: "queued",
              requestId: item.id,
            });
          }
        }
        setQueue((current) => removeQueuedRuns(current, ids));
      } catch (reason) {
        if (sent.size > 0) setQueue((current) => removeQueuedRuns(current, sent));
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
    selectedModel.vision !== true &&
    selectedModel.userImages !== true
      ? `${selectedModel.displayName} cannot read attached images — pick a vision model or remove them.`
      : undefined;
  // History badges read the catalog name for the run's model, never its slug.
  const runModelMap = useMemo(
    () =>
      new Map(
        Object.entries(runModels).map(([runId, modelId]) => [
          runId,
          modelNames[modelId] ?? modelId,
        ]),
      ),
    [runModels, modelNames],
  );
  const ghost = preview && preview.frameId === frameId ? preview.buffer : null;
  const activePalette = buffer?.palette ?? asset.data?.palette ?? [];
  const socialSelectedElement = sceneArtboard?.scene.elements.find(
    (element) => element.id === socialElementId,
  );
  const socialUsedColors = useMemo(() => {
    if (!sceneArtboard) return 0;
    const used = new Set<number>();
    for (const element of sceneArtboard.scene.elements) {
      if ("color" in element) used.add(element.color);
    }
    return used.size;
  }, [sceneArtboard]);

  const socialSummary = summarizeChecks(socialChecks);
  const socialPanels =
    sceneFrame && sceneArtboard && scenePreset ? (
      <Inspector
        board={sceneArtboard}
        preset={scenePreset}
        copy={socialCopy}
        checks={socialChecks}
        palette={asset.data?.palette ?? []}
        spriteChoices={spriteChoices}
        selectedElementId={socialElementId}
        tab={socialTab}
        onTab={setSocialTab}
        onTemplate={applySocialTemplate}
        onRename={(name) => {
          patchCachedFrame(sceneFrame.id, { name });
          queueSocialSave(sceneFrame.id);
        }}
        onBackground={(background) => {
          updateSocialScene({ ...(sceneFrame.scene ?? emptyScene()), background });
        }}
        onUpdateElement={updateSocialElement}
        onText={setSocialText}
        onRemoveElement={removeSocialElement}
        onCopy={(copy) => void applySocialCopy(copy)}
        onClearOverrides={clearSocialOverrides}
        onSelectElement={setSocialElementId}
        onAddText={addSocialText}
        onAddElement={addSocialElement}
        onImportBackground={() => setBackgroundImportOpen(true)}
        showName={false}
        showElements={false}
        running={running}
      />
    ) : null;

  const leftPanels = (
    <>
      <FramePanel
        frames={frames}
        palette={buffer?.palette ?? asset.data?.palette ?? []}
        pixelWidth={asset.data?.width}
        pixelHeight={asset.data?.height}
        liveFrames={liveFrames}
        asset={asset.data}
        sprites={socialSprites}
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
          setSocialElementId(null);
          setSocialTab("layout");
        }}
        onTogglePlay={() => setPlaying((value) => !value)}
        onAdd={() => void frameAction("add")}
        onAddSocial={() => setSocialPickerOpen(true)}
        onImport={() => setImportFrameOpen(true)}
        onDuplicate={(id) => void frameAction("duplicate", undefined, id)}
        onRename={(id, name) => void frameAction("rename", name, id)}
        onDelete={(id) => void frameAction("delete", undefined, id)}
        onReorder={(id, index) => frameReorder(id, index)}
      />
      <LayerPanel
        buffer={socialFrame ? undefined : buffer}
        elements={sceneArtboard?.scene.elements ?? []}
        selectedElementId={socialElementId}
        activeId={socialFrame ? "" : panelLayerId}
        locked={locked}
        onSelect={setActiveLayerId}
        onToggleVisible={(layerId, visible) =>
          frameId &&
          edit(frameId, drafts[frameId], { type: "setLayerVisible", layerId, visible })
        }
        onAdd={
          socialFrame
            ? addSocialText
            : () =>
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
        onSelectElement={(id) => {
          setSocialElementId(id);
          setSocialTab("layout");
        }}
        onToggleElement={(id, visible) => updateSocialElement(id, { visible })}
      />
    </>
  );

  const frameHeaderPanel = frame ? (
    <FrameHeaderPanel
      name={frame.name}
      width={socialFrame?.width ?? asset.data?.width ?? buffer?.width ?? 0}
      height={socialFrame?.height ?? asset.data?.height ?? buffer?.height ?? 0}
      meta={
        socialFrame
          ? (socialPreset?.label ?? "Frame")
          : `${buffer?.layers.length ?? 0} layer${(buffer?.layers.length ?? 0) === 1 ? "" : "s"}`
      }
      detail={
        socialFrame
          ? `${socialSummary.errors} ${socialSummary.errors === 1 ? "error" : "errors"} · ${socialSummary.warnings} ${socialSummary.warnings === 1 ? "warning" : "warnings"}`
          : undefined
      }
      disabled={locked}
      onRename={(name) => void frameAction("rename", name, frame.id)}
    />
  ) : null;

  const palettePanel = (
    <PalettePanel
      palette={activePalette}
      color={color}
      usedColors={socialFrame ? socialUsedColors : usedColors}
      onPick={(index) => {
        setColor(index);
        if (socialSelectedElement && "color" in socialSelectedElement) {
          updateSocialElement(socialSelectedElement.id, { color: index });
        }
      }}
      onImportPalette={() => {
        setPaletteSourceId("");
        setPaletteImportOpen(true);
      }}
      onAdd={(hex) => {
        if (activePalette.includes(hex)) {
          setColor(activePalette.indexOf(hex));
          return;
        }
        void updateAsset({ palette: [...activePalette, hex] });
      }}
    />
  );

  const viewPanel = socialFrame ? (
    <ViewPanel
      grid={grid}
      checker={checker}
      onion={onion}
      onGrid={setGrid}
      onChecker={setChecker}
      onOnion={setOnion}
    />
  ) : (
    <ViewPanel
      grid={grid}
      checker={checker}
      onion={onion}
      onGrid={setGrid}
      onChecker={setChecker}
      onOnion={setOnion}
    />
  );

  const frameTabBody = (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {frameHeaderPanel}
      {palettePanel}
      {viewPanel}
      <StylePanel
        style={style}
        width={socialFrame?.width ?? asset.data?.width ?? 32}
        height={socialFrame?.height ?? asset.data?.height ?? 32}
        readOnly={socialFrame !== null}
        onResize={(width, height) => void updateAsset({ width, height })}
      />
    </div>
  );

  const contentTabBody = (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      {sceneFrame
        ? (socialPanels ?? (
            <EmptyState
              title="No content yet"
              body="Add text, a block, or a pattern from the top bar."
            />
          ))
        : null}
    </div>
  );

  const inspectorTabs = (
    <div
      role="tablist"
      aria-label="Frame inspector"
      className="grid shrink-0 grid-cols-3 border-2 border-line"
    >
      {(["frame", "content", "history"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={inspectorTab === value}
          onClick={() => setInspectorTab(value)}
          className={`px-2 py-1.5 text-pixel-mono uppercase tracking-[0.14em] transition-colors duration-150 ${
            inspectorTab === value
              ? "bg-accent text-coffee"
              : "text-muted hover:bg-raised hover:text-ink"
          }`}
        >
          {value}
        </button>
      ))}
    </div>
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

  const historyTabBody = (
    <div className="flex min-h-0 flex-1 flex-col">{historyPanel("min-h-0 flex-1")}</div>
  );

  const inspectorBody =
    inspectorTab === "frame"
      ? frameTabBody
      : inspectorTab === "content"
        ? contentTabBody
        : historyTabBody;

  /**
   * Back to the home: the artwork itself shrinks into its thumbnail in the
   * grid. The editor's frame is not part of the flight — a transparent copy of
   * the painted pixels is laid over it, named `asset-flight`, and the frame's
   * own name is switched off for this move. So the sprite floats out of the
   * editor and lands in the card with no panel, checker, or border behind it;
   * the card's thumbnail canvas carries the same name on the other side.
   *
   * The overlay is plain DOM, appended outside React: it has to exist in the
   * old snapshot, which is taken after this handler returns, and a re-render
   * between the two would otherwise remove it.
   */
  const backToHome = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const view = viewRef.current;
      const frame = view;
      let overlay: HTMLCanvasElement | null = null;
      if (view !== null) {
        const doc = buffer ?? fallbackBuffer;
        // Nothing painted means nothing to fly; the frame keeps the name and
        // the move falls back to the plain page transition.
        const painted = paintedBounds(doc) !== null;
        // The overlay is the document's own box, transparent everywhere the
        // artwork is not: same aspect as the thumbnail's canvas, so the morph
        // scales one into the other exactly, with no panel behind it.
        const sprite = painted
          ? spriteCanvas(doc, { x: 0, y: 0, width: doc.width, height: doc.height })
          : null;
        if (sprite !== null) {
          // The canvas maps a document pixel to `zoom` CSS pixels from the
          // snapped camera origin; the same mapping places the overlay exactly
          // over the artwork on screen.
          const rect = view.getBoundingClientRect();
          const cell = camera.zoom;
          sprite.setAttribute("aria-hidden", "");
          Object.assign(sprite.style, {
            position: "fixed",
            left: `${rect.left + Math.round(camera.x)}px`,
            top: `${rect.top + Math.round(camera.y)}px`,
            width: `${doc.width * cell}px`,
            height: `${doc.height * cell}px`,
            imageRendering: "pixelated",
            pointerEvents: "none",
            zIndex: "60",
            viewTransitionName: "asset-flight",
          });
          document.body.append(sprite);
          overlay = sprite;
          // The frame must not keep the name too: two elements with one name
          // abort the transition.
          view.style.viewTransitionName = "none";
        }
      }
      const state = {
        door: "back" as const,
        homeReturn: { cardAssetId: assetId },
      };
      void navigateTyped(
        (options) => navigate({ to: "/projects", state, resetScroll: false, ...options }),
        FLIGHT_BACK_TYPE,
        () => navigate({ to: "/projects", state, resetScroll: false }),
      ).finally(() => {
        // The old snapshot is taken when the transition starts, so the overlay
        // has done its work by the time the navigation commits. Clearing it
        // here also covers a plain navigation, where nothing would hide it.
        overlay?.remove();
        if (frame !== null) frame.style.viewTransitionName = "";
      });
    },
    [assetId, buffer, camera, navigate],
  );

  return (
    <main
      id="content"
      className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-paper"
    >
      {/* The bar is one element across home and editor: it keeps its name on
          both sides, and its pieces carry their own so they can travel. */}
      <header
        data-flight="bar"
        className="flex min-h-16 min-w-0 items-center gap-3 border-b-2 border-line bg-panel px-3"
      >
        <Link
          to="/projects"
          className="shrink-0"
          onClick={backToHome}
          {...(brandMorphs ? { "data-flight": "brand" } : {})}
        >
          <Wordmark hideLabelOnNarrow />
        </Link>
        <span className="h-4 w-0.5 shrink-0 bg-line" aria-hidden />
        <p
          data-flight="bar-context"
          className="min-w-0 truncate text-pixel-label text-muted"
        >
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
        <span data-flight="bar-actions" className="ml-auto flex items-center gap-1.5">
          <IconButton
            label="Frames"
            className="lg:hidden"
            onClick={() => setLeftSheet(true)}
          >
            ☰
          </IconButton>
          <IconButton
            label="Inspector"
            className="lg:hidden"
            onClick={() => setRightSheet(true)}
          >
            ◨
          </IconButton>
          <Button
            tone="danger"
            className="px-2.5 py-1.5 text-pixel-label"
            disabled={!asset.data || running}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
          <Button
            tone="ghost"
            className="px-2.5 py-1.5 text-pixel-label"
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
        <div className="grid min-h-0 min-w-0 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(240px,300px)]">
          <aside className="hidden min-h-0 min-w-0 flex-col gap-4 overflow-y-auto border-r-2 border-line bg-panel px-3 pt-2 pb-3 lg:flex">
            {leftPanels}
          </aside>

          <div className="relative flex min-h-0 min-w-0 flex-col bg-field">
            <div className="order-1 min-w-0 border-b-2 border-line bg-panel px-2 pt-2 pb-1.5">
              <div className="flex min-h-9 min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto">
                  <Toolbar
                    tool={tool}
                    brushSize={brushSize}
                    selectionActive={selection !== null}
                    locked={locked || socialFrame !== null}
                    onTool={setTool}
                    onBrush={setBrushSize}
                    onSelectionFill={() => selectionCommand("fill")}
                    onSelectionClear={() => selectionCommand("clear")}
                    onDeselect={() => setSelection(null)}
                  />
                </div>
                <span aria-hidden className="h-5 w-0.5 shrink-0 bg-line" />
                <IconButton
                  label="Add text"
                  disabled={running || !sceneFrame}
                  onClick={addSocialText}
                >
                  <TextIcon />
                </IconButton>
                <IconButton
                  label="Add block"
                  disabled={running || !sceneFrame}
                  onClick={() => addSocialElement("rect")}
                >
                  <Square />
                </IconButton>
                <IconButton
                  label="Add pattern"
                  disabled={running || !sceneFrame}
                  onClick={() => addSocialElement("pattern")}
                >
                  <Grid />
                </IconButton>
                <Button
                  tone="ghost"
                  className="shrink-0 px-2 py-1 text-pixel-label"
                  onClick={() => setSocialPickerOpen(true)}
                >
                  + Frame
                </Button>
              </div>
            </div>
            <div
              ref={viewRef}
              className={`relative ${socialFrame ? "order-2" : "order-1"} min-h-0 min-w-0 flex-1 [view-transition-name:asset-flight] sm:order-2`}
              data-flight-frame=""
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
              ) : socialFrame && socialArtboard && socialPreset && asset.data ? (
                <div
                  className="checkerboard h-full w-full overflow-hidden"
                  style={{
                    paddingBottom: consoleOpen ? "min(56vh, 32rem)" : "9rem",
                  }}
                >
                  <div className="flex h-full min-h-0 w-full items-center justify-center p-6">
                    <ArtboardCanvas
                      artboard={socialArtboard}
                      preset={socialPreset}
                      asset={asset.data}
                      sprites={socialSprites}
                      fit={socialFit}
                      zoom={socialZoom}
                      panTool={tool === "pan"}
                      checker={checker}
                      onZoom={(direction) =>
                        setSocialZoom((value) => stepSocialZoom(value, direction))
                      }
                      showZones={false}
                      selectedId={socialElementId}
                      onSelect={setSocialElementId}
                      onMove={(id, x, y) =>
                        updateSocialElement(id, { x, y } as Partial<Element>)
                      }
                      locked={running}
                    />
                  </div>
                </div>
              ) : socialFrame ? (
                <Centered>
                  <p className="max-w-sm text-center text-sm text-muted">
                    Loading the project's sprite frames so this social scene can render.
                  </p>
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
                    overlay={socialFrame ? null : sceneOverlay}
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
              <div className="absolute top-3 right-3 z-30 flex w-11 flex-col items-center gap-1 border-2 border-line-strong bg-panel p-1 lg:top-auto lg:bottom-3">
                {socialFrame ? (
                  <>
                    <span className="w-full text-center text-pixel-mono text-muted">
                      {Math.round(socialZoom * 100)}%
                    </span>
                    <IconButton
                      label="Zoom out"
                      size="sm"
                      onClick={() => {
                        setSocialZoom((value) => stepSocialZoom(value, -1));
                      }}
                    >
                      <Minus />
                    </IconButton>
                    <IconButton
                      label="Zoom in"
                      size="sm"
                      onClick={() => {
                        setSocialZoom((value) => stepSocialZoom(value, 1));
                      }}
                    >
                      <Plus />
                    </IconButton>
                    <span className="my-0.5 h-px w-7 bg-line" aria-hidden />
                    <button
                      type="button"
                      aria-label="Fit to view"
                      aria-pressed={socialFit}
                      title="Fit to view"
                      onClick={() => {
                        setSocialFit(true);
                        setSocialZoom(1);
                      }}
                      className={`flex h-7 w-7 items-center justify-center border-2 text-pixel-mono transition-colors duration-150 ${
                        socialFit
                          ? "border-accent text-accent"
                          : "border-line text-muted hover:text-ink"
                      }`}
                    >
                      Fit
                    </button>
                    <button
                      type="button"
                      aria-label="Actual size"
                      aria-pressed={!socialFit}
                      title="Actual size"
                      onClick={() => {
                        setSocialFit(false);
                        setSocialZoom(1);
                      }}
                      className={`flex h-7 w-7 items-center justify-center border-2 text-pixel-mono transition-colors duration-150 ${
                        !socialFit
                          ? "border-accent text-accent"
                          : "border-line text-muted hover:text-ink"
                      }`}
                    >
                      1:1
                    </button>
                  </>
                ) : (
                  <>
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
                            centerCamera(
                              rect.width,
                              rect.height,
                              doc.width,
                              doc.height,
                              1,
                            ),
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
                  </>
                )}
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
                            const requestId = clarify.requestId ?? crypto.randomUUID();
                            const candidates = clarify.candidates;
                            setClarify(null);
                            startTransition(async () => {
                              if (activeTaskId === null) return;
                              try {
                                const result = await api<{
                                  routed: string;
                                  candidates?: string[];
                                }>(`/api/tasks/${activeTaskId}/steer`, {
                                  method: "POST",
                                  body: JSON.stringify({
                                    prompt: message,
                                    frameName: name,
                                    requestId,
                                  }),
                                });
                                if (result.routed === "clarify") {
                                  setClarify({
                                    message,
                                    candidates: result.candidates ?? candidates,
                                    requestId,
                                  });
                                }
                                noteFollowUp(
                                  message,
                                  steerOutcome(result.routed, {
                                    frameName: name,
                                    requestId,
                                  }),
                                );
                              } catch (reason) {
                                setClarify({ message, candidates, requestId });
                                const text =
                                  reason instanceof Error
                                    ? reason.message
                                    : "Steering failed.";
                                setError(text);
                                notify({
                                  title: "Could not steer the task",
                                  description: text,
                                });
                              }
                            });
                          }}
                        >
                          {name}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="pixel-corners-sm border-2 border-line px-2 py-1 text-pixel-mono text-muted transition-colors duration-150 hover:text-ink"
                        onClick={() => {
                          const message = clarify.message;
                          const requestId = clarify.requestId ?? crypto.randomUUID();
                          const candidates = clarify.candidates;
                          setClarify(null);
                          startTransition(async () => {
                            if (activeTaskId === null) return;
                            try {
                              const result = await api<{
                                routed: string;
                                candidates?: string[];
                              }>(`/api/tasks/${activeTaskId}/steer`, {
                                method: "POST",
                                body: JSON.stringify({ prompt: message, requestId }),
                              });
                              if (result.routed === "clarify") {
                                setClarify({
                                  message,
                                  candidates: result.candidates ?? candidates,
                                  requestId,
                                });
                              }
                              noteFollowUp(
                                message,
                                steerOutcome(result.routed, { requestId }),
                              );
                            } catch (reason) {
                              setClarify({ message, candidates, requestId });
                              const text =
                                reason instanceof Error
                                  ? reason.message
                                  : "Steering failed.";
                              setError(text);
                              notify({
                                title: "Could not steer the task",
                                description: text,
                              });
                            }
                          });
                        }}
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
                <div
                  ref={consoleRef}
                  className="w-full shrink-0 [view-transition-name:console-flight]"
                >
                  <RunConsole
                    taskProgress={
                      taskActive && task.data?.task
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
                    turns={consoleTurns(logTurns, {
                      id: taskId ?? "live",
                      prompt: runPrompt,
                      rows,
                      meta: currentTurnMeta,
                      createdAt: restoredMeta?.startedAt ?? null,
                    })}
                    running={consoleRunning}
                    session={session.data ?? null}
                    live={liveContribution}
                    model={
                      selectedModel !== undefined
                        ? {
                            id: selectedModel.id,
                            displayName: selectedModel.displayName,
                            contextWindow: selectedModel.contextWindow ?? null,
                          }
                        : null
                    }
                    modelNames={modelNames}
                    open={consoleOpen}
                    onOpen={setConsoleOpen}
                    message={message || (error ?? "")}
                    prompt={runPrompt}
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
                    modelLabels={modelNames}
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

          <aside className="hidden min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-l-2 border-line bg-panel p-3 lg:flex">
            {inspectorTabs}
            {inspectorBody}
          </aside>
        </div>
      </div>

      {wide ? null : (
        <>
          <Sheet open={leftSheet} onOpenChange={setLeftSheet} title="Frames" side="left">
            <div className="grid gap-4">{leftPanels}</div>
          </Sheet>
          <Sheet
            open={rightSheet}
            onOpenChange={setRightSheet}
            title="Inspector"
            side="right"
          >
            <div className="grid gap-4">
              {inspectorTabs}
              {inspectorBody}
            </div>
          </Sheet>
        </>
      )}

      <Dialog
        open={paletteImportOpen}
        onOpenChange={setPaletteImportOpen}
        title="Import a project palette"
        description="The source palette becomes this asset's palette. Pixels and scene colours map to the nearest colour."
        width="34rem"
      >
        <Field label="Source asset" htmlFor="palette-source">
          <SelectControl
            id="palette-source"
            label="Source asset"
            value={paletteSourceId}
            options={(resources.data?.assets ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={setPaletteSourceId}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button tone="ghost" onClick={() => setPaletteImportOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!paletteSourceId || importPalette.isPending}
            onClick={() => importPalette.mutate(paletteSourceId)}
          >
            {importPalette.isPending ? "Importing" : "Import palette"}
          </Button>
        </div>
      </Dialog>
      <ImportFrameDialog
        open={backgroundImportOpen}
        onOpenChange={setBackgroundImportOpen}
        mode="background"
        assets={resources.data?.assets ?? []}
        currentAssetId={assetId}
        busy={copyBackground.isPending}
        onImport={(sourceAssetId, sourceFrameId) =>
          copyBackground.mutate({ sourceAssetId, sourceFrameId })
        }
      />
      <ImportFrameDialog
        open={importFrameOpen}
        onOpenChange={setImportFrameOpen}
        assets={resources.data?.assets ?? []}
        currentAssetId={assetId}
        busy={importFrame.isPending}
        onImport={(sourceAssetId, sourceFrameId) =>
          importFrame.mutate({ sourceAssetId, sourceFrameId })
        }
      />
      <FormatPicker
        open={socialPickerOpen}
        onOpenChange={setSocialPickerOpen}
        existing={
          new Set(
            frames
              .filter((item) => item.kind === "social" && item.presetId)
              .map((item) => item.presetId as string),
          )
        }
        onPick={(presetId) => addSocialFrame.mutate(presetId)}
        busy={addSocialFrame.isPending}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        projectId={asset.data?.projectId ?? ""}
        assetId={assetId}
        frameId={frameId ?? ""}
        frameName={frame?.name ?? ""}
        assetName={asset.data?.name ?? ""}
        social={socialFrame !== null}
        onBeforeExport={async () => {
          await flush();
          await flushSocialSaves();
        }}
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

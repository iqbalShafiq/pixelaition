import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  availableSizes,
  availableWeights,
  buildTemplateScene,
  checkScene,
  fitTextToSlot,
  formatPresets,
  paletteRoles,
  presetAspect,
  presetsByGroup,
  summarizeChecks,
  syncCopyScene,
  type Artboard,
  type ArtboardCheck,
  type ArtboardScene,
  type CopyDeck,
  type CopyOverride,
  type Element,
  type FormatPreset,
  type SetWithArtboards,
  type SpriteSource,
  type TemplateId,
} from "@pixelaition/artboard";
import { ArtboardCanvas } from "../components/artboard-canvas.js";
import { applyRunEvent, type RunRow } from "../lib/run-activity.js";
import { useRunStream } from "../lib/run-stream.js";
import { useAttachments } from "../lib/use-attachments.js";
import { api, ApiError } from "../lib/api.js";
import { spritesForAsset } from "../lib/artboard.js";
import { Composer } from "../components/composer.js";
import { RunConsole } from "../components/run-console.js";
import type {
  InteractionResponse,
  PendingInteraction,
} from "../components/interaction-card.js";
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MenuItem,
  SegmentedControl,
  SelectControl,
  Sheet,
  TextInput,
  Textarea,
  Wordmark,
  useToast,
} from "../components/ui.js";
import type { AssetDto, FrameDto } from "../lib/types.js";

const DEFAULT_PRESETS = [
  "linkedin-profile",
  "linkedin-cover",
  "facebook-cover",
  "instagram-post",
  "instagram-reel",
  "youtube-thumbnail",
];

const templates: Array<{ value: TemplateId; label: string }> = [
  { value: "split-copy", label: "Split — copy left, mark right" },
  { value: "stack-copy", label: "Stack — copy top, mark middle" },
  { value: "centered-copy", label: "Centered copy" },
  { value: "centered-mark", label: "Centered mark" },
  { value: "thumbnail", label: "Thumbnail — big mark, bold copy" },
  { value: "banner-copy", label: "Banner — horizontal copy" },
  { value: "profile-mark", label: "Profile mark" },
  { value: "blank", label: "Blank" },
];

type SetDto = SetWithArtboards;
type Catalog = {
  models: Array<{
    id: string;
    displayName: string;
    efforts: string[];
    vision: boolean;
    userImages: boolean;
    contextWindow: number | null;
  }>;
  modelReady: boolean;
};

type SaveState = "saved" | "saving" | "failed";

export function StudioScreen() {
  const { projectId, assetId } = useParams({
    from: "/projects/$projectId/assets/$assetId/studio",
  });
  const queryClient = useQueryClient();
  const notify = useToast();
  const [setId, setSetId] = useState<string | null>(null);
  const [boards, setBoards] = useState<Artboard[]>([]);
  const [setInfo, setSetInfo] = useState<SetDto | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [view, setView] = useState<"sheet" | "board">("sheet");
  const [fit, setFit] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<"layout" | "copy" | "checks">(
    "layout",
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteBoard, setDeleteBoard] = useState<Artboard | null>(null);
  const [deleteSetOpen, setDeleteSetOpen] = useState(false);
  const [leftSheet, setLeftSheet] = useState(false);
  const [rightSheet, setRightSheet] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [runId, setRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [runPrompt, setRunPrompt] = useState("");
  const [message, setMessage] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const attachments = useAttachments();
  const { open: openStream, close: closeStream } = useRunStream();
  const answeredRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLDivElement | null>(null);
  const boardsRef = useRef<Artboard[]>([]);
  const timers = useRef(new Map<string, number>());
  const chains = useRef(new Map<string, Promise<void>>());
  const loadedSet = useRef<string | null>(null);

  const asset = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api<AssetDto>(`/api/assets/${assetId}`),
  });
  const sets = useQuery({
    queryKey: ["sets", projectId],
    queryFn: () =>
      api<{
        sets: Array<{
          id: string;
          assetId: string;
          name: string;
          artboardCount?: number;
        }>;
      }>(`/api/sets?projectId=${encodeURIComponent(projectId)}`),
  });
  const setQuery = useQuery({
    queryKey: ["set", setId],
    enabled: setId !== null,
    refetchInterval: runId !== null ? 1800 : false,
    queryFn: () => api<SetDto>(`/api/sets/${setId}`),
  });
  const activeRun = useQuery({
    queryKey: ["studio-active-run", assetId],
    enabled: setId !== null && runId === null,
    refetchInterval: runId === null ? 4000 : false,
    queryFn: () =>
      api<{
        run: {
          id: string;
          status: string;
          prompt: string | null;
          setId?: string | null;
        } | null;
        interaction: PendingInteraction | null;
      }>(`/api/assets/${assetId}/active-run`),
  });
  const catalog = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Catalog>("/api/models"),
  });
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () =>
      api<{ lastModelId: string | null; lastReasoningEffort: string | null }>(
        "/api/preferences",
      ),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () =>
      api<{ projects: Array<{ id: string; name: string }> }>("/api/projects"),
  });
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () =>
      api<{ assets: Array<{ id: string; projectId: string; name: string }> }>(
        "/api/assets",
      ),
  });

  const sprites = useMemo(
    () => (asset.data ? spritesForAsset(asset.data) : new Map()),
    [asset.data],
  );
  const presets = useMemo(
    () => new Map(formatPresets.map((preset) => [preset.id, preset])),
    [],
  );
  const models = catalog.data?.models ?? [];
  const selectedModel = models.find((item) => item.id === modelId);
  const efforts = selectedModel?.efforts ?? [];
  const running = runId !== null;
  const selectedBoard = boards.find((board) => board.id === selectedBoardId) ?? boards[0];
  const selectedPreset = selectedBoard ? presets.get(selectedBoard.presetId) : undefined;
  const checks = useMemo(() => {
    if (!asset.data) return new Map<string, ArtboardCheck[]>();
    const map = new Map<string, ArtboardCheck[]>();
    for (const board of boards) {
      const preset = presets.get(board.presetId);
      if (!preset) continue;
      map.set(
        board.id,
        checkScene({
          scene: board.scene,
          preset,
          palette: asset.data.palette,
          sprites,
        }),
      );
    }
    return map;
  }, [boards, asset.data, presets, sprites]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  // Pick the first set for this asset once the list arrives; a future deep
  // link can name a different set without changing the route shape.
  useEffect(() => {
    if (setId !== null) return;
    const key = `pixelaition:studio-set:${assetId}`;
    const stored = window.localStorage.getItem(key);
    const first =
      sets.data?.sets.find((item) => item.id === stored && item.assetId === assetId) ??
      sets.data?.sets.find((item) => item.assetId === assetId);
    if (first) setSetId(first.id);
  }, [sets.data, assetId, setId]);

  useEffect(() => {
    if (!setQuery.data) return;
    const data = setQuery.data;
    setSetInfo(data);
    if (
      runId !== null ||
      loadedSet.current !== data.id ||
      boardsRef.current.length === 0
    ) {
      loadedSet.current = data.id;
      setBoards(data.artboards);
    }
  }, [setQuery.data, runId]);

  useEffect(() => {
    if (runId !== null || setId === null) return;
    const run = activeRun.data?.run;
    if (
      !run ||
      run.setId !== setId ||
      !["queued", "running", "waiting"].includes(run.status)
    ) {
      return;
    }
    setRunId(run.id);
    setRunPrompt(run.prompt ?? "");
    setRows([]);
    setConsoleOpen(true);
    if (activeRun.data?.interaction) {
      setInteraction(activeRun.data.interaction);
      setPendingRunId(run.id);
    }
    listen(run.id);
  }, [activeRun.data, runId, setId]);

  useEffect(() => {
    if (modelId.length > 0) return;
    const preferred = preferences.data?.lastModelId;
    const first = models.find((model) => model.id === preferred) ?? models[0];
    if (first) {
      setModelId(first.id);
      setEffort(
        preferences.data?.lastReasoningEffort &&
          first.efforts.includes(preferences.data.lastReasoningEffort)
          ? preferences.data.lastReasoningEffort
          : (first.efforts[0] ?? "medium"),
      );
    }
  }, [models, modelId, preferences.data]);

  useEffect(() => {
    return () => {
      closeStream();
    };
  }, [closeStream]);

  const createSet = useMutation({
    mutationFn: (input: { presetIds?: string[]; all?: boolean }) =>
      api<SetDto>(`/api/projects/${projectId}/sets`, {
        method: "POST",
        body: JSON.stringify({
          assetId,
          presetIds: input.all
            ? formatPresets.map((preset) => preset.id)
            : (input.presetIds ?? DEFAULT_PRESETS),
        }),
      }),
    onSuccess: (created) => {
      setSetInfo(created);
      setBoards(created.artboards);
      loadedSet.current = created.id;
      setSetId(created.id);
      window.localStorage.setItem(`pixelaition:studio-set:${assetId}`, created.id);
      setSelectedBoardId(created.artboards[0]?.id ?? null);
      setSelectedElementId(null);
      setView("board");
      void queryClient.invalidateQueries({ queryKey: ["sets", projectId] });
      notify({
        title: "Social kit created",
        description: `${created.artboards.length} formats`,
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not create the kit",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const addBoard = useMutation({
    mutationFn: (presetId: string) =>
      api<{ artboard: Artboard; set: SetDto }>(`/api/sets/${setId}/artboards`, {
        method: "POST",
        body: JSON.stringify({ presetId }),
      }),
    onSuccess: (result) => {
      setBoards((current) => [...current, result.artboard]);
      setSetInfo(result.set);
      setSelectedBoardId(result.artboard.id);
      setSelectedElementId(null);
      setView("board");
      setPickerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["sets", projectId] });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not add the format",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const applyCopy = useMutation({
    mutationFn: (copy: CopyDeck) =>
      api<SetDto>(`/api/sets/${setId}`, {
        method: "PATCH",
        body: JSON.stringify({ copy }),
      }),
    onSuccess: (updated) => {
      setSetInfo(updated);
      setBoards(updated.artboards);
      clearTimers();
      notify({
        title: "Copy applied",
        description: "Every format that did not override it.",
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not update the copy",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  function clearTimers() {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }

  function flushBoard(boardId: string) {
    if (!setId) return;
    const timer = timers.current.get(boardId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(boardId);
    }
    const previous = chains.current.get(boardId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const board = boardsRef.current.find((item) => item.id === boardId);
        if (!board) return;
        setSaveState("saving");
        try {
          const result = await api<{ artboard: Artboard; set: SetDto }>(
            `/api/artboards/${boardId}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                version: board.version,
                scene: board.scene,
                name: board.name,
                copyOverride: board.copyOverride,
                status: board.status,
              }),
            },
          );
          setBoards((current) =>
            current.map((item) =>
              item.id === boardId
                ? {
                    ...item,
                    version: result.artboard.version,
                    updatedAt: result.artboard.updatedAt,
                    status: result.artboard.status,
                  }
                : item,
            ),
          );
          setSaveState("saved");
        } catch (reason) {
          setSaveState("failed");
          if (reason instanceof ApiError && reason.status === 409) {
            void setQuery.refetch();
            notify({
              title: "That artboard changed elsewhere",
              description: "Reloaded the latest version.",
            });
          } else {
            notify({
              title: "Could not save the artboard",
              description: reason instanceof Error ? reason.message : "Unknown error",
            });
          }
        }
      });
    chains.current.set(boardId, next);
  }

  function queueSave(board: Artboard) {
    if (!setId) return;
    const previous = timers.current.get(board.id);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => flushBoard(board.id), 600);
    timers.current.set(board.id, timer);
  }

  function commitBoard(next: Artboard) {
    boardsRef.current = boardsRef.current.map((item) =>
      item.id === next.id ? next : item,
    );
    setBoards(boardsRef.current);
    queueSave(next);
  }

  function updateElement(elementId: string, patch: Partial<Element>): void {
    if (!selectedBoard) return;
    const scene = {
      ...selectedBoard.scene,
      elements: selectedBoard.scene.elements.map((element) =>
        element.id === elementId ? ({ ...element, ...patch } as Element) : element,
      ),
    };
    commitBoard({ ...selectedBoard, scene });
  }

  function moveElement(elementId: string, x: number, y: number): void {
    if (!selectedBoard || running) return;
    updateElement(elementId, { x, y } as Partial<Element>);
  }

  function setElementText(
    elementId: string,
    text: string,
    copyKey?: keyof CopyDeck,
  ): void {
    if (!selectedBoard) return;
    const override: CopyOverride = { ...selectedBoard.copyOverride };
    if (copyKey !== undefined && setInfo) {
      if (text.trim() === (setInfo.copy[copyKey] ?? "").trim()) delete override[copyKey];
      else override[copyKey] = text;
    }
    const scene = {
      ...selectedBoard.scene,
      elements: selectedBoard.scene.elements.map((element) => {
        if (element.id !== elementId || element.kind !== "text") return element;
        const nextTextY = selectedBoard.scene.elements
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
      }),
    };
    commitBoard({ ...selectedBoard, scene, copyOverride: override });
  }

  function removeElement(elementId: string): void {
    if (!selectedBoard) return;
    commitBoard({
      ...selectedBoard,
      scene: {
        ...selectedBoard.scene,
        elements: selectedBoard.scene.elements.filter(
          (element) => element.id !== elementId,
        ),
      },
    });
  }

  function setBackground(background: ArtboardScene["background"]): void {
    if (!selectedBoard) return;
    commitBoard({ ...selectedBoard, scene: { ...selectedBoard.scene, background } });
  }

  function applyTemplate(template: TemplateId): void {
    if (!selectedBoard || !selectedPreset || !asset.data) return;
    const source = [...sprites.values()].find((item) => item.assetId === asset.data.id);
    const scene = buildTemplateScene({
      preset: selectedPreset,
      template,
      copy: setInfo?.copy ?? {},
      palette: asset.data.palette,
      ...(source ? { sprite: source } : {}),
    });
    commitBoard({ ...selectedBoard, scene });
  }

  function addElement(kind: "rect" | "pattern" | "frame"): void {
    if (!selectedBoard) return;
    const roles = paletteRoles(
      asset.data?.palette ?? ["#00000000", "#0b0906", "#f1efe9"],
    );
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const element: Element =
      kind === "rect"
        ? {
            id,
            kind: "rect",
            x: 0,
            y: 0,
            width: selectedBoard.width,
            height: Math.max(4, Math.round(selectedBoard.height * 0.12)),
            color: roles.accent,
          }
        : kind === "pattern"
          ? {
              id,
              kind: "pattern",
              x: 0,
              y: 0,
              width: selectedBoard.width,
              height: selectedBoard.height,
              colorA: roles.background,
              colorB: roles.muted,
              unit: selectedBoard.pixelUnit,
              mode: "checker",
            }
          : {
              id,
              kind: "frame",
              x: 0,
              y: 0,
              width: selectedBoard.width,
              height: selectedBoard.height,
              thickness: Math.max(2, selectedBoard.pixelUnit * 2),
              color: roles.accent,
            };
    commitBoard({
      ...selectedBoard,
      scene: {
        ...selectedBoard.scene,
        elements: [...selectedBoard.scene.elements, element],
      },
    });
    setInspectorTab("layout");
  }

  function addTextElement(): void {
    if (!selectedBoard) return;
    const roles = paletteRoles(
      asset.data?.palette ?? ["#00000000", "#0b0906", "#f1efe9"],
    );
    const id = `text-${Math.random().toString(36).slice(2, 7)}`;
    const element: Element = {
      id,
      kind: "text",
      text: "Your words",
      face: "silkscreen",
      weight: 700,
      size: availableSizes("silkscreen", 700).includes(64) ? 64 : 48,
      color: roles.ink,
      x: Math.round(selectedBoard.width * 0.06),
      y: Math.round(selectedBoard.height * 0.12),
      width: Math.round(selectedBoard.width * 0.56),
      align: "left",
      maxLines: 3,
    };
    commitBoard({
      ...selectedBoard,
      scene: {
        ...selectedBoard.scene,
        elements: [...selectedBoard.scene.elements, element],
      },
    });
  }

  function generate() {
    if (running || starting || !setId) return;
    const text = prompt.trim();
    if (text.length === 0) return;
    setStarting(true);
    setRows([]);
    setMessage("");
    setConsoleOpen(true);
    setRunPrompt(text);
    setPrompt("");
    void (async () => {
      try {
        await api(`/api/preferences`, {
          method: "PATCH",
          body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
        });
        const started = await api<{ runId: string }>(`/api/sets/${setId}/compose`, {
          method: "POST",
          body: JSON.stringify({
            prompt: text,
            modelId,
            reasoningEffort: effort,
            ...(attachments.items.length > 0
              ? {
                  attachments: attachments.items.map(({ mediaType, data }) => ({
                    mediaType,
                    data,
                  })),
                }
              : {}),
          }),
        });
        attachments.clear();
        setRunId(started.runId);
        listen(started.runId);
      } catch (reason) {
        setPrompt(text);
        setMessage(reason instanceof Error ? reason.message : "Could not start the run.");
        notify({
          title: "Could not start the compose run",
          description: reason instanceof Error ? reason.message : "Unknown error",
        });
      } finally {
        setStarting(false);
      }
    })();
  }

  function listen(id: string) {
    openStream(id, {
      onMessage: (body) => {
        setRows((current) => applyRunEvent(current, body.sequence, body.type, body.data));
        if (body.type === "interaction") {
          const data = body.data as PendingInteraction & { runId?: string };
          if (typeof data.id === "string" && !answeredRef.current.has(data.id)) {
            setInteraction(data);
            setPendingRunId(typeof data.runId === "string" ? data.runId : id);
            setConsoleOpen(true);
          }
          return;
        }
        if (body.type === "interaction-resolved") {
          const data = body.data as { id?: string };
          if (typeof data.id === "string") {
            answeredRef.current.add(data.id);
            setInteraction((current) => (current?.id === data.id ? null : current));
          }
          return;
        }
        if (body.type === "done" || body.type === "status") {
          const data = body.data as { status?: string };
          if (
            body.type === "done" ||
            ["succeeded", "failed", "cancelled"].includes(data.status ?? "")
          ) {
            closeStream();
            setRunId(null);
            setInteraction(null);
            setPendingRunId(null);
            void refreshSet();
            void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
          }
        }
      },
      onDrop: () => {
        // A dropped stream is not a stopped run: retry once, then let the
        // periodic set refetch and the run page fill the gap.
        window.setTimeout(() => {
          if (runId !== null) {
            void setQuery.refetch();
          }
        }, 1500);
      },
    });
  }

  async function respond(response: InteractionResponse) {
    if (!pendingRunId || !interaction) return;
    const run = pendingRunId;
    const id = interaction.id;
    try {
      await api(`/api/runs/${run}/respond`, {
        method: "POST",
        body: JSON.stringify({ interactionId: id, response }),
      });
      answeredRef.current.add(id);
      setInteraction(null);
      setPendingRunId(null);
    } catch (reason) {
      notify({
        title: "Could not answer the agent",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    }
  }

  async function refreshSet() {
    if (!setId) return;
    try {
      const data = await api<SetDto>(`/api/sets/${setId}`);
      setSetInfo(data);
      setBoards(data.artboards);
      loadedSet.current = data.id;
    } catch {
      // The interval refetch and the next run are the fallback.
    }
  }

  async function stop() {
    if (!runId) return;
    setStopping(true);
    try {
      await api(`/api/runs/${runId}/cancel`, { method: "POST" });
      closeStream();
      setRunId(null);
      setInteraction(null);
      void setQuery.refetch();
    } catch (reason) {
      notify({
        title: "Could not stop the run",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    } finally {
      setStopping(false);
    }
  }

  function clearOverrides() {
    if (!selectedBoard || !setInfo) return;
    const scene = syncCopyScene(selectedBoard.scene, setInfo.copy, {});
    commitBoard({ ...selectedBoard, scene, copyOverride: {} });
  }

  const selectedChecks = selectedBoard ? (checks.get(selectedBoard.id) ?? []) : [];
  const assetFrames: FrameDto[] = asset.data?.frames ?? [];

  if (asset.isPending) {
    return <Centered>Loading the social studio…</Centered>;
  }
  if (asset.isError || !asset.data) {
    return <Centered>That asset is not available.</Centered>;
  }

  if (
    setId === null &&
    !sets.isPending &&
    !sets.data?.sets.some((item) => item.assetId === assetId)
  ) {
    return (
      <Shell asset={asset.data} title="Social kit" actions={null}>
        <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-8">
          <div className="pixel-window bg-panel p-5">
            <p className="text-pixel-mono tracking-[0.18em] text-accent uppercase">
              One mark, every feed
            </p>
            <h1 className="mt-2 text-pixel-display text-ink">
              Turn this sprite into a social kit
            </h1>
            <p className="mt-2 max-w-2xl text-pixel-body text-muted">
              Exact native sizes, safe areas and crops for LinkedIn, Facebook, Instagram,
              TikTok, YouTube and more. Start with six useful formats or add the full set.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                onClick={() => createSet.mutate({ presetIds: DEFAULT_PRESETS })}
                disabled={createSet.isPending}
              >
                {createSet.isPending ? "Creating" : "Create social kit"}
              </Button>
              <Button
                tone="ghost"
                onClick={() => createSet.mutate({ all: true })}
                disabled={createSet.isPending}
              >
                Create all {formatPresets.length} formats
              </Button>
            </div>
            {createSet.isError ? (
              <Callout tone="danger">
                {createSet.error instanceof Error
                  ? createSet.error.message
                  : "Could not create the kit."}
              </Callout>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {formatPresets.slice(0, 9).map((preset) => (
              <FormatCard key={preset.id} preset={preset} />
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  const currentSet = setInfo;
  if (setId !== null && setQuery.isError) {
    return (
      <Shell asset={asset.data} title="Social kit" actions={null}>
        <div className="mx-auto grid w-full max-w-xl gap-3 p-6">
          <Callout tone="danger">The social kit could not be loaded.</Callout>
          <p className="text-pixel-body text-muted">
            {setQuery.error instanceof Error
              ? setQuery.error.message
              : "The API did not answer."}
          </p>
          <Button onClick={() => void setQuery.refetch()}>Try again</Button>
        </div>
      </Shell>
    );
  }
  if (!currentSet) {
    return <Centered>Loading the social kit…</Centered>;
  }

  const left = (
    <FormatRail
      boards={boards}
      presets={presets}
      checks={checks}
      asset={asset.data}
      sprites={sprites}
      selectedId={selectedBoardId}
      onSelect={(id) => {
        setSelectedBoardId(id);
        setSelectedElementId(null);
        setView("board");
        setLeftSheet(false);
      }}
      onSheet={() => {
        setSelectedBoardId(null);
        setSelectedElementId(null);
        setView("sheet");
        setLeftSheet(false);
      }}
      onAdd={() => setPickerOpen(true)}
      sets={sets.data?.sets.map((item) => ({ id: item.id, name: item.name })) ?? []}
      setId={setId ?? ""}
      onDeleteSet={() => setDeleteSetOpen(true)}
      onSet={(id) => {
        if (id === setId) return;
        loadedSet.current = null;
        window.localStorage.setItem(`pixelaition:studio-set:${assetId}`, id);
        setSetId(id);
        setSetInfo(null);
        setBoards([]);
        setSelectedBoardId(null);
        setSelectedElementId(null);
        setView("sheet");
      }}
    />
  );

  const inspector = selectedBoard ? (
    <Inspector
      board={selectedBoard}
      preset={selectedPreset}
      copy={currentSet.copy}
      checks={selectedChecks}
      palette={asset.data.palette}
      selectedElementId={selectedElementId}
      tab={inspectorTab}
      onTab={setInspectorTab}
      onTemplate={applyTemplate}
      onRename={(name) => {
        const trimmed = name.trim();
        if (selectedBoard && trimmed.length > 0) {
          commitBoard({ ...selectedBoard, name: trimmed.slice(0, 80) });
        }
      }}
      onBackground={setBackground}
      onUpdateElement={updateElement}
      onText={setElementText}
      onRemoveElement={removeElement}
      onCopy={(copy) => applyCopy.mutate(copy)}
      onClearOverrides={clearOverrides}
      onSelectElement={(id) => setSelectedElementId(id)}
      onAddText={addTextElement}
      onAddElement={addElement}
      running={running}
    />
  ) : null;

  const stage = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-field">
      <div className="flex flex-wrap items-center gap-1.5 border-b-2 border-line bg-panel px-2 py-1.5">
        <IconButton
          label="Kit formats"
          className="xl:hidden"
          onClick={() => setLeftSheet(true)}
        >
          ☰
        </IconButton>
        <IconButton
          label="Artboard inspector"
          className="xl:hidden"
          onClick={() => setRightSheet(true)}
        >
          ◨
        </IconButton>
        {view === "board" ? (
          <Button
            tone="quiet"
            className="px-2 py-1 text-pixel-label"
            onClick={() => setView("sheet")}
          >
            ← Kit
          </Button>
        ) : (
          <span className="px-1 text-pixel-mono tracking-[0.14em] text-muted uppercase">
            {boards.length} formats
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <SegmentedControl
            label="Zoom"
            value={fit ? "fit" : "100"}
            options={[
              { value: "fit", label: "Fit" },
              { value: "100", label: "1:1" },
            ]}
            onChange={(next) => setFit(next === "fit")}
          />
          <Button
            tone={showZones ? "solid" : "ghost"}
            className="px-2 py-1 text-pixel-label"
            onClick={() => setShowZones((value) => !value)}
          >
            Zones
          </Button>
          <Button
            tone="ghost"
            className="px-2 py-1 text-pixel-label"
            onClick={() => setPreviewOpen(true)}
            disabled={!selectedBoard}
          >
            Preview
          </Button>
          <Button
            tone="ghost"
            className="px-2 py-1 text-pixel-label"
            onClick={() => setExportOpen(true)}
          >
            Export
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 pb-24 sm:p-5 sm:pb-28">
        {view === "sheet" || !selectedBoard ? (
          <div className="mx-auto grid max-w-6xl gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                  {currentSet.name}
                </p>
                <p className="mt-1 text-pixel-body text-muted">
                  {boards.length} formats ·{" "}
                  {currentSet.copy.headline ?? "No headline yet"}
                </p>
              </div>
              <Button tone="ghost" onClick={() => setPickerOpen(true)}>
                + Add format
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {boards.map((board) => {
                const preset = presets.get(board.presetId);
                if (!preset) return null;
                const boardChecks = checks.get(board.id) ?? [];
                const summary = summarizeChecks(boardChecks);
                return (
                  <button
                    key={board.id}
                    type="button"
                    onClick={() => {
                      setSelectedBoardId(board.id);
                      setSelectedElementId(null);
                      setView("board");
                    }}
                    className={`group grid gap-2 border-2 border-line bg-panel p-2 text-left transition-colors hover:border-accent ${
                      board.width / board.height >= 1.6 ? "sm:col-span-2" : ""
                    }`}
                  >
                    <div className="relative flex h-[210px] items-center justify-center overflow-hidden bg-field p-2">
                      <LazyArtboard
                        artboard={board}
                        preset={preset}
                        asset={asset.data}
                        sprites={sprites}
                      />
                    </div>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-pixel-label text-ink">
                        {board.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted">
                        {board.width}×{board.height}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.08em] uppercase">
                      <span className={summary.errors > 0 ? "text-erase" : "text-muted"}>
                        {summary.errors > 0
                          ? `${summary.errors} errors`
                          : summary.warnings > 0
                            ? `${summary.warnings} warnings`
                            : "ready"}
                      </span>
                      <span className="text-muted">{preset.platform}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : selectedPreset ? (
          <div className="mx-auto flex h-full max-w-6xl flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-pixel-title text-ink">{selectedBoard.name}</p>
                <p className="text-pixel-mono text-muted">
                  {selectedPreset.platform} · {selectedPreset.width}×
                  {selectedPreset.height} · {presetAspect(selectedPreset)} ·{" "}
                  {selectedChecks.length} checks
                </p>
              </div>
              <span className="font-mono text-[11px] text-muted">
                {saveState === "saving"
                  ? "saving…"
                  : saveState === "failed"
                    ? "save failed"
                    : "saved"}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto border-2 border-line bg-screen p-3">
              <div className="flex min-h-full items-center justify-center">
                <ArtboardCanvas
                  artboard={selectedBoard}
                  preset={selectedPreset}
                  asset={asset.data}
                  sprites={sprites}
                  fit={fit}
                  showZones={showZones}
                  selectedId={selectedElementId}
                  onSelect={setSelectedElementId}
                  onMove={moveElement}
                  locked={running}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <SelectControl
                label="Template"
                value=""
                options={[{ value: "", label: "Apply a template…" }, ...templates]}
                onChange={(value) => {
                  if (value.length > 0) applyTemplate(value as TemplateId);
                }}
                className="min-w-[16rem]"
              />
              <Menu label="Add element">
                <MenuItem onClick={addTextElement}>Text</MenuItem>
                <MenuItem onClick={() => addElement("rect")}>Block</MenuItem>
                <MenuItem onClick={() => addElement("pattern")}>Pattern</MenuItem>
                <MenuItem onClick={() => addElement("frame")}>Frame</MenuItem>
              </Menu>
            </div>
          </div>
        ) : (
          <EmptyState title="Unknown format" body="This artboard's preset is missing." />
        )}
      </div>

      <div className="shrink-0 border-t-2 border-line bg-panel px-2 pt-2 pb-1.5">
        <div ref={composerRef} className="mx-auto w-full max-w-2xl">
          <Composer
            prompt={prompt}
            onPrompt={setPrompt}
            modelId={modelId}
            models={models.map((model) => model.id)}
            modelLabels={Object.fromEntries(
              models.map((model) => [model.id, model.displayName]),
            )}
            onModel={setModelId}
            effort={effort}
            efforts={efforts}
            onEffort={setEffort}
            running={running}
            starting={starting}
            stopping={stopping}
            modelReady={catalog.data?.modelReady ?? false}
            onGenerate={generate}
            onStop={() => void stop()}
            onQueue={() => undefined}
            attachments={attachments.items}
            attachmentError={attachments.error}
            attachmentIssue={
              attachments.items.length > 0 &&
              selectedModel !== undefined &&
              selectedModel.vision !== true &&
              selectedModel.userImages !== true
                ? `${selectedModel.id} cannot read attached images; pick a vision model.`
                : undefined
            }
            onAttach={attachments.add}
            onRemoveAttachment={attachments.remove}
          />
        </div>
        <div className="mx-auto w-full max-w-2xl">
          <RunConsole
            rows={rows}
            running={running}
            open={consoleOpen}
            onOpen={setConsoleOpen}
            message={message}
            prompt={runPrompt}
            interaction={interaction}
            frames={assetFrames}
            palette={asset.data.palette}
            projects={projects.data?.projects ?? []}
            assets={assets.data?.assets ?? []}
            onRespond={respond}
            onEscape={() => composerRef.current?.querySelector("textarea")?.focus()}
            model={
              selectedModel
                ? {
                    id: selectedModel.id,
                    displayName: selectedModel.displayName,
                    contextWindow: selectedModel.contextWindow,
                  }
                : null
            }
            modelNames={Object.fromEntries(
              models.map((model) => [model.id, model.displayName]),
            )}
          />
        </div>
      </div>
    </div>
  );

  return (
    <Shell
      asset={asset.data}
      title={currentSet.name}
      actions={
        <>
          <Link
            to="/projects/$projectId/assets/$assetId"
            params={{ projectId, assetId }}
            className="inline-flex min-h-9 items-center border-2 border-line px-2 py-1 text-pixel-body text-muted hover:border-line-strong hover:text-ink"
          >
            Sprite
          </Link>
          <Button
            tone="ghost"
            className="px-2 py-1 text-pixel-label"
            onClick={() => setExportOpen(true)}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
        <div className="grid min-h-0 min-w-0 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
          <aside className="hidden min-h-0 overflow-y-auto border-r-2 border-line bg-panel p-2 xl:block">
            {left}
          </aside>
          {stage}
          <aside className="hidden min-h-0 overflow-y-auto border-l-2 border-line bg-panel p-2 xl:block">
            {inspector}
          </aside>
        </div>
      </div>
      <Sheet open={leftSheet} onOpenChange={setLeftSheet} title="Formats">
        {left}
      </Sheet>
      <Sheet
        open={rightSheet}
        onOpenChange={setRightSheet}
        title="Inspector"
        side="right"
      >
        {inspector}
      </Sheet>
      <FormatPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existing={new Set(boards.map((board) => board.presetId))}
        onPick={(presetId) => addBoard.mutate(presetId)}
        busy={addBoard.isPending}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        setId={currentSet.id}
        board={selectedBoard ?? null}
        boards={boards}
        checks={checks}
        name={currentSet.name}
      />
      <PreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        boards={boards}
        presets={presets}
        asset={asset.data}
        sprites={sprites}
        selectedId={selectedBoard?.id}
      />
      <ConfirmDialog
        open={deleteSetOpen}
        onOpenChange={setDeleteSetOpen}
        title="Delete this social kit?"
        description={`${currentSet.name} and its ${boards.length} formats will be removed. The sprite and its frames are untouched.`}
        onConfirm={() => {
          setDeleteSetOpen(false);
          void api(`/api/sets/${currentSet.id}`, { method: "DELETE" })
            .then(() => {
              window.localStorage.removeItem(`pixelaition:studio-set:${assetId}`);
              queryClient.setQueryData(
                ["sets", projectId],
                (current: { sets: Array<{ id: string }> } | undefined) =>
                  current
                    ? {
                        ...current,
                        sets: current.sets.filter((item) => item.id !== currentSet.id),
                      }
                    : current,
              );
              setSetId(null);
              setSetInfo(null);
              setBoards([]);
              setSelectedBoardId(null);
              setSelectedElementId(null);
              loadedSet.current = null;
              void queryClient.invalidateQueries({ queryKey: ["sets", projectId] });
              notify({ title: "Social kit deleted" });
            })
            .catch((reason: unknown) =>
              notify({
                title: "Could not delete the kit",
                description: reason instanceof Error ? reason.message : "Unknown error",
              }),
            );
        }}
      />
      <ConfirmDialog
        open={deleteBoard !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteBoard(null);
        }}
        title="Delete this format?"
        description={`${deleteBoard?.name ?? "This artboard"} and its layout will be removed from the kit. The sprite is untouched.`}
        onConfirm={() => {
          if (!deleteBoard) return;
          const id = deleteBoard.id;
          setDeleteBoard(null);
          void api(`/api/artboards/${id}`, { method: "DELETE" })
            .then(() => {
              setBoards((current) => current.filter((board) => board.id !== id));
              setSelectedBoardId((current) => (current === id ? null : current));
              setSelectedElementId(null);
              setView("sheet");
            })
            .catch((reason: unknown) =>
              notify({
                title: "Could not delete the format",
                description: reason instanceof Error ? reason.message : "Unknown error",
              }),
            );
        }}
      />
    </Shell>
  );
}

function Shell({
  asset,
  title,
  actions,
  children,
}: {
  asset: AssetDto;
  title: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <main
      id="content"
      className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-paper"
    >
      <header className="flex min-h-16 min-w-0 items-center gap-2 border-b-2 border-line bg-panel px-3">
        <Link to="/projects" className="shrink-0">
          <Wordmark hideLabelOnNarrow />
        </Link>
        <span className="h-4 w-0.5 shrink-0 bg-line" aria-hidden />
        <p className="min-w-0 truncate text-pixel-label text-muted">
          <span className="text-ink">{asset.name}</span>
          <span className="mx-1.5">/</span>
          {asset.projectName}
          <span className="mx-1.5">/</span>
          <span className="text-accent">{title}</span>
        </p>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      </header>
      {children}
    </main>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4">
      <div className="border-2 border-line bg-panel px-4 py-3 text-pixel-body text-muted">
        {children}
      </div>
    </main>
  );
}

function LazyArtboard({
  artboard,
  preset,
  asset,
  sprites,
}: {
  artboard: Artboard;
  preset: FormatPreset;
  asset: AssetDto;
  sprites: Map<string, SpriteSource>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="grid h-full w-full place-items-center">
      {visible ? (
        <ArtboardCanvas
          artboard={artboard}
          preset={preset}
          asset={asset}
          sprites={sprites}
          fit
          showZones={false}
          thumbnail
        />
      ) : (
        <span className="font-mono text-[9px] text-muted">
          {artboard.width}×{artboard.height}
        </span>
      )}
    </div>
  );
}

function FormatCard({ preset }: { preset: FormatPreset }) {
  return (
    <div className="border-2 border-line bg-panel p-2">
      <div
        className="grid place-items-center border-2 border-line bg-field p-2"
        style={{ aspectRatio: `${preset.width}/${preset.height}` }}
      >
        <span className="text-center font-mono text-[10px] text-muted">
          {preset.width}×{preset.height}
        </span>
      </div>
      <p className="mt-2 truncate text-pixel-label text-ink">{preset.label}</p>
      <p className="font-mono text-[10px] text-muted">
        {preset.platform} · {presetAspect(preset)}
      </p>
    </div>
  );
}

function FormatRail({
  boards,
  presets,
  checks,
  asset,
  sprites,
  selectedId,
  onSelect,
  onSheet,
  onAdd,
  sets,
  setId,
  onSet,
  onDeleteSet,
}: {
  boards: Artboard[];
  presets: Map<string, FormatPreset>;
  checks: Map<string, ArtboardCheck[]>;
  asset: AssetDto;
  sprites: Map<string, SpriteSource>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSheet: () => void;
  onAdd: () => void;
  sets: Array<{ id: string; name: string }>;
  setId: string;
  onSet: (id: string) => void;
  onDeleteSet: () => void;
}) {
  return (
    <div className="grid gap-2">
      {sets.length > 1 ? (
        <Field label="Kit" htmlFor="studio-set">
          <SelectControl
            id="studio-set"
            label="Kit"
            value={setId}
            options={sets.map((item) => ({ value: item.id, label: item.name }))}
            onChange={onSet}
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">Formats</p>
        <span className="font-mono text-[10px] text-muted">{boards.length}</span>
      </div>
      <Button
        tone="ghost"
        className="justify-start px-2 py-1 text-pixel-label"
        onClick={onSheet}
      >
        ← All formats
      </Button>
      <div className="grid gap-1">
        {boards.map((board) => {
          const preset = presets.get(board.presetId);
          if (!preset) return null;
          const summary = summarizeChecks(checks.get(board.id) ?? []);
          return (
            <button
              key={board.id}
              type="button"
              onClick={() => onSelect(board.id)}
              className={`grid min-w-0 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-2 border-2 px-1.5 py-1.5 text-left ${
                selectedId === board.id
                  ? "border-accent bg-field"
                  : "border-transparent hover:border-line hover:bg-field"
              }`}
            >
              <span className="grid h-12 w-12 place-items-center overflow-hidden border border-line bg-field">
                <LazyArtboard
                  artboard={board}
                  preset={preset}
                  asset={asset}
                  sprites={sprites}
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-pixel-label text-ink">
                  {board.name}
                </span>
                <span className="block font-mono text-[10px] text-muted">
                  {board.width}×{board.height}
                </span>
              </span>
              <span
                className={`font-mono text-[9px] uppercase ${
                  summary.errors > 0 ? "text-erase" : "text-muted"
                }`}
              >
                {summary.errors > 0 ? summary.errors : summary.warnings > 0 ? "!" : "ok"}
              </span>
            </button>
          );
        })}
      </div>
      <Button
        tone="ghost"
        className="justify-start px-2 py-1 text-pixel-label"
        onClick={onAdd}
      >
        + Add format
      </Button>
      <button
        type="button"
        onClick={onDeleteSet}
        className="mt-1 border-t-2 border-line px-2 pt-2 pb-1 text-left text-pixel-label text-erase hover:text-ink"
      >
        Delete kit
      </button>
    </div>
  );
}

export function Inspector({
  board,
  preset,
  copy,
  checks,
  palette,
  spriteChoices,
  selectedElementId,
  tab,
  onTab,
  onTemplate,
  onRename,
  onBackground,
  onUpdateElement,
  onText,
  onRemoveElement,
  onCopy,
  onClearOverrides,
  onSelectElement,
  onAddText,
  onAddElement,
  onImportPalette,
  running,
}: {
  board: Artboard;
  preset: FormatPreset | undefined;
  copy: CopyDeck;
  checks: ArtboardCheck[];
  palette: string[];
  spriteChoices?: Array<{
    assetId: string;
    assetName: string;
    frameId: string;
    frameName: string;
  }>;
  selectedElementId: string | null;
  tab: "layout" | "copy" | "checks";
  onTab: (tab: "layout" | "copy" | "checks") => void;
  onTemplate: (template: TemplateId) => void;
  onRename: (name: string) => void;
  onBackground: (background: ArtboardScene["background"]) => void;
  onUpdateElement: (id: string, patch: Partial<Element>) => void;
  onText: (id: string, text: string, key?: keyof CopyDeck) => void;
  onRemoveElement: (id: string) => void;
  onCopy: (copy: CopyDeck) => void;
  onClearOverrides: () => void;
  onSelectElement: (id: string) => void;
  onAddText: () => void;
  onAddElement: (kind: "rect" | "pattern" | "frame") => void;
  onImportPalette?: () => void;
  running: boolean;
}) {
  const [elementId, setElementId] = useState<string | null>(
    board.scene.elements[0]?.id ?? null,
  );
  const [copyDraft, setCopyDraft] = useState<CopyDeck>(copy);
  const [nameDraft, setNameDraft] = useState(board.name);
  useEffect(() => setCopyDraft(copy), [copy]);
  useEffect(() => setNameDraft(board.name), [board.name]);
  useEffect(() => {
    if (selectedElementId) setElementId(selectedElementId);
  }, [selectedElementId]);
  const selected = board.scene.elements.find((element) => element.id === elementId);
  const roles = paletteRoles(palette);
  const summary = summarizeChecks(checks);

  return (
    <div className="grid gap-3">
      <Field label="Frame name" htmlFor="artboard-name">
        <TextInput
          id="artboard-name"
          value={nameDraft}
          disabled={running}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => onRename(nameDraft)}
        />
      </Field>
      <SegmentedControl
        label="Inspector section"
        value={tab}
        options={[
          { value: "layout", label: "Layout" },
          { value: "copy", label: "Copy" },
          { value: "checks", label: `Checks ${checks.length}` },
        ]}
        onChange={(next) => onTab(next as "layout" | "copy" | "checks")}
      />
      {tab === "layout" ? (
        <>
          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Background
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                tone={board.scene.background.kind === "solid" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() => onBackground({ kind: "solid", color: roles.background })}
              >
                Solid
              </Button>
              <Button
                tone={board.scene.background.kind === "transparent" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() => onBackground({ kind: "transparent" })}
              >
                Transparent
              </Button>
              <Button
                tone={board.scene.background.kind === "pattern" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() =>
                  onBackground({
                    kind: "pattern",
                    colorA: roles.background,
                    colorB: roles.muted,
                    unit: Math.max(2, board.pixelUnit),
                    mode: "checker",
                  })
                }
              >
                Pattern
              </Button>
            </div>
          </section>

          {onImportPalette ? (
            <Button
              tone="ghost"
              className="justify-start px-2 py-1 text-pixel-label"
              onClick={onImportPalette}
            >
              Import project palette
            </Button>
          ) : null}

          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Elements
            </p>
            <div className="grid gap-1">
              {board.scene.elements.map((element) => (
                <button
                  key={element.id}
                  type="button"
                  onClick={() => {
                    setElementId(element.id);
                    onSelectElement(element.id);
                  }}
                  className={`flex items-center justify-between gap-2 border-2 px-2 py-1 text-left ${
                    selected?.id === element.id
                      ? "border-accent text-ink"
                      : "border-transparent text-muted hover:border-line hover:text-ink"
                  }`}
                >
                  <span className="truncate font-mono text-[11px]">
                    {element.kind === "text"
                      ? `“${element.text.slice(0, 22)}”`
                      : element.kind}
                  </span>
                  <span className="font-mono text-[9px] text-muted">
                    {element.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={onAddText}
                disabled={running}
              >
                + Text
              </Button>
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={() => onAddElement("rect")}
                disabled={running}
              >
                + Block
              </Button>
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={() => onAddElement("pattern")}
                disabled={running}
              >
                + Pattern
              </Button>
            </div>
          </section>

          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Template
            </p>
            <SelectControl
              label="Template"
              value=""
              options={[{ value: "", label: "Apply a template…" }, ...templates]}
              onChange={(value) => {
                if (value.length > 0) onTemplate(value as TemplateId);
              }}
            />
          </section>

          {selected ? (
            <ElementEditor
              element={selected}
              palette={palette}
              board={board}
              spriteChoices={spriteChoices}
              disabled={running}
              onUpdate={(patch) => onUpdateElement(selected.id, patch)}
              onText={(text) =>
                onText(
                  selected.id,
                  text,
                  ["eyebrow", "headline", "subhead", "cta", "handle", "legal"].includes(
                    selected.id,
                  )
                    ? (selected.id as keyof CopyDeck)
                    : undefined,
                )
              }
              onRemove={() => {
                onRemoveElement(selected.id);
                setElementId(null);
              }}
            />
          ) : null}

          {preset ? (
            <section className="grid gap-1 border-2 border-line bg-field p-2 font-mono text-[10px] text-muted">
              <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
                Format notes
              </p>
              {preset.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <p className="mt-1 break-all">
                {preset.official ? "Official" : "Industry"} · {preset.source} · checked{" "}
                {preset.verifiedAt}
              </p>
            </section>
          ) : null}
        </>
      ) : null}

      {tab === "copy" ? (
        <section className="grid gap-2 border-2 border-line bg-field p-2">
          <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
            Shared copy
          </p>
          <p className="text-[11px] text-muted">
            This deck feeds every format that has not overridden a field. A text edit on a
            board creates an override, not a fork.
          </p>
          {(
            [
              ["eyebrow", "Eyebrow"],
              ["headline", "Headline"],
              ["subhead", "Subhead"],
              ["cta", "CTA"],
              ["handle", "Handle"],
              ["caption", "Post caption"],
            ] as Array<[keyof CopyDeck, string]>
          ).map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`copy-${key}`}>
              <TextInput
                id={`copy-${key}`}
                value={copyDraft[key] ?? ""}
                onChange={(event) =>
                  setCopyDraft({ ...copyDraft, [key]: event.target.value })
                }
              />
            </Field>
          ))}
          <div className="flex flex-wrap gap-1">
            <Button onClick={() => onCopy(copyDraft)} disabled={running}>
              Apply to all formats
            </Button>
            <Button tone="ghost" onClick={onClearOverrides} disabled={running}>
              Reset overrides
            </Button>
          </div>
        </section>
      ) : null}

      {tab === "checks" ? (
        <section className="grid gap-2 border-2 border-line bg-field p-2">
          <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
            {summary.errors} errors · {summary.warnings} warnings
          </p>
          {checks.length === 0 ? (
            <p className="text-[12px] text-muted">No deterministic findings.</p>
          ) : (
            checks.map((check, index) => (
              <div
                key={`${check.code}-${index}`}
                className={`border-l-2 px-2 py-1 ${
                  check.severity === "error" ? "border-erase" : "border-line-strong"
                }`}
              >
                <p className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">
                  {check.code}
                </p>
                <p className="text-[11px] text-ink">{check.message}</p>
              </div>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}

function ElementEditor({
  element,
  palette,
  board,
  spriteChoices,
  disabled,
  onUpdate,
  onText,
  onRemove,
}: {
  element: Element;
  palette: string[];
  board: Artboard;
  spriteChoices?: Array<{
    assetId: string;
    assetName: string;
    frameId: string;
    frameName: string;
  }>;
  disabled: boolean;
  onUpdate: (patch: Partial<Element>) => void;
  onText: (text: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(element.kind === "text" ? element.text : "");
  useEffect(() => {
    if (element.kind === "text") setText(element.text);
  }, [element.kind === "text" ? element.text : ""]);
  return (
    <section className="grid gap-2 border-2 border-line bg-field p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
          {element.kind} · {element.id}
        </p>
        <Button
          tone="danger"
          className="px-2 py-1 text-pixel-label"
          onClick={onRemove}
          disabled={disabled}
        >
          Remove
        </Button>
      </div>
      {element.kind === "sprite" && spriteChoices && spriteChoices.length > 0 ? (
        <Field label="Source sprite" htmlFor="element-sprite-source">
          <SelectControl
            id="element-sprite-source"
            label="Source sprite"
            value={`${element.assetId}:${element.frameId ?? ""}`}
            options={spriteChoices.map((choice) => ({
              value: `${choice.assetId}:${choice.frameId}`,
              label: `${choice.assetName} · ${choice.frameName}`,
            }))}
            onChange={(value) => {
              const [assetId, frameId] = value.split(":");
              if (assetId && frameId) onUpdate({ assetId, frameId } as Partial<Element>);
            }}
          />
        </Field>
      ) : null}
      {element.kind === "text" ? (
        <>
          <Field label="Text" htmlFor="element-text">
            <Textarea
              id="element-text"
              value={text}
              rows={2}
              onChange={(event) => setText(event.target.value)}
              onBlur={() => onText(text)}
              disabled={disabled}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Face" htmlFor="element-face">
              <SelectControl
                id="element-face"
                label="Face"
                value={element.face}
                options={["silkscreen", "pixelify", "mono"]}
                onChange={(face) => {
                  const nextFace = face as "silkscreen" | "pixelify" | "mono";
                  const weight = availableWeights(nextFace).includes(element.weight)
                    ? element.weight
                    : (availableWeights(nextFace)[0] ?? 400);
                  const sizes = availableSizes(nextFace, weight);
                  onUpdate({
                    face: nextFace,
                    weight,
                    size: sizes.includes(element.size)
                      ? element.size
                      : (sizes.at(-1) ?? element.size),
                  } as Partial<Element>);
                }}
              />
            </Field>
            <Field label="Weight" htmlFor="element-weight">
              <SelectControl
                id="element-weight"
                label="Weight"
                value={String(element.weight)}
                options={availableWeights(element.face).map(String)}
                onChange={(weight) => {
                  const nextWeight = Number(weight) as 400 | 600 | 700;
                  const sizes = availableSizes(element.face, nextWeight);
                  onUpdate({
                    weight: nextWeight,
                    size: sizes.includes(element.size)
                      ? element.size
                      : (sizes.at(-1) ?? element.size),
                  } as Partial<Element>);
                }}
              />
            </Field>
            <Field label="Size" htmlFor="element-size">
              <SelectControl
                id="element-size"
                label="Size"
                value={String(element.size)}
                options={availableSizes(element.face, element.weight).map(String)}
                onChange={(size) => onUpdate({ size: Number(size) } as Partial<Element>)}
              />
            </Field>
            <Field label="Align" htmlFor="element-align">
              <SelectControl
                id="element-align"
                label="Align"
                value={element.align}
                options={["left", "center", "right"]}
                onChange={(align) =>
                  onUpdate({
                    align: align as "left" | "center" | "right",
                  } as Partial<Element>)
                }
              />
            </Field>
          </div>
        </>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label="X" htmlFor="element-x">
          <TextInput
            id="element-x"
            type="number"
            value={element.x}
            onChange={(event) =>
              onUpdate({ x: Number(event.target.value) } as Partial<Element>)
            }
            disabled={disabled}
          />
        </Field>
        <Field label="Y" htmlFor="element-y">
          <TextInput
            id="element-y"
            type="number"
            value={element.y}
            onChange={(event) =>
              onUpdate({ y: Number(event.target.value) } as Partial<Element>)
            }
            disabled={disabled}
          />
        </Field>
        {element.kind === "sprite" ? (
          <>
            <Field label="Scale" htmlFor="element-scale">
              <TextInput
                id="element-scale"
                type="number"
                min={1}
                max={64}
                value={element.scale}
                onChange={(event) =>
                  onUpdate({
                    scale: Math.max(1, Number(event.target.value)),
                  } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
            <Field label="Anchor" htmlFor="element-anchor">
              <SelectControl
                id="element-anchor"
                label="Anchor"
                value={element.anchor}
                options={[
                  "top-left",
                  "top-center",
                  "top-right",
                  "center-left",
                  "center",
                  "center-right",
                  "bottom-left",
                  "bottom-center",
                  "bottom-right",
                ]}
                onChange={(anchor) => onUpdate({ anchor } as Partial<Element>)}
              />
            </Field>
          </>
        ) : null}
        {element.kind === "text" ? (
          <>
            <Field label="Width" htmlFor="element-width">
              <TextInput
                id="element-width"
                type="number"
                value={element.width}
                onChange={(event) =>
                  onUpdate({ width: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
            <Field label="Max lines" htmlFor="element-lines">
              <TextInput
                id="element-lines"
                type="number"
                min={1}
                max={20}
                value={element.maxLines ?? 3}
                onChange={(event) =>
                  onUpdate({ maxLines: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
          </>
        ) : null}
      </div>
      {"color" in element ? (
        <ColorPicker
          label="Colour"
          palette={palette}
          value={element.color}
          onChange={(color) => onUpdate({ color } as Partial<Element>)}
        />
      ) : null}
      {"colorA" in element ? (
        <>
          <ColorPicker
            label="Colour A"
            palette={palette}
            value={element.colorA}
            onChange={(color) => onUpdate({ colorA: color } as Partial<Element>)}
          />
          <ColorPicker
            label="Colour B"
            palette={palette}
            value={element.colorB}
            onChange={(color) => onUpdate({ colorB: color } as Partial<Element>)}
          />
        </>
      ) : null}
      {element.kind === "rect" || element.kind === "frame" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width" htmlFor="element-w">
            <TextInput
              id="element-w"
              type="number"
              value={element.width}
              onChange={(event) =>
                onUpdate({ width: Number(event.target.value) } as Partial<Element>)
              }
              disabled={disabled}
            />
          </Field>
          <Field label="Height" htmlFor="element-h">
            <TextInput
              id="element-h"
              type="number"
              value={element.height}
              onChange={(event) =>
                onUpdate({ height: Number(event.target.value) } as Partial<Element>)
              }
              disabled={disabled}
            />
          </Field>
          {element.kind === "frame" ? (
            <Field label="Thickness" htmlFor="element-t">
              <TextInput
                id="element-t"
                type="number"
                value={element.thickness}
                onChange={(event) =>
                  onUpdate({ thickness: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
      <p className="font-mono text-[10px] text-muted">
        Board {board.width}×{board.height} · x/y in output pixels
      </p>
    </section>
  );
}

function ColorPicker({
  label,
  palette,
  value,
  onChange,
}: {
  label: string;
  palette: string[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <p className="font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {palette.map((hex, index) => (
          <button
            key={`${hex}-${index}`}
            type="button"
            title={`${index} ${hex}`}
            onClick={() => onChange(index)}
            className={`h-6 w-6 border-2 ${
              value === index ? "border-accent" : "border-line hover:border-line-strong"
            }`}
            style={{ background: index === 0 ? "transparent" : hex }}
          />
        ))}
      </div>
    </div>
  );
}

export function FormatPicker({
  open,
  onOpenChange,
  existing,
  onPick,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Set<string>;
  onPick: (presetId: string) => void;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a format"
      description="Native output sizes, safe areas and byte limits come from the format registry."
      width="54rem"
    >
      <Field label="Search" htmlFor="format-search">
        <TextInput
          id="format-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="LinkedIn, Reels, thumbnail…"
        />
      </Field>
      <div className="grid max-h-[60vh] gap-4 overflow-auto pr-1">
        {presetsByGroup().map((group) => {
          const items = group.presets.filter(
            (preset) =>
              query.length === 0 ||
              `${preset.label} ${preset.platform} ${preset.id}`
                .toLowerCase()
                .includes(query),
          );
          if (items.length === 0) return null;
          return (
            <section key={group.group} className="grid gap-2">
              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                {group.label}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(preset.id)}
                    className={`grid gap-1 border-2 p-2 text-left ${
                      existing.has(preset.id)
                        ? "border-line-strong bg-field"
                        : "border-line hover:border-accent"
                    } disabled:opacity-50`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-pixel-label text-ink">
                        {preset.label}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        {preset.width}×{preset.height}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      {preset.platform} · {presetAspect(preset)} ·{" "}
                      {existing.has(preset.id) ? "in kit — add variant" : "add"}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  setId,
  board,
  boards,
  checks,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setId: string;
  board: Artboard | null;
  boards: Artboard[];
  checks: Map<string, ArtboardCheck[]>;
  name: string;
}) {
  const [scope, setScope] = useState<"board" | "set">("set");
  const [format, setFormat] = useState<"png" | "jpg" | "zip">("zip");
  const effectiveFormat = scope === "set" ? "zip" : format;
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const summary = board ? summarizeChecks(checks.get(board.id) ?? []) : null;

  async function download() {
    setBusy(true);
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          scope === "board" && board
            ? { scope: "artboard", artboardId: board.id, format: effectiveFormat }
            : { scope: "set", setId, format: "zip" },
        ),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${slug(name)}-${scope === "board" && board ? `${slug(board.name)}-${board.width}x${board.height}` : "kit"}.${effectiveFormat === "jpg" ? "jpg" : effectiveFormat === "zip" ? "zip" : "png"}`;
      link.click();
      URL.revokeObjectURL(url);
      onOpenChange(false);
    } catch (reason) {
      notify({
        title: "Could not export",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export the kit"
      description={`${boards.length} formats · native dimensions · checks included in the manifest.`}
      width="36rem"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Scope" htmlFor="export-scope">
          <SelectControl
            id="export-scope"
            label="Scope"
            value={scope}
            options={[
              { value: "set", label: "Whole kit (ZIP)" },
              ...(board ? [{ value: "board", label: board.name }] : []),
            ]}
            onChange={(next) => setScope(next as "board" | "set")}
          />
        </Field>
        <Field label="Format" htmlFor="export-format">
          <SelectControl
            id="export-format"
            label="Format"
            value={effectiveFormat}
            options={scope === "set" ? ["zip"] : ["png", "jpg", "zip"]}
            onChange={(next) => setFormat(next as "png" | "jpg" | "zip")}
          />
        </Field>
      </div>
      {summary ? (
        <Callout tone={summary.errors > 0 ? "danger" : "muted"}>
          {summary.errors} errors · {summary.warnings} warnings. The export is allowed,
          but the manifest keeps every finding.
        </Callout>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={() => void download()} disabled={busy}>
          {busy ? "Rendering" : "Download"}
        </Button>
        <Button tone="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

export function PreviewDialog({
  open,
  onOpenChange,
  boards,
  presets,
  asset,
  sprites,
  selectedId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boards: Artboard[];
  presets: Map<string, FormatPreset>;
  asset: AssetDto;
  sprites: Map<string, SpriteSource>;
  selectedId?: string;
}) {
  const [activeId, setActiveId] = useState(selectedId ?? boards[0]?.id ?? "");
  useEffect(() => {
    if (selectedId) setActiveId(selectedId);
  }, [selectedId]);
  const board = boards.find((item) => item.id === activeId) ?? boards[0];
  const preset = board ? presets.get(board.presetId) : undefined;
  if (!board || !preset) return null;
  const vertical = preset.group === "vertical";
  const video = preset.group === "video";
  const cover = preset.group === "cover" || preset.group === "banner";
  const profile = preset.group === "profile";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Preview in context"
      description="Neutral platform wireframes. Simulated crops are not part of the export."
      width="60rem"
    >
      <div className="flex flex-wrap gap-1">
        {boards.map((item) => (
          <Button
            key={item.id}
            tone={item.id === activeId ? "solid" : "ghost"}
            className="px-2 py-1 text-pixel-label"
            onClick={() => setActiveId(item.id)}
          >
            {item.name}
          </Button>
        ))}
      </div>
      <div className="flex min-h-[22rem] items-center justify-center overflow-auto border-2 border-line bg-field p-4">
        {profile ? (
          <div className="grid w-full max-w-sm gap-3 border-2 border-line bg-panel p-4">
            <div className="flex items-center gap-3">
              <div className="h-24 w-24 overflow-hidden rounded-full border-2 border-line">
                <ArtboardCanvas
                  artboard={board}
                  preset={preset}
                  asset={asset}
                  sprites={sprites}
                  fit
                  showZones={false}
                />
              </div>
              <div>
                <p className="text-pixel-title text-ink">{asset.name}</p>
                <p className="font-mono text-[11px] text-muted">
                  {preset.platform} profile
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted">
              Simulated circular crop — the platform applies it on upload.
            </p>
          </div>
        ) : vertical ? (
          <div className="relative w-[min(20rem,75vw)] overflow-hidden border-2 border-line bg-screen">
            <ArtboardCanvas
              artboard={board}
              preset={preset}
              asset={asset}
              sprites={sprites}
              fit
              showZones={false}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-coffee/55" />
            <div className="pointer-events-none absolute right-2 bottom-16 grid gap-2">
              {[0, 1, 2].map((index) => (
                <span key={index} className="block h-6 w-6 border-2 border-ink/40" />
              ))}
            </div>
            <p className="pointer-events-none absolute bottom-2 left-2 font-mono text-[10px] text-ink/80">
              simulated caption + action rail
            </p>
          </div>
        ) : cover ? (
          <div className="grid w-full max-w-3xl gap-2">
            <div className="border-2 border-line bg-panel p-2">
              <div className="flex items-center gap-1 border-b-2 border-line pb-1">
                <span className="h-2 w-2 border border-line-strong" />
                <span className="h-1.5 w-16 bg-line" />
              </div>
              <div className="relative mt-2 overflow-hidden border-2 border-line bg-screen">
                <ArtboardCanvas
                  artboard={board}
                  preset={preset}
                  asset={asset}
                  sprites={sprites}
                  fit
                  showZones={false}
                />
                <div className="pointer-events-none absolute bottom-0 left-3 h-16 w-16 -translate-y-1/3 overflow-hidden rounded-full border-2 border-ink bg-field">
                  <span className="grid h-full place-items-center font-mono text-[9px] text-muted">
                    profile
                  </span>
                </div>
              </div>
            </div>
            <p className="font-mono text-[10px] text-muted">
              {preset.label} — profile overlap and mobile crop are simulated only.
            </p>
          </div>
        ) : (
          <div className="w-full max-w-2xl border-2 border-line bg-panel p-2">
            <div className="flex items-center gap-2 border-b-2 border-line pb-2">
              <span className="h-8 w-8 border-2 border-line bg-field" />
              <div className="grid gap-1">
                <span className="h-2 w-24 bg-line-strong" />
                <span className="h-1.5 w-16 bg-line" />
              </div>
            </div>
            <div className="relative mt-2 overflow-hidden border-2 border-line">
              <ArtboardCanvas
                artboard={board}
                preset={preset}
                asset={asset}
                sprites={sprites}
                fit
                showZones={false}
              />
              {video ? (
                <span className="pointer-events-none absolute right-2 bottom-2 bg-coffee/80 px-1 font-mono text-[10px] text-ink">
                  12:48
                </span>
              ) : null}
            </div>
            <p className="mt-2 font-mono text-[10px] text-muted">
              {preset.platform} feed preview · {board.width}×{board.height}
            </p>
          </div>
        )}
      </div>
      <p className="font-mono text-[10px] text-muted">
        Simulated crop — not exported. The actual file keeps the native dimensions.
      </p>
    </Dialog>
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "social"
  );
}

export default StudioScreen;

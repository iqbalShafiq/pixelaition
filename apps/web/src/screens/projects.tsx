import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Close, Logout, Search } from "../components/pixel-icons.js";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { Composer } from "../components/composer.js";
import { RunConsole } from "../components/run-console.js";
import { ConfirmTargetCard } from "../components/confirm-target-card.js";
import { LibraryGrid } from "../components/library-grid.js";
import { ProjectNav } from "../components/project-nav.js";
import { PixelLoader } from "../components/pixel-loader.js";
import { RecentRunsRail } from "../components/recent-runs-rail.js";
import { filterLibrary } from "../lib/library.js";
import {
  FLIGHT_CARD_TYPE,
  FLIGHT_SIGN_OUT_TYPE,
  FLIGHT_TYPE,
  decodeHomeReturn,
  type Door,
  markCardFlight,
  markFlight,
  navigateTyped,
  viewTransitionOption,
} from "../lib/transition.js";
import {
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "../components/interaction-card.js";
import {
  Callout,
  ConfirmDialog,
  Menu,
  MenuItem,
  SegmentedControl,
  TextInput,
  Wordmark,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { useAttachments } from "../lib/use-attachments.js";
import { useMediaQuery } from "../lib/use-media.js";
import {
  buildConfirmPayload,
  type ConfirmChoice,
  type TargetProposal,
} from "../lib/target-proposal.js";
import { applyRunEvent, type RunRow } from "../lib/run-activity.js";
import { useRejoinPacer, useRunStream } from "../lib/run-stream.js";
import { useTaskStream } from "../lib/task.js";

type Project = {
  id: string;
  name: string;
  description: string;
  summary?: string;
  updatedAt?: string;
  assetCount?: number;
};
type RecentRun = {
  id: string;
  status: string;
  prompt: string | null;
  assetId?: string;
  projectId?: string;
  createdAt: string;
  assetName?: string;
  scope?: "asset" | "workspace";
  /** A waiting run's pending card, restored without the retained stream. */
  interaction?: PendingInteraction;
};

/** Long enough to outlast the return flight, short enough to free the name. */
const RETURN_MARK_MS = 700;

/**
 * The home's account cluster. The monogram is the signed-in user's first
 * letter in a pixel square; the one destructive action lives in the menu
 * instead of loose in the bar.
 */
function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const session = authClient.useSession();
  const user = session.data?.user;
  const name = user?.name?.trim() ?? "";
  const email = user?.email ?? "";
  const label = name.length > 0 ? name : email;
  const initial = label.charAt(0).toUpperCase();
  return (
    <Menu
      label="Account"
      align="end"
      popupClassName="w-64"
      trigger={
        // No container at rest: the monogram and the name sit on the page,
        // and the chip only grows an edge on hover or while the menu is open.
        <button
          type="button"
          className="group flex min-w-0 items-center gap-2 border-2 border-transparent px-1.5 py-1 text-pixel-label transition-colors duration-150 hover:border-line hover:bg-raised data-[popup-open]:border-line-strong data-[popup-open]:bg-raised"
        >
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center border-2 border-line-strong bg-field text-pixel-mono text-accent uppercase"
          >
            {session.isPending ? "" : initial}
          </span>
          <span className="hidden max-w-[10rem] truncate text-muted group-hover:text-ink sm:block">
            {session.isPending ? "Account" : label.length > 0 ? label : "Account"}
          </span>
          <ChevronDown className="shrink-0 text-muted" />
        </button>
      }
    >
      {/* A profile card between two hairlines: who is signed in, then the one
          action. The kicker matches every other mono label in the app. */}
      <p className="px-2 pt-1 pb-2 text-pixel-mono tracking-[0.16em] text-muted uppercase">
        Account
      </p>
      <div className="flex min-w-0 items-center gap-2.5 border-y-2 border-line px-2 py-2.5">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center border-2 border-line-strong bg-field text-pixel-mono text-accent uppercase"
        >
          {session.isPending ? "" : initial}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-pixel-label text-ink">
            {label.length > 0 ? label : "Signed in"}
          </span>
          {email.length > 0 && email !== label ? (
            <span className="truncate text-pixel-mono text-muted">{email}</span>
          ) : null}
        </span>
      </div>
      <div className="pt-1">
        <MenuItem onClick={onSignOut}>
          <Logout width={12} height={12} className="shrink-0" />
          Sign out
        </MenuItem>
      </div>
    </Menu>
  );
}

/**
 * The home bar floats on the page at the top and gains its container once the
 * library scrolls under it. One passive listener, coalesced into a frame, so a
 * scroll never re-renders the page more than once per paint; the state only
 * flips at the threshold because React bails out on the same value.
 */
function usePageScrolled(threshold = 6) {
  const [scrolled, setScrolled] = useState(false);
  // A layout effect, so a restored scroll position (the editor's back move
  // passes `resetScroll: false`) paints the contained bar on the first frame
  // instead of flashing a transparent one over the library.
  useLayoutEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrolled(window.scrollY > threshold);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [threshold]);
  return scrolled;
}

export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const notify = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: Project[] }>("/api/projects"),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: async (project) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      notify({ title: "Project created", description: project.name });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not create the project",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  // The home composer runs against the same catalog and preferences the editor
  // uses, so the model and effort a run was given are never invented here.
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
  // The catalog's readable names; the composer and header print these.
  const modelNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const item of catalog.data?.models ?? []) names[item.id] = item.displayName;
    return names;
  }, [catalog.data]);
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () =>
      api<{ lastModelId: string | null; lastReasoningEffort: string | null }>(
        "/api/preferences",
      ),
  });
  const recent = useQuery({
    queryKey: ["recent-runs"],
    queryFn: () => api<{ runs: RecentRun[] }>("/api/runs/recent"),
  });
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () =>
      api<{
        assets: Array<{
          id: string;
          projectId: string;
          name: string;
          summary: string;
          width: number;
          height: number;
          updatedAt: string;
        }>;
      }>("/api/assets"),
  });

  // A visit back from the editor: the asset's thumbnail is where the canvas
  // lands, so the home names that card's picture well before its first paint
  // and brings it into view in the same frame. Both have to happen in the
  // render/commit that the view transition captures — an effect that runs
  // after the paint would leave the new snapshot without a counterpart, and
  // the canvas would simply vanish instead of shrinking into the grid.
  const returnCardAssetId = useLocation({
    select: (location) => {
      if (location.state.door !== "back") return undefined;
      return decodeHomeReturn(location.state.homeReturn);
    },
  });
  // Signed in: the brand and the library are the flying elements, so the home
  // names them in the same render the transition captures.
  const arrivedFromAuth = useLocation({
    select: (location) => location.state.door === "auth",
  });
  // The names only belong to that one flight: leaving them on would make the
  // brand and the library animate separately in the next move (the editor).
  const [authFlight, setAuthFlight] = useState(arrivedFromAuth);
  useEffect(() => {
    if (!authFlight) return;
    const timer = window.setTimeout(() => setAuthFlight(false), RETURN_MARK_MS);
    return () => window.clearTimeout(timer);
  }, [authFlight]);
  const barRef = useRef<HTMLElement | null>(null);
  const brandRef = useRef<HTMLSpanElement | null>(null);
  // The editor keeps the wordmark's label at this width, so the brand can fly
  // between the two bars; below it the editor shows only the mark, and a morph
  // would squash the label, so the bar's own cross-fade carries it instead.
  const brandMorphs = useMediaQuery("(min-width: 640px)");
  // The bar is part of the page at the very top; the container arrives with
  // the first scroll, so the wordmark floats before anything passes under it.
  const barContained = usePageScrolled();
  const libraryRef = useRef<HTMLDivElement | null>(null);
  const returnCardRef = useRef<HTMLAnchorElement | null>(null);
  // The name lives only as long as the flight: two elements with the same
  // view-transition-name abort a transition, and the next card click marks
  // its own element. `true` on the first render is what the snapshot sees.
  const [returnMarked, setReturnMarked] = useState(returnCardAssetId !== undefined);
  useEffect(() => {
    if (!returnMarked) return;
    const timer = window.setTimeout(() => setReturnMarked(false), RETURN_MARK_MS);
    return () => window.clearTimeout(timer);
  }, [returnMarked]);
  const holdReturnCard = useCallback((element: HTMLAnchorElement | null) => {
    returnCardRef.current = element;
  }, []);
  useLayoutEffect(() => {
    if (returnCardAssetId === undefined) return;
    const card = returnCardRef.current;
    if (card === null) return;
    // The home may be scrolled anywhere; the flight has to end on screen.
    card.scrollIntoView({ block: "center", behavior: "instant" });
  }, [returnCardAssetId]);
  const [prompt, setPrompt] = useState("");
  const attachments = useAttachments();
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<"recent" | "project">("recent");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [runPrompt, setRunPrompt] = useState("");
  // The proposal phase: Jev's target, held until the user confirms.
  const [proposal, setProposal] = useState<{
    proposalId: string;
    proposal: TargetProposal;
    /** The request this proposal answered, for a suggested new-asset name. */
    prompt: string;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(
    null,
  );
  // A task stream's card belongs to a child run. Responding to the task id
  // itself is a 404; this is the child the event named.
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  // The ids this session already answered, so a replayed interaction event
  // cannot bring an answered card back before its resolved marker arrives.
  const answeredIdsRef = useRef<Set<string>>(new Set());
  // One rejoin attempt per mount: a refresh must not strand a workspace run
  // that is still going or waiting for an answer.
  const rejoinedRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  // Set when a run will bind its asset mid-flight; the asset-created event
  // then assembles into the editor exactly once.
  const pendingAutoNavRef = useRef(false);
  const { sourceRef, open: openStream, close: closeStream } = useRunStream();
  const taskStream = useTaskStream();
  const { pace: paceRejoin, reset: resetRejoin, cancel: cancelRejoin } = useRejoinPacer();
  const running = runId !== null;
  // Optimistic overlays: the composer and console react the moment the user
  // acts, and each overlay reverts by itself when the action fails.
  const [optimisticStart, setOptimisticStart] = useOptimistic<string | null>(null);
  const [optimisticStopping, setOptimisticStopping] = useOptimistic(false);

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

  const log = useCallback((text: string) => {
    setRows((current) => [
      ...current.slice(-120),
      { id: crypto.randomUUID(), kind: "status", label: text, state: "running" },
    ]);
  }, []);

  /** The typed view transition: the dock, console, and target card assemble
   *  into the editor's canvas, console, and composer. A card opened from the
   *  library sends the card itself instead. */
  const navigateToEditor = useCallback(
    (projectId: string, assetId: string, from: { card?: Element | null } = {}) => {
      const card = from.card ?? null;
      const marks: Array<[Element | null, "composer" | "console" | "asset" | "brand"]> =
        card !== null
          ? [[card, "asset"]]
          : [
              [composerRef.current, "composer"],
              [consoleRef.current, "console"],
              [targetRef.current, "asset"],
            ];
      // The brand rides the same move so the wordmark glides between the two
      // bars instead of cross-fading at two different x positions.
      if (brandMorphs) marks.push([brandRef.current, "brand"]);
      for (const [element, name] of marks) markFlight([element], true, name);
      // The door rides the history state as well, so a plain navigation (a
      // browser without the API) still tells the editor where the visit began.
      const door: Door = card !== null ? "card" : "plan";
      const state = { door };
      void navigate({
        to: "/projects/$projectId/assets/$assetId",
        params: { projectId, assetId },
        state,
        viewTransition: viewTransitionOption(
          undefined,
          card !== null ? FLIGHT_CARD_TYPE : FLIGHT_TYPE,
        ),
      }).catch(() => {
        // A transition the browser aborted (hidden tab, another transition)
        // must not strand the user on the home; navigate plainly.
        void navigate({
          to: "/projects/$projectId/assets/$assetId",
          params: { projectId, assetId },
          state,
        });
      });
      // Clearing during the transition aborts it; the home unmounts on a
      // successful navigation, so this only tidies a failed one.
      window.setTimeout(() => {
        for (const [element] of marks) markFlight([element], false);
      }, 600);
    },
    [brandMorphs, navigate],
  );

  /** A library card: the card itself flies into the canvas. */
  const openAsset = useCallback(
    (asset: { id: string; projectId: string }, card: Element | null) => {
      markCardFlight(card);
      navigateToEditor(asset.projectId, asset.id, { card });
    },
    [navigateToEditor],
  );

  const listen = useCallback(
    (id: string) => {
      openStream(id, {
        onMessage: (body) => {
          resetRejoin();
          setRows((current) =>
            applyRunEvent(current, body.sequence, body.type, body.data),
          );
          if (
            (body.type === "asset-created" || body.type === "asset-bound") &&
            pendingAutoNavRef.current
          ) {
            const data = body.data as { assetId?: string; projectId?: string };
            if (typeof data.assetId === "string" && typeof data.projectId === "string") {
              pendingAutoNavRef.current = false;
              navigateToEditor(data.projectId, data.assetId);
            }
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
            // so it is visible even if the user had collapsed it.
            const data = body.data as PendingInteraction;
            if (!answeredIdsRef.current.has(data.id)) {
              setPendingInteraction(data);
              setConsoleOpen(true);
            }
            return;
          }
          if (body.type === "interaction-resolved") {
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
            setRunId(null);
            void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            return;
          }
        },
        onDrop: () => {
          // A dropped stream does not mean the run stopped: ask the run list.
          // A still-active run rejoins from the top, paced so an unreachable
          // worker cannot spin the console; a finished one closes.
          void api<{ runs: RecentRun[] }>("/api/runs/recent")
            .catch(() => null)
            .then((result) => {
              if (sourceRef.current) return;
              const row = result?.runs.find((item) => item.id === id);
              if (row && ["queued", "running", "waiting"].includes(row.status)) {
                const firstDrop = paceRejoin(() => listen(id));
                if (firstDrop) log("The stream dropped; rejoining the running agent");
                return;
              }
              setRunId(null);
              setPendingInteraction(null);
              log("The activity stream closed");
              void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
            });
        },
      });
    },
    [
      cancelRejoin,
      closeStream,
      log,
      openStream,
      paceRejoin,
      queryClient,
      resetRejoin,
      sourceRef,
    ],
  );

  // A home refresh must not strand a workspace run: on the first load of the
  // run list, rejoin the newest non-terminal workspace run — reattach its
  // stream and restore its pending card when it is waiting for an answer.
  useEffect(() => {
    if (rejoinedRef.current || !recent.data) return;
    rejoinedRef.current = true;
    if (runId !== null) return;
    const candidate = recent.data.runs.find(
      (item) =>
        item.scope === "workspace" &&
        ["queued", "running", "waiting"].includes(item.status),
    );
    if (!candidate) return;
    setRunId(candidate.id);
    setRunPrompt(candidate.prompt ?? "");
    setConsoleOpen(true);
    setPendingInteraction(candidate.interaction ?? null);
    setPendingRunId(candidate.id);
    log(`Rejoined run ${candidate.id.slice(0, 8)}`);
    listen(candidate.id);
    // The asset already exists: the plan card lives on the editor, and a
    // refresh must not leave it behind an idle home.
    if (candidate.assetId && candidate.projectId) {
      const projectId = candidate.projectId;
      const assetId = candidate.assetId;
      window.setTimeout(() => navigateToEditor(projectId, assetId), 0);
    }
  }, [recent.data, runId, listen, log, navigateToEditor]);

  const list = projects.data?.projects ?? [];
  useEffect(() => {
    if (projectId === null || !projects.isSuccess) return;
    if (!list.some((project) => project.id === projectId)) setProjectId(null);
  }, [list, projectId, projects.isSuccess]);
  const projectNames = Object.fromEntries(
    list.map((project) => [project.id, project.name]),
  );
  const assetRows = assets.data?.assets ?? [];
  const counts = assetRows.reduce<Record<string, number>>((map, asset) => {
    map[asset.projectId] = (map[asset.projectId] ?? 0) + 1;
    return map;
  }, {});
  const library = filterLibrary({
    projects: list.map((project) => ({
      id: project.id,
      name: project.name,
      summary: project.summary ?? "",
      updatedAt: project.updatedAt ?? "",
    })),
    assets: assetRows,
    query: search,
    group,
    ...(projectId !== null ? { projectId } : {}),
  });
  // Deleting names what goes with it; the API refuses while a run is live.
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "asset" | "project";
    id: string;
    name: string;
    assets: number;
  } | null>(null);
  const removeAsset = useMutation({
    mutationFn: (assetId: string) =>
      api<{ ok: boolean }>(`/api/assets/${assetId}`, { method: "DELETE" }),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
    },
    onError: (reason: unknown) => {
      setPendingDelete(null);
      notify({
        title: "Could not delete the asset",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    },
  });
  const removeProject = useMutation({
    mutationFn: (projectId: string) =>
      api<{ ok: boolean }>(`/api/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
    },
    onError: (reason: unknown) => {
      setPendingDelete(null);
      notify({
        title: "Could not delete the project",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    },
  });
  const newAsset = useMutation({
    mutationFn: (projectId: string) =>
      api<{ id: string }>(`/api/projects/${projectId}/assets`, {
        method: "POST",
        body: JSON.stringify({ name: "Untitled" }),
      }),
    onSuccess: async (asset, projectId) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      void navigate({
        to: "/projects/$projectId/assets/$assetId",
        params: { projectId, assetId: asset.id },
      });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not create an asset",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });
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
      ? `${selectedModel.id} cannot read attached images — pick a vision model or remove them.`
      : undefined;
  // The card needs a target before a run exists; an empty library is fine
  // because the card can create the first project.
  const blockedReason = projects.isPending
    ? "your projects are still loading"
    : projects.isError
      ? "your projects could not be loaded"
      : undefined;

  function generate() {
    if (running || proposal !== null) return;
    const text = prompt.trim();
    if (text.length === 0) return;
    const staged = attachments.items;
    // Urgent updates: the console reacts before any await.
    setError(null);
    setMessage("");
    setRows([]);
    setConsoleOpen(true);
    setRunPrompt(text);
    setPrompt("");
    startTransition(async () => {
      // Optimistic "starting…" until the run exists; a failure reverts it and
      // hands the prompt back.
      setOptimisticStart(text);
      try {
        await api("/api/preferences", {
          method: "PATCH",
          body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
        });
        // Phase A: Jev proposes a target; no run exists until the confirm.
        const proposed = await api<{ proposalId: string; proposal: TargetProposal }>(
          "/api/home/runs",
          {
            method: "POST",
            body: JSON.stringify({
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
          },
        );
        setProposal({ ...proposed, prompt: text });
      } catch (reason) {
        setPrompt(text);
        const message = reason instanceof Error ? reason.message : "Generation failed.";
        setError(message);
        notify({ title: "Could not start the run", description: message });
      } finally {
        setOptimisticStart(null);
      }
    });
  }

  function confirm(choice: ConfirmChoice) {
    if (proposal === null || confirming) return;
    const staged = attachments.items;
    setConfirming(true);
    startTransition(async () => {
      try {
        const payload = buildConfirmPayload(proposal.proposalId, choice);
        const started = await api<{
          runId: string;
          kind?: "task" | "run";
          assetId?: string | null;
          projectId?: string | null;
        }>("/api/home/runs", {
          method: "POST",
          body: JSON.stringify({
            prompt: runPrompt,
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
            ...payload,
          }),
        });
        if (staged.length > 0) attachments.clear();
        setProposal(null);
        setRunId(started.runId);
        // A new run needs the plan card in view and its asset known: keep the
        // console open and follow the stream until the editor can take over.
        setConsoleOpen(true);
        void queryClient.invalidateQueries({ queryKey: ["assets"] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
        let heading = false;
        const openEditor = (projectId: string, assetId: string) => {
          if (heading || projectId.length === 0 || assetId.length === 0) return;
          heading = true;
          pendingAutoNavRef.current = false;
          // After the state updates above, so a view transition is not aborted
          // by the same turn that started the run.
          window.setTimeout(() => navigateToEditor(projectId, assetId), 0);
        };
        const responseAsset = typeof started.assetId === "string" ? started.assetId : "";
        const responseProject =
          typeof started.projectId === "string" ? started.projectId : "";
        const knownProject =
          responseProject.length > 0
            ? responseProject
            : choice.projectId !== "new"
              ? choice.projectId
              : "";
        if (responseAsset.length > 0) openEditor(knownProject, responseAsset);
        if (!heading && choice.assetName !== undefined && choice.assetName.length > 0) {
          // The named asset is created with the confirmation. Read the list
          // itself; the render's copy never sees the row this call just made.
          const bornName = choice.assetName;
          const bornPoll = window.setInterval(() => {
            void queryClient
              .fetchQuery({
                queryKey: ["assets"],
                queryFn: () =>
                  api<{
                    assets: Array<{ id: string; name: string; projectId: string }>;
                  }>("/api/assets"),
              })
              .then((result) => {
                const born = result.assets.find((item) => item.name === bornName);
                if (born === undefined) return;
                window.clearInterval(bornPoll);
                openEditor(born.projectId, born.id);
              })
              .catch(() => undefined);
          }, 1500);
          window.setTimeout(() => window.clearInterval(bornPoll), 5 * 60 * 1000);
        }
        log(`Run ${started.runId.slice(0, 8)} started`);
        const pinnedAsset =
          choice.mode === "generate" &&
          choice.assetId !== undefined &&
          choice.assetId !== null &&
          choice.assetId !== "new"
            ? choice.assetId
            : undefined;
        if (pinnedAsset !== undefined) {
          const asset = (assets.data?.assets ?? []).find(
            (item) => item.id === pinnedAsset,
          );
          const projectForAsset = asset?.projectId ?? knownProject;
          setRows((current) =>
            applyRunEvent(current, Date.now(), "asset-created", {
              assetId: pinnedAsset,
              projectId: projectForAsset,
              name: asset?.name ?? "asset",
            }),
          );
          openEditor(projectForAsset, pinnedAsset);
        }
        if (!heading) pendingAutoNavRef.current = true;
        if (started.kind === "task") {
          // The task stream carries the tree, the plan card, and the asset
          // the supervisor binds. A dropped stream is not a stopped task.
          let finished = false;
          let rejoins = 0;
          const openTaskStream = () => {
            taskStream.open(started.runId, {
              onMessage: (body) => {
                setRows((current) =>
                  applyRunEvent(current, body.sequence, body.type, body.data),
                );
                if (body.type === "interaction") {
                  const data = body.data as PendingInteraction & { runId?: string };
                  if (
                    typeof data.id === "string" &&
                    !answeredIdsRef.current.has(data.id)
                  ) {
                    setPendingInteraction(data);
                    if (typeof data.runId === "string") setPendingRunId(data.runId);
                    setConsoleOpen(true);
                  }
                  return;
                }
                if (body.type === "interaction-resolved") {
                  const data = body.data as { id?: string };
                  if (typeof data.id === "string") {
                    answeredIdsRef.current.add(data.id);
                    setPendingInteraction((current) =>
                      current?.id === data.id ? null : current,
                    );
                  }
                  return;
                }
                if (body.type === "asset-created" || body.type === "asset-bound") {
                  const data = body.data as { assetId?: string; projectId?: string };
                  void queryClient.invalidateQueries({ queryKey: ["assets"] });
                  void queryClient.invalidateQueries({ queryKey: ["projects"] });
                  if (
                    pendingAutoNavRef.current &&
                    typeof data.assetId === "string" &&
                    typeof data.projectId === "string"
                  ) {
                    openEditor(data.projectId, data.assetId);
                  }
                  return;
                }
                if (body.type === "task-complete" || body.type === "done")
                  finished = true;
                if (body.type === "task-complete") {
                  taskStream.close();
                  setRunId(null);
                  setPendingInteraction(null);
                  setPendingRunId(null);
                  void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
                  void queryClient.invalidateQueries({ queryKey: ["assets"] });
                  void queryClient.invalidateQueries({ queryKey: ["projects"] });
                }
              },
              onDrop: () => {
                if (finished || rejoins >= 20) {
                  taskStream.close();
                  return;
                }
                rejoins += 1;
                window.setTimeout(() => {
                  if (!finished) openTaskStream();
                }, 1500);
              },
            });
          };
          openTaskStream();
        } else {
          listen(started.runId);
          setPendingRunId(started.runId);
        }
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "The run could not start.";
        setError(message);
        notify({ title: "Could not start the run", description: message });
      } finally {
        setConfirming(false);
      }
    });
  }

  function stop() {
    if (!runId || optimisticStopping) return;
    startTransition(async () => {
      // The button says "Stopping…" immediately; a refused cancel reverts it.
      setOptimisticStopping(true);
      try {
        await Promise.all([
          api(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined),
          api(`/api/tasks/${runId}/cancel`, { method: "POST" }).catch(() => undefined),
        ]);
        log("Stopped; waiting for the agent to acknowledge");
        // The stream stays open: the worker's cancelled status and done event
        // clear the run state.
      } catch (reason) {
        notify({
          title: "Could not stop the run",
          description: reason instanceof Error ? reason.message : "Unknown error",
        });
      }
    });
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
      answeredIdsRef.current.add(pendingInteraction.id);
      setPendingInteraction(null);
      setPendingRunId(null);
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

  function focusComposer() {
    composerRef.current?.querySelector("textarea")?.focus();
  }

  const navProps = {
    projects: list.map((project) => ({ id: project.id, name: project.name })),
    counts,
    activeId: projectId,
    onSelect: setProjectId,
    name,
    onName: setName,
    onCreate: () => create.mutate(),
    creating: create.isPending,
  };

  /**
   * Signing out leaves the way signing in arrived: the bar and the library
   * drop away as the signed-out page arrives. The names go on before the
   * transition snapshots the page, and the navigation is in-app — a full
   * reload would throw the move away.
   */
  const signOut = useCallback(async () => {
    // The bar carries its flight name statically now (the home and the editor
    // share it). The library and the brand are marked for this move: the brand
    // is the same shared element as the signed-out page's, so it morphs out of
    // the bar instead of dissolving with it.
    markFlight([libraryRef.current], true, "library");
    markFlight([brandRef.current], true, "brand");
    try {
      await authClient.signOut();
    } catch (reason) {
      markFlight([libraryRef.current], false, "library");
      markFlight([brandRef.current], false, "brand");
      notify({
        title: "Could not sign out",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
      return;
    }
    await navigateTyped(
      (options) => navigate({ to: "/login", ...options }),
      FLIGHT_SIGN_OUT_TYPE,
      () => navigate({ to: "/login" }),
    ).finally(() => {
      markFlight([libraryRef.current], false, "library");
      markFlight([brandRef.current], false, "brand");
      // The next session starts from an empty cache, not the last one's.
      queryClient.clear();
    });
  }, [navigate, notify, queryClient]);

  return (
    <main id="content" className="min-h-dvh bg-paper">
      <header
        ref={barRef}
        data-flight="bar"
        data-contained={barContained ? "" : undefined}
        className={`sticky top-0 z-20 border-b-2 transition-colors duration-200 ease-out ${
          barContained ? "border-line bg-panel" : "border-transparent bg-transparent"
        }`}
      >
        {/* The bar's content shares the page's container, so the wordmark and
            the account cluster sit on the same rails as the columns below. */}
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-3 px-4">
          {/* The brand is named only while a move is in flight: the editor's
              wordmark carries the same name, so the two glide into each other
              instead of cross-fading at two different x positions. Signing in
              names it too, because the signed-out wordmark is the same element
              arriving from the auth slide. */}
          <span
            ref={brandRef}
            className="flex shrink-0 items-center"
            {...(authFlight || (returnMarked && brandMorphs)
              ? { "data-flight": "brand" }
              : {})}
          >
            <Wordmark />
          </span>
          <span data-flight="bar-account" className="flex min-w-0 items-center">
            <AccountMenu onSignOut={() => void signOut()} />
          </span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 pb-80 lg:flex-row lg:items-start">
        <aside className="hidden w-60 shrink-0 lg:sticky lg:top-20 lg:block lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto">
          <ProjectNav {...navProps} layout="rail" />
        </aside>

        <div
          ref={libraryRef}
          className="grid min-w-0 flex-1 gap-4"
          {...(authFlight ? { "data-flight": "library" } : {})}
        >
          <div className="lg:hidden">
            <ProjectNav {...navProps} layout="strip" />
          </div>
          <div className="grid gap-3 border-b-2 border-line pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h1 className="text-pixel-title text-ink">Library</h1>
              <span className="text-pixel-mono text-muted">
                {library.assets.length.toString().padStart(2, "0")} assets
              </span>
            </div>
            <p className="text-pixel-label text-muted">
              Describe a sprite in the composer, or open one from the grid.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden
                  width={12}
                  height={12}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
                />
                <TextInput
                  value={search}
                  aria-label="Search projects and assets"
                  placeholder="Search projects and assets…"
                  className="pl-7"
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search.length > 0 ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 place-items-center text-muted transition-colors duration-150 hover:text-ink"
                    onClick={() => setSearch("")}
                  >
                    <Close width={12} height={12} />
                  </button>
                ) : null}
              </div>
              <SegmentedControl
                label="Library grouping"
                value={group}
                options={[
                  { value: "recent", label: "Recent" },
                  { value: "project", label: "By project" },
                ]}
                onChange={setGroup}
              />
            </div>
          </div>
          {projects.isPending || assets.isPending ? (
            <p className="flex items-center gap-2 text-pixel-mono text-muted">
              <PixelLoader size={12} />
              Reading your library…
            </p>
          ) : projects.isError || assets.isError ? (
            <Callout tone="danger">The library could not be loaded.</Callout>
          ) : (
            <LibraryGrid
              result={library}
              group={group}
              projectNames={projectNames}
              onOpen={openAsset}
              {...(returnMarked && returnCardAssetId !== undefined
                ? { returnCardId: returnCardAssetId, returnCardRef: holdReturnCard }
                : {})}
              onNewAsset={(id) => newAsset.mutate(id)}
              onDeleteAsset={(asset) =>
                setPendingDelete({
                  kind: "asset",
                  id: asset.id,
                  name: asset.name,
                  assets: 0,
                })
              }
              onDeleteProject={(project) =>
                setPendingDelete({
                  kind: "project",
                  id: project.id,
                  name: project.name,
                  assets: project.assets,
                })
              }
            />
          )}
        </div>
        <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:w-72">
          <RecentRunsRail runs={recent.data?.runs ?? []} />
        </aside>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete === null ? "" : `Delete “${pendingDelete.name}”?`}
        description={
          pendingDelete === null
            ? ""
            : pendingDelete.kind === "asset"
              ? "Its frames, versions, and run history go with it. This cannot be undone."
              : `The project and its ${pendingDelete.assets} asset${
                  pendingDelete.assets === 1 ? "" : "s"
                } — with their frames, versions, and run history — go with it. This cannot be undone.`
        }
        onConfirm={() => {
          if (pendingDelete === null) return;
          if (pendingDelete.kind === "asset") removeAsset.mutate(pendingDelete.id);
          else removeProject.mutate(pendingDelete.id);
        }}
      />

      {/* The dock: the same composer as the editor, fixed at the bottom
          centre with the console and the confirmation card stacked above it. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center p-3">
        <div
          ref={composerRef}
          className="pointer-events-auto grid w-full gap-2"
          style={{ maxWidth: "40rem" }}
        >
          {proposal !== null ? (
            <div ref={targetRef} className="grid gap-2">
              <ConfirmTargetCard
                onRetryLists={() => {
                  void projects.refetch();
                  void assets.refetch();
                }}
                proposal={proposal.proposal}
                request={proposal.prompt}
                projects={list.map((project) => ({
                  id: project.id,
                  name: project.name,
                  summary: project.summary ?? "",
                }))}
                assets={assets.data?.assets ?? []}
                busy={confirming}
                onConfirm={confirm}
                onCancel={() => setProposal(null)}
              />
            </div>
          ) : null}
          <div ref={consoleRef} className="grid gap-2">
            <RunConsole
              rows={rows}
              running={running || optimisticStart !== null}
              open={consoleOpen}
              onOpen={setConsoleOpen}
              message={message || (error ?? "")}
              prompt={runPrompt}
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
              interaction={pendingInteraction}
              frames={[]}
              palette={[]}
              projects={list.map((project) => ({
                id: project.id,
                name: project.name,
              }))}
              assets={(assets.data?.assets ?? []).map((asset) => ({
                id: asset.id,
                projectId: asset.projectId,
                name: asset.name,
              }))}
              onRespond={respondToInteraction}
              onEscape={focusComposer}
            />
          </div>
          <Composer
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
            onGenerate={generate}
            onStop={stop}
            blockedReason={blockedReason}
            attachments={attachments.items}
            attachmentError={attachments.error}
            attachmentIssue={attachmentIssue}
            onAttach={attachments.add}
            onRemoveAttachment={attachments.remove}
          />
        </div>
      </div>
    </main>
  );
}

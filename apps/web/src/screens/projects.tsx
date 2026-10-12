import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "../components/pixel-icons.js";
import {
  startTransition,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { Composer } from "../components/composer.js";
import { RunConsole } from "../components/run-console.js";
import { ConfirmTargetCard } from "../components/confirm-target-card.js";
import { LibraryGrid } from "../components/library-grid.js";
import { RecentRunsRail } from "../components/recent-runs-rail.js";
import { filterLibrary } from "../lib/library.js";
import { markFlight, viewTransitionOption } from "../lib/transition.js";
import {
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "../components/interaction-card.js";
import {
  Button,
  Callout,
  Card,
  Field,
  PixelMark,
  TextInput,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { useAttachments } from "../lib/use-attachments.js";
import {
  buildConfirmPayload,
  type ConfirmChoice,
  type TargetProposal,
} from "../lib/target-proposal.js";
import { applyRunEvent, type RunRow } from "../lib/run-activity.js";
import { useRejoinPacer, useRunStream } from "../lib/run-stream.js";

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
        models: Array<{ id: string; efforts: string[]; vision: boolean }>;
        modelReady: boolean;
      }>("/api/models"),
  });
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

  const [prompt, setPrompt] = useState("");
  const attachments = useAttachments();
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<"recent" | "project">("recent");
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
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(
    null,
  );
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
   *  into the editor's canvas, console, and composer. */
  const navigateToEditor = useCallback(
    (projectId: string, assetId: string) => {
      const marks: Array<[Element | null, "composer" | "console" | "asset"]> = [
        [composerRef.current, "composer"],
        [consoleRef.current, "console"],
        [targetRef.current, "asset"],
      ];
      for (const [element, name] of marks) markFlight([element], true, name);
      void navigate({
        to: "/projects/$projectId/assets/$assetId",
        params: { projectId, assetId },
        viewTransition: viewTransitionOption(),
      });
      // Clearing during the transition aborts it; the home unmounts on a
      // successful navigation, so this only tidies a failed one.
      window.setTimeout(() => {
        for (const [element] of marks) markFlight([element], false);
      }, 600);
    },
    [navigate],
  );

  const listen = useCallback(
    (id: string) => {
      openStream(id, {
        onMessage: (body) => {
          resetRejoin();
          setRows((current) =>
            applyRunEvent(current, body.sequence, body.type, body.data),
          );
          if (body.type === "asset-created" && pendingAutoNavRef.current) {
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
    log(`Rejoined run ${candidate.id.slice(0, 8)}`);
    listen(candidate.id);
  }, [recent.data, runId, listen, log]);

  const list = projects.data?.projects ?? [];
  const projectNames = Object.fromEntries(
    list.map((project) => [project.id, project.name]),
  );
  const library = filterLibrary({
    projects: list.map((project) => ({
      id: project.id,
      name: project.name,
      summary: project.summary ?? "",
      updatedAt: project.updatedAt ?? "",
    })),
    assets: assets.data?.assets ?? [],
    query: search,
    group,
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
    selectedModel.vision !== true
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
        setProposal(proposed);
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
        const started = await api<{ runId: string }>("/api/home/runs", {
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
        log(`Run ${started.runId.slice(0, 8)} started`);
        listen(started.runId);
        const pinnedAsset =
          choice.mode === "generate" &&
          choice.assetId !== undefined &&
          choice.assetId !== null &&
          choice.assetId !== "new"
            ? choice.assetId
            : undefined;
        if (pinnedAsset !== undefined) {
          // Show the binding as the console's last row, then assemble.
          const asset = (assets.data?.assets ?? []).find(
            (item) => item.id === pinnedAsset,
          );
          setRows((current) =>
            applyRunEvent(current, Date.now(), "asset-created", {
              assetId: pinnedAsset,
              projectId: asset?.projectId ?? choice.projectId,
              name: asset?.name ?? "asset",
            }),
          );
          navigateToEditor(asset?.projectId ?? choice.projectId, pinnedAsset);
        } else {
          // The agent binds mid-run; the asset-created event navigates.
          pendingAutoNavRef.current = true;
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
        await api(`/api/runs/${runId}/cancel`, { method: "POST" });
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

  function focusComposer() {
    composerRef.current?.querySelector("textarea")?.focus();
  }

  return (
    <main id="content" className="pixel-grid-lg min-h-dvh bg-paper">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-8 pb-48">
        <header className="flex items-center justify-between gap-4 border-b-2 border-line pb-4">
          <span className="flex items-center gap-2.5">
            <PixelMark />
            <span className="text-pixel-display text-accent">PIXELAITION</span>
          </span>
          <Button
            tone="ghost"
            className="px-3 py-1.5 text-[12px]"
            onClick={() => {
              void authClient.signOut().then(() => window.location.assign("/login"));
            }}
          >
            Sign out
          </Button>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1fr_24rem] lg:items-start">
          <div className="grid gap-5">
            <div>
              <p className="text-pixel-mono tracking-[0.2em] text-muted uppercase">
                Workspace
              </p>
              <h1 className="mt-3 text-pixel-hero text-ink text-balance">
                Your sprite families
              </h1>
              <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">
                Describe a sprite and the agent finds it a home, or draw one by hand from
                a project below. One project keeps one palette and one style guide, so
                every asset inside it stays recognisably related.
              </p>
            </div>
          </div>

          <Card className="grid gap-3">
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <Field label="New project" htmlFor="project-name">
                <TextInput
                  id="project-name"
                  value={name}
                  placeholder="Knights, potions, dungeon tiles…"
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={!name.trim() || create.isPending}
                className="w-full"
              >
                {create.isPending ? "Creating" : "Create project"}
                <ArrowRight />
              </Button>
            </form>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3 border-b-2 border-line pb-2">
              <h2 className="text-pixel-title text-muted">Library</h2>
              <span className="text-pixel-mono text-muted">
                {library.assets.length.toString().padStart(2, "0")}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <TextInput
                  value={search}
                  aria-label="Search projects and assets"
                  placeholder="Search projects and assets…"
                  className="max-w-[16rem]"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="flex items-center gap-1">
                  {(["recent", "project"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={group === value}
                      className={
                        group === value
                          ? "pixel-corners-sm border-2 border-accent bg-accent/15 px-2.5 py-1.5 text-xs text-accent"
                          : "pixel-corners-sm border-2 border-line px-2.5 py-1.5 text-xs text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
                      }
                      onClick={() => setGroup(value)}
                    >
                      {value === "recent" ? "Recent" : "By project"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {projects.isPending || assets.isPending ? (
              <p className="text-pixel-mono text-muted">Reading your library…</p>
            ) : projects.isError || assets.isError ? (
              <Callout tone="danger">The library could not be loaded.</Callout>
            ) : (
              <LibraryGrid
                result={library}
                group={group}
                projectNames={projectNames}
                onNewAsset={(projectId) => newAsset.mutate(projectId)}
              />
            )}
          </div>
          <div className="grid gap-4">
            <RecentRunsRail runs={recent.data?.runs ?? []} />
          </div>
        </section>
      </div>

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
                proposal={proposal.proposal}
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Folder, Plus } from "../components/pixel-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { SpriteThumb } from "../components/sprite-thumb.js";
import { Composer } from "../components/composer.js";
import { RunConsole } from "../components/run-console.js";
import {
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "../components/interaction-card.js";
import {
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  PixelMark,
  SelectControl,
  TextInput,
  motionToken,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";
import { applyRunEvent, type RunRow } from "../lib/run-activity.js";
import { useRunStream } from "../lib/run-stream.js";

type Project = { id: string; name: string; description: string };
type Asset = { id: string; name: string; width: number; height: number };
type RecentRun = {
  id: string;
  status: string;
  prompt: string | null;
  assetId?: string;
  projectId?: string;
  createdAt: string;
  assetName?: string;
};

export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const notify = useToast();
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
        models: Array<{ id: string; efforts: string[] }>;
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

  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("medium");
  const [pickedProjectId, setPickedProjectId] = useState("");
  const [rows, setRows] = useState<RunRow[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [runPrompt, setRunPrompt] = useState("");
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(
    null,
  );
  // The ids this session already answered, so a replayed interaction event
  // cannot bring an answered card back before its resolved marker arrives.
  const answeredIdsRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLDivElement>(null);
  const { sourceRef, open: openStream, close: closeStream } = useRunStream();
  const running = runId !== null;

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

  const listen = useCallback(
    (id: string) => {
      openStream(id, {
        onMessage: (body) => {
          setRows((current) =>
            applyRunEvent(current, body.sequence, body.type, body.data),
          );
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
                : (data.error ?? `The run ${data.status ?? "finished"}.`),
            );
            setPendingInteraction(null);
            closeStream();
            setRunId(null);
            void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            return;
          }
        },
        onDrop: () => {
          // A dropped stream does not mean the run stopped: ask the run list.
          // A still-active run rejoins from the top; a finished one closes.
          void api<{ runs: RecentRun[] }>("/api/runs/recent")
            .catch(() => null)
            .then((result) => {
              if (sourceRef.current) return;
              const row = result?.runs.find((item) => item.id === id);
              if (row && ["queued", "running", "waiting"].includes(row.status)) {
                log("The stream dropped; rejoining the running agent");
                listen(id);
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
    [closeStream, log, openStream, queryClient, sourceRef],
  );

  const list = projects.data?.projects ?? [];
  const projectId = list.some((project) => project.id === pickedProjectId)
    ? pickedProjectId
    : (list[0]?.id ?? "");
  const models = catalog.data?.models.map((item) => item.id) ?? [];
  const efforts = catalog.data?.models.find((item) => item.id === modelId)?.efforts ?? [];
  // A workspace run belongs to one project; without one the composer names the
  // cause instead of starting a run against a guessed home.
  const blockedReason = projects.isPending
    ? "your projects are still loading"
    : projects.isError
      ? "your projects could not be loaded"
      : list.length === 0
        ? "a workspace run needs a project — create one first"
        : undefined;

  async function generate() {
    if (running || !projectId) return;
    setError(null);
    setMessage("");
    setRows([]);
    setConsoleOpen(true);
    setRunPrompt(prompt);
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: JSON.stringify({ lastModelId: modelId, lastReasoningEffort: effort }),
      });
      const started = await api<{ runId: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          scope: "workspace",
          projectId,
          prompt,
          modelId,
          reasoningEffort: effort,
        }),
      });
      setRunId(started.runId);
      log(`Run ${started.runId.slice(0, 8)} started`);
      listen(started.runId);
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
      // clear the run state.
    } catch (reason) {
      notify({
        title: "Could not stop the run",
        description: reason instanceof Error ? reason.message : "Unknown error",
      });
    }
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
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-8">
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

            <div ref={composerRef} className="grid gap-2">
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
                scope={
                  <SelectControl
                    label="Project"
                    value={projectId}
                    options={list.map((project) => ({
                      value: project.id,
                      label: project.name,
                    }))}
                    onChange={setPickedProjectId}
                    placeholder="no projects"
                    className="max-w-[12rem]"
                  />
                }
                blockedReason={blockedReason}
              />
              <RunConsole
                rows={rows}
                running={running}
                open={consoleOpen}
                onOpen={setConsoleOpen}
                message={message || (error ?? "")}
                prompt={runPrompt}
                interaction={pendingInteraction}
                frames={[]}
                palette={[]}
                onRespond={respondToInteraction}
                onEscape={focusComposer}
              />
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

        <section className="grid gap-4">
          <div className="flex items-baseline justify-between gap-4 border-b-2 border-line pb-2">
            <h2 className="text-pixel-title text-muted">Recent runs</h2>
            <span className="text-pixel-mono text-muted">
              {(recent.data?.runs.length ?? 0).toString().padStart(2, "0")}
            </span>
          </div>

          {recent.isPending ? (
            <p className="text-pixel-mono text-muted">
              Reading your recent runs from the server…
            </p>
          ) : recent.isError ? (
            <Callout tone="danger">
              {recent.error instanceof Error
                ? recent.error.message
                : "The recent runs could not be loaded."}
            </Callout>
          ) : (recent.data?.runs.length ?? 0) === 0 ? (
            <EmptyState
              title="No runs yet"
              body="Describe a sprite above and the agent's work will show up here."
            />
          ) : (
            <ul className="grid gap-2">
              {recent.data?.runs.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-2 border-line bg-raised px-3 py-2"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] text-ink"
                    title={run.prompt ?? ""}
                  >
                    {run.prompt ?? "—"}
                  </span>
                  <span className={`text-pixel-mono ${runStatusTone(run.status)}`}>
                    {run.status}
                  </span>
                  <span className="text-pixel-mono text-muted">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                  {run.assetId && run.projectId ? (
                    <Link
                      to="/projects/$projectId/assets/$assetId"
                      params={{ projectId: run.projectId, assetId: run.assetId }}
                      className="text-pixel-mono text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      Open {run.assetName ?? "asset"}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-4">
          <div className="flex items-baseline justify-between gap-4 border-b-2 border-line pb-2">
            <h2 className="text-pixel-title text-muted">Projects</h2>
            <span className="text-pixel-mono text-muted">
              {list.length.toString().padStart(2, "0")}
            </span>
          </div>

          {projects.isPending ? (
            <p className="text-pixel-mono text-muted">
              Reading your projects from the server…
            </p>
          ) : projects.isError ? (
            <Callout tone="danger">
              {projects.error instanceof Error
                ? projects.error.message
                : "The project list could not be loaded."}
            </Callout>
          ) : list.length === 0 ? (
            <EmptyState
              title="No projects yet"
              body="Create one above. Every asset inside it inherits the same palette and style guide."
            />
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

/** A finished run reads in the accent, a dead one in the erase colour. */
function runStatusTone(status: string): string {
  if (status === "succeeded" || status === "completed") return "text-accent";
  if (status === "failed" || status === "cancelled") return "text-erase";
  return "text-muted";
}

function ProjectCard({ project }: { project: Project }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["project-assets", project.id],
    // Loaded eagerly so the shelf can show a real sprite instead of a folder.
    queryFn: () => api<{ assets: Asset[] }>(`/api/projects/${project.id}`),
  });
  const createAsset = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/projects/${project.id}/assets`, {
        method: "POST",
        body: JSON.stringify({ name: "Untitled" }),
      }),
    onSuccess: async (asset) => {
      await queryClient.invalidateQueries({ queryKey: ["project-assets", project.id] });
      window.location.assign(`/projects/${project.id}/assets/${asset.id}`);
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not open a new asset",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const assets = detail.data?.assets ?? [];
  const newest = assets.at(-1);

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionToken}
      className="pixel-window bg-raised shadow-pixel-md grid h-full grid-cols-1 grid-rows-[auto_auto_auto] gap-4 p-5 transition-transform duration-150 hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-pixel-lg"
    >
      <div className="flex items-start gap-3">
        {newest ? (
          <SpriteThumb assetId={newest.id} />
        ) : (
          <span className="grid h-12 w-12 shrink-0 place-items-center border-2 border-dashed border-line text-muted">
            <Folder />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[17px] leading-tight font-medium text-ink">
            {project.name}
          </h3>
          <p className="mt-1 text-pixel-mono text-muted">
            {detail.isPending
              ? "Loading…"
              : assets.length === 0
                ? "Nothing drawn yet"
                : `${assets.length} asset${assets.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      <div className="min-h-0">
        <p className="text-[13px] leading-relaxed text-muted">
          {project.description || "No description yet."}
        </p>
        {open ? (
          detail.isPending ? (
            <p className="mt-3 text-pixel-mono text-muted">Loading…</p>
          ) : assets.length === 0 ? (
            <p className="mt-3 text-pixel-mono text-muted">Nothing drawn here yet.</p>
          ) : (
            <ul className="mt-3 grid gap-1">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <Link
                    to="/projects/$projectId/assets/$assetId"
                    params={{ projectId: project.id, assetId: asset.id }}
                    className="flex items-center gap-2 border-2 border-transparent px-2 py-1.5 text-[13px] text-ink transition-colors duration-150 hover:border-line hover:bg-raised"
                  >
                    <SpriteThumb assetId={asset.id} display={26} />
                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                    <span className="text-pixel-mono text-muted">
                      {asset.width}×{asset.height}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          className="flex-1 px-3 py-1.5 text-[12px]"
          disabled={createAsset.isPending}
          onClick={() => createAsset.mutate()}
        >
          <Plus />
          New asset
        </Button>
        <Button
          tone="ghost"
          className="px-3 py-1.5 text-[12px]"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : `Browse ${assets.length > 0 ? `(${assets.length})` : ""}`}
        </Button>
      </div>
    </motion.article>
  );
}

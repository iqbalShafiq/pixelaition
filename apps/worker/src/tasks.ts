import {
  type AssetDrawDeps,
  type AssetDrawInput,
  type DrawPlan,
  userRequestFromPrompt,
  userTurnsFromRuns,
  type WorkerContext,
  type WorkerPromptInput,
} from "@pixelaition/agent";
import {
  assets,
  type Database,
  frames,
  generationRuns,
  generationThreads,
  projects,
  runTasks,
} from "@pixelaition/db";
import { defaultStyle } from "@pixelaition/pixel";
import { and, asc, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import {
  formatPriorContext,
  stepsFromRuns,
  type DurableDrawRecord,
  type PriorContext,
  type PriorTurn,
} from "./prior-context.js";
import { styleLine } from "./prompt.js";

/** The fields prior-context loading reads. An ask run builds the same shape. */
export type PriorContextInput = {
  threadId: string;
  assetId: string | null;
  taskId?: string;
  /** false only when the chosen model cannot view images; omitted keeps them. */
  modelVision?: boolean;
};

/**
 * Every earlier task in the thread, oldest first: each user request, the
 * follow-ups steered into it, its reference images, and a compact record of
 * what its agents did. The drawing task builds prompts from this; an ask run
 * receives the same material so a follow-up question lands on full history.
 */
export async function loadPriorContextFor(
  db: Database,
  readDurable: ((durableId: string) => DurableDrawRecord | undefined) | undefined,
  input: PriorContextInput,
): Promise<PriorContext> {
  const rows = await db
    .select({
      id: runTasks.id,
      durableTaskId: runTasks.durableTaskId,
      assetId: runTasks.assetId,
      status: runTasks.status,
    })
    .from(runTasks)
    .where(eq(runTasks.threadId, input.threadId))
    .orderBy(asc(runTasks.createdAt));
  let prior = rows.filter((row) => row.id !== input.taskId);
  if (input.assetId !== null) {
    prior = prior.filter((row) => row.assetId === input.assetId);
  }
  if (input.taskId === undefined) {
    const active = [...prior]
      .reverse()
      .find(
        (row) =>
          row.status === "queued" || row.status === "running" || row.status === "waiting",
      );
    if (active !== undefined) prior = prior.filter((row) => row.id !== active.id);
  }
  const turns: PriorTurn[] = [];
  for (const task of prior) {
    const children = await db
      .select({
        role: generationRuns.role,
        workerKey: generationRuns.workerKey,
        prompt: generationRuns.prompt,
        events: generationRuns.events,
      })
      .from(generationRuns)
      .where(eq(generationRuns.taskId, task.id))
      .orderBy(asc(generationRuns.createdAt));
    const durable =
      task.durableTaskId !== null && readDurable !== undefined
        ? readDurable(task.durableTaskId)
        : undefined;
    const request =
      durable?.request?.trim() ||
      children
        .map((child) => userRequestFromPrompt(child.role, child.prompt))
        .find((text): text is string => text !== null) ||
      "";
    if (request.length === 0) continue;
    turns.push({
      request,
      followUps: durable?.followUps ?? [],
      steps: stepsFromRuns(children),
      attachments: durable?.attachments ?? [],
    });
  }
  return formatPriorContext(turns, { images: input.modelVision !== false });
}

/**
 * The DB-backed context the asset-draw task injects. The task itself stays
 * pure and testable; every read of the live asset happens here.
 */
export function buildTaskDeps(
  db: Database,
  readDurable?: (durableId: string) => DurableDrawRecord | undefined,
): AssetDrawDeps {
  async function loadAsset(assetId: string | null) {
    if (assetId === null) return undefined;
    const [row] = await db
      .select({ asset: assets, project: projects })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(assets.id, assetId));
    return row;
  }

  function styleLines(style: unknown): string[] {
    return [styleLine(style)];
  }

  /**
   * Sibling assets of one asset, with what a painter reads for style: size,
   * palette, and each frame's name and summary. Pixels stay out of the prompt —
   * a role that wants them calls read_frame with the asset id.
   */
  async function projectAssetsFor(projectId: string, exceptAssetId: string) {
    const rows = await db
      .select({
        id: assets.id,
        name: assets.name,
        width: assets.width,
        height: assets.height,
        palette: assets.palette,
        summary: assets.summary,
      })
      .from(assets)
      .where(eq(assets.projectId, projectId))
      .orderBy(asc(assets.createdAt));
    const siblings: Array<{
      id: string;
      name: string;
      width: number;
      height: number;
      palette: string[];
      summary: string;
      frames: string[];
    }> = [];
    for (const sibling of rows) {
      if (sibling.id === exceptAssetId) continue;
      const siblingsFrames = await db
        .select({ name: frames.name, summary: frames.summary })
        .from(frames)
        .where(eq(frames.assetId, sibling.id))
        .orderBy(asc(frames.index));
      siblings.push({
        id: sibling.id,
        name: sibling.name,
        width: sibling.width,
        height: sibling.height,
        palette: sibling.palette as string[],
        summary: sibling.summary,
        frames: siblingsFrames.map((frame) =>
          frame.summary.length > 0 ? `${frame.name} (${frame.summary})` : frame.name,
        ),
      });
    }
    return siblings;
  }

  return {
    loadPlanContext: async (input: AssetDrawInput) => {
      const row = await loadAsset(input.assetId);
      const palette = (row?.asset.palette as string[] | undefined) ?? [];
      const frameRows = await db
        .select({ name: frames.name })
        .from(frames)
        .where(eq(frames.assetId, input.assetId ?? ""));
      return {
        projectName: row?.project.name ?? "project",
        assetName: row?.asset.name ?? "asset",
        assetId: input.assetId ?? "",
        paletteSize: palette.length,
        styleLines: styleLines(row?.project.style),
        frames: frameRows.map((frame) => frame.name),
      };
    },
    claimDefaultFrame: async (input: AssetDrawInput, name: string) => {
      const rows = await db
        .select({ id: frames.id, name: frames.name, layers: frames.layers })
        .from(frames)
        .where(eq(frames.assetId, input.assetId ?? ""));
      if (rows.length !== 1) return false;
      const row = rows[0];
      if (row === undefined) return false;
      const layers = (row.layers as Array<{ pixels?: string }> | null) ?? [];
      const untouched =
        layers.length > 0 &&
        layers.every((layer) => /^A*$/.test((layer.pixels ?? "").replace(/=+$/, "")));
      if (!untouched) return false;
      if (row.name === name) return true;
      await db.update(frames).set({ name }).where(eq(frames.id, row.id));
      return true;
    },
    unpaintedFrames: async (input: AssetDrawInput, names: string[]) => {
      if (names.length === 0) return [];
      const rows = await db
        .select({ name: frames.name, layers: frames.layers })
        .from(frames)
        .where(eq(frames.assetId, input.assetId ?? ""));
      const byName = new Map(rows.map((row) => [row.name, row.layers]));
      return names.filter((name) => {
        const layers = (byName.get(name) ?? []) as Array<{ pixels?: string }>;
        return (
          layers.length === 0 ||
          layers.every((layer) => /^A*$/.test((layer.pixels ?? "").replace(/=+$/, "")))
        );
      });
    },
    loadWorkerContext: async (
      input: AssetDrawInput,
      plan: DrawPlan,
      workerKey: string,
    ) => {
      const row = await loadAsset(plan.assetId.length > 0 ? plan.assetId : input.assetId);
      const palette = (row?.asset.palette as string[] | undefined) ?? [];
      const worker = plan.workers.find((candidate) => candidate.key === workerKey);
      const frameRows = await db
        .select({ name: frames.name, summary: frames.summary })
        .from(frames)
        .where(eq(frames.assetId, plan.assetId));
      const ownedSummaries = frameRows
        .filter(
          (frame) => worker?.frames.includes(frame.name) && frame.summary.length > 0,
        )
        .map((frame) => `${frame.name}: ${frame.summary}`)
        .join("; ");
      const promptData: Omit<
        WorkerPromptInput,
        "ownedFrames" | "readOnlyFrames" | "references"
      > = {
        request: input.request,
        projectName: row?.project.name ?? "project",
        assetName: row?.asset.name ?? "asset",
        width: row?.asset.width ?? 32,
        height: row?.asset.height ?? 32,
        paletteSize: palette.length,
        palette,
        styleLines: styleLines(row?.project.style),
        style: (row?.project.style as WorkerContext["style"]) ?? defaultStyle,
        attachments: input.attachments.length,
        ...(ownedSummaries.length > 0 ? { assetSummary: ownedSummaries } : {}),
        assetId: plan.assetId,
        frames: frameRows.map((frame) => frame.name),
        projectAssets: row ? await projectAssetsFor(row.project.id, plan.assetId) : [],
      };
      return { promptData };
    },
    loadPriorContext: (input: AssetDrawInput) =>
      loadPriorContextFor(db, readDurable, input),
    loadReviewContext: async (input: AssetDrawInput, plan: DrawPlan) => {
      const row = await loadAsset(plan.assetId.length > 0 ? plan.assetId : input.assetId);
      const rows = await db
        .select({ name: frames.name, summary: frames.summary })
        .from(frames)
        .where(eq(frames.assetId, plan.assetId));
      const lines = plan.frames.map((frame) => {
        const row = rows.find((candidate) => candidate.name === frame.name);
        return `- ${frame.name} (${frame.intent}): ${
          row?.summary && row.summary.length > 0 ? row.summary : "(no summary yet)"
        }`;
      });
      const palette = (row?.asset.palette as string[] | undefined) ?? [];
      return [
        `Asset: ${row?.asset.name ?? plan.assetId} (${row?.asset.width ?? 32}×${row?.asset.height ?? 32}). Project: ${row?.project.name ?? "project"}.`,
        `Palette: ${palette.map((hex, index) => `${index}:${hex}`).join(" ")}`,
        `Style: ${styleLines(row?.project.style).join("; ")}`,
        `Plan: ${JSON.stringify(plan)}`,
        "Frames to review:",
        ...lines,
        ...((await projectAssetsFor(row?.project.id ?? "", plan.assetId)).length > 0
          ? [
              "Other assets in this project (read-only; read them with their assetId):",
              ...(await projectAssetsFor(row?.project.id ?? "", plan.assetId)).map(
                (asset) =>
                  `- ${asset.name} [${asset.id}] ${asset.width}×${asset.height}: ${asset.frames.join(", ")}`,
              ),
            ]
          : []),
      ].join("\n");
    },
  };
}

/**
 * The reference URLs a worker may look at: everything aimed at "all" plus
 * everything aimed at one of its frames. Seeding these into the worker's
 * view_image allow-list lets it see the supervisor's search results without
 * ever trusting an arbitrary URL.
 */
export function referencesForWorker(plan: DrawPlan, workerKey: string): string[] {
  const worker = plan.workers.find((candidate) => candidate.key === workerKey);
  if (!worker) return [];
  return plan.references
    .filter(
      (reference) =>
        reference.appliesTo === "all" ||
        reference.appliesTo.some((name) => worker.frames.includes(name)),
    )
    .map((reference) => reference.url);
}

/**
 * The turns a run prompt's recent-runs block carries: the user's own messages
 * and the requests a plan run embeds, oldest first — never the machinery of
 * an earlier drawing task. A run still queued, running, or waiting has no
 * answer to show; only finished rows count.
 */
export async function recentRuns(
  db: Database,
  scope: { assetId: string } | { projectId: string },
): Promise<Array<{ prompt: string | null; answer: string | null }>> {
  const inScope =
    "assetId" in scope
      ? eq(generationThreads.assetId, scope.assetId)
      : eq(generationThreads.projectId, scope.projectId);
  const rows = await db
    .select({
      role: generationRuns.role,
      prompt: generationRuns.prompt,
      answer: generationRuns.answer,
    })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationThreads.id, generationRuns.threadId))
    .where(
      and(
        inScope,
        notInArray(generationRuns.status, ["queued", "running", "waiting"]),
        or(isNull(generationRuns.role), eq(generationRuns.role, "plan")),
      ),
    )
    .orderBy(desc(generationRuns.createdAt))
    .limit(12);
  return userTurnsFromRuns(rows, 3).map((turn) => ({
    prompt: turn.prompt,
    answer: turn.answer ?? null,
  }));
}

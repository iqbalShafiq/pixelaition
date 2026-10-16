import {
  type AssetDrawDeps,
  type AssetDrawInput,
  type DrawPlan,
  userRequestFromPrompt,
  type WorkerPromptInput,
} from "@pixelaition/agent";
import {
  assets,
  type Database,
  frames,
  generationRuns,
  projects,
  runTasks,
} from "@pixelaition/db";
import { defaultStyle, type StyleGuide } from "@pixelaition/pixel";
import { asc, eq } from "drizzle-orm";
import {
  formatPriorContext,
  stepsFromRuns,
  type DurableDrawRecord,
  type PriorContext,
  type PriorTurn,
} from "./prior-context.js";

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
    return [JSON.stringify((style as StyleGuide | undefined) ?? defaultStyle)];
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
        styleLines: styleLines(row?.project.style),
        attachments: input.attachments.length,
        ...(ownedSummaries.length > 0 ? { assetSummary: ownedSummaries } : {}),
      };
      return { promptData };
    },
    loadPriorContext: (input: AssetDrawInput) =>
      loadPriorContextFor(db, readDurable, input),
    loadReviewContext: async (_input: AssetDrawInput, plan: DrawPlan) => {
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
      return [
        `Plan: ${JSON.stringify(
          plan.frames.map((frame) => ({
            name: frame.name,
            intent: frame.intent,
            layers: frame.layers,
          })),
        )}`,
        "Frames to review:",
        ...lines,
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

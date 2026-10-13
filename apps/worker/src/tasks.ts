import {
  type AssetDrawDeps,
  type AssetDrawInput,
  type DrawPlan,
  type WorkerPromptInput,
} from "@pixelaition/agent";
import { assets, type Database, frames, projects } from "@pixelaition/db";
import { defaultStyle, type StyleGuide } from "@pixelaition/pixel";
import { eq } from "drizzle-orm";

/**
 * The DB-backed context the asset-draw task injects. The task itself stays
 * pure and testable; every read of the live asset happens here.
 */
export function buildTaskDeps(db: Database): AssetDrawDeps {
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
      return {
        projectName: row?.project.name ?? "project",
        assetName: row?.asset.name ?? "asset",
        assetId: input.assetId ?? "",
        paletteSize: palette.length,
        styleLines: styleLines(row?.project.style),
      };
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

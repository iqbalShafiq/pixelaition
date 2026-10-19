import { randomUUID } from "node:crypto";
import {
  assetFrameBuffer,
  bufferToFrame,
  frameToBuffer,
  type PixelProject,
  type StyleGuide,
} from "@pixelaition/pixel";
import {
  frameToJpg,
  frameToPng,
  frameToSvg,
  serializeProject,
  zipFiles,
} from "@pixelaition/export";
import { toNodeHandler } from "better-auth/node";
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { auth, db } from "./auth.js";
import {
  decideHomeTarget,
  decidePrompt,
  routeSteering,
  STEERING_CONFIDENCE,
  DecisionNotConfiguredError,
  HomeDecisionError,
  JevNotConfiguredError,
  LangfuseTelemetry,
  parseModelSpecRow,
  screenInput,
  seesUserImages,
  stagedOverrideSchema,
  WORKER_ATTEMPTS,
  traceIdFor,
  userRequestFromPrompt,
  userTurnsFromRuns,
  type DecisionContext,
  type DrawDecision,
  type GuardrailReport,
  type HomeAssetOption,
  type HomeContext,
  type HomeTarget,
  type ModelSpec,
} from "@pixelaition/agent";

const telemetry =
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
    ? new LangfuseTelemetry({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        ...(process.env.LANGFUSE_BASE_URL
          ? { baseUrl: process.env.LANGFUSE_BASE_URL }
          : {}),
        serviceName: "pixelaition-api",
      })
    : undefined;
import {
  addFrameRecord,
  assetHasActiveRun,
  consumeProposal,
  createApiKey,
  createAssetRecord,
  createProjectRecord,
  deleteFrameRecord,
  duplicateFrameRecord,
  ensureThread,
  getAssetRecord,
  getPreferences,
  getProjectRecord,
  failTask,
  insertProposal,
  insertTaskRecord,
  setTaskDurableId,
  taskBelongsTo,
  taskSnapshot,
  insertRun,
  listProjects,
  listVersions,
  moveFrameRecord,
  renameFrameRecord,
  restoreVersion,
  revokeApiKey,
  runBelongsTo,
  saveFrame,
  savePreferences,
  sessionUsageForThread,
  updateAssetRecord,
  updateVersionLabel,
  userIdForToken,
  type VersionCursor,
} from "./store.js";
import {
  runTasks,
  assets,
  frames,
  generationRuns,
  generationThreads,
  models,
  projects,
  RETENTION_LIMIT,
} from "@pixelaition/db";

const scaleSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(4),
  z.literal(8),
  z.literal(10),
]);

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ code, message });
}

/**
 * One task's console transcript, plus the meta the console header reads: the
 * task's rolled-up usage, its model and effort (every child shares them), and
 * its wall-clock bounds. The newest task doubles as the console's live turn.
 */
async function taskLog(task: {
  id: string;
  plan: unknown;
  usage: unknown;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  const children = await db
    .select({
      id: generationRuns.id,
      role: generationRuns.role,
      workerKey: generationRuns.workerKey,
      status: generationRuns.status,
      answer: generationRuns.answer,
      prompt: generationRuns.prompt,
      modelId: generationRuns.modelId,
      reasoningEffort: generationRuns.reasoningEffort,
      createdAt: generationRuns.createdAt,
      events: generationRuns.events,
    })
    .from(generationRuns)
    .where(eq(generationRuns.taskId, task.id))
    .orderBy(asc(generationRuns.createdAt));
  const prompt =
    children
      .map((child) => userRequestFromPrompt(child.role, child.prompt))
      .find((text) => text !== null) ?? null;
  // A task's children all run the model the request selected; the first child
  // that names one is that model.
  const model = children.find((child) => child.modelId.length > 0) ?? null;
  return {
    id: task.id,
    prompt,
    plan: task.plan ?? null,
    usage: task.usage ?? null,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    modelId: model?.modelId ?? null,
    effort: model?.reasoningEffort ?? null,
    runs: children
      .filter((child) => !(child.workerKey ?? "").startsWith("slot-"))
      .map((child) => ({
        id: child.id,
        role: child.role,
        workerKey: child.workerKey,
        status: child.status,
        answer: child.answer,
        createdAt: child.createdAt.toISOString(),
        events: Array.isArray(child.events) ? child.events : [],
      })),
  };
}

/**
 * One request's console turn when it was not a drawing task: an ask-only run
 * is a single run with no task, so its own id is the turn's id and that row
 * is the child the console rebuilds. It appears in the asset conversation
 * exactly like a drawing request, never merely as a "you" line a refresh
 * forgets.
 */
function askRunLog(run: {
  id: string;
  status: string;
  prompt: string | null;
  answer: string | null;
  modelId: string;
  reasoningEffort: string;
  createdAt: Date;
  finishedAt: Date | null;
  usage: unknown;
  events: unknown;
}) {
  return {
    id: run.id,
    prompt: run.prompt,
    plan: null,
    usage: run.usage ?? null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    modelId: run.modelId,
    effort: run.reasoningEffort,
    runs: [
      {
        id: run.id,
        role: null,
        workerKey: null,
        status: run.status,
        answer: run.answer,
        createdAt: run.createdAt.toISOString(),
        events: Array.isArray(run.events) ? run.events : [],
      },
    ],
  };
}

async function actor(req: Request): Promise<string | undefined> {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return userIdForToken(db, header.slice(7).trim());
  }
  const session = await auth.api.getSession({ headers: fromNode(req.headers) });
  return session?.user.id;
}

function fromNode(headers: Request["headers"]): Headers {
  const next = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") next.set(key, value);
    else if (Array.isArray(value)) next.set(key, value.join(", "));
  }
  return next;
}

// A run that is still live (queued, drawing, or paused for input) owns every
// frame of its asset — through its thread for editor runs, through its
// frame_id for a workspace run that bound an asset — so the mutation routes
// refuse to write under it.
async function activeRunFor(assetId: string): Promise<boolean> {
  return assetHasActiveRun(db, assetId);
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${new Date(row.createdAt).toISOString()}|${row.id}`;
}

function decodeCursor(value: string): VersionCursor | undefined {
  const separator = value.lastIndexOf("|");
  if (separator === -1) return undefined;
  const createdAt = new Date(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return undefined;
  return { createdAt, id };
}

// The worker never accepted this run, so the row must not stay queued: queued
// reads as active, and a stale active row would lock the asset forever.
async function failUnacceptedRun(runId: string, workerMessage?: string | null) {
  await db
    .update(generationRuns)
    .set({
      status: "failed",
      errorCode: "WORKER_UNAVAILABLE",
      finishedAt: new Date(),
      answer: workerMessage?.slice(0, 2000) ?? null,
    })
    .where(eq(generationRuns.id, runId));
}

/** The Jev spend a proposal already carries, shaped like the run's usage seed. */
export function usageSeedFromSpend(spend: {
  guardrailUsage?:
    { input?: number; output?: number; total?: number; cost?: number } | undefined;
  decisionUsage?:
    { input?: number; output?: number; total?: number; cost?: number } | undefined;
}): {
  input: number;
  output: number;
  total: number;
  cached: number;
  cost: number;
  jevCalls: number;
  jevCost: number;
} {
  const guardrail = spend.guardrailUsage;
  const decision = spend.decisionUsage;
  return {
    input: (guardrail?.input ?? 0) + (decision?.input ?? 0),
    output: (guardrail?.output ?? 0) + (decision?.output ?? 0),
    total: (guardrail?.total ?? 0) + (decision?.total ?? 0),
    cached: 0,
    cost: (guardrail?.cost ?? 0) + (decision?.cost ?? 0),
    jevCalls: (guardrail ? 1 : 0) + (decision ? 1 : 0),
    jevCost: (guardrail?.cost ?? 0) + (decision?.cost ?? 0),
  };
}

/**
 * The model checks every generation route shares: the key, the catalog pair,
 * and the vision requirement for attachments. Returns the pair or sends the
 * named failure itself.
 */
async function modelPairFor(
  res: express.Response,
  modelId: string,
  reasoningEffort: string,
  attachmentCount: number,
): Promise<ModelSpec | undefined> {
  if (!process.env.AGENT_API_KEY?.trim()) {
    fail(res, 503, "MODEL_UNCONFIGURED", "Add AGENT_API_KEY on the server to generate.");
    return undefined;
  }
  let catalog: ModelSpec[];
  try {
    catalog = await listModels();
  } catch (reason) {
    fail(
      res,
      503,
      "CATALOG_INVALID",
      reason instanceof Error ? reason.message : "The model catalog is malformed.",
    );
    return undefined;
  }
  const pair = catalog.find((model) => model.id === modelId);
  if (!pair || !pair.efforts.includes(reasoningEffort)) {
    fail(res, 422, "MODEL_NOT_AVAILABLE", "Pick a model and effort from the catalog.");
    return undefined;
  }
  if (attachmentCount > 0 && !seesUserImages(pair)) {
    fail(
      res,
      422,
      "MODEL_CANNOT_READ_IMAGES",
      `Model ${pair.id} cannot read attached images; pick a vision model or remove the attachments.`,
    );
    return undefined;
  }
  return pair;
}

/** Sums the Jev usage of several calls into one shape. */
function sumUsage(
  current: Record<string, number> | undefined,
  next: Record<string, number>,
): Record<string, number> | undefined {
  const keys = Object.keys(next);
  if (keys.length === 0) return current;
  const summed: Record<string, number> = { ...(current ?? {}) };
  for (const key of keys) summed[key] = (summed[key] ?? 0) + (next[key] ?? 0);
  return summed;
}

/**
 * Insert the run row and hand it to the worker; every failure names its cause
 * and leaves the row failed rather than queued. Shared by the editor route and
 * the home's confirm phase.
 */
async function startRunViaWorker(
  res: express.Response,
  input: {
    userId: string;
    prompt: string;
    modelId: string;
    reasoningEffort: string;
    attachments?: Array<{ mediaType: string; data: string }> | undefined;
    target:
      | { scope: "asset"; assetId: string; frameId: string }
      | { scope: "workspace"; projectId: string };
    threadId: string;
    requestId: string;
    mode: "draw" | "ask";
    /** Jev's task shape; present for draw runs. */
    shape?: { workers: number; review: boolean; source?: string } | undefined;
    usage: {
      input: number;
      output: number;
      total: number;
      cached: number;
      cost: number;
      jevCalls: number;
      jevCost: number;
    };
  },
): Promise<void> {
  if (input.mode === "draw" && input.shape?.source === "default") {
    // Jev did not answer the shape questions; the conservative default is used
    // and the fact is named instead of hidden.
    console.warn("[shape] Jev did not answer; using workers=2, review=true");
  }
  // One task per asset: the guard runs here as well as in the worker, because
  // a task's child rows may not exist yet when the second request arrives.
  if (
    input.mode === "draw" &&
    input.target.scope === "asset" &&
    (await assetHasActiveRun(db, input.target.assetId))
  ) {
    return fail(
      res,
      409,
      "RUN_IN_PROGRESS",
      "This frame already has an unfinished run; wait for it to finish or cancel it first.",
    );
  }
  // A drawing request is one durable task; the API owns its public id and the
  // worker records the durable task id on the row. An ask stays a single run.
  const runId =
    input.mode === "draw"
      ? await insertTaskRecord(db, {
          id: randomUUID(),
          threadId: input.threadId,
          ...(input.target.scope === "asset" ? { assetId: input.target.assetId } : {}),
          shape: input.shape ?? { workers: 2, review: true, source: "default" },
        })
      : await insertRun(db, {
          threadId: input.threadId,
          requestId: input.requestId,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          ...(input.target.scope === "asset" ? { frameId: input.target.frameId } : {}),
          prompt: input.prompt,
          status: "queued",
        });
  let worker: Awaited<ReturnType<typeof fetch>>;
  try {
    worker = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          scope: input.target.scope,
          ...(input.target.scope === "asset"
            ? { assetId: input.target.assetId, frameId: input.target.frameId }
            : { projectId: input.target.projectId }),
          prompt: input.prompt,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          runId,
          requestId: input.requestId,
          userId: input.userId,
          threadId: input.threadId,
          mode: input.mode,
          ...(input.shape !== undefined ? { shape: input.shape } : {}),
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          usage: input.usage,
        }),
      },
    );
  } catch (reason) {
    if (input.mode === "draw") await failTask(db, runId, "worker unavailable");
    else await failUnacceptedRun(runId);
    return fail(
      res,
      502,
      "WORKER_UNAVAILABLE",
      reason instanceof Error ? reason.message : "The drawing worker is not available.",
    );
  }
  if (!worker.ok) {
    const detail = (await worker.json().catch(() => null)) as {
      message?: string;
    } | null;
    if (input.mode === "draw") await failTask(db, runId, detail?.message ?? "refused");
    else await failUnacceptedRun(runId, detail?.message);
    if (worker.status === 409) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        detail?.message ?? "This frame already has an unfinished run.",
      );
    }
    return fail(
      res,
      502,
      "WORKER_UNAVAILABLE",
      detail?.message ?? "The drawing worker is not available.",
    );
  }
  const started = (await worker.json()) as {
    durableRunId?: string;
    durableTaskId?: string;
  };
  if (started.durableTaskId) {
    await setTaskDurableId(db, runId, started.durableTaskId);
  }
  if (started.durableRunId) {
    await db
      .update(generationRuns)
      .set({ durableRunId: started.durableRunId, status: "running" })
      .where(eq(generationRuns.id, runId));
  }
  // The home opens the editor from this response, so the bound target rides
  // along: without the asset and its project the plan card stayed on the
  // home, behind a refresh, until the user opened the new asset by hand.
  const [bound] = await db
    .select({ assetId: runTasks.assetId, projectId: assets.projectId })
    .from(runTasks)
    .leftJoin(assets, eq(assets.id, runTasks.assetId))
    .where(eq(runTasks.id, runId))
    .limit(1);
  res.status(202).json({
    runId,
    streamId: runId,
    kind: input.mode === "draw" ? "task" : "run",
    ...(bound?.assetId ? { assetId: bound.assetId, projectId: bound.projectId } : {}),
  });
}

export function createApp() {
  const app = express();
  app.use("/api/auth", toNodeHandler(auth));
  // Reference images arrive as base64 with the generate request.
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api", async (req, res, next) => {
    if (req.path === "/health") return next();
    const userId = await actor(req);
    if (!userId) return fail(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
    res.locals.userId = userId;
    next();
  });

  app.get("/api/preferences", async (_req, res) => {
    res.json(await getPreferences(db, res.locals.userId as string));
  });

  app.patch("/api/preferences", async (req, res) => {
    const body = z
      .object({
        lastModelId: z.string().min(1).max(200).nullable().optional(),
        lastReasoningEffort: z.string().min(1).max(40).nullable().optional(),
      })
      .parse(req.body);
    res.json(await savePreferences(db, res.locals.userId as string, body));
  });

  app.get("/api/models", async (_req, res) => {
    try {
      res.json({
        models: await listModels(),
        modelReady: Boolean(process.env.AGENT_API_KEY?.trim()),
      });
    } catch (reason) {
      return fail(
        res,
        503,
        "CATALOG_INVALID",
        reason instanceof Error ? reason.message : "The model catalog is malformed.",
      );
    }
  });

  app.post("/api/api-keys", async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    res.status(201).json(await createApiKey(db, res.locals.userId as string, body.name));
  });

  app.delete("/api/api-keys/:id", async (req, res) => {
    await revokeApiKey(db, res.locals.userId as string, req.params.id ?? "");
    res.status(204).end();
  });

  app.get("/api/projects", async (_req, res) => {
    res.json({ projects: await listProjects(db, res.locals.userId as string) });
  });

  app.post("/api/projects", async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(80),
        description: z.string().max(2000).optional(),
      })
      .parse(req.body);
    res
      .status(201)
      .json(
        await createProjectRecord(
          db,
          res.locals.userId as string,
          body.name,
          body.description,
        ),
      );
  });

  app.get("/api/projects/:id", async (req, res) => {
    const project = await getProjectRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!project) return fail(res, 404, "NOT_FOUND", "That project is not available.");
    res.json(project);
  });

  app.post("/api/projects/:id/assets", async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const asset = await createAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      body.name,
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That project is not available.");
    res.status(201).json(asset);
  });

  app.get("/api/assets/:id", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    res.json(asset);
  });

  app.put("/api/assets/:id/frames/:frameId", async (req, res) => {
    const body = z
      .object({
        layers: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            visible: z.boolean(),
            pixels: z.string(),
          }),
        ),
      })
      .parse(req.body);
    // Defence in depth: a live agent owns every frame, so the client cannot
    // clobber streamed strokes even if its own suspension fails.
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const saved = await saveFrame(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.frameId ?? "",
      body.layers,
    );
    if (!saved.asset)
      return fail(
        res,
        saved.failure?.code === "FRAME_SIZE_MISMATCH" ? 422 : 404,
        saved.failure?.code ?? "NOT_FOUND",
        saved.failure?.message ?? "That frame is not available.",
      );
    res.json(saved.asset);
  });

  app.patch("/api/assets/:id", async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        palette: z.array(z.string()).min(2).max(256).optional(),
      })
      .parse(req.body);
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const result = await updateAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      body,
    );
    if (!result.asset)
      return fail(
        res,
        result.failure?.code === "NOT_FOUND" ? 404 : 422,
        result.failure?.code ?? "INVALID",
        result.failure?.message ?? "That asset is not available.",
      );
    res.json(result.asset);
  });

  app.post("/api/assets/:id/frames", async (req, res) => {
    const body = z.object({ name: z.string().max(80).default("") }).parse(req.body);
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const result = await addFrameRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      body.name,
    );
    if (!result.asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    res.status(201).json(result.asset);
  });

  app.post("/api/assets/:id/frames/:frameId/duplicate", async (req, res) => {
    const body = z.object({ name: z.string().max(80).optional() }).parse(req.body);
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const result = await duplicateFrameRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.frameId ?? "",
      body.name,
    );
    if (!result.asset)
      return fail(
        res,
        404,
        "NOT_FOUND",
        result.failure?.message ?? "That frame is gone.",
      );
    res.status(201).json(result.asset);
  });

  app.patch("/api/assets/:id/frames/:frameId", async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        index: z.number().int().min(0).optional(),
      })
      .refine((value) => value.name !== undefined || value.index !== undefined, {
        message: "Send a name or an index.",
      })
      .parse(req.body);
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const userId = res.locals.userId as string;
    const assetId = req.params.id ?? "";
    const frameId = req.params.frameId ?? "";
    if (body.index !== undefined) {
      const result = await moveFrameRecord(db, userId, assetId, frameId, body.index);
      if (!result.asset)
        return fail(
          res,
          404,
          result.failure?.code ?? "NOT_FOUND",
          result.failure?.message ?? "That frame is not available.",
        );
      return res.json(result.asset);
    }
    const asset = await renameFrameRecord(db, userId, assetId, frameId, body.name ?? "");
    if (!asset) return fail(res, 404, "NOT_FOUND", "That frame is not available.");
    res.json(asset);
  });

  app.delete("/api/assets/:id", async (req, res) => {
    const assetId = req.params.id;
    const asset = await getAssetRecord(db, res.locals.userId as string, assetId);
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const tasks = await db
      .select({ status: runTasks.status })
      .from(runTasks)
      .where(eq(runTasks.assetId, assetId));
    if (tasks.some((task) => ["queued", "running", "waiting"].includes(task.status))) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "That asset is being drawn right now — stop the run first.",
      );
    }
    await db.delete(assets).where(eq(assets.id, assetId));
    return res.json({ ok: true });
  });

  app.delete("/api/projects/:id", async (req, res) => {
    const projectId = req.params.id;
    const project = await getProjectRecord(db, res.locals.userId as string, projectId);
    if (!project) return fail(res, 404, "NOT_FOUND", "That project is not available.");
    const tasks = await db
      .select({ status: runTasks.status })
      .from(runTasks)
      .innerJoin(assets, eq(runTasks.assetId, assets.id))
      .where(eq(assets.projectId, projectId));
    if (tasks.some((task) => ["queued", "running", "waiting"].includes(task.status))) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "A project asset is being drawn right now — stop that run first.",
      );
    }
    await db.delete(projects).where(eq(projects.id, projectId));
    return res.json({ ok: true });
  });

  app.delete("/api/assets/:id/frames/:frameId", async (req, res) => {
    if (await activeRunFor(req.params.id ?? "")) {
      return fail(
        res,
        409,
        "RUN_IN_PROGRESS",
        "The agent is drawing on this asset right now.",
      );
    }
    const result = await deleteFrameRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.frameId ?? "",
    );
    if (result.failure)
      return fail(
        res,
        result.failure.code === "FRAME_REQUIRED" ? 422 : 404,
        result.failure.code,
        result.failure.message,
      );
    res.status(204).end();
  });

  app.get("/api/assets/:id/versions", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const scope =
      req.query.scope === "frame" || req.query.scope === "asset"
        ? req.query.scope
        : undefined;
    const frameId =
      typeof req.query.frameId === "string" && req.query.frameId
        ? req.query.frameId
        : undefined;
    const requested = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), RETENTION_LIMIT)
      : undefined;
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor
        ? decodeCursor(req.query.cursor)
        : undefined;
    const rows = await listVersions(db, asset.id, {
      ...(scope ? { scope } : {}),
      ...(frameId ? { frameId } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const last = rows.at(-1);
    res.json({
      versions: rows,
      nextCursor:
        last && limit !== undefined && rows.length === limit ? encodeCursor(last) : null,
    });
  });

  app.patch("/api/assets/:id/versions/:versionId", async (req, res) => {
    const body = z
      .object({ label: z.string().trim().max(80).nullable() })
      .parse(req.body);
    const updated = await updateVersionLabel(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.versionId ?? "",
      body.label || null,
    );
    if (!updated) return fail(res, 404, "NOT_FOUND", "That version is not available.");
    res.json(updated);
  });

  app.post("/api/assets/:id/versions/:versionId/restore", async (req, res) => {
    const result = await restoreVersion(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.versionId ?? "",
    );
    if (!result.asset) {
      const code = result.failure?.code ?? "NOT_FOUND";
      return fail(
        res,
        code === "RUN_IN_PROGRESS" ? 409 : code === "NOT_FOUND" ? 404 : 422,
        code,
        result.failure?.message ?? "That version is not available.",
      );
    }
    res.json(result.asset);
  });

  app.post("/api/runs", async (req, res) => {
    const body = z
      .object({
        scope: z.enum(["asset", "workspace"]).default("asset"),
        assetId: z.string().optional(),
        frameId: z.string().optional(),
        projectId: z.string().optional(),
        prompt: z.string().min(1).max(4000),
        modelId: z.string().min(1),
        reasoningEffort: z.string().min(1),
        // Reference images: the web app downscales each one well under these
        // caps, so a body over them is a bug or an abuse, not a big picture.
        attachments: z
          .array(
            z.object({
              mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
              data: z.string().min(16).max(1_500_000),
            }),
          )
          .max(4)
          .refine(
            (list) => list.reduce((sum, item) => sum + item.data.length, 0) <= 5_000_000,
            { message: "The attachments are too large together." },
          )
          .optional(),
      })
      .parse(req.body);
    const userId = res.locals.userId as string;
    // A run has exactly one home: an asset with a frame, or a workspace project.
    // Missing either names the cause instead of guessing a default.
    let target:
      | { scope: "asset"; assetId: string; frameId: string }
      | { scope: "workspace"; projectId: string };
    /** What the run draws on, for the decision's context. */
    let targetContext: DecisionContext | undefined;
    if (body.scope === "workspace") {
      const projectId = body.projectId;
      if (!projectId)
        return fail(res, 422, "SCOPE_REQUIRED", "A workspace run needs a projectId.");
      // Ownership first: the decision call spends the operator's key, so it
      // must not run on behalf of a project the caller does not own.
      const project = await getProjectRecord(db, userId, projectId);
      if (!project) return fail(res, 404, "NOT_FOUND", "That project is not available.");
      target = { scope: "workspace", projectId: project.id };
      targetContext = { projectName: project.name };
    } else {
      const assetId = body.assetId;
      const frameId = body.frameId;
      if (!assetId || !frameId)
        return fail(
          res,
          422,
          "SCOPE_REQUIRED",
          "An asset run needs an assetId and a frameId.",
        );
      // Ownership first: the decision call spends the operator's key, so it
      // must not run on behalf of an asset the caller does not own.
      const asset = await getAssetRecord(db, userId, assetId);
      if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
      target = { scope: "asset", assetId: asset.id, frameId };
      const originFrame = asset.frames.find((item) => item.id === frameId);
      targetContext = {
        asset: {
          name: asset.name,
          width: asset.width,
          height: asset.height,
          palette: asset.palette as string[],
          ...(asset.summary.length > 0 ? { summary: asset.summary } : {}),
        },
        frames: asset.frames.map((item) => item.name),
        ...(originFrame ? { frameName: originFrame.name } : {}),
        ...(originFrame !== undefined && originFrame.summary.length > 0
          ? { frameSummary: originFrame.summary }
          : {}),
      };
    }
    const pair = await modelPairFor(
      res,
      body.modelId,
      body.reasoningEffort,
      body.attachments?.length ?? 0,
    );
    if (!pair) return;
    const decisionModel = process.env.DECISION_MODEL?.trim();
    const decisionBaseUrl = process.env.DECISION_MODEL_BASE_URL?.trim();
    const decisionApiKey = process.env.DECISION_MODEL_API_KEY?.trim();
    if (!decisionModel || !decisionBaseUrl || !decisionApiKey) {
      return fail(
        res,
        503,
        "DECISION_UNCONFIGURED",
        "Set DECISION_MODEL, DECISION_MODEL_BASE_URL, and DECISION_MODEL_API_KEY before generating.",
      );
    }
    const thread = await ensureThread(
      db,
      userId,
      target.scope === "asset"
        ? { assetId: target.assetId }
        : { projectId: target.projectId },
    );
    const requestId = crypto.randomUUID();
    // The guardrail screens the user's message before any run exists, the
    // input side of the cookbook's pass/review/block policy.
    const guardrailStarted = Date.now();
    let guardrail: GuardrailReport;
    try {
      guardrail = await screenInput(body.prompt, {
        apiKey: decisionApiKey,
        model: decisionModel,
        baseUrl: decisionBaseUrl,
      });
    } catch (reason) {
      if (reason instanceof JevNotConfiguredError) {
        return fail(res, 503, "DECISION_UNCONFIGURED", reason.message);
      }
      return fail(
        res,
        502,
        "GUARDRAIL_FAILED",
        reason instanceof Error ? reason.message : "The content guardrail failed.",
      );
    }
    void telemetry?.recordSpan(
      {
        traceId: traceIdFor(requestId),
        kind: "generation",
        name: "guardrail-input",
        startMs: guardrailStarted,
        endMs: Date.now(),
        input: body.prompt,
        output: JSON.stringify({
          action: guardrail.action,
          hazards: guardrail.hazards,
          severity: guardrail.severity,
        }),
        model: decisionModel,
        ...(guardrail.usage !== undefined ? { usage: { ...guardrail.usage } } : {}),
        ...(guardrail.action !== "pass"
          ? { level: "WARNING" as const, statusMessage: guardrail.reason }
          : {}),
      },
      {
        name: "decide",
        userId: res.locals.userId as string,
        sessionId: thread.id,
        tags: ["pixelaition", "decide", "guardrail"],
        metadata:
          target.scope === "asset"
            ? { assetId: target.assetId }
            : { projectId: target.projectId },
      },
    );
    if (guardrail.action === "block") {
      return fail(
        res,
        422,
        "POLICY_BLOCKED",
        `This request breaks the content policy (${guardrail.top.hazard}=${guardrail.top.probability.toFixed(2)}, severity=${guardrail.severity.toFixed(2)}).`,
      );
    }
    if (guardrail.action === "review") {
      return fail(
        res,
        422,
        "POLICY_REVIEW",
        `This request was flagged for review (${guardrail.top.hazard}=${guardrail.top.probability.toFixed(2)}). Rephrase it and try again.`,
      );
    }
    // The decision reads the thread's recent exchanges — the turns a person
    // typed, never a drawing task's supervisor/worker/review/fix prompts.
    // Those once crowded the window and turned an edit request into an ask,
    // so the query keeps only role-null runs and plan requests; its window is
    // wide enough to net four user turns after plan continuations are skipped.
    const historyRows = await db
      .select({
        role: generationRuns.role,
        prompt: generationRuns.prompt,
        answer: generationRuns.answer,
      })
      .from(generationRuns)
      .where(
        and(
          eq(generationRuns.threadId, thread.id),
          or(isNull(generationRuns.role), eq(generationRuns.role, "plan")),
        ),
      )
      .orderBy(desc(generationRuns.createdAt))
      .limit(16);
    const history = userTurnsFromRuns(historyRows, 4);
    const decisionStarted = Date.now();
    let decided: DrawDecision;
    let decisionUsage: Record<string, number> | undefined;
    try {
      decided = await decidePrompt(
        body.prompt,
        {
          apiKey: decisionApiKey,
          model: decisionModel,
          baseUrl: decisionBaseUrl,
          onCall: (call) => {
            const { model: _model, latencyMs: _latencyMs, ...usage } = call;
            decisionUsage = Object.keys(usage).length > 0 ? usage : undefined;
          },
        },
        {
          ...(history.length > 0 ? { history } : {}),
          ...(body.attachments !== undefined && body.attachments.length > 0
            ? { attachments: body.attachments.length }
            : {}),
          ...(targetContext ?? {}),
        },
      );
    } catch (reason) {
      if (reason instanceof DecisionNotConfiguredError) {
        return fail(res, 503, "DECISION_UNCONFIGURED", reason.message);
      }
      return fail(
        res,
        502,
        "DECISION_FAILED",
        reason instanceof Error ? reason.message : "The decision provider failed.",
      );
    }
    void telemetry?.recordSpan(
      {
        traceId: traceIdFor(requestId),
        kind: "generation",
        name: "decide-request",
        startMs: decisionStarted,
        endMs: Date.now(),
        input: body.prompt,
        output: JSON.stringify(decided),
        model: decisionModel,
        ...(decisionUsage !== undefined ? { usage: decisionUsage } : {}),
      },
      {
        name: "decide",
        userId: res.locals.userId as string,
        sessionId: thread.id,
        tags: ["pixelaition", "decide"],
        metadata:
          target.scope === "asset"
            ? { assetId: target.assetId }
            : { projectId: target.projectId },
      },
    );
    // The decision chose the mode: an ask is a conversational run that
    // answers with the same context but no painting tools, never an error.
    const mode = decided.intent === "ask" ? "ask" : "draw";
    return startRunViaWorker(res, {
      userId,
      prompt: body.prompt,
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      target,
      threadId: thread.id,
      requestId,
      mode,
      ...(decided.shape !== undefined ? { shape: decided.shape } : {}),
      usage: usageSeedFromSpend({
        guardrailUsage: guardrail.usage,
        decisionUsage,
      }),
    });
  });

  // The home composer's run list. An editor run's asset hangs off its thread;
  // a workspace run's created asset exists only in its stored events, so the
  // event is the source of the link target and the asset name when present.
  // An event's asset id is paired only with the event's own project id and
  // name — never with a thread-derived project or another asset's name. The
  // retained-event bound can evict an early `asset-created` on a long run, so
  // the run's pinned frame (set when a workspace run binds an asset) is the
  // fallback: it names the asset the run actually touched.
  // Every asset of the user, for the home library and the confirmation card.
  app.get("/api/assets", async (_req, res) => {
    const rows = await db
      .select({
        id: assets.id,
        projectId: assets.projectId,
        name: assets.name,
        summary: assets.summary,
        width: assets.width,
        height: assets.height,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(projects.userId, res.locals.userId as string))
      .orderBy(desc(assets.updatedAt));
    res.json({ assets: rows });
  });

  // The home runs in two phases: a proposal (guardrail + Jev target, spending
  // Jev once) that starts nothing, then a confirm that starts the run from the
  // stored proposal. The card always appears, even at high confidence.
  app.post("/api/home/runs", async (req, res) => {
    const body = z
      .object({
        prompt: z.string().min(1).max(4000),
        modelId: z.string().min(1),
        reasoningEffort: z.string().min(1),
        attachments: z
          .array(
            z.object({
              mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
              data: z.string().min(16).max(1_500_000),
            }),
          )
          .max(4)
          .refine(
            (list) => list.reduce((sum, item) => sum + item.data.length, 0) <= 5_000_000,
            { message: "The attachments are too large together." },
          )
          .optional(),
        proposalId: z.string().optional(),
        confirm: z
          .object({
            projectId: z.union([z.string().min(1), z.literal("new")]),
            assetId: z.union([z.string().min(1), z.literal("new"), z.null()]).optional(),
            projectName: z.string().min(1).max(80).optional(),
            assetName: z.string().min(1).max(80).optional(),
            mode: z.enum(["generate", "agent"]),
          })
          .optional(),
      })
      .parse(req.body);
    const userId = res.locals.userId as string;
    const pair = await modelPairFor(
      res,
      body.modelId,
      body.reasoningEffort,
      body.attachments?.length ?? 0,
    );
    if (!pair) return;
    const decisionModel = process.env.DECISION_MODEL?.trim();
    const decisionBaseUrl = process.env.DECISION_MODEL_BASE_URL?.trim();
    const decisionApiKey = process.env.DECISION_MODEL_API_KEY?.trim();
    if (!decisionModel || !decisionBaseUrl || !decisionApiKey) {
      return fail(
        res,
        503,
        "DECISION_UNCONFIGURED",
        "Set DECISION_MODEL, DECISION_MODEL_BASE_URL, and DECISION_MODEL_API_KEY before generating.",
      );
    }

    if (body.confirm === undefined) {
      // Phase A: guardrail, then Jev reads the library and proposes a target.
      const requestId = crypto.randomUUID();
      const guardrailStarted = Date.now();
      let guardrail: GuardrailReport;
      try {
        guardrail = await screenInput(body.prompt, {
          apiKey: decisionApiKey,
          model: decisionModel,
          baseUrl: decisionBaseUrl,
        });
      } catch (reason) {
        if (reason instanceof JevNotConfiguredError) {
          return fail(res, 503, "DECISION_UNCONFIGURED", reason.message);
        }
        return fail(
          res,
          502,
          "GUARDRAIL_FAILED",
          reason instanceof Error ? reason.message : "The content guardrail failed.",
        );
      }
      void telemetry?.recordSpan(
        {
          traceId: traceIdFor(requestId),
          kind: "generation",
          name: "guardrail-input",
          startMs: guardrailStarted,
          endMs: Date.now(),
          input: body.prompt,
          output: JSON.stringify({
            action: guardrail.action,
            hazards: guardrail.hazards,
            severity: guardrail.severity,
          }),
          model: decisionModel,
          ...(guardrail.usage !== undefined ? { usage: { ...guardrail.usage } } : {}),
          ...(guardrail.action !== "pass"
            ? { level: "WARNING" as const, statusMessage: guardrail.reason }
            : {}),
        },
        {
          name: "home-propose",
          userId,
          sessionId: `home:${userId}`,
          tags: ["pixelaition", "decide", "guardrail", "home"],
          metadata: {},
        },
      );
      if (guardrail.action === "block") {
        return fail(
          res,
          422,
          "POLICY_BLOCKED",
          `This request breaks the content policy (${guardrail.top.hazard}=${guardrail.top.probability.toFixed(2)}, severity=${guardrail.severity.toFixed(2)}).`,
        );
      }
      if (guardrail.action === "review") {
        return fail(
          res,
          422,
          "POLICY_REVIEW",
          `This request was flagged for review (${guardrail.top.hazard}=${guardrail.top.probability.toFixed(2)}). Rephrase it and try again.`,
        );
      }
      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
          summary: projects.summary,
          updatedAt: projects.updatedAt,
          assetCount: count(assets.id),
        })
        .from(projects)
        .leftJoin(assets, eq(assets.projectId, projects.id))
        .where(eq(projects.userId, userId))
        .groupBy(projects.id)
        .orderBy(desc(projects.updatedAt));
      const assetRows = await db
        .select({
          id: assets.id,
          projectId: assets.projectId,
          name: assets.name,
          summary: assets.summary,
          width: assets.width,
          height: assets.height,
        })
        .from(assets)
        .innerJoin(projects, eq(assets.projectId, projects.id))
        .where(eq(projects.userId, userId))
        .orderBy(desc(assets.updatedAt));
      const assetsByProject = new Map<string, HomeAssetOption[]>();
      for (const row of assetRows) {
        const list = assetsByProject.get(row.projectId) ?? [];
        list.push({
          id: row.id,
          name: row.name,
          summary: row.summary,
          width: row.width,
          height: row.height,
        });
        assetsByProject.set(row.projectId, list);
      }
      const homeContext: HomeContext = {
        projects: projectRows.map((row) => ({
          id: row.id,
          name: row.name,
          summary: row.summary,
          assetCount: row.assetCount,
        })),
        assetsByProject,
      };
      const decisionStarted = Date.now();
      let decided: HomeTarget;
      let decisionUsage: Record<string, number> | undefined;
      try {
        decided = await decideHomeTarget(
          body.prompt,
          {
            apiKey: decisionApiKey,
            model: decisionModel,
            baseUrl: decisionBaseUrl,
            onCall: (call) => {
              const { model: _model, latencyMs: _latencyMs, ...usage } = call;
              decisionUsage = sumUsage(decisionUsage, usage);
            },
          },
          homeContext,
        );
      } catch (reason) {
        if (reason instanceof HomeDecisionError) {
          // The card still appears; the agent will ask instead of guessing.
          const stored = await insertProposal(db, {
            userId,
            prompt: body.prompt,
            intent: "draw",
            project: { id: "new", confidence: 0 },
            guardrail,
            decision: { reason: reason.message, usage: decisionUsage },
            expiresAt: new Date(Date.now() + 15 * 60_000),
          });
          return res.json({
            proposalId: stored.id,
            proposal: {
              intent: "draw",
              project: { id: "new", confidence: 0 },
              reason: reason.message,
            },
          });
        }
        if (reason instanceof JevNotConfiguredError) {
          return fail(res, 503, "DECISION_UNCONFIGURED", reason.message);
        }
        return fail(
          res,
          502,
          "DECISION_FAILED",
          reason instanceof Error ? reason.message : "The decision provider failed.",
        );
      }
      void telemetry?.recordSpan(
        {
          traceId: traceIdFor(requestId),
          kind: "generation",
          name: "decide-request",
          startMs: decisionStarted,
          endMs: Date.now(),
          input: body.prompt,
          output: JSON.stringify(decided),
          model: decisionModel,
          ...(decisionUsage !== undefined ? { usage: decisionUsage } : {}),
        },
        {
          name: "home-propose",
          userId,
          sessionId: `home:${userId}`,
          tags: ["pixelaition", "decide", "home"],
          metadata: {},
        },
      );
      const stored = await insertProposal(db, {
        userId,
        prompt: body.prompt,
        intent: decided.intent,
        project: decided.project,
        ...(decided.asset !== undefined ? { asset: decided.asset } : {}),
        guardrail,
        decision: { target: decided, usage: decisionUsage },
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      const projectName =
        decided.project.id === "new"
          ? undefined
          : projectRows.find((row) => row.id === decided.project.id)?.name;
      const assetName =
        decided.asset === undefined || decided.asset.id === "new"
          ? undefined
          : assetRows.find((row) => row.id === decided.asset?.id)?.name;
      return res.json({
        proposalId: stored.id,
        proposal: {
          intent: decided.intent,
          project: {
            id: decided.project.id,
            ...(projectName !== undefined ? { name: projectName } : {}),
            confidence: decided.project.confidence,
          },
          ...(decided.asset !== undefined
            ? {
                asset: {
                  id: decided.asset.id,
                  ...(assetName !== undefined ? { name: assetName } : {}),
                  confidence: decided.asset.confidence,
                },
              }
            : {}),
        },
      });
    }

    // Phase B: consume the proposal, resolve the confirmed target, start.
    if (body.proposalId === undefined) {
      return fail(
        res,
        422,
        "PROPOSAL_REQUIRED",
        "A confirm needs the proposalId it confirms.",
      );
    }
    const consumed = await consumeProposal(db, userId, body.proposalId);
    if ("failure" in consumed) {
      const status = consumed.failure.code === "NOT_FOUND" ? 404 : 409;
      return fail(res, status, consumed.failure.code, consumed.failure.message);
    }
    const stored = consumed.proposal;
    const confirm = body.confirm;
    // The run always starts from the prompt the guardrail screened; a client
    // that changed it must send a fresh proposal instead of smuggling text
    // past the guardrail.
    if (body.prompt !== stored.prompt) {
      return fail(
        res,
        422,
        "PROMPT_MISMATCH",
        "The prompt changed after the proposal; send it again.",
      );
    }
    let projectId: string;
    if (confirm.projectId === "new") {
      if (confirm.projectName === undefined) {
        return fail(res, 422, "PROJECT_NAME_REQUIRED", "Give the new project a name.");
      }
      const created = await createProjectRecord(db, userId, confirm.projectName);
      projectId = created.id;
    } else {
      const project = await getProjectRecord(db, userId, confirm.projectId);
      if (!project) return fail(res, 404, "NOT_FOUND", "That project is not available.");
      projectId = project.id;
    }
    let target:
      | { scope: "asset"; assetId: string; frameId: string }
      | { scope: "workspace"; projectId: string };
    let prompt = stored.prompt;
    if (
      confirm.mode === "generate" &&
      confirm.assetId !== undefined &&
      confirm.assetId !== null &&
      confirm.assetId !== "new"
    ) {
      const asset = await getAssetRecord(db, userId, confirm.assetId);
      if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
      if (asset.projectId !== projectId) {
        return fail(
          res,
          422,
          "ASSET_NOT_IN_PROJECT",
          "That asset belongs to another project; pick an asset of the confirmed project.",
        );
      }
      const origin = asset.frames[0];
      if (!origin) return fail(res, 422, "ASSET_EMPTY", "That asset has no frames.");
      target = { scope: "asset", assetId: asset.id, frameId: origin.id };
    } else if (confirm.assetName !== undefined) {
      // The user named the asset: create it here, so the run binds a real
      // target and the home opens the editor without waiting for the agent
      // (which used to leave the plan card unreachable until a refresh).
      const created = await createAssetRecord(db, userId, projectId, confirm.assetName);
      if (!created) return fail(res, 404, "NOT_FOUND", "That project is not available.");
      const origin = created.frames[0];
      if (!origin) return fail(res, 422, "ASSET_EMPTY", "That asset has no frames.");
      target = { scope: "asset", assetId: created.id, frameId: origin.id };
      prompt = `${prompt}\n\nAsset name to use: ${confirm.assetName}`;
    } else {
      // The agent creates the asset (or asks) inside the confirmed project.
      target = { scope: "workspace", projectId };
    }
    const thread = await ensureThread(
      db,
      userId,
      target.scope === "asset"
        ? { assetId: target.assetId }
        : { projectId: target.projectId },
    );
    const requestId = crypto.randomUUID();
    const guardrailReport = stored.guardrail as GuardrailReport | null;
    const decisionStored = stored.decision as {
      usage?: Record<string, number>;
      shape?: { workers: number; review: boolean; source?: string };
    } | null;
    const storedDecisionShape = decisionStored?.shape;
    return startRunViaWorker(res, {
      userId,
      prompt,
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      target,
      threadId: thread.id,
      requestId,
      mode: stored.intent === "ask" ? "ask" : "draw",
      ...(storedDecisionShape !== undefined ? { shape: storedDecisionShape } : {}),
      usage: usageSeedFromSpend({
        guardrailUsage: guardrailReport?.usage,
        decisionUsage: decisionStored?.usage,
      }),
    });
  });

  // --- Tasks -----------------------------------------------------------------
  // The editor reads one snapshot per asset: the task, every child run with
  // its frames, and the questions waiting for the user.

  app.get("/api/assets/:id/task", async (req, res) => {
    const assetId = req.params.id ?? "";
    const asset = await getAssetRecord(db, res.locals.userId as string, assetId);
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const snapshot = await taskSnapshot(db, assetId);
    if (snapshot === undefined)
      return res.json({ task: null, workers: [], pendingQuestions: 0 });
    const frameName = new Map(snapshot.frameRows.map((frame) => [frame.id, frame.name]));
    const workers = [];
    let pendingQuestions = 0;
    for (const child of snapshot.children) {
      const frameIds = (child.frameIds as string[] | null) ?? [];
      let pendingInteraction: unknown;
      let status = child.status;
      if (child.durableRunId !== null && child.status === "waiting") {
        const probe = await fetch(
          `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${child.id}/state`,
          {
            headers: {
              authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
            },
            signal: AbortSignal.timeout(2000),
          },
        ).catch(() => null);
        const state = probe?.ok
          ? ((await probe.json()) as { status?: string; interaction?: unknown })
          : null;
        if (state?.interaction !== undefined) {
          pendingInteraction = state.interaction;
          pendingQuestions += 1;
        }
        if (state?.status !== undefined) status = state.status;
      }
      const frameStatus =
        status === "succeeded" || status === "completed"
          ? "done"
          : status === "cancelled"
            ? "failed"
            : status === "failed"
              ? "failed"
              : status === "waiting"
                ? "asking"
                : "working";
      // The children arrive oldest first, so a later attempt of the same role
      // means this one was superseded — a retry that answers its failure. The
      // latest attempt of a role that already failed once is retrying, and
      // the UI says so instead of showing the dead attempt's failure.
      const children = snapshot.children;
      const baseKey = (child.workerKey ?? child.role ?? "run").split("-retry-")[0];
      const siblings = children.filter(
        (other) =>
          (other.workerKey ?? other.role ?? "run").split("-retry-")[0] === baseKey,
      );
      const superseded = children
        .slice(children.indexOf(child) + 1)
        .some(
          (other) =>
            (other.workerKey ?? other.role ?? "run").split("-retry-")[0] === baseKey,
        );
      const retrying =
        !superseded &&
        siblings
          .slice(0, -1)
          .some((other) => other.status === "failed" || other.status === "cancelled") &&
        !["failed", "cancelled", "succeeded", "completed"].includes(status);
      // A failed attempt that still has tries left is not a failure the user
      // should see. The slot spawns the next attempt on its own.
      const willRetry =
        !superseded &&
        status === "failed" &&
        snapshot.task.phase === "execute" &&
        siblings.length < WORKER_ATTEMPTS;
      const shownStatus = willRetry ? "retrying" : frameStatus;
      workers.push({
        key: child.workerKey ?? child.role ?? "run",
        runId: child.id,
        status: willRetry ? "running" : status,
        ...(superseded ? { superseded: true } : {}),
        ...(retrying || willRetry ? { retrying: true } : {}),
        frames: frameIds.map((id) => ({
          id,
          name: frameName.get(id) ?? "frame",
          status: shownStatus,
        })),
        ...(pendingInteraction !== undefined ? { pendingInteraction } : {}),
      });
    }
    res.json({
      task: {
        id: snapshot.task.id,
        phase: snapshot.task.phase,
        status: snapshot.task.status,
        plan: snapshot.task.plan,
        usage: snapshot.task.usage,
        // The console computes the live turn's elapsed from the task's own
        // start, not from when this tab first rendered it. Its model and
        // effort are the ones its children run.
        createdAt: snapshot.task.createdAt,
        modelId:
          snapshot.children.find((child) => child.modelId.length > 0)?.modelId ?? null,
        effort:
          snapshot.children.find((child) => child.reasoningEffort.length > 0)
            ?.reasoningEffort ?? null,
      },
      workers,
      pendingQuestions,
    });
  });

  app.get("/api/assets/:id/task/log", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const snapshot = await taskSnapshot(db, asset.id);
    const task = snapshot?.task;
    // The asset's own thread is where an ask-only run is recorded: the run
    // belongs to the asset, not to a frame, so the run rows scope it by the
    // thread's asset (`assetHasActiveRun` reads it the same way).
    const [thread] = await db
      .select({ id: generationThreads.id })
      .from(generationThreads)
      .where(eq(generationThreads.assetId, asset.id))
      .limit(1);
    // Every request of this asset's conversation, oldest first: the drawing
    // tasks' children and the ask-only runs. The console shows them as one
    // list of turns, so a refresh re-finds each request in the same place.
    const [tasks, askRuns] = await Promise.all([
      db
        .select({
          id: runTasks.id,
          plan: runTasks.plan,
          usage: runTasks.usage,
          createdAt: runTasks.createdAt,
          finishedAt: runTasks.finishedAt,
        })
        .from(runTasks)
        .where(eq(runTasks.assetId, asset.id))
        .orderBy(asc(runTasks.createdAt)),
      thread === undefined
        ? Promise.resolve([])
        : db
            .select({
              id: generationRuns.id,
              status: generationRuns.status,
              prompt: generationRuns.prompt,
              answer: generationRuns.answer,
              modelId: generationRuns.modelId,
              reasoningEffort: generationRuns.reasoningEffort,
              createdAt: generationRuns.createdAt,
              finishedAt: generationRuns.finishedAt,
              usage: generationRuns.usage,
              events: generationRuns.events,
            })
            .from(generationRuns)
            .where(
              and(eq(generationRuns.threadId, thread.id), isNull(generationRuns.taskId)),
            )
            .orderBy(asc(generationRuns.createdAt)),
    ]);
    const logged = [
      ...(await Promise.all(tasks.map((row) => taskLog(row)))),
      ...askRuns
        .filter((run) => (run.prompt?.trim() ?? "").length > 0)
        .map((run) => askRunLog(run)),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latest = task
      ? (logged.find((item) => item.id === task.id) ?? logged.at(-1))
      : logged.at(-1);
    res.json({
      task: task ? { id: task.id, status: task.status, phase: task.phase } : null,
      prompt: latest?.prompt ?? null,
      plan: task?.plan ?? null,
      runs: latest?.runs ?? [],
      usage: latest?.usage ?? null,
      createdAt: latest?.createdAt ?? null,
      finishedAt: latest?.finishedAt ?? null,
      modelId: latest?.modelId ?? null,
      effort: latest?.effort ?? null,
      earlier: latest ? logged.filter((item) => item.id !== latest.id) : [],
    });
  });

  app.get("/api/tasks/:id/stream", async (req, res) => {
    const taskId = req.params.id ?? "";
    if (!(await taskBelongsTo(db, taskId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That task is not available.");
    }
    const [row] = await db
      .select({ durableTaskId: runTasks.durableTaskId })
      .from(runTasks)
      .where(eq(runTasks.id, taskId));
    if (!row?.durableTaskId) {
      return fail(
        res,
        409,
        "TASK_NOT_STARTED",
        "That task has not reached the worker yet.",
      );
    }
    const after = Number(req.query.after ?? 0);
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/tasks/${row.durableTaskId}/events?after=${after}`,
      { headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` } },
    );
    if (!upstream.ok || !upstream.body)
      return fail(res, 502, "WORKER_UNAVAILABLE", "The drawing stream is not available.");
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        res.write(decoder.decode(chunk.value));
      }
    } catch {
      // The worker died mid-stream; the client rejoins through the snapshot.
    } finally {
      res.end();
    }
  });

  app.post("/api/tasks/:id/steer", async (req, res) => {
    const taskId = req.params.id ?? "";
    if (!(await taskBelongsTo(db, taskId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That task is not available.");
    }
    const body = z
      .object({
        prompt: z.string().min(1).max(4000),
        frameName: z.string().min(1).max(40).optional(),
        // The queue item id. A retried Send now must not deliver twice.
        requestId: z.string().min(1).max(120).optional(),
      })
      .safeParse(req.body);
    if (!body.success)
      return fail(res, 422, "BAD_REQUEST", "A steering message is required.");
    const [row] = await db
      .select({ durableTaskId: runTasks.durableTaskId })
      .from(runTasks)
      .where(eq(runTasks.id, taskId));
    if (!row?.durableTaskId) {
      return fail(
        res,
        409,
        "TASK_NOT_STARTED",
        "That task has not reached the worker yet.",
      );
    }
    // A frame the user anchored needs no decision; free-form steering goes to
    // Jev, which reads the plan and what each worker is doing.
    const [taskRow] = await db
      .select({ assetId: runTasks.assetId })
      .from(runTasks)
      .where(eq(runTasks.id, taskId));
    const snapshot = taskRow?.assetId
      ? await taskSnapshot(db, taskRow.assetId)
      : undefined;
    const plan = (snapshot?.task.plan ?? null) as {
      workers?: Array<{ key: string; frames: string[] }>;
    } | null;
    const frameNames = (snapshot?.frameRows ?? []).map((frame) => frame.name);
    const workers = plan?.workers ?? [];
    let target: string | undefined;
    let frames: string[] | undefined;
    if (body.data.frameName !== undefined) {
      frames = [body.data.frameName];
      target = workers.find((worker) =>
        worker.frames.includes(body.data.frameName as string),
      )?.key;
    } else {
      try {
        const route = await routeSteering(
          body.data.prompt,
          {
            workers,
            frameNames,
            activity: (snapshot?.children ?? []).map((child) => ({
              key: child.workerKey ?? child.role ?? "run",
              status: child.status,
            })),
          },
          {
            apiKey: process.env.DECISION_MODEL_API_KEY,
            model: process.env.DECISION_MODEL,
            baseUrl: process.env.DECISION_MODEL_BASE_URL,
          },
        );
        if (route.confidence >= STEERING_CONFIDENCE) {
          target = route.target === "supervisor" ? undefined : route.target;
          frames = route.frames.length > 0 ? route.frames : undefined;
        } else {
          return res.status(202).json({ routed: "clarify", candidates: frameNames });
        }
      } catch (reason) {
        // Without the router the message still reaches the supervisor; the
        // cause is logged rather than hidden.
        console.error(
          `[steer] routing unavailable: ${reason instanceof Error ? reason.message : "unknown"}`,
        );
      }
    }
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/tasks/${row.durableTaskId}/steer`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          prompt: body.data.prompt,
          ...(body.data.frameName !== undefined
            ? { frameName: body.data.frameName }
            : {}),
          ...(frames !== undefined ? { frames } : {}),
          ...(target !== undefined ? { target } : {}),
          requestId: body.data.requestId ?? randomUUID(),
        }),
      },
    );
    if (!upstream.ok) {
      const detail = (await upstream.json().catch(() => null)) as {
        message?: string;
      } | null;
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The steering message could not be delivered.",
      );
    }
    const routed = (await upstream.json()) as { routed?: string };
    res.status(202).json({ routed: routed.routed ?? "queued" });
  });

  app.post("/api/tasks/:id/cancel", async (req, res) => {
    const taskId = req.params.id ?? "";
    if (!(await taskBelongsTo(db, taskId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That task is not available.");
    }
    const [row] = await db
      .select({ durableTaskId: runTasks.durableTaskId })
      .from(runTasks)
      .where(eq(runTasks.id, taskId));
    if (!row?.durableTaskId) {
      await failTask(db, taskId, "cancelled before the worker accepted it");
      return res.status(204).end();
    }
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/tasks/${row.durableTaskId}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` },
      },
    );
    if (!upstream.ok) {
      const detail = (await upstream.json().catch(() => null)) as {
        message?: string;
      } | null;
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The task could not be cancelled.",
      );
    }
    await db
      .update(runTasks)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(runTasks.id, taskId));
    res.status(204).end();
  });

  app.post("/api/tasks/:id/signal", async (req, res) => {
    const taskId = req.params.id ?? "";
    if (!(await taskBelongsTo(db, taskId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That task is not available.");
    }
    const body = z
      .object({
        name: z.string().min(1),
        value: z.unknown(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 422, "BAD_REQUEST", "A signal name is required.");
    const [row] = await db
      .select({ durableTaskId: runTasks.durableTaskId })
      .from(runTasks)
      .where(eq(runTasks.id, taskId));
    if (!row?.durableTaskId) {
      return fail(
        res,
        409,
        "TASK_NOT_STARTED",
        "That task has not reached the worker yet.",
      );
    }
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/tasks/${row.durableTaskId}/signal`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          name: body.data.name,
          requestId: randomUUID(),
          value: body.data.value,
        }),
      },
    );
    if (!upstream.ok) {
      const detail = (await upstream.json().catch(() => null)) as {
        message?: string;
      } | null;
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The signal could not be delivered.",
      );
    }
    res.status(204).end();
  });

  app.get("/api/runs/recent", async (_req, res) => {
    const bound = alias(assets, "bound_assets");
    const rows = await db
      .select({
        id: generationRuns.id,
        status: generationRuns.status,
        prompt: generationRuns.prompt,
        createdAt: generationRuns.createdAt,
        events: generationRuns.events,
        threadAssetId: generationThreads.assetId,
        assetName: assets.name,
        assetProjectId: assets.projectId,
        boundAssetId: bound.id,
        boundAssetName: bound.name,
        boundAssetProjectId: bound.projectId,
      })
      .from(generationRuns)
      .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
      .leftJoin(assets, eq(generationThreads.assetId, assets.id))
      .leftJoin(frames, eq(generationRuns.frameId, frames.id))
      .leftJoin(bound, eq(frames.assetId, bound.id))
      .where(eq(generationThreads.userId, res.locals.userId as string))
      .orderBy(desc(generationRuns.createdAt))
      .limit(10);
    res.json({
      runs: rows.map((row) => {
        const storedEvents =
          (row.events as Array<{
            type?: string;
            data?: {
              assetId?: unknown;
              projectId?: unknown;
              name?: unknown;
              id?: unknown;
              toolName?: unknown;
            };
          }> | null) ?? [];
        const created = storedEvents
          .filter((event) => event.type === "asset-created")
          .at(-1);
        const eventAssetId =
          typeof created?.data?.assetId === "string" ? created.data.assetId : undefined;
        const eventProjectId =
          typeof created?.data?.projectId === "string"
            ? created.data.projectId
            : undefined;
        const eventName =
          typeof created?.data?.name === "string" ? created.data.name : undefined;
        // The event is authoritative only when it names the asset's project
        // too: an id from the event must never be paired with a thread-derived
        // project or a database name that may belong to a different asset.
        const fromEvent = eventAssetId !== undefined && eventProjectId !== undefined;
        const assetId = fromEvent
          ? eventAssetId
          : (row.threadAssetId ?? row.boundAssetId ?? undefined);
        const projectId = fromEvent
          ? eventProjectId
          : row.threadAssetId
            ? row.assetProjectId
            : row.boundAssetProjectId;
        const assetName = fromEvent ? eventName : (row.assetName ?? row.boundAssetName);
        // A waiting run's pending card travels with the row so the home can
        // restore it without trusting the retained stream to still hold it.
        const pending =
          row.status === "waiting"
            ? (storedEvents.filter((event) => event.type === "interaction").at(-1)
                ?.data ?? undefined)
            : undefined;
        return {
          id: row.id,
          status: row.status,
          prompt: row.prompt,
          createdAt: row.createdAt,
          // A workspace thread keeps assetId NULL; its runs are the ones the
          // home composer can rejoin, an editor run's home is the editor.
          scope: row.threadAssetId === null ? "workspace" : "asset",
          ...(assetId ? { assetId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(assetName ? { assetName } : {}),
          ...(pending !== undefined ? { interaction: pending } : {}),
        };
      }),
    });
  });

  app.get("/api/runs/:id/stream", async (req, res) => {
    const runId = req.params.id ?? "";
    if (!(await runBelongsTo(db, runId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That run is not available.");
    }
    const after = Number(req.query.after ?? 0);
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${runId}/events?after=${after}`,
      { headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` } },
    );
    if (!upstream.ok || !upstream.body)
      return fail(res, 502, "WORKER_UNAVAILABLE", "The drawing stream is not available.");
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        res.write(decoder.decode(chunk.value));
      }
    } catch {
      // The worker died mid-stream. The client treats the closed stream as a
      // drop and rejoins through active-run; nothing to log here.
    } finally {
      res.end();
    }
  });

  app.post("/api/runs/:id/cancel", async (req, res) => {
    const runId = req.params.id ?? "";
    if (!(await runBelongsTo(db, runId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That run is not available.");
    }
    await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` },
      },
    );
    res.status(204).end();
  });

  app.post("/api/runs/:id/respond", async (req, res) => {
    const runId = req.params.id ?? "";
    if (!(await runBelongsTo(db, runId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That run is not available.");
    }
    const body = z
      .object({ interactionId: z.string().min(1), response: z.unknown() })
      .parse(req.body);
    const [row] = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.id, runId));
    if (!row || row.status !== "waiting") {
      return fail(res, 409, "NOT_WAITING", "That run is not waiting for an answer.");
    }
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(
        `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${runId}/respond`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // A connection failure names the cause; the raw fetch error ("fetch
      // failed") tells the caller nothing the status code does not.
      return fail(res, 502, "WORKER_UNAVAILABLE", "The drawing worker is not available.");
    }
    if (!upstream.ok) {
      const detail = (await upstream.json().catch(() => null)) as {
        message?: string;
      } | null;
      // The worker refuses a response the durable runtime no longer matches;
      // pass that conflict through instead of inventing a retry.
      if (upstream.status === 409) {
        return fail(
          res,
          409,
          "NOT_WAITING",
          detail?.message ?? "That run is not waiting for an answer.",
        );
      }
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The drawing worker is not available.",
      );
    }
    res.status(204).end();
  });

  app.post("/api/runs/:id/steer", async (req, res) => {
    const runId = req.params.id ?? "";
    if (!(await runBelongsTo(db, runId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That run is not available.");
    }
    const body = z
      .object({
        messages: z
          .array(
            z.object({
              text: z.string().min(1).max(4000),
              requestId: z.string().min(1).max(120).optional(),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(req.body);
    const [row] = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.id, runId));
    if (!row || !["queued", "running", "waiting"].includes(row.status)) {
      return fail(res, 409, "NOT_ACTIVE", "That run is no longer active.");
    }
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(
        `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${runId}/steer`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      return fail(res, 502, "WORKER_UNAVAILABLE", "The drawing worker is not available.");
    }
    if (!upstream.ok) {
      const detail = (await upstream.json().catch(() => null)) as {
        message?: string;
      } | null;
      // The worker refuses steering a run that already ended; pass that
      // conflict through instead of inventing a retry.
      if (upstream.status === 409) {
        return fail(
          res,
          409,
          "NOT_ACTIVE",
          detail?.message ?? "That run is no longer active.",
        );
      }
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The follow-up was not accepted.",
      );
    }
    const accepted = (await upstream.json().catch(() => null)) as {
      queued?: unknown;
    } | null;
    res.status(202).json({ queued: accepted?.queued ?? 0 });
  });

  app.post("/api/runs/:id/stage-override", async (req, res) => {
    const runId = req.params.id ?? "";
    if (!(await runBelongsTo(db, runId, res.locals.userId as string))) {
      return fail(res, 404, "NOT_FOUND", "That run is not available.");
    }
    // The user's edit of a pending plan, keyed to the card it answers; the
    // worker hydrates it only for that interaction and present_plan consumes it.
    const body = stagedOverrideSchema.safeParse(req.body);
    if (!body.success) {
      return fail(
        res,
        422,
        "INVALID_OVERRIDE",
        "The plan override must name the pending interaction and list 1-24 frames with a name and a description.",
      );
    }
    const [row] = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.id, runId));
    if (!row || row.status !== "waiting") {
      return fail(res, 409, "NOT_WAITING", "That run is not waiting for an answer.");
    }
    // The stored events carry the pending card; when it is derivable, the
    // override must name exactly that interaction, and that interaction must
    // be a plan proposal — a scope edit against any other tool has no meaning.
    const events =
      (row.events as Array<{
        type?: string;
        data?: { id?: unknown; toolName?: unknown };
      }> | null) ?? [];
    const pending = events.filter((event) => event.type === "interaction").at(-1)?.data;
    const pendingId = pending?.id;
    if (typeof pendingId === "string" && pendingId !== body.data.interactionId) {
      return fail(
        res,
        409,
        "STALE_INTERACTION",
        "That plan card is not the run's pending interaction.",
      );
    }
    if (typeof pending?.toolName === "string" && pending.toolName !== "present_plan") {
      return fail(res, 409, "NOT_A_PLAN", "That interaction is not a plan proposal.");
    }
    await db
      .update(generationRuns)
      .set({ override: body.data })
      .where(eq(generationRuns.id, runId));
    res.status(204).end();
  });

  app.get("/api/assets/:id/session", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const thread = await ensureThread(db, res.locals.userId as string, {
      assetId: asset.id,
    });
    // The whole asset conversation's settled spend, for the console header's
    // session totals. The live turn travels on the client's own stream.
    res.json({ session: await sessionUsageForThread(db, thread.id) });
  });

  app.get("/api/assets/:id/active-run", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const thread = await ensureThread(db, res.locals.userId as string, {
      assetId: asset.id,
    });
    const frameId =
      typeof req.query.frameId === "string" && req.query.frameId
        ? req.query.frameId
        : undefined;
    // A live run on this asset is either an editor run through its thread, or
    // a workspace run that bound one of the asset's frames (the same join the
    // mutation guard uses). Both must be surfaced so the editor locks and can
    // rejoin; the thread join keeps the ownership check.
    const [activeRow] = await db
      .select({ run: generationRuns })
      .from(generationRuns)
      .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
      .leftJoin(frames, eq(frames.id, generationRuns.frameId))
      .where(
        and(
          eq(generationThreads.userId, res.locals.userId as string),
          inArray(generationRuns.status, ["queued", "running", "waiting"]),
          or(eq(generationRuns.threadId, thread.id), eq(frames.assetId, asset.id)),
        ),
      )
      .orderBy(desc(generationRuns.createdAt))
      .limit(1);
    const run = activeRow?.run;
    const active = run !== undefined;
    type StoredEvent = {
      sequence: number;
      type: string;
      data?: {
        outcome?: { text?: string };
        id?: string;
        type?: string;
        toolName?: string;
        questions?: unknown;
        input?: unknown;
      };
    };
    // The console's history is scoped to one frame when the editor asks for it;
    // without a frame it falls back to the whole asset.
    const finishedScope = and(
      eq(generationRuns.threadId, thread.id),
      notInArray(generationRuns.status, ["queued", "running", "waiting"]),
      ...(frameId ? [eq(generationRuns.frameId, frameId)] : []),
    );
    let lastRow: typeof run;
    let historyRows: Array<{
      id: string;
      status: string;
      prompt: string | null;
      answer: string | null;
      modelId: string;
      reasoningEffort: string;
      usage: unknown;
      createdAt: Date;
      finishedAt: Date | null;
    }> = [];
    if (!active) {
      [lastRow] = await db
        .select()
        .from(generationRuns)
        .where(finishedScope)
        .orderBy(desc(generationRuns.createdAt))
        .limit(1);
      // The console's earlier-runs list carries the turns a person typed; a
      // drawing task's supervisor/worker/review/fix prompts are machinery and
      // must never read as "you said". A plan run's prompt embeds the user
      // request, so it is recovered the way the decision recovers it.
      historyRows = (
        await db
          .select({
            id: generationRuns.id,
            role: generationRuns.role,
            status: generationRuns.status,
            prompt: generationRuns.prompt,
            answer: generationRuns.answer,
            modelId: generationRuns.modelId,
            reasoningEffort: generationRuns.reasoningEffort,
            usage: generationRuns.usage,
            createdAt: generationRuns.createdAt,
            finishedAt: generationRuns.finishedAt,
          })
          .from(generationRuns)
          .where(
            and(
              finishedScope,
              or(isNull(generationRuns.role), eq(generationRuns.role, "plan")),
            ),
          )
          .orderBy(desc(generationRuns.createdAt))
          .limit(16)
      )
        .flatMap((row) => {
          if (row.role !== null && row.role !== "plan") return [];
          const request =
            row.role === "plan"
              ? userRequestFromPrompt(row.role, row.prompt)
              : (row.prompt?.trim() ?? null);
          if (request === null || request.length === 0) return [];
          return [
            {
              id: row.id,
              status: row.status,
              prompt: request,
              answer: row.answer,
              modelId: row.modelId,
              reasoningEffort: row.reasoningEffort,
              usage: row.usage,
              createdAt: row.createdAt,
              finishedAt: row.finishedAt,
            },
          ];
        })
        .slice(0, 10);
    }
    const events = (lastRow?.events as StoredEvent[] | null) ?? [];
    const text =
      lastRow?.answer ??
      events.find((event) => event.type === "status" && event.data?.outcome?.text)?.data
        ?.outcome?.text ??
      "";
    // A waiting run's newest interaction event is the card the console shows;
    // older ones were already answered.
    const interaction =
      run?.status === "waiting"
        ? (((run.events as StoredEvent[] | null) ?? [])
            .filter((event) => event.type === "interaction")
            .at(-1)?.data ?? null)
        : null;
    res.json({
      run: active ? run : null,
      interaction,
      lastRun: lastRow
        ? {
            id: lastRow.id,
            status: lastRow.status,
            prompt: lastRow.prompt,
            modelId: lastRow.modelId,
            reasoningEffort: lastRow.reasoningEffort,
            createdAt: lastRow.createdAt.toISOString(),
            events,
            text,
            usage: lastRow.usage,
            durationMs: lastRow.finishedAt
              ? new Date(lastRow.finishedAt).getTime() -
                new Date(lastRow.createdAt).getTime()
              : null,
          }
        : null,
      history: historyRows.map((row) => ({
        id: row.id,
        status: row.status,
        prompt: row.prompt,
        answer: row.answer,
        modelId: row.modelId,
        reasoningEffort: row.reasoningEffort,
        createdAt: row.createdAt.toISOString(),
        usage: row.usage,
        durationMs: row.finishedAt
          ? new Date(row.finishedAt).getTime() - new Date(row.createdAt).getTime()
          : null,
      })),
      // The whole asset conversation's settled spend: the console header's
      // session totals, composed with the live run's own stream on the client.
      session: await sessionUsageForThread(db, thread.id),
    });
  });

  app.post("/api/export", async (req, res) => {
    const body = z
      .object({
        scope: z.enum(["frame", "asset", "project"]).default("project"),
        projectId: z.string(),
        assetId: z.string().optional(),
        frameId: z.string().optional(),
        format: z.enum(["pxl", "png", "jpg", "svg", "zip"]),
        scale: scaleSchema.default(1),
        background: z.string().optional(),
      })
      .parse(req.body);
    if (body.scope !== "project" && body.format === "pxl") {
      return fail(
        res,
        422,
        "INVALID",
        "A .pxl document holds a whole project. Choose PNG, JPG, SVG, or ZIP.",
      );
    }
    if (body.scope === "frame" && !(body.assetId && body.frameId)) {
      return fail(res, 400, "INVALID", "Exporting one frame needs an asset and a frame.");
    }
    if (body.scope === "asset" && !body.assetId) {
      return fail(res, 400, "INVALID", "Exporting one asset needs an asset id.");
    }
    const document = await documentForScope(res.locals.userId as string, {
      projectId: body.projectId,
      assetId: body.scope === "project" ? undefined : body.assetId,
      frameId: body.scope === "frame" ? body.frameId : undefined,
    });
    if (!document) return fail(res, 404, "NOT_FOUND", "That project is not available.");
    if (body.format === "pxl") {
      res.setHeader("content-type", "application/vnd.pixelaition+json");
      res.setHeader(
        "content-disposition",
        `attachment; filename="${slug(document.project.name)}.pxl"`,
      );
      return res.send(serializeProject(document));
    }
    const files: Record<string, Uint8Array | string> = {};
    for (const asset of document.assets) {
      for (const frame of asset.frames) {
        const buffer = assetFrameBuffer(asset, frame.id);
        if (!buffer) continue;
        const name = `${slug(asset.name)}-${String(frame.index).padStart(2, "0")}-${slug(frame.name)}`;
        if (body.format === "png" || body.format === "zip")
          files[`${name}.png`] = frameToPng(buffer, body.scale);
        if (body.format === "jpg")
          files[`${name}.jpg`] = frameToJpg(buffer, body.scale, body.background);
        if (body.format === "svg" || body.format === "zip")
          files[`${name}.svg`] = frameToSvg(buffer, body.scale);
      }
    }
    const names = Object.keys(files);
    if (names.length > 1 || body.format === "zip") {
      res.setHeader("content-type", "application/zip");
      res.setHeader(
        "content-disposition",
        `attachment; filename="${slug(document.project.name)}.zip"`,
      );
      return res.send(Buffer.from(zipFiles(files)));
    }
    const only = names[0];
    if (!only) return fail(res, 422, "EXPORT_TOO_LARGE", "There is nothing to export.");
    const contents = files[only];
    res.setHeader("content-disposition", `attachment; filename="${only}"`);
    res.send(
      Buffer.from(
        typeof contents === "string" ? contents : (contents ?? new Uint8Array()),
      ),
    );
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError)
      return fail(res, 400, "INVALID", "The request is missing a required field.");
    console.error(error);
    if (!res.headersSent) fail(res, 500, "INTERNAL", "Something went wrong.");
  });

  return app;
}

async function documentForScope(
  userId: string,
  input: { projectId: string; assetId?: string; frameId?: string },
): Promise<PixelProject | undefined> {
  const project = await getProjectRecord(db, userId, input.projectId);
  if (!project) return undefined;
  const built: PixelProject = {
    format: "pixelaition",
    version: 1,
    project: {
      name: project.name,
      description: project.description,
      style: project.style as StyleGuide,
    },
    assets: [],
  };
  const wanted = input.assetId
    ? project.assets.filter((asset) => asset.id === input.assetId)
    : project.assets;
  if (input.assetId && wanted.length === 0) return undefined;
  for (const asset of wanted) {
    const full = await getAssetRecord(db, userId, asset.id);
    if (!full) continue;
    const frames = input.frameId
      ? full.frames.filter((frame) => frame.id === input.frameId)
      : full.frames;
    if (frames.length === 0) continue;
    built.assets.push({
      id: full.id,
      name: full.name,
      width: full.width,
      height: full.height,
      palette: full.palette as string[],
      frames: frames.map((frame) =>
        bufferToFrame(
          frameToBuffer(frame, full.width, full.height, full.palette as string[]),
          frame,
        ),
      ),
    });
  }
  if (built.assets.length === 0) return undefined;
  return built;
}

async function listModels(): Promise<Array<ModelSpec>> {
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.enabled, true))
    .orderBy(asc(models.position));
  return rows.map((row) => parseModelSpecRow(row));
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export"
  );
}

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
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { auth, db } from "./auth.js";
import {
  decidePrompt,
  DecisionNotConfiguredError,
  LangfuseTelemetry,
  parseModelSpecRow,
  stagedOverrideSchema,
  traceIdFor,
  type DrawDecision,
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
  createApiKey,
  createAssetRecord,
  createProjectRecord,
  deleteFrameRecord,
  duplicateFrameRecord,
  ensureThread,
  getAssetRecord,
  getPreferences,
  getProjectRecord,
  insertRun,
  listProjects,
  moveFrameRecord,
  renameFrameRecord,
  revokeApiKey,
  runBelongsTo,
  saveFrame,
  savePreferences,
  updateAssetRecord,
  userIdForToken,
} from "./store.js";
import { generationRuns, generationThreads, models } from "@pixelaition/db";

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
// frame of its asset, so the mutation routes refuse to write under it.
async function activeRunFor(assetId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: generationRuns.id })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
    .where(
      and(
        eq(generationThreads.assetId, assetId),
        inArray(generationRuns.status, ["queued", "running", "waiting"]),
      ),
    )
    .orderBy(desc(generationRuns.createdAt))
    .limit(1);
  return run !== undefined;
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

export function createApp() {
  const app = express();
  app.use("/api/auth", toNodeHandler(auth));
  app.use(express.json({ limit: "4mb" }));

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
        modelReady: Boolean(process.env.OPENAI_API_KEY?.trim()),
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
        palette: z.array(z.string()).min(2).max(33).optional(),
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

  app.post("/api/runs", async (req, res) => {
    const body = z
      .object({
        assetId: z.string(),
        frameId: z.string(),
        prompt: z.string().min(1).max(4000),
        modelId: z.string().min(1),
        reasoningEffort: z.string().min(1),
      })
      .parse(req.body);
    // Ownership first: the decision call spends the operator's key, so it must
    // not run on behalf of an asset the caller does not own.
    const asset = await getAssetRecord(db, res.locals.userId as string, body.assetId);
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    if (!process.env.OPENAI_API_KEY?.trim()) {
      return fail(
        res,
        503,
        "MODEL_UNCONFIGURED",
        "Add OPENAI_API_KEY on the server to generate.",
      );
    }
    let catalog: ModelSpec[];
    try {
      catalog = await listModels();
    } catch (reason) {
      return fail(
        res,
        503,
        "CATALOG_INVALID",
        reason instanceof Error ? reason.message : "The model catalog is malformed.",
      );
    }
    const pair = catalog.find((model) => model.id === body.modelId);
    if (!pair || !pair.efforts.includes(body.reasoningEffort)) {
      return fail(
        res,
        422,
        "MODEL_NOT_AVAILABLE",
        "Pick a model and effort from the catalog.",
      );
    }
    const decisionModel = process.env.DECISION_MODEL?.trim();
    const decisionApi = catalog.find((model) => model.id === decisionModel)?.api;
    const hasJev = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    if (!hasJev && (!decisionModel || !decisionApi)) {
      return fail(
        res,
        503,
        "DECISION_UNCONFIGURED",
        "Set DECISION_MODEL to a model from the catalog before generating.",
      );
    }
    const thread = await ensureThread(db, res.locals.userId as string, body.assetId);
    const requestId = crypto.randomUUID();
    const decisionStarted = Date.now();
    let decided: DrawDecision;
    try {
      decided = await decidePrompt(body.prompt, {
        typesafeApiKey: process.env.TYPESAFE_API_KEY,
        openaiApiKey: process.env.OPENAI_API_KEY,
        openaiBaseUrl: process.env.OPENAI_BASE_URL,
        decisionModel,
        decisionApi: decisionApi as "chat" | "responses" | undefined,
      });
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
        model: decisionModel ?? "jev",
      },
      {
        name: "decide",
        userId: res.locals.userId as string,
        sessionId: thread.id,
        tags: ["pixelaition", "decide"],
        metadata: { assetId: body.assetId },
      },
    );
    if (decided.intent === "clarify") {
      return fail(
        res,
        422,
        "PROMPT_NEEDS_DETAIL",
        decided.question ?? "Add a subject and a size.",
      );
    }
    const runId = await insertRun(db, {
      threadId: thread.id,
      requestId,
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      frameId: body.frameId,
      prompt: body.prompt,
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
            ...body,
            runId,
            requestId,
            userId: res.locals.userId,
            threadId: thread.id,
          }),
        },
      );
    } catch (reason) {
      // No fallback: the worker never took the run, so it must not stay queued.
      await failUnacceptedRun(runId);
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
      await failUnacceptedRun(runId, detail?.message);
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        detail?.message ?? "The drawing worker is not available.",
      );
    }
    const started = (await worker.json()) as { durableRunId?: string };
    if (started.durableRunId) {
      await db
        .update(generationRuns)
        .set({ durableRunId: started.durableRunId, status: "running" })
        .where(eq(generationRuns.id, runId));
    }
    res.status(202).json({ runId, streamId: runId });
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
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      res.write(decoder.decode(chunk.value));
    }
    res.end();
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
    } catch (reason) {
      return fail(
        res,
        502,
        "WORKER_UNAVAILABLE",
        reason instanceof Error ? reason.message : "The drawing worker is not available.",
      );
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
    // override must name exactly that interaction.
    const events =
      (row.events as Array<{ type?: string; data?: { id?: unknown } }> | null) ?? [];
    const pendingId = events.filter((event) => event.type === "interaction").at(-1)
      ?.data?.id;
    if (typeof pendingId === "string" && pendingId !== body.data.interactionId) {
      return fail(
        res,
        409,
        "STALE_INTERACTION",
        "That plan card is not the run's pending interaction.",
      );
    }
    await db
      .update(generationRuns)
      .set({ override: body.data })
      .where(eq(generationRuns.id, runId));
    res.status(204).end();
  });

  app.get("/api/assets/:id/active-run", async (req, res) => {
    const asset = await getAssetRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const thread = await ensureThread(db, res.locals.userId as string, asset.id);
    const frameId =
      typeof req.query.frameId === "string" && req.query.frameId
        ? req.query.frameId
        : undefined;
    const [run] = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.threadId, thread.id))
      .orderBy(desc(generationRuns.createdAt))
      .limit(1);
    const active =
      run &&
      (run.status === "queued" || run.status === "running" || run.status === "waiting");
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
      historyRows = await db
        .select({
          id: generationRuns.id,
          status: generationRuns.status,
          prompt: generationRuns.prompt,
          answer: generationRuns.answer,
          createdAt: generationRuns.createdAt,
          finishedAt: generationRuns.finishedAt,
        })
        .from(generationRuns)
        .where(finishedScope)
        .orderBy(desc(generationRuns.createdAt))
        .limit(10);
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
            events,
            text,
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
        durationMs: row.finishedAt
          ? new Date(row.finishedAt).getTime() - new Date(row.createdAt).getTime()
          : null,
      })),
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

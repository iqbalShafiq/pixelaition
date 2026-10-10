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
import { eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { auth, db } from "./auth.js";
import { decideFromPrompt } from "@pixelaition/agent";
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
  renameFrameRecord,
  revokeApiKey,
  saveFrame,
  savePreferences,
  updateAssetRecord,
  userIdForToken,
} from "./store.js";
import { generationRuns } from "@pixelaition/db";

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
    res.json({
      models: await listModels(),
      modelReady: Boolean(process.env.OPENAI_API_KEY?.trim()),
      reasoningEfforts: await listReasoningEfforts(),
    });
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
    const asset = await saveFrame(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.frameId ?? "",
      body.layers,
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That frame is not available.");
    res.json(asset);
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
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const asset = await renameFrameRecord(
      db,
      res.locals.userId as string,
      req.params.id ?? "",
      req.params.frameId ?? "",
      body.name,
    );
    if (!asset) return fail(res, 404, "NOT_FOUND", "That frame is not available.");
    res.json(asset);
  });

  app.delete("/api/assets/:id/frames/:frameId", async (req, res) => {
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
    const decision = decideFromPrompt(body.prompt);
    if (decision.intent === "clarify") {
      return fail(
        res,
        422,
        "PROMPT_NEEDS_DETAIL",
        decision.question ?? "Add a subject and a size.",
      );
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      return fail(
        res,
        503,
        "MODEL_UNCONFIGURED",
        "Add OPENAI_API_KEY on the server to generate.",
      );
    }
    const asset = await getAssetRecord(db, res.locals.userId as string, body.assetId);
    if (!asset) return fail(res, 404, "NOT_FOUND", "That asset is not available.");
    const thread = await ensureThread(db, res.locals.userId as string, body.assetId);
    const requestId = crypto.randomUUID();
    const runId = await insertRun(db, {
      threadId: thread.id,
      requestId,
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      status: "queued",
    });
    const worker = await fetch(
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
    if (!worker.ok) {
      const detail = (await worker.json().catch(() => null)) as {
        message?: string;
      } | null;
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
    const after = Number(req.query.after ?? 0);
    const upstream = await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${req.params.id}/events?after=${after}`,
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
    await fetch(
      `${process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002"}/internal/runs/${req.params.id}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` },
      },
    );
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
    const [run] = await db
      .select()
      .from(generationRuns)
      .where(eq(generationRuns.threadId, thread.id));
    res.json({
      run: run && (run.status === "queued" || run.status === "running") ? run : null,
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
        const name = `${slug(asset.name)}-${slug(frame.name)}`;
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

let modelCache: { at: number; models: Array<{ id: string }> } | undefined;

async function listModels(): Promise<Array<{ id: string }>> {
  if (modelCache && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.models;
  const base = process.env.OPENAI_BASE_URL?.replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY;
  const fallback = process.env.OPENAI_MODEL ? [{ id: process.env.OPENAI_MODEL }] : [];
  if (!base || !key) return fallback;
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    const models = (body.data ?? []).map((model) => ({ id: model.id })).slice(0, 200);
    modelCache = { at: Date.now(), models: models.length > 0 ? models : fallback };
    return modelCache.models;
  } catch {
    return fallback;
  }
}

const fallbackEfforts = ["none", "low", "medium", "high"];

let effortCache: { at: number; efforts: string[] } | undefined;

/**
 * The worker owns the reasoning-effort options, because only it knows which
 * controls the configured model actually declares. Falls back to the generic
 * set when the worker is unreachable or the model takes no controls.
 */
async function listReasoningEfforts(): Promise<string[]> {
  if (effortCache && Date.now() - effortCache.at < 5 * 60 * 1000) {
    return effortCache.efforts;
  }
  const base = process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002";
  try {
    const response = await fetch(`${base}/internal/agents`, {
      headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` },
    });
    if (!response.ok) return fallbackEfforts;
    const body = (await response.json()) as { reasoningEfforts?: string[] };
    const efforts = body.reasoningEfforts?.filter(Boolean) ?? [];
    effortCache = {
      at: Date.now(),
      efforts: efforts.length > 0 ? efforts : fallbackEfforts,
    };
    return effortCache.efforts;
  } catch {
    return fallbackEfforts;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export"
  );
}

import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Agent } from "@anvia/core";
import { DurableRuntime } from "@anvia/durable";
import { SqliteDurableStore } from "@anvia/durable/sqlite";
import { OpenAIClient } from "@anvia/openai";
import {
  REASONING_EFFORT_CONTROL_ID,
  defineCompletionModelControls,
} from "@anvia/core/completion";
import {
  bindRun,
  createPixelTools,
  getRun,
  LangfuseTelemetry,
  openCodeGoHeaders,
  parseModelSpecRow,
  pixelInstructions,
  releaseRun,
  selectRunTarget,
  type ModelSpec,
  type RunTarget,
} from "@pixelaition/agent";
import { createDatabase, frames, generationRuns, models } from "@pixelaition/db";
import {
  bufferToFrame,
  defaultStyle,
  encodePixels,
  frameToBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import { asc, eq } from "drizzle-orm";
import express from "express";
import { z } from "zod";

type PublicEvent = {
  sequence: number;
  type: string;
  data: unknown;
};

const agentPrefix = "pixel-draw";

const events = new Map<string, PublicEvent[]>();
const listeners = new Map<string, Set<(event: PublicEvent) => void>>();
// Stroke events carry the whole frame base64-encoded, so an unbounded list would
// hold megabytes per run for the life of the process.
const MAX_RETAINED_EVENTS = 200;
let sequence = 0;

function publish(runId: string, type: string, data: unknown) {
  const event = { sequence: ++sequence, type, data };
  const list = events.get(runId) ?? [];
  list.push(event);
  if (list.length > MAX_RETAINED_EVENTS)
    list.splice(0, list.length - MAX_RETAINED_EVENTS);
  events.set(runId, list);
  for (const listener of listeners.get(runId) ?? []) listener(event);
}

function forgetRun(runId: string) {
  events.delete(runId);
  listeners.delete(runId);
}

const db = createDatabase();
const durablePath = process.env.DURABLE_DATABASE_PATH ?? "./data/anvia-runs.sqlite";
mkdirSync(dirname(durablePath), { recursive: true });

const telemetry =
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
    ? new LangfuseTelemetry({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        ...(process.env.LANGFUSE_BASE_URL
          ? { baseUrl: process.env.LANGFUSE_BASE_URL }
          : {}),
        serviceName: "pixelaition-worker",
      })
    : undefined;

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const baseUrl = process.env.OPENAI_BASE_URL?.trim();
// OpenCode Go requires a stable session header on every request.
const headers = openCodeGoHeaders(baseUrl, randomUUID());
const openai = apiKey
  ? new OpenAIClient({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(headers ? { headers } : {}),
    })
  : undefined;

// The catalog is the database table, seeded by migrations. A malformed row
// fails boot with the row id named; it never becomes a guessed endpoint.
const modelRows = await db
  .select()
  .from(models)
  .where(eq(models.enabled, true))
  .orderBy(asc(models.position));
const specs: ModelSpec[] = modelRows.map((row) => parseModelSpecRow(row));

// The control is declared explicitly so the options survive model ids Anvia
// does not know, such as an OpenRouter slug. The adapter maps it to the
// provider field.
const completions = openai
  ? specs.map((spec) => ({
      spec,
      model: openai.completionModel({
        modelId: spec.id,
        api: spec.api,
        controls: defineCompletionModelControls({
          [REASONING_EFFORT_CONTROL_ID]: {
            type: "select",
            label: "Reasoning effort",
            options: spec.efforts,
          },
        }),
      }),
    }))
  : [];

const observer = telemetry?.observer();

// Durable submits carry no model controls, so one agent is registered per
// model and reasoning effort and the run picks the pair the composer chose.
const agents = completions.flatMap(({ spec, model }) =>
  spec.efforts.map((effort) => ({
    id: `${agentPrefix}:${spec.id}:${effort}`,
    agent: new Agent({
      id: `${agentPrefix}:${spec.id}:${effort}`,
      model,
      instructions: pixelInstructions,
      tools: createPixelTools(),
      maxTurns: 24,
      controls: { reasoningEffort: effort },
      ...(observer
        ? {
            observability: {
              observers: { langfuse: observer },
              primaryTrace: "langfuse",
              errorPolicy: "ignore" as const,
            },
          }
        : {}),
    }),
  })),
);

function agentForTarget(target: RunTarget): Agent | undefined {
  return agents.find(
    (entry) => entry.id === `${agentPrefix}:${target.modelId}:${target.effort}`,
  )?.agent;
}

// A store that cannot be acquired — usually a second worker on the same file —
// must surface as a 503 on every endpoint, not as a crash on boot. The promise
// resolves to undefined rather than rejecting, because a rejection with no
// handler at module scope is an unhandled rejection and Node exits on it.
let durableFailure: string | undefined;

const runtimePromise: Promise<DurableRuntime | undefined> = DurableRuntime.open({
  store: new SqliteDurableStore(durablePath),
  ...(agents.length > 0
    ? {
        agents: agents.map((entry) => ({
          agent: entry.agent,
          version: "1",
          stream: true,
          toolRecovery: toolRecovery(),
        })),
      }
    : {}),
  maxConcurrentRuns: 2,
})
  .then(async (runtime) => {
    await runtime.resume();
    return runtime;
  })
  .catch((reason: unknown) => {
    durableFailure = reason instanceof Error ? reason.message : String(reason);
    console.error(`durable runtime unavailable: ${durableFailure}`);
    return undefined;
  });

async function runtimeOr503(res: express.Response): Promise<DurableRuntime | undefined> {
  const runtime = await runtimePromise;
  if (runtime) return runtime;
  res.status(503).json({
    message: `The drawing worker has no durable store: ${durableFailure ?? "unavailable"}`,
  });
  return undefined;
}

function toolRecovery() {
  return {
    read_project: "safe" as const,
    read_frame: "safe" as const,
    critique_frame: "safe" as const,
    paint_stroke: "idempotent" as const,
    fill_rect: "idempotent" as const,
    set_palette: "idempotent" as const,
    mirror_frame: "idempotent" as const,
  };
}

const app = express();
app.use(express.json({ limit: "2mb" }));

function authorized(req: express.Request): boolean {
  const expected = process.env.WORKER_INTERNAL_TOKEN ?? "";
  return req.header("authorization") === `Bearer ${expected}` && expected.length > 0;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: completions.length > 0,
    durable: durableFailure ? undefined : "ready",
  });
});

app.get("/internal/agents", (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  res.json({
    models: specs.map((spec) => ({ id: spec.id, efforts: spec.efforts })),
    agents: agents.map((entry) => entry.id),
  });
});

app.post("/internal/runs", async (req, res) => {
  if (!authorized(req))
    return res.status(401).json({ message: "Unauthorized worker call." });
  const body = z
    .object({
      runId: z.string(),
      requestId: z.string(),
      assetId: z.string(),
      frameId: z.string(),
      prompt: z.string(),
      modelId: z.string(),
      reasoningEffort: z.string(),
      userId: z.string(),
      threadId: z.string(),
    })
    .parse(req.body);
  const target = selectRunTarget(specs, body.modelId, body.reasoningEffort);
  if (!target) {
    return res.status(422).json({
      message: `Unknown model or effort: ${body.modelId} / ${body.reasoningEffort}.`,
    });
  }
  const chosen = agentForTarget(target);
  if (!chosen || !openai)
    return res.status(503).json({ message: "Add OPENAI_API_KEY to generate." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const asset = await loadAsset(body.assetId);
  if (!asset) return res.status(404).json({ message: "Asset was not found." });
  const frame = asset.frames.find((item) => item.id === body.frameId) ?? asset.frames[0];
  if (!frame) return res.status(404).json({ message: "Frame was not found." });
  const run = await runtime.submit({
    agentId: `${agentPrefix}:${target.modelId}:${target.effort}`,
    sessionId: body.threadId,
    requestId: body.requestId,
    prompt: `${body.prompt}\nStyle: ${JSON.stringify(asset.style)}\nFrame: ${frame.name}`,
  });
  telemetry?.setTraceContext(run.id, {
    name: "draw-sprite",
    userId: body.userId,
    sessionId: body.threadId,
    tags: ["pixelaition", "draw"],
    metadata: {
      assetId: body.assetId,
      frameId: frame.id,
      modelId: target.modelId,
      reasoningEffort: target.effort,
    },
  });
  bindRun(run.id, {
    assetId: body.assetId,
    frameId: frame.id,
    style: asset.style,
    buffer: frameToBuffer(frame, asset.width, asset.height, asset.palette),
    strokes: [],
    issues: [],
    onStroke: (_stroke, buffer) => {
      publish(body.runId, "canvas-stroke", {
        frameId: frame.id,
        layers: buffer.layers.map((layer) => ({
          ...layer,
          pixels: encodePixels(layer.pixels),
        })),
      });
      // Drizzle query promises are lazy: without awaiting or then-ing, the
      // update never executes. Persist explicitly and surface any failure.
      void (async () => {
        try {
          await db
            .update(frames)
            .set({ layers: bufferToFrame(buffer, frame).layers, updatedAt: new Date() })
            .where(eq(frames.id, frame.id));
        } catch (error) {
          console.error("[onStroke] frame persist failed", error);
        }
      })();
    },
  });
  void follow(runtime, run.id, body.runId, target.effort);
  res.status(202).json({ durableRunId: run.id });
});

app.get("/internal/runs/:id/events", (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const runId = req.params.id ?? "";
  const after = Number(req.query.after ?? 0);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  for (const event of events.get(runId) ?? []) {
    if (event.sequence > after) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const sink = (event: PublicEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const set = listeners.get(runId) ?? new Set();
  set.add(sink);
  listeners.set(runId, set);
  // Drop the whole map entry once the last subscriber leaves, not just the sink.
  req.on("close", () => {
    set.delete(sink);
    if (set.size === 0 && !events.has(runId)) listeners.delete(runId);
  });
});

app.post("/internal/runs/:id/cancel", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const [row] = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, req.params.id ?? ""));
  if (row?.durableRunId) runtime.cancel(row.durableRunId);
  res.status(204).end();
});

async function follow(
  runtime: DurableRuntime,
  durableId: string,
  publicId: string,
  effort: string,
) {
  let cursor = 0;
  let finished = false;
  try {
    for (;;) {
      const batch = runtime.events(durableId, cursor);
      for (const event of batch) {
        cursor = event.sequence;
        publish(publicId, event.type, event.data);
      }
      const snapshot = runtime.snapshot(durableId);
      if (["completed", "failed", "cancelled"].includes(snapshot.run.status)) {
        const binding = getRun(durableId);
        await db
          .update(generationRuns)
          .set({
            status:
              snapshot.run.status === "completed" ? "succeeded" : snapshot.run.status,
            finishedAt: new Date(),
          })
          .where(eq(generationRuns.id, publicId));
        publish(publicId, "done", { status: snapshot.run.status, effort });
        finished = true;
        // Telemetry is optional and bounded (5s) so a broken Langfuse cannot
        // delay the run's terminal state beyond the publish above.
        if (telemetry) {
          if (binding) {
            await telemetry.recordScore({
              runId: durableId,
              name: "pixel-critique",
              value: binding.issues.length === 0 ? 1 : 0,
            });
          }
          await telemetry.flush();
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    releaseRun(durableId);
    // Give a subscriber a moment to read the tail, then drop the retained events.
    if (finished) {
      setTimeout(() => forgetRun(publicId), 60_000).unref?.();
    }
  }
}

async function loadAsset(assetId: string) {
  const { assets, projects } = await import("@pixelaition/db");
  const [row] = await db
    .select({ asset: assets, style: projects.style })
    .from(assets)
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(eq(assets.id, assetId));
  if (!row) return undefined;
  const frameRows = await db.select().from(frames).where(eq(frames.assetId, assetId));
  return {
    ...row.asset,
    palette: row.asset.palette as string[],
    style: (row.style as StyleGuide) ?? defaultStyle,
    frames: frameRows.map((frame) => ({
      id: frame.id,
      name: frame.name,
      index: frame.index,
      layers: frame.layers as Array<{
        id: string;
        name: string;
        visible: boolean;
        pixels: string;
      }>,
    })),
  };
}

const port = Number(process.env.WORKER_PORT ?? 4002);
app.listen(port, "0.0.0.0", () => {
  console.log(
    `worker listening on ${port}${completions.length > 0 ? ` with ${agents.length} drawing agents` : ""}`,
  );
});

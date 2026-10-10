import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "@anvia/core";
import { DurableRuntime } from "@anvia/durable";
import { SqliteDurableStore } from "@anvia/durable/sqlite";
import { LangfuseClient } from "@anvia/langfuse";
import { OpenAIClient } from "@anvia/openai";
import {
  REASONING_EFFORT_CONTROL_ID,
  defineCompletionModelControls,
} from "@anvia/core/completion";
import {
  bindRun,
  createPixelTools,
  getRun,
  pixelInstructions,
  releaseRun,
} from "@pixelaition/agent";
import { createDatabase, frames, generationRuns } from "@pixelaition/db";
import {
  bufferToFrame,
  defaultStyle,
  encodePixels,
  frameToBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import { eq } from "drizzle-orm";
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
let sequence = 0;

function publish(runId: string, type: string, data: unknown) {
  const event = { sequence: ++sequence, type, data };
  const list = events.get(runId) ?? [];
  list.push(event);
  events.set(runId, list);
  for (const listener of listeners.get(runId) ?? []) listener(event);
}

const db = createDatabase();
const durablePath = process.env.DURABLE_DATABASE_PATH ?? "./data/anvia-runs.sqlite";
mkdirSync(dirname(durablePath), { recursive: true });

const langfuse =
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
    ? new LangfuseClient({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        ...(process.env.LANGFUSE_BASE_URL
          ? { baseUrl: process.env.LANGFUSE_BASE_URL }
          : {}),
        environment: process.env.NODE_ENV,
      })
    : undefined;

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const baseUrl = process.env.OPENAI_BASE_URL?.trim();
const openai = apiKey
  ? new OpenAIClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) })
  : undefined;

const modelId = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
const genericEfforts = ["none", "low", "medium", "high"];

// The control is declared explicitly so the options survive model ids Anvia does
// not know, such as an OpenRouter slug. The adapter maps it to the provider field.
const model = openai?.completionModel({
  modelId,
  api: baseUrl?.includes("openrouter.ai") ? "chat" : "responses",
  controls: defineCompletionModelControls({
    [REASONING_EFFORT_CONTROL_ID]: {
      type: "select",
      label: "Reasoning effort",
      options: genericEfforts,
    },
  }),
});

const efforts: string[] = [
  ...(model?.controls?.[REASONING_EFFORT_CONTROL_ID]?.options ?? genericEfforts),
];

const observer = langfuse?.observer({ redactInputs: true });

// Durable submits carry no controls, so one agent is registered per effort level
// and the run picks the one the user chose in the composer.
const agents = model
  ? efforts.map((effort) => ({
      id: `${agentPrefix}:${effort}`,
      agent: new Agent({
        id: `${agentPrefix}:${effort}`,
        model,
        instructions: pixelInstructions,
        tools: createPixelTools(),
        maxTurns: 12,
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
    }))
  : [];

const agent = agents[0]?.agent;

function agentForEffort(effort: string): Agent | undefined {
  const match = agents.find((entry) => entry.id === `${agentPrefix}:${effort}`);
  return match?.agent ?? agent;
}

const runtimePromise = DurableRuntime.open({
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
}).then(async (runtime) => {
  await runtime.resume();
  return runtime;
});

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
  res.json({ ok: true, model: Boolean(model) });
});

app.get("/internal/agents", (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  res.json({ reasoningEfforts: efforts, agents: agents.map((entry) => entry.id) });
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
  const chosen = agentForEffort(body.reasoningEffort);
  if (!chosen || !openai)
    return res.status(503).json({ message: "Add OPENAI_API_KEY to generate." });
  const asset = await loadAsset(body.assetId);
  if (!asset) return res.status(404).json({ message: "Asset was not found." });
  const frame = asset.frames.find((item) => item.id === body.frameId) ?? asset.frames[0];
  if (!frame) return res.status(404).json({ message: "Frame was not found." });
  const runtime = await runtimePromise;
  const effort = efforts.includes(body.reasoningEffort)
    ? body.reasoningEffort
    : (efforts[0] ?? "none");
  const run = await runtime.submit({
    agentId: `${agentPrefix}:${effort}`,
    sessionId: body.threadId,
    requestId: body.requestId,
    prompt: `${body.prompt}\nStyle: ${JSON.stringify(asset.style)}\nFrame: ${frame.name}`,
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
      void db
        .update(frames)
        .set({ layers: bufferToFrame(buffer, frame).layers, updatedAt: new Date() })
        .where(eq(frames.id, frame.id));
    },
  });
  void follow(runtime, run.id, body.runId, effort);
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
  req.on("close", () => set.delete(sink));
});

app.post("/internal/runs/:id/cancel", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const runtime = await runtimePromise;
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
        if (langfuse && binding) {
          await langfuse.score({
            traceId: snapshot.run.id,
            name: "pixel-critique",
            value: binding.issues.length === 0 ? 1 : 0,
            dataType: "NUMERIC",
          });
          await langfuse.flush();
        }
        await db
          .update(generationRuns)
          .set({
            status:
              snapshot.run.status === "completed" ? "succeeded" : snapshot.run.status,
            finishedAt: new Date(),
          })
          .where(eq(generationRuns.id, publicId));
        publish(publicId, "done", { status: snapshot.run.status, effort });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    releaseRun(durableId);
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
    `worker listening on ${port}${model ? ` with ${agents.length} drawing agents` : ""}`,
  );
});

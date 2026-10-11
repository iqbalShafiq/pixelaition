import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Agent } from "@anvia/core";
import {
  parseAgentInteractionResponse,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentQuestionPrompt,
} from "@anvia/core/agent/interactions";
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
  stagedOverrideSchema,
  type ModelSpec,
  type RunTarget,
  type StagedPlanOverride,
} from "@pixelaition/agent";
import { createDatabase, assets, frames, generationRuns, models } from "@pixelaition/db";
import {
  bufferToFrame,
  defaultStyle,
  encodePixels,
  frameToBuffer,
  type FrameBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import { asc, and, eq, sql } from "drizzle-orm";
import express from "express";
import { z } from "zod";

type PublicEvent = {
  sequence: number;
  type: string;
  data: unknown;
};

/** What the console needs to answer: no toolCallId, internalCallId, or reason. */
type SanitizedInteraction = {
  id: string;
  type: "tool-approval" | "tool-question";
  toolName: string;
  questions?: readonly AgentQuestionPrompt[];
  input?: unknown;
};

type StoredInteraction = {
  sequence: number;
  data: SanitizedInteraction;
};

const agentPrefix = "pixel-draw";

const events = new Map<string, PublicEvent[]>();
const listeners = new Map<string, Set<(event: PublicEvent) => void>>();
// A suspended run can publish hundreds of events after its interaction, so the
// retained-event bound would evict the pending card. Interactions live in their
// own map until the run is forgotten; the row's stored events carry them, so a
// refresh or a worker restart can restore the card.
const interactions = new Map<string, Map<string, StoredInteraction>>();
// An answered run leaves "waiting" exactly once per suspension; cleared again
// when the run suspends on a new interaction.
const leftWaiting = new Set<string>();
// Stroke events carry the whole frame base64-encoded, so an unbounded list would
// hold megabytes per run for the life of the process.
const MAX_RETAINED_EVENTS = 200;
let sequence = 0;

function publish(runId: string, type: string, data: unknown): PublicEvent {
  const event = { sequence: ++sequence, type, data };
  const list = events.get(runId) ?? [];
  list.push(event);
  if (list.length > MAX_RETAINED_EVENTS)
    list.splice(0, list.length - MAX_RETAINED_EVENTS);
  events.set(runId, list);
  for (const listener of listeners.get(runId) ?? []) listener(event);
  return event;
}

function forgetRun(runId: string) {
  events.delete(runId);
  listeners.delete(runId);
  interactions.delete(runId);
  leftWaiting.delete(runId);
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
    vision: spec.vision,
    agent: new Agent({
      id: `${agentPrefix}:${spec.id}:${effort}`,
      model,
      instructions: pixelInstructions,
      tools: createPixelTools({ vision: spec.vision }),
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
          toolRecovery: toolRecovery(entry.vision),
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

function toolRecovery(vision: boolean) {
  return {
    read_project: "safe" as const,
    read_frame: "safe" as const,
    read_region: "safe" as const,
    critique_frame: "safe" as const,
    check_animation: "safe" as const,
    plan: "safe" as const,
    present_plan: "safe" as const,
    // Only vision agents register preview_frame, and the durable runtime
    // rejects a recovery entry for a tool the agent does not have.
    ...(vision ? { preview_frame: "safe" as const } : {}),
    use_frame: "safe" as const,
    paint_stroke: "idempotent" as const,
    fill_rect: "idempotent" as const,
    set_palette: "idempotent" as const,
    mirror_frame: "idempotent" as const,
    rename_frame: "idempotent" as const,
    move_frame: "idempotent" as const,
    // Adding and deleting frames are not idempotent: a replay would add a
    // second frame or delete a frame that is already gone, so an interruption
    // after the intent is committed needs reconciliation, not a retry.
    add_frame: "manual" as const,
    delete_frame: "manual" as const,
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
    models: specs.map((spec) => ({
      id: spec.id,
      efforts: spec.efforts,
      vision: spec.vision,
    })),
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
  const framesById = new Map(
    asset.frames.map((item) => [
      item.id,
      { id: item.id, name: item.name, index: item.index },
    ]),
  );
  const originFrame = framesById.get(body.frameId);
  if (!originFrame) return res.status(404).json({ message: "Frame was not found." });

  /** Insert one frames row, exactly like store.ts's addFrameRecord does. */
  const insertFrameRow = async (frame: {
    id: string;
    name: string;
    index: number;
    buffer: FrameBuffer;
  }) => {
    await db.insert(frames).values({
      id: frame.id,
      assetId: body.assetId,
      name: frame.name,
      index: frame.index,
      layers: bufferToFrame(frame.buffer, frame).layers,
    });
    framesById.set(frame.id, { id: frame.id, name: frame.name, index: frame.index });
  };

  const run = await runtime.submit({
    agentId: `${agentPrefix}:${target.modelId}:${target.effort}`,
    sessionId: body.threadId,
    requestId: body.requestId,
    prompt: `${body.prompt}\nStyle: ${JSON.stringify(asset.style)}\nFrame: ${originFrame.name}`,
  });
  telemetry?.setTraceContext(run.id, {
    name: "draw-sprite",
    userId: body.userId,
    sessionId: body.threadId,
    tags: ["pixelaition", "draw"],
    metadata: {
      assetId: body.assetId,
      frameId: originFrame.id,
      modelId: target.modelId,
      reasoningEffort: target.effort,
    },
  });
  bindRun(run.id, {
    assetId: body.assetId,
    originFrameId: originFrame.id,
    currentFrameId: originFrame.id,
    frames: new Map(
      asset.frames.map((item) => [
        item.id,
        {
          name: item.name,
          index: item.index,
          buffer: frameToBuffer(item, asset.width, asset.height, asset.palette),
        },
      ]),
    ),
    palette: [...asset.palette],
    width: asset.width,
    height: asset.height,
    style: asset.style,
    approvedScope: new Set([originFrame.id]),
    strokes: [],
    issues: [],
    onStroke: (_stroke, buffer, editedFrameId) => {
      publish(body.runId, "canvas-stroke", {
        frameId: editedFrameId,
        layers: buffer.layers.map((layer) => ({
          ...layer,
          pixels: encodePixels(layer.pixels),
        })),
      });
      // A stroke always targets a frame the binding knows: the origin frame
      // from loadAsset, or one a frame tool inserted and registered below.
      const edited = framesById.get(editedFrameId);
      if (!edited) {
        console.error(`[onStroke] no frame row for ${editedFrameId}`);
        return;
      }
      // Drizzle query promises are lazy: without awaiting or then-ing, the
      // update never executes. Persist explicitly and surface any failure.
      void (async () => {
        try {
          await db
            .update(frames)
            .set({ layers: bufferToFrame(buffer, edited).layers, updatedAt: new Date() })
            .where(eq(frames.id, editedFrameId));
        } catch (error) {
          console.error("[onStroke] frame persist failed", error);
        }
      })();
    },
    // Frame CRUD tools await this before committing their in-memory change, so
    // a row exists before any later stroke targets it. A failed save is logged
    // and rethrown as a bounded cause: the tool call fails and the binding
    // stays put instead of diverging from the database.
    onFrameChange: async (change) => {
      try {
        if (change.type === "add") {
          await insertFrameRow(change.frame);
        } else if (change.type === "delete") {
          await db
            .delete(frames)
            .where(and(eq(frames.id, change.frameId), eq(frames.assetId, body.assetId)));
          framesById.delete(change.frameId);
          // The tool replaced the last frame; the row must go before the
          // replacement takes the same (asset, index) slot.
          if (change.replacement) await insertFrameRow(change.replacement);
        } else if (change.type === "rename") {
          await db
            .update(frames)
            .set({ name: change.name, updatedAt: new Date() })
            .where(and(eq(frames.id, change.frameId), eq(frames.assetId, body.assetId)));
          const row = framesById.get(change.frameId);
          if (row) row.name = change.name;
        } else {
          await db.transaction(async (tx) => {
            // A unique index guards (asset, index), so a direct renumber might
            // collide with a row that has not moved yet. Park every frame far
            // above the final range first, then write the dense order — the
            // same rule store.ts uses for the editor's reorder.
            await tx
              .update(frames)
              .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
              .where(eq(frames.assetId, body.assetId));
            for (const item of change.order) {
              await tx
                .update(frames)
                .set({ index: item.index, updatedAt: new Date() })
                .where(and(eq(frames.id, item.id), eq(frames.assetId, body.assetId)));
            }
          });
          for (const item of change.order) {
            const row = framesById.get(item.id);
            if (row) row.index = item.index;
          }
        }
        await db
          .update(assets)
          .set({ updatedAt: new Date() })
          .where(eq(assets.id, body.assetId));
      } catch (error) {
        console.error("[onFrameChange] frame persist failed", error);
        throw new Error("The frame change could not be saved.");
      }
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

app.post("/internal/runs/:id/respond", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({ interactionId: z.string().min(1), response: z.unknown() })
    .safeParse(req.body);
  if (!body.success)
    return res.status(400).json({ message: "The request is missing a required field." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const [row] = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, req.params.id ?? ""));
  if (!row?.durableRunId)
    return res.status(404).json({ message: "That run is not waiting." });
  let response: AgentInteractionResponse;
  try {
    response = parseAgentInteractionResponse(body.data.response);
  } catch {
    return res.status(400).json({ message: "The response is malformed." });
  }
  // The API stages a user-edited plan against the interaction it answers.
  // Hydrate it into the live binding only for that interaction; present_plan
  // consumes it when it executes. A mismatched or malformed row never seeds a
  // plan.
  const binding = getRun(row.durableRunId);
  let staged: StagedPlanOverride | undefined;
  let malformedOverride = false;
  if (row.override !== null && row.override !== undefined) {
    const parsed = stagedOverrideSchema.safeParse(row.override);
    if (parsed.success) staged = parsed.data;
    else malformedOverride = true;
  }
  const denied = response.type === "tool-approval" && !response.approved;
  // A malformed row cannot seed a plan; a denial clears it below, anything
  // else must fail with the cause named.
  if (malformedOverride && !denied)
    return res.status(422).json({ message: "The staged plan override is malformed." });
  const stagedForResponse =
    staged !== undefined && staged.interactionId === body.data.interactionId;
  if (binding && stagedForResponse) binding.stagedOverride = staged;
  try {
    runtime.respond(row.durableRunId, body.data.interactionId, response);
  } catch (reason) {
    // The runtime refuses a response that does not match the pending
    // interaction: a stale card must re-read the run, never retry blindly.
    return res.status(409).json({
      message:
        reason instanceof Error
          ? reason.message.slice(0, 200)
          : "That interaction is not pending.",
    });
  }
  // A rejected proposal must never seed a later plan: drop the edit outright.
  // An approved one is consumed once present_plan executes, so only the row
  // copy is cleared here — consume-once from the row.
  if (denied && binding) binding.stagedOverride = undefined;
  if (
    (denied || stagedForResponse) &&
    row.override !== null &&
    row.override !== undefined
  ) {
    await db
      .update(generationRuns)
      .set({ override: null })
      .where(eq(generationRuns.id, row.id));
  }
  res.status(204).end();
});

/** Only the events the run console needs, and only the fields it reads. */
function consoleEvents(runId: string, extra: StoredInteraction[] = []) {
  const kept = [
    "model_started",
    "model_completed",
    "tool_started",
    "tool_completed",
    "status",
    "done",
    "interaction",
  ];
  const stored = (events.get(runId) ?? [])
    .filter((event) => kept.includes(event.type))
    .slice(-160)
    .map((event) => ({
      sequence: event.sequence,
      type: event.type,
      data: sanitizeEvent(event.type, event.data),
    }));
  // Interactions that the retained-event bound already evicted are still part
  // of the run's story; merge them back in sequence order.
  const seen = new Set(stored.map((event) => event.sequence));
  for (const entry of extra) {
    if (seen.has(entry.sequence)) continue;
    stored.push({ sequence: entry.sequence, type: "interaction", data: entry.data });
  }
  return stored.sort((a, b) => a.sequence - b.sequence);
}

function interactionsFor(runId: string): StoredInteraction[] {
  return [...(interactions.get(runId)?.values() ?? [])];
}

function rememberInteraction(runId: string, interaction: StoredInteraction) {
  const list = interactions.get(runId) ?? new Map<string, StoredInteraction>();
  list.set(interaction.data.id, interaction);
  interactions.set(runId, list);
}

/**
 * The durable request carries call ids the console never needs. Approval keeps
 * the tool arguments; a question keeps its prompts.
 */
function sanitizeInteraction(request: AgentInteractionRequest): SanitizedInteraction {
  if (request.type === "tool-approval") {
    return {
      id: request.id,
      type: request.type,
      toolName: request.toolName,
      input: request.input,
    };
  }
  return {
    id: request.id,
    type: request.type,
    toolName: request.toolName,
    questions: request.questions,
  };
}

function sanitizeEvent(type: string, raw: unknown): unknown {
  // An interaction payload was already reduced to the console's fields when it
  // was published; nothing here to strip.
  if (type === "interaction") return raw;
  const data = raw as Record<string, unknown> | undefined;
  const operationId =
    typeof data?.operationId === "string" ? data.operationId : undefined;
  if (type === "model_started" || type === "model_completed") return { operationId };
  if (type === "tool_started") {
    const input = data?.input as
      { toolCall?: { toolName?: unknown; input?: unknown } } | undefined;
    return {
      operationId,
      input: {
        toolCall: { toolName: input?.toolCall?.toolName, input: input?.toolCall?.input },
      },
    };
  }
  if (type === "tool_completed") {
    const result = data?.result as
      { failed?: unknown; error?: unknown; output?: unknown } | undefined;
    const output = result?.output as { pairs?: unknown; flags?: unknown } | undefined;
    return {
      operationId,
      result: {
        failed: result?.failed === true,
        error: typeof result?.error === "string" ? result.error : undefined,
        // check_animation's report is large; the console row prints only the
        // pair and flag counts, so only those travel through the stream.
        ...(Array.isArray(output?.pairs) && Array.isArray(output?.flags)
          ? { output: { pairs: output.pairs.length, flags: output.flags.length } }
          : {}),
      },
    };
  }
  if (type === "status") {
    const outcome = data?.outcome as { text?: unknown } | undefined;
    return {
      status: data?.status,
      error: typeof data?.error === "string" ? data.error : undefined,
      ...(typeof outcome?.text === "string" ? { outcome: { text: outcome.text } } : {}),
    };
  }
  if (type === "done") return { status: data?.status };
  return {};
}

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
        // Runtime events are raw: a suspension's status event carries the whole
        // AgentInteractionRequest, call ids included. Sanitize before anything
        // leaves the worker; the SSE path forwards the published payload
        // byte-for-byte.
        publish(publicId, event.type, sanitizeEvent(event.type, event.data));
      }
      const snapshot = runtime.snapshot(durableId);
      // A suspended run is still this run: publish the pending card once per
      // interaction id and persist it, so a refresh or a worker restart can
      // restore it from the row's stored events.
      const outcome = snapshot.run.outcome as
        { type?: string; interaction?: AgentInteractionRequest } | undefined;
      if (
        snapshot.run.status === "waiting" &&
        outcome?.type === "interaction" &&
        outcome.interaction
      ) {
        const interaction = outcome.interaction;
        if (!interactions.get(publicId)?.has(interaction.id)) {
          const published = publish(
            publicId,
            "interaction",
            sanitizeInteraction(interaction),
          );
          rememberInteraction(publicId, {
            sequence: published.sequence,
            data: published.data as SanitizedInteraction,
          });
          leftWaiting.delete(publicId);
          await db
            .update(generationRuns)
            .set({
              status: "waiting",
              events: consoleEvents(publicId, interactionsFor(publicId)),
            })
            .where(eq(generationRuns.id, publicId));
        }
      }
      // An answered run must leave "waiting" or active-run would hand the
      // console an answered card after a remount. The interaction stays in the
      // persisted events; the pending derivation is status-gated. Written once
      // per suspension.
      if (
        (snapshot.run.status === "running" || snapshot.run.status === "queued") &&
        interactionsFor(publicId).length > 0 &&
        !leftWaiting.has(publicId)
      ) {
        leftWaiting.add(publicId);
        await db
          .update(generationRuns)
          .set({ status: "running" })
          .where(eq(generationRuns.id, publicId));
      }
      if (["completed", "failed", "cancelled"].includes(snapshot.run.status)) {
        const binding = getRun(durableId);
        const stored = consoleEvents(publicId, interactionsFor(publicId));
        const outcome = (
          stored.find((event) => event.type === "status")?.data as
            { outcome?: { text?: string } } | undefined
        )?.outcome;
        await db
          .update(generationRuns)
          .set({
            status:
              snapshot.run.status === "completed" ? "succeeded" : snapshot.run.status,
            finishedAt: new Date(),
            events: stored,
            answer: typeof outcome?.text === "string" ? outcome.text : null,
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
  const frameRows = await db
    .select()
    .from(frames)
    .where(eq(frames.assetId, assetId))
    .orderBy(asc(frames.index));
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

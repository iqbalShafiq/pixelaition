import { mkdirSync } from "node:fs";
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
import OpenAI from "openai";
import {
  REASONING_EFFORT_CONTROL_ID,
  defineCompletionModelControls,
} from "@anvia/core/completion";
import {
  bindRun,
  clearGateOutcomes,
  createPixelTools,
  getRun,
  LangfuseTelemetry,
  parseModelSpecRow,
  pixelInstructions,
  releaseRun,
  screenOutput,
  selectRunTarget,
  stagedOverrideSchema,
  traceIdFor,
  type AssetSummary,
  type CreateAssetInput,
  type FrameChange,
  type JevGateCheck,
  type ModelSpec,
  type ProjectSummary,
  type RunAsset,
  type RunTarget,
  type StagedPlanOverride,
  type Stroke,
} from "@pixelaition/agent";
import {
  createDatabase,
  createVersion,
  assets,
  frames,
  generationRuns,
  generationThreads,
  models,
  projects,
} from "@pixelaition/db";
import {
  bufferToFrame,
  createAsset,
  defaultStyle,
  encodePixels,
  frameToBuffer,
  type FrameBuffer,
  type StyleGuide,
} from "@pixelaition/pixel";
import {
  asc,
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import express from "express";
import { z } from "zod";
import { sanitizeEvent } from "./events.js";
import { buildRunPrompt, type RecentRun } from "./prompt.js";

type PublicEvent = {
  sequence: number;
  type: string;
  data: unknown;
};

/**
 * What the console needs to answer: no toolCallId or internalCallId. The
 * reason is kept when one exists — the Jev request check puts its verdict
 * there, and the human deciding a review is the one who needs it.
 */
type SanitizedInteraction = {
  id: string;
  type: "tool-approval" | "tool-question";
  toolName: string;
  reason?: string;
  questions?: readonly AgentQuestionPrompt[];
  input?: unknown;
};

type StoredInteraction = {
  sequence: number;
  data: SanitizedInteraction;
  /** The sequence of the resolved marker once the interaction is answered. */
  resolved?: number;
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

/**
 * One Jev request check lands on the run's own trace with its verdict and
 * cost. Telemetry is optional and must never disturb the run.
 */
function recordGateCheck(durableRunId: string, check: JevGateCheck): void {
  void telemetry?.recordRunSpan({
    traceId: traceIdFor(durableRunId),
    kind: "generation",
    name: "jev-gate",
    startMs: Date.now() - check.durationMs,
    endMs: Date.now(),
    input: check.toolName,
    output: JSON.stringify({ outcome: check.outcome, checks: check.checks }),
    model: check.model,
    ...(check.usage !== undefined ? { usage: { ...check.usage } } : {}),
    ...(check.outcome === "block"
      ? { level: "WARNING" as const, statusMessage: check.reason }
      : {}),
  });
}

/**
 * Screen a run's closing message before it is stored — the output side of the
 * guardrail. A blocked message is withheld, and a message the check could not
 * screen is withheld too with the cause named: an unscreened reply is never
 * stored. The verdict lands on the run's trace as a span and a score.
 */
async function screenAnswer(durableRunId: string, text: unknown): Promise<string | null> {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const started = Date.now();
  try {
    const report = await screenOutput(text, {
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.JEV_MODEL,
    });
    void telemetry?.recordRunSpan({
      traceId: traceIdFor(durableRunId),
      kind: "generation",
      name: "guardrail-output",
      startMs: started,
      endMs: Date.now(),
      input: text.slice(0, 1000),
      output: JSON.stringify({
        action: report.action,
        hazards: report.hazards,
        severity: report.severity,
      }),
      model: process.env.JEV_MODEL,
      ...(report.usage !== undefined ? { usage: { ...report.usage } } : {}),
      ...(report.action !== "pass"
        ? { level: "WARNING" as const, statusMessage: report.reason }
        : {}),
    });
    await telemetry?.recordScore({
      runId: durableRunId,
      name: "guardrail-output",
      value: report.action === "block" ? 0 : report.action === "review" ? 0.5 : 1,
      ...(report.action !== "pass" ? { comment: report.reason } : {}),
    });
    if (report.action === "block") {
      return "This reply was withheld by the content policy.";
    }
    return text;
  } catch (reason) {
    void telemetry?.recordRunSpan({
      traceId: traceIdFor(durableRunId),
      kind: "generation",
      name: "guardrail-output",
      startMs: started,
      endMs: Date.now(),
      input: text.slice(0, 1000),
      output: JSON.stringify({ action: "unscreened" }),
      model: process.env.JEV_MODEL,
      level: "ERROR",
      statusMessage: boundedReason(reason),
    });
    await telemetry?.recordScore({
      runId: durableRunId,
      name: "guardrail-output",
      value: 0,
      comment: `unscreened: ${boundedReason(reason)}`,
    });
    return `The reply could not be screened (${boundedReason(reason)}), so it was withheld.`;
  }
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
const baseUrl = process.env.OPENROUTER_BASE_URL?.trim();
const openai = apiKey
  ? new OpenAIClient({
      // Anvia builds its SDK client with zero retries; one transient 429 in
      // the middle of a long agent run would end the run. The official SDK
      // retries 429s and 5xx with backoff, honoring Retry-After.
      client: new OpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        maxRetries: 2,
      }),
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
      maxTurns: 60,
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
    await recoverInterruptedRuns(runtime);
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
    think: "safe" as const,
    list_projects: "safe" as const,
    list_assets: "safe" as const,
    // Creating an asset mints fresh ids, so an interruption after the insert
    // needs reconciliation rather than a retry.
    create_asset: "manual" as const,
    // Rebinding the same asset is a safe re-run: it only switches the binding.
    use_asset: "safe" as const,
    paint_stroke: "idempotent" as const,
    fill_rect: "idempotent" as const,
    erase_stroke: "idempotent" as const,
    draw_line: "idempotent" as const,
    flood_fill: "idempotent" as const,
    fill_region: "idempotent" as const,
    clear_region: "idempotent" as const,
    replace_color: "idempotent" as const,
    apply_outline: "idempotent" as const,
    dither_rect: "idempotent" as const,
    resize_canvas: "idempotent" as const,
    set_palette: "idempotent" as const,
    rename_layer: "idempotent" as const,
    set_layer_visible: "idempotent" as const,
    mirror_frame: "idempotent" as const,
    rename_frame: "idempotent" as const,
    move_frame: "idempotent" as const,
    // Adding and deleting frames and layers are not idempotent: a replay
    // would add a second frame or layer, or delete one that is already gone,
    // so an interruption after the intent is committed needs reconciliation,
    // not a retry.
    add_frame: "manual" as const,
    delete_frame: "manual" as const,
    add_layer: "manual" as const,
    remove_layer: "manual" as const,
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
      scope: z.enum(["asset", "workspace"]),
      assetId: z.string().optional(),
      frameId: z.string().optional(),
      projectId: z.string().optional(),
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
    return res.status(503).json({ message: "Add OPENROUTER_API_KEY to generate." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;

  // An asset run binds its asset up front. A workspace run stays unbound until
  // a tool picks an asset, so its drawing tools fail closed in the meantime.
  let asset: LoadedAsset | undefined;
  let originFrameId: string | undefined;
  let frameName: string | undefined;
  let style: StyleGuide;
  let recent: RecentRun[];
  if (body.scope === "workspace") {
    const projectId = body.projectId;
    if (!projectId)
      return res.status(422).json({ message: "A workspace run needs a projectId." });
    const project = await loadProject(projectId);
    if (!project) return res.status(404).json({ message: "Project was not found." });
    style = project.style;
    recent = await recentRuns({ projectId });
  } else {
    const assetId = body.assetId;
    const frameId = body.frameId;
    if (!assetId || !frameId)
      return res
        .status(422)
        .json({ message: "An asset run needs an assetId and a frameId." });
    asset = await loadAsset(assetId);
    if (!asset) return res.status(404).json({ message: "Asset was not found." });
    const originFrame = asset.frames.find((frame) => frame.id === frameId);
    if (!originFrame) return res.status(404).json({ message: "Frame was not found." });
    originFrameId = originFrame.id;
    frameName = originFrame.name;
    style = asset.style;
    recent = await recentRuns({ assetId });
  }

  const run = await runtime.submit({
    agentId: `${agentPrefix}:${target.modelId}:${target.effort}`,
    sessionId: body.threadId,
    requestId: body.requestId,
    prompt: buildRunPrompt({
      prompt: body.prompt,
      style,
      ...(frameName !== undefined ? { frameName } : {}),
      recent,
    }),
  });
  telemetry?.setTraceContext(run.id, {
    name: "draw-sprite",
    userId: body.userId,
    sessionId: body.threadId,
    tags: ["pixelaition", "draw"],
    metadata: {
      ...(body.assetId ? { assetId: body.assetId } : {}),
      ...(originFrameId ? { frameId: originFrameId } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
      modelId: target.modelId,
      reasoningEffort: target.effort,
    },
  });
  if (asset && originFrameId) {
    bindAssetRun({
      durableRunId: run.id,
      publicRunId: body.runId,
      assetId: asset.id,
      asset,
      originFrameId,
      request: body.prompt,
    });
  } else if (body.scope === "workspace") {
    // A workspace run starts with no asset; its tools bind one lazily.
    bindWorkspaceRun({
      durableRunId: run.id,
      publicRunId: body.runId,
      userId: body.userId,
      style,
      request: body.prompt,
    });
  }
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
    "interaction-resolved",
    "asset-created",
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
  // of the run's story; merge them back in sequence order, with their resolved
  // marker when one answered them.
  const seen = new Set(stored.map((event) => event.sequence));
  for (const entry of extra) {
    if (seen.has(entry.sequence)) continue;
    seen.add(entry.sequence);
    stored.push({ sequence: entry.sequence, type: "interaction", data: entry.data });
    if (entry.resolved !== undefined && !seen.has(entry.resolved)) {
      seen.add(entry.resolved);
      stored.push({
        sequence: entry.resolved,
        type: "interaction-resolved",
        data: { id: entry.data.id },
      });
    }
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
      ...(request.reason ? { reason: request.reason } : {}),
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

// The sanitizer lives in its own module so its idempotence is unit-testable
// without importing this file's database and runtime side effects.

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
      // persisted events as history; the resolved marker retires it, so a
      // late subscriber replaying from 0 ends in the answered state instead of
      // resurrecting the card. Written once per suspension.
      if (
        (snapshot.run.status === "running" || snapshot.run.status === "queued") &&
        interactionsFor(publicId).length > 0 &&
        !leftWaiting.has(publicId)
      ) {
        leftWaiting.add(publicId);
        const answered = interactionsFor(publicId).at(-1);
        if (answered) {
          const marker = publish(publicId, "interaction-resolved", {
            id: answered.data.id,
          });
          // Remember the marker's sequence on the interaction: the retained
          // event list may evict it long before the row is written, and the
          // persisted history should keep the pair together.
          answered.resolved = marker.sequence;
        }
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
        const answer = await screenAnswer(durableId, outcome?.text);
        await db
          .update(generationRuns)
          .set({
            status:
              snapshot.run.status === "completed" ? "succeeded" : snapshot.run.status,
            finishedAt: new Date(),
            events: stored,
            answer,
          })
          .where(eq(generationRuns.id, publicId));
        // One snapshot per frame the run actually touched, written through the
        // shared createVersion so coalescing and retention both run. A failed
        // insert must not disturb the terminal run state. A workspace run that
        // never bound an asset has nothing to snapshot.
        if (binding?.assetId !== undefined) {
          const assetId = binding.assetId;
          try {
            for (const frameId of binding.touchedFrames) {
              const frame = binding.frames.get(frameId);
              if (!frame) continue;
              await createVersion(db, {
                assetId,
                frameId,
                scope: "frame",
                kind: "run",
                author: "agent",
                runId: publicId,
                snapshot: {
                  name: frame.name,
                  layers: bufferToFrame(frame.buffer, {
                    id: frameId,
                    name: frame.name,
                    index: frame.index,
                  }).layers,
                },
              });
            }
          } catch (reason) {
            console.error(`[follow] run version write failed: ${boundedReason(reason)}`);
          }
        }
        publish(publicId, "done", { status: snapshot.run.status, effort });
        finished = true;
        // Telemetry is optional and bounded (5s) so a broken Langfuse cannot
        // delay the run's terminal state beyond the publish above.
        if (telemetry) {
          // Only a run that drew on an asset has a critique to score.
          if (binding?.assetId !== undefined) {
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
    clearGateOutcomes(durableId);
    // Give a subscriber a moment to read the tail, then drop the retained events.
    if (finished) {
      setTimeout(() => forgetRun(publicId), 60_000).unref?.();
    }
  }
}

async function loadAsset(assetId: string, userId?: string) {
  const { assets, projects } = await import("@pixelaition/db");
  const [row] = await db
    .select({ asset: assets, style: projects.style })
    .from(assets)
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(
      userId === undefined
        ? eq(assets.id, assetId)
        : and(eq(assets.id, assetId), eq(projects.userId, userId)),
    );
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

type LoadedAsset = NonNullable<Awaited<ReturnType<typeof loadAsset>>>;

/** The style guide a workspace run draws under, read from its project. */
async function loadProject(projectId: string) {
  const [row] = await db
    .select({ style: projects.style })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) return undefined;
  return { style: row.style as StyleGuide };
}

/**
 * A follow-up should build on what already happened, so the prompt carries the
 * last finished runs in the same scope. A run still queued, running, or waiting
 * has no answer to show; only finished rows count.
 */
async function recentRuns(scope: { assetId: string } | { projectId: string }) {
  const inScope =
    "assetId" in scope
      ? eq(generationThreads.assetId, scope.assetId)
      : eq(generationThreads.projectId, scope.projectId);
  return db
    .select({ prompt: generationRuns.prompt, answer: generationRuns.answer })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationThreads.id, generationRuns.threadId))
    .where(
      and(inScope, notInArray(generationRuns.status, ["queued", "running", "waiting"])),
    )
    .orderBy(desc(generationRuns.createdAt))
    .limit(3);
}

/** Asset-scoped version snapshot: the metadata plus the frames that existed. */
function assetVersionSnapshot(asset: LoadedAsset) {
  return {
    name: asset.name,
    width: asset.width,
    height: asset.height,
    palette: asset.palette,
    frameIds: asset.frames.map((frame) => frame.id),
  };
}

/** A durable error message that fits one log line. */
function boundedReason(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * The persistence callbacks for one asset's frames, shared by asset runs and
 * workspace runs once they have bound an asset. `onStroke` streams the live
 * frame and writes the frame row; `onFrameChange` writes frame CRUD and its
 * version rows. Frame CRUD tools await onFrameChange before committing their
 * in-memory change, so a row exists before any later stroke targets it; a
 * failed save is logged and rethrown as a bounded cause, so the tool call
 * fails and the binding stays put instead of diverging from the database.
 */
function frameWrites(options: {
  durableRunId: string;
  publicRunId: string;
  assetId: string;
  frames: Array<{ id: string; name: string; index: number }>;
}) {
  const { durableRunId, publicRunId, assetId } = options;
  const framesById = new Map(
    options.frames.map((item) => [
      item.id,
      { id: item.id, name: item.name, index: item.index },
    ]),
  );

  /** Insert one frames row, exactly like store.ts's addFrameRecord does. */
  const insertFrameRow = async (frame: {
    id: string;
    name: string;
    index: number;
    buffer: FrameBuffer;
  }) => {
    await db.insert(frames).values({
      id: frame.id,
      assetId,
      name: frame.name,
      index: frame.index,
      layers: bufferToFrame(frame.buffer, frame).layers,
    });
    framesById.set(frame.id, { id: frame.id, name: frame.name, index: frame.index });
  };

  const onStroke = (
    _stroke: Stroke,
    buffer: FrameBuffer,
    editedFrameId: string,
  ): void => {
    publish(publicRunId, "canvas-stroke", {
      assetId,
      frameId: editedFrameId,
      layers: buffer.layers.map((layer) => ({
        ...layer,
        pixels: encodePixels(layer.pixels),
      })),
    });
    // A stroke always targets a frame the binding knows: a frame from the
    // loaded asset, or one a frame tool inserted and registered below.
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
  };

  const onFrameChange = async (change: FrameChange): Promise<void> => {
    try {
      if (change.type === "add") {
        await insertFrameRow(change.frame);
        await createVersion(db, {
          assetId,
          frameId: change.frame.id,
          scope: "frame",
          kind: "frame-add",
          author: "agent",
          runId: publicRunId,
          snapshot: {
            name: change.frame.name,
            layers: bufferToFrame(change.frame.buffer, change.frame).layers,
          },
        });
      } else if (change.type === "delete") {
        await db
          .delete(frames)
          .where(and(eq(frames.id, change.frameId), eq(frames.assetId, assetId)));
        framesById.delete(change.frameId);
        // The tool replaced the last frame; the row must go before the
        // replacement takes the same (asset, index) slot.
        if (change.replacement) await insertFrameRow(change.replacement);
        // The run row's frame_id pins the asset for the API's active-run
        // guard. When the deleted frame was that pin, it must follow to a
        // frame that still exists — the replacement under the last-frame
        // rule, otherwise the first remaining frame — or the asset would
        // silently unlock mid-run. A pin on another frame is left alone.
        const remaining = [...framesById.values()].sort(
          (left, right) => left.index - right.index,
        );
        const nextPin = change.replacement?.id ?? remaining[0]?.id ?? null;
        await db
          .update(generationRuns)
          .set({ frameId: nextPin })
          .where(
            and(
              eq(generationRuns.id, publicRunId),
              eq(generationRuns.frameId, change.frameId),
            ),
          );
        const after = await loadAsset(assetId);
        if (!after)
          throw new Error("The asset could not be read after the frame change.");
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "frame-delete",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      } else if (change.type === "rename") {
        const live = getRun(durableRunId)?.frames.get(change.frameId);
        if (!live) throw new Error("The frame change could not be saved.");
        await db
          .update(frames)
          .set({ name: change.name, updatedAt: new Date() })
          .where(and(eq(frames.id, change.frameId), eq(frames.assetId, assetId)));
        const row = framesById.get(change.frameId);
        if (row) row.name = change.name;
        await createVersion(db, {
          assetId,
          frameId: change.frameId,
          scope: "frame",
          kind: "rename",
          author: "agent",
          runId: publicRunId,
          snapshot: {
            name: change.name,
            layers: bufferToFrame(live.buffer, {
              id: change.frameId,
              name: change.name,
              index: live.index,
            }).layers,
          },
        });
      } else {
        await db.transaction(async (tx) => {
          // A unique index guards (asset, index), so a direct renumber might
          // collide with a row that has not moved yet. Park every frame far
          // above the final range first, then write the dense order — the
          // same rule store.ts uses for the editor's reorder.
          await tx
            .update(frames)
            .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
            .where(eq(frames.assetId, assetId));
          for (const item of change.order) {
            await tx
              .update(frames)
              .set({ index: item.index, updatedAt: new Date() })
              .where(and(eq(frames.id, item.id), eq(frames.assetId, assetId)));
          }
        });
        for (const item of change.order) {
          const row = framesById.get(item.id);
          if (row) row.index = item.index;
        }
        const after = await loadAsset(assetId);
        if (!after)
          throw new Error("The asset could not be read after the frame change.");
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "frame-move",
          author: "agent",
          runId: publicRunId,
          snapshot: assetVersionSnapshot(after),
        });
      }
      await db
        .update(assets)
        .set({ updatedAt: new Date() })
        .where(eq(assets.id, assetId));
    } catch (error) {
      console.error("[onFrameChange] frame persist failed", error);
      throw new Error("The frame change could not be saved.");
    }
  };

  return { onStroke, onFrameChange };
}

/**
 * Bind a durable run to its asset. Submission and boot recovery share this so a
 * recovered run persists strokes and frame changes exactly like a fresh one.
 */
function bindAssetRun(options: {
  durableRunId: string;
  publicRunId: string;
  assetId: string;
  asset: LoadedAsset;
  originFrameId: string;
  /** The user's own words; absent when the row never recorded them. */
  request?: string;
}): void {
  const { durableRunId, publicRunId, assetId, asset, originFrameId, request } = options;
  const writes = frameWrites({
    durableRunId,
    publicRunId,
    assetId,
    frames: asset.frames,
  });
  bindRun(durableRunId, {
    assetId,
    assetName: asset.name,
    request,
    originFrameId,
    currentFrameId: originFrameId,
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
    approvedScope: new Set([originFrameId]),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    onStroke: writes.onStroke,
    onFrameChange: writes.onFrameChange,
    onJevCheck: (check) => recordGateCheck(durableRunId, check),
  });
}

/**
 * Bind a workspace run before it has an asset. The callbacks let its tools list
 * the user's projects and assets, then create or load one; from that point the
 * run persists strokes and frame changes exactly like an asset run. Ownership
 * is enforced here, from the run owner's id: every query joins on it, so a
 * foreign project or asset fails with a bounded cause instead of leaking.
 */
function bindWorkspaceRun(options: {
  durableRunId: string;
  publicRunId: string;
  userId: string;
  style: StyleGuide;
  /** The user's own words; absent when the row never recorded them. */
  request?: string;
}): void {
  const { durableRunId, publicRunId, userId, style, request } = options;
  let writes: ReturnType<typeof frameWrites> | undefined;

  // The single choke point where a workspace run acquires an asset, used by
  // both create_asset and use_asset. Besides wiring the persistence callbacks,
  // it pins the asset's origin frame on the run row: the API's active-run
  // guard reads generation_runs.frame_id to lock a workspace run's asset while
  // the run is live, since a workspace thread stays project-scoped.
  const register = async (asset: LoadedAsset): Promise<RunAsset> => {
    const framesByIndex = [...asset.frames].sort(
      (left, right) => left.index - right.index,
    );
    const origin = framesByIndex[0];
    if (!origin) throw new Error("That asset has no frames.");
    writes = frameWrites({
      durableRunId,
      publicRunId,
      assetId: asset.id,
      frames: asset.frames,
    });
    await db
      .update(generationRuns)
      .set({ frameId: origin.id })
      .where(eq(generationRuns.id, publicRunId));
    return {
      id: asset.id,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      palette: [...asset.palette],
      style: asset.style,
      frames: framesByIndex.map((frame) => ({
        id: frame.id,
        name: frame.name,
        index: frame.index,
        buffer: frameToBuffer(frame, asset.width, asset.height, asset.palette),
      })),
    };
  };

  const loadOwned = async (ownerId: string, assetId: string): Promise<RunAsset> => {
    const asset = await loadAsset(assetId, ownerId);
    if (!asset) throw new Error("That asset is not available.");
    return register(asset);
  };

  bindRun(durableRunId, {
    request,
    frames: new Map(),
    palette: [],
    style,
    approvedScope: new Set(),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    userId,
    onListProjects: async (ownerId): Promise<ProjectSummary[]> => {
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          updatedAt: projects.updatedAt,
          assetCount: count(assets.id),
        })
        .from(projects)
        .leftJoin(assets, eq(assets.projectId, projects.id))
        .where(eq(projects.userId, ownerId))
        .groupBy(projects.id)
        .orderBy(desc(projects.updatedAt));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        updatedAt: row.updatedAt.toISOString(),
        assetCount: row.assetCount,
      }));
    },
    onListAssets: async (ownerId, projectId): Promise<AssetSummary[]> => {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, ownerId)));
      if (!project) throw new Error("That project is not available.");
      const rows = await db
        .select({
          id: assets.id,
          name: assets.name,
          width: assets.width,
          height: assets.height,
          updatedAt: assets.updatedAt,
          frameCount: count(frames.id),
        })
        .from(assets)
        .leftJoin(frames, eq(frames.assetId, assets.id))
        .where(eq(assets.projectId, projectId))
        .groupBy(assets.id)
        .orderBy(desc(assets.updatedAt));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        width: row.width,
        height: row.height,
        frameCount: row.frameCount,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    onCreateAsset: async (ownerId, input: CreateAssetInput): Promise<RunAsset> => {
      const [project] = await db
        .select({ style: projects.style })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ownerId)));
      if (!project) throw new Error("That project is not available.");
      const asset = createAsset({
        name: input.name,
        width: input.width,
        height: input.height,
        ...(input.palette === undefined ? {} : { palette: input.palette }),
      });
      await db.insert(assets).values({
        id: asset.id,
        projectId: input.projectId,
        name: asset.name,
        width: asset.width,
        height: asset.height,
        palette: asset.palette,
      });
      for (const frame of asset.frames) {
        await db.insert(frames).values({
          id: frame.id,
          assetId: asset.id,
          name: frame.name,
          index: frame.index,
          layers: frame.layers,
        });
      }
      const loaded: LoadedAsset = {
        id: asset.id,
        projectId: input.projectId,
        name: asset.name,
        width: asset.width,
        height: asset.height,
        palette: asset.palette,
        style: project.style as StyleGuide,
        createdAt: new Date(),
        updatedAt: new Date(),
        frames: asset.frames.map((frame) => ({
          id: frame.id,
          name: frame.name,
          index: frame.index,
          layers: frame.layers,
        })),
      };
      const bound = await register(loaded);
      // The console links a workspace run to the asset it made; the event is
      // published once the rows exist and the run is locked to it.
      publish(publicRunId, "asset-created", {
        assetId: asset.id,
        projectId: input.projectId,
        name: asset.name,
        width: asset.width,
        height: asset.height,
        frameCount: asset.frames.length,
      });
      return bound;
    },
    onLoadAsset: loadOwned,
    onStroke: (stroke, buffer, frameId) => {
      if (!writes) throw new Error("The run is not bound to an asset.");
      writes.onStroke(stroke, buffer, frameId);
    },
    onFrameChange: async (change) => {
      if (!writes) throw new Error("The run is not bound to an asset.");
      await writes.onFrameChange(change);
    },
    onJevCheck: (check) => recordGateCheck(durableRunId, check),
  });
}

/**
 * Re-attach the runs the previous process left behind. The durable store holds
 * their continuations, but `follow()` and the tool bindings live in memory, so
 * after a restart a waiting run would never re-publish its card and a resumed
 * run's tools would have no binding. Rebuild both from the database; a row
 * that cannot be recovered is logged and skipped, never a boot failure.
 */
async function recoverInterruptedRuns(runtime: DurableRuntime): Promise<void> {
  let rows: Array<{
    run: typeof generationRuns.$inferSelect;
    assetId: string | null;
    projectId: string | null;
    userId: string;
  }>;
  try {
    rows = await db
      .select({
        run: generationRuns,
        assetId: generationThreads.assetId,
        projectId: generationThreads.projectId,
        userId: generationThreads.userId,
      })
      .from(generationRuns)
      .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
      .where(
        and(
          inArray(generationRuns.status, ["queued", "running", "waiting"]),
          isNotNull(generationRuns.durableRunId),
        ),
      );
  } catch (reason) {
    console.error(`[recovery] could not list interrupted runs: ${boundedReason(reason)}`);
    return;
  }
  for (const { run, assetId, projectId, userId } of rows) {
    const durableRunId = run.durableRunId;
    if (!durableRunId) continue;
    // Idempotent: a run this process already follows is left alone.
    if (getRun(durableRunId)) continue;
    try {
      // The submission path set this context; recovery must rebuild it too so
      // gate and guardrail spans land on the same trace with user and session.
      telemetry?.setTraceContext(durableRunId, {
        name: "draw-sprite",
        userId,
        sessionId: run.threadId,
        tags: ["pixelaition", "draw"],
        metadata: {
          ...(assetId ? { assetId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(run.frameId ? { frameId: run.frameId } : {}),
          modelId: run.modelId,
          reasoningEffort: run.reasoningEffort,
        },
      });
      // A workspace run has no asset to bind until its tools pick one, so its
      // binding starts unbound and its follow loop is rebuilt; its events and
      // terminal state still land.
      if (!assetId) {
        const project = projectId ? await loadProject(projectId) : undefined;
        if (!project) {
          console.error(
            `[recovery] project ${projectId ?? "none"} for run ${run.id} was not found; leaving the run unrecovered`,
          );
          continue;
        }
        bindWorkspaceRun({
          durableRunId,
          publicRunId: run.id,
          userId,
          style: project.style,
          request: run.prompt ?? undefined,
        });
        void follow(runtime, durableRunId, run.id, run.reasoningEffort).catch(
          (reason: unknown) => {
            console.error(`[recovery] run ${run.id} stopped: ${boundedReason(reason)}`);
          },
        );
        console.log(`[recovery] re-attached workspace run ${run.id} (${run.status})`);
        continue;
      }
      const asset = await loadAsset(assetId);
      if (!asset) {
        console.error(
          `[recovery] asset ${assetId} for run ${run.id} was not found; leaving the run unrecovered`,
        );
        continue;
      }
      const originFrameId =
        run.frameId && asset.frames.some((frame) => frame.id === run.frameId)
          ? run.frameId
          : asset.frames[0]?.id;
      if (!originFrameId) {
        console.error(
          `[recovery] asset ${assetId} for run ${run.id} has no frames; leaving the run unrecovered`,
        );
        continue;
      }
      bindAssetRun({
        durableRunId,
        publicRunId: run.id,
        assetId,
        asset,
        originFrameId,
        request: run.prompt ?? undefined,
      });
      void follow(runtime, durableRunId, run.id, run.reasoningEffort).catch(
        (reason: unknown) => {
          console.error(`[recovery] run ${run.id} stopped: ${boundedReason(reason)}`);
        },
      );
      console.log(`[recovery] re-attached run ${run.id} (${run.status})`);
    } catch (reason) {
      console.error(
        `[recovery] run ${run.id} could not be recovered: ${boundedReason(reason)}`,
      );
    }
  }
}

const port = Number(process.env.WORKER_PORT ?? 4002);
app.listen(port, "0.0.0.0", () => {
  console.log(
    `worker listening on ${port}${completions.length > 0 ? ` with ${agents.length} drawing agents` : ""}`,
  );
});

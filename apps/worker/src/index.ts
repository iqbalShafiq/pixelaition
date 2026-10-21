import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, createSummaryMemoryCompactor, estimateMemoryTokens } from "@anvia/core";
import { createQuestionTool } from "@anvia/core/tool";
import type { AgentPrompt } from "@anvia/core/agent";
import type { CompletionModel } from "@anvia/core";
import type { AgentGenerationEndArgs, AgentObserver } from "@anvia/core/observability";
import {
  parseAgentInteractionResponse,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentQuestionPrompt,
} from "@anvia/core/agent/interactions";
import { DurableConflictError, DurableRuntime } from "@anvia/durable";
import { SqliteDurableStore } from "@anvia/durable/sqlite";
import { OpenAIClient } from "@anvia/openai";
import OpenAI from "openai";
import {
  generateCompletion,
  REASONING_EFFORT_CONTROL_ID,
  defineCompletionModelControls,
} from "@anvia/core/completion";
import { frameToPng } from "@pixelaition/export";
import {
  assertRoleAllowsTool,
  searchImagesFor,
  createAssetDrawTask,
  promptText,
  workerAttemptTask,
  type AssetDrawInput,
  type DrawPlan,
  pixelInstructions,
  askInstructions,
  bindRun,
  clearGateOutcomes,
  createPixelTools,
  getRun,
  LangfuseTelemetry,
  openCodeGoHeaders,
  paletteCapacity,
  parseModelSpecRow,
  roleOfKey,
  releaseRun,
  runIdFromOperation,
  screenOutput,
  seesUserImages,
  selectRunTarget,
  artboardDirectorInstructions,
  ARTBOARD_DIRECTOR_TOOLS,
  bindArtboardRun,
  createArtboardTools,
  releaseArtboardRun,
  stagedOverrideSchema,
  traceIdFor,
  PLAN_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  type AssetSummary,
  type CreateAssetInput,
  type JevGateCheck,
  type JevUsage,
  type ModelSpec,
  type ProjectAsset,
  type ProjectSummary,
  type RunAsset,
  type RunTarget,
  type StagedPlanOverride,
} from "@pixelaition/agent";
import {
  createDatabase,
  createVersion,
  artboardSets,
  artboardVersions,
  artboards,
  assets,
  frames,
  generationRuns,
  generationThreads,
  models,
  projects,
  runTasks,
} from "@pixelaition/db";
import {
  buildTemplateScene,
  getPreset,
  sceneSchema,
  syncCopyScene,
  type Artboard,
  type ArtboardSet,
  type CopyDeck,
  type CopyOverride,
  type FormatPreset,
  type SpriteSource,
} from "@pixelaition/artboard";
import {
  MAX_COLORS,
  bufferToFrame,
  createAsset,
  defaultStyle,
  frameToBuffer,
  type Frame,
  type StyleGuide,
} from "@pixelaition/pixel";
import { ne, asc, and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import express from "express";
import { z } from "zod";
import { outcomeTextFrom, sanitizeEvent } from "./events.js";
import { frameWrites } from "./frame-writes.js";
import {
  applyJevUsage,
  applyModelUsage,
  contextFromResponse,
  emptyUsage,
  mergeUsage,
  type ModelUsageLike,
  type RunUsage,
} from "./usage.js";
import {
  buildFrameSummaryPrompt,
  clampSummary,
  createSummarizer,
  SUMMARY_LIMIT,
  type SummaryKind,
} from "./summarize.js";
import { buildRunPrompt, type RecentRun } from "./prompt.js";
import { parseDurableRecord } from "./prior-context.js";
import { askSessionId, composeSessionId } from "./sessions.js";
import {
  buildTaskDeps,
  loadPriorContextFor,
  recentRuns,
  referencesForWorker,
} from "./tasks.js";

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
 * The frames the user has approved are durable state: a worker restart must
 * not re-ask for frames the run was already allowed to draw on.
 */
function persistScope(publicRunId: string, scope: string[]): void {
  void db
    .update(generationRuns)
    .set({ approvedScope: scope })
    .where(eq(generationRuns.id, publicRunId))
    .catch((reason: unknown) => {
      console.error(`[scope] persist failed: ${boundedReason(reason)}`);
    });
}

/**
 * Serialized steering: one message in flight per run. The next message is
 * submitted only after the previous one lands at a turn boundary, so each
 * follow-up gets its own turn (FIFO) instead of arriving as one batch — the
 * delivery contract the durable runtime's drain expects clients to honor.
 */
type PendingSteer = { id: string; text: string };
const steerQueues = new Map<string, PendingSteer[]>();
const steerInFlight = new Map<string, string>();

function submitNextSteer(runtime: DurableRuntime, durableRunId: string): void {
  if (steerInFlight.has(durableRunId)) return;
  const queue = steerQueues.get(durableRunId);
  const next = queue?.shift();
  if (!next) {
    steerQueues.delete(durableRunId);
    return;
  }
  try {
    const receipt = runtime.steer(
      durableRunId,
      { messages: [{ role: "user" as const, content: next.text }] },
      { requestId: next.id },
    );
    steerInFlight.set(durableRunId, receipt.id);
  } catch (reason) {
    console.error(`[steer] delivery refused: ${boundedReason(reason)}`);
    submitNextSteer(runtime, durableRunId);
  }
}

/** The applied receipt releases the next queued message for its own turn. */
function steerApplied(runtime: DurableRuntime, durableRunId: string, id: string): void {
  if (steerInFlight.get(durableRunId) !== id) return;
  steerInFlight.delete(durableRunId);
  submitNextSteer(runtime, durableRunId);
}

/** Drop every pending steer a finished run left behind. */
function clearSteerQueue(durableRunId: string): void {
  steerQueues.delete(durableRunId);
  steerInFlight.delete(durableRunId);
}

/** Durable run id → public run id, so usage events reach the right console. */
const publicIdByDurable = new Map<string, string>();

const usageByRun = new Map<string, RunUsage>();

function usageFor(durableRunId: string): RunUsage {
  const existing = usageByRun.get(durableRunId);
  if (existing) return existing;
  const fresh = emptyUsage();
  usageByRun.set(durableRunId, fresh);
  return fresh;
}

function publishUsage(durableRunId: string): void {
  const publicId = publicIdByDurable.get(durableRunId);
  if (!publicId) return;
  publish(publicId, "usage", { ...usageFor(durableRunId) });
}

/** The API's decision and guardrail calls already spent before the run began. */
function seedUsage(durableRunId: string, usage: Partial<RunUsage> | undefined): void {
  if (!usage) return;
  mergeUsage(usageFor(durableRunId), usage);
  publishUsage(durableRunId);
}

function recordModelUsage(
  durableRunId: string,
  usage: ModelUsageLike | undefined,
  cost: number | undefined,
  context: ReturnType<typeof contextFromResponse>,
): void {
  if (!usage) return;
  applyModelUsage(usageFor(durableRunId), usage, cost, context);
  publishUsage(durableRunId);
}

function recordJevUsage(durableRunId: string, usage: JevUsage | undefined): void {
  if (!usage) return;
  applyJevUsage(usageFor(durableRunId), usage);
  publishUsage(durableRunId);
}

/**
 * Wraps the telemetry observer with per-run usage accounting. Model cost comes
 * from the provider's raw response (`usage.cost`), which the normalized usage
 * drops; Jev reports its own cost through the request-check hook. The context
 * state is Anvia's own `contextUsage`, attached to the response because the
 * model is built with `contextLimits`; the newest one wins.
 */
function usageObserver(base: AgentObserver | undefined): AgentObserver {
  return {
    startRun: async (args) => {
      const inner = await base?.startRun(args);
      return {
        startGeneration: async (generation) => {
          const gen = await inner?.startGeneration?.(generation);
          return {
            ...(gen ?? {}),
            end: (end: AgentGenerationEndArgs) => {
              void gen?.end?.(end);
              const response = end.response as {
                usage?: ModelUsageLike;
                contextUsage?: unknown;
                rawResponse?: { usage?: { cost?: number } };
              };
              const cost = response.rawResponse?.usage?.cost;
              recordModelUsage(
                args.runId,
                response.usage,
                typeof cost === "number" ? cost : undefined,
                contextFromResponse(response.contextUsage),
              );
            },
          };
        },
        startTool: (tool) => inner?.startTool?.(tool),
        end: async (end) => {
          await inner?.end?.(end);
        },
        error: async (error) => {
          await inner?.error?.(error);
        },
      };
    },
  };
}

/**
 * One Jev request check lands on the run's own trace with its verdict and
 * cost. Telemetry is optional and must never disturb the run.
 */
function recordGateCheck(durableRunId: string, check: JevGateCheck): void {
  recordJevUsage(durableRunId, check.usage);
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
      apiKey: process.env.DECISION_MODEL_API_KEY,
      model: process.env.DECISION_MODEL,
      baseUrl: process.env.DECISION_MODEL_BASE_URL,
    });
    recordJevUsage(durableRunId, report.usage);
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
      model: process.env.DECISION_MODEL,
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
      model: process.env.DECISION_MODEL,
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

const apiKey = process.env.AGENT_API_KEY?.trim() ?? "";
const baseUrl = process.env.AGENT_BASE_URL?.trim();
// Pointed at OpenCode Go, that provider asks every client to identify itself
// and keep a stable session so it can route one conversation to the same
// upstream and keep its prompt cache warm. Any other provider, such as
// OpenRouter, gets no extra headers.
const headers = openCodeGoHeaders(baseUrl, randomUUID());
const openai = apiKey
  ? new OpenAIClient({
      // Anvia builds its SDK client with zero retries; one transient 429 in
      // the middle of a long agent run would end the run. The official SDK
      // retries 429s and 5xx with backoff, honoring Retry-After.
      client: new OpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(headers ? { defaultHeaders: headers } : {}),
        // A thinking model on a big tool set can take a long time per turn;
        // the request gets room, and the SDK retries timeouts, 429s, and 5xx
        // with backoff so one slow turn never ends a run.
        timeout: 15 * 60 * 1000,
        maxRetries: 4,
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
// provider field. A cataloged context window rides along as `contextLimits`,
// which is what makes the adapter attach `contextUsage` to every response.
const completions = openai
  ? specs.map((spec) => ({
      spec,
      model: openai.completionModel({
        modelId: spec.id,
        api: spec.api,
        ...(spec.contextWindow !== undefined
          ? { contextLimits: { contextWindow: spec.contextWindow } }
          : {}),
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

/** Web search turns on with its key; a missing key keeps the tools out. */
const webSearch = Boolean(process.env.TAVILY_API_KEY?.trim());

/** Read-only tools the asking-only agent may use: it answers, never paints. */
const ASK_TOOL_NAMES = new Set([
  "read_project",
  "read_frame",
  "read_region",
  "list_formats",
  "read_set",
  "read_artboard",
  "check_artboard",
  "list_project_sprites",
  "list_projects",
  "list_assets",
  "use_asset",
  "think",
  "web_search",
  "view_image",
  "ask_user",
]);

const observability = {
  observers: {
    usage: usageObserver(undefined),
    ...(observer ? { langfuse: observer } : {}),
  },
  primaryTrace: observer ? "langfuse" : "usage",
  errorPolicy: "ignore" as const,
};

/**
 * Task children carry one model and effort, and the role decides the tools.
 * `continueFrom` only continues a child of the same agent, so roles that
 * continue each other's conversation share one agent: the supervisor (plan →
 * review → fix) carries the full catalogue, and each worker runs on a painter
 * agent that carries the painting, transfer and reading tools and nothing
 * structural — a worker is never offered a tool it may not call.
 */
const AGENT_ROLES = ["supervisor", "painter", "ask", "art-director"] as const;
export type AgentRoleName = (typeof AGENT_ROLES)[number];

const ROLE_TOOLS: Record<AgentRoleName, ReadonlySet<string>> = {
  supervisor: PLAN_TOOL_NAMES,
  painter: WORKER_TOOL_NAMES,
  ask: ASK_TOOL_NAMES,
  "art-director": ARTBOARD_DIRECTOR_TOOLS,
};

/**
 * A long plan/review/fix conversation must not lose its early decisions when
 * it grows. The summary compactor reads the transcript when the conversation
 * approaches the model's window and replaces the oldest part with a summary
 * the model wrote; the canonical history stays in the durable run.
 */
function compactionFor(model: CompletionModel, window: number | undefined) {
  if (window === undefined) return undefined;
  return {
    trigger: { afterTokens: Math.floor(window * 0.8) },
    retention: { recentTurns: 2, recentToolTurns: 2 },
    compactor: createSummaryMemoryCompactor({
      model,
      instructions:
        "Summarize this pixel-art task so the supervisor can keep going: the approved plan (frames, intents, layers), every review verdict and fix order, what each fix reported, and what is still open. Keep frame names and numbers exact; drop tool payloads and pixel data.",
    }),
    tokenCounter: (messages: readonly unknown[]) =>
      estimateMemoryTokens(messages as never),
  };
}

// Durable submits carry no model controls, so one agent is registered per
// model, reasoning effort, and role, and a child's spawn picks the trio. Every
// role's tool list is fixed here, so the model only ever sees what it owns.
const agents = completions.flatMap(({ spec, model }) => {
  const questionTool = createQuestionTool();
  const catalogue = createPixelTools({ vision: spec.vision, webSearch });
  const artboardCatalogue = createArtboardTools({ vision: spec.vision });
  const tool = (name: string) => {
    const entry = catalogue.find((candidate) => candidate.name === name);
    if (entry === undefined) return [];
    // ask_user is role-gated like every tool: the gate resolves the run from
    // the "<runId>/<operationKey>" id the durable runtime passes.
    const call = async (args: never, context?: { operationId?: string }) => {
      const operationId = context?.operationId;
      const run =
        operationId === undefined ? undefined : getRun(runIdFromOperation(operationId));
      if (run !== undefined) assertRoleAllowsTool(run, name);
      return entry.call(args, context as never);
    };
    return [{ ...entry, call }];
  };
  const compaction = compactionFor(model, spec.contextWindow);
  return spec.efforts.flatMap((effort) =>
    AGENT_ROLES.map((role) => {
      // Registration order matters for the ask agent only in that its tool
      // list is explicit; every role filters the same catalogue.
      const roleTools =
        role === "art-director"
          ? artboardCatalogue.filter((entry) => ROLE_TOOLS[role].has(entry.name))
          : role === "ask"
            ? [
                ...new Map(
                  [...catalogue, ...artboardCatalogue]
                    .filter((entry) => ROLE_TOOLS.ask.has(entry.name))
                    .map((entry) => [entry.name, entry]),
                ).values(),
              ]
            : catalogue.filter((entry) => ROLE_TOOLS[role].has(entry.name));
      // `ask_user` belongs to the roles that talk to the user; the review
      // answers with its verdict and never interrupts.
      const tools =
        role === "art-director"
          ? [...roleTools, questionTool]
          : role === "ask" || role === "painter"
            ? [...roleTools, ...tool(questionTool.name)]
            : roleTools;
      const id = `${agentPrefix}:${role}:${spec.id}:${effort}`;
      return {
        id,
        role,
        vision: spec.vision,
        tools,
        compaction,
        agent: new Agent({
          id,
          model,
          instructions:
            role === "ask"
              ? askInstructions
              : role === "art-director"
                ? artboardDirectorInstructions
                : pixelInstructions,
          tools,
          // A painting run needs room for many tool rounds; a question is one
          // or two turns. Floor and per-run `maxModelTurns` do the bounding.
          maxTurns: role === "ask" ? 8 : 120,
          controls: { reasoningEffort: effort },
          observability,
        }),
      };
    }),
  );
});

/**
 * The agent id for one role. Plan, review and fix continue each other's
 * conversation, so they all live on the supervisor agent.
 */
function drawAgentId(role: AgentRoleName, target: RunTarget): string {
  return `${agentPrefix}:${role}:${target.modelId}:${target.effort}`;
}

/** The agent a child with this key runs on: workers paint, everyone else supervises. */
export function agentRoleForKey(key: string): AgentRoleName {
  return roleOfKey(key) === "worker" ? "painter" : "supervisor";
}

function agentForTarget(
  target: RunTarget,
  mode: "draw" | "ask" | "compose",
  role: AgentRoleName = "supervisor",
): Agent | undefined {
  if (mode === "ask")
    return agents.find((entry) => entry.id === drawAgentId("ask", target))?.agent;
  if (mode === "compose")
    return agents.find((entry) => entry.id === drawAgentId("art-director", target))
      ?.agent;
  return agents.find((entry) => entry.id === drawAgentId(role, target))?.agent;
}

// --- Entity summaries -------------------------------------------------------
// One short, read-only description per frame, asset, and project. Frames are
// described by the vision model from a rendered PNG; asset and project text
// comes from the cheap chat model. Failures log and keep the old value.

async function loadFrameForSummary(frameId: string) {
  const [row] = await db
    .select({ frame: frames, asset: assets, project: projects })
    .from(frames)
    .innerJoin(assets, eq(frames.assetId, assets.id))
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(eq(frames.id, frameId));
  if (!row) return undefined;
  const palette = row.asset.palette as string[];
  const buffer = frameToBuffer(
    {
      id: row.frame.id,
      name: row.frame.name,
      index: row.frame.index,
      layers: row.frame.layers as Frame["layers"],
    },
    row.asset.width,
    row.asset.height,
    palette,
  );
  return {
    input: {
      assetName: row.asset.name,
      frameName: row.frame.name,
      width: buffer.width,
      height: buffer.height,
      paletteSize: palette.length,
      paintedPixels: buffer.layers.reduce(
        (total, layer) => total + [...layer.pixels].filter((value) => value !== 0).length,
        0,
      ),
    },
    png: Buffer.from(frameToPng(buffer, 4)),
  };
}

async function loadAssetForSummary(assetId: string) {
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!row) return undefined;
  const [project] = await db
    .select({ description: projects.description })
    .from(projects)
    .where(eq(projects.id, row.projectId));
  const frameRows = await db
    .select({ name: frames.name, summary: frames.summary })
    .from(frames)
    .where(eq(frames.assetId, assetId))
    .orderBy(asc(frames.index));
  return {
    name: row.name,
    width: row.width,
    height: row.height,
    paletteSize: (row.palette as string[]).length,
    projectDescription: project?.description ?? "",
    frames: frameRows,
  };
}

async function loadProjectForSummary(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return undefined;
  const assetRows = await db
    .select({ name: assets.name, summary: assets.summary })
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .orderBy(desc(assets.updatedAt));
  return {
    name: row.name,
    description: row.description,
    styleNotes: (row.style as StyleGuide).notes ?? "",
    assets: assetRows,
  };
}

async function saveSummary(
  kind: SummaryKind,
  id: string,
  summary: string,
): Promise<void> {
  const at = new Date();
  if (kind === "frame") {
    await db.update(frames).set({ summary, summaryAt: at }).where(eq(frames.id, id));
    // Cascade: the parent asset reads fresh frame text, then its project.
    const [row] = await db
      .select({ assetId: frames.assetId })
      .from(frames)
      .where(eq(frames.id, id));
    if (row) summarizer?.queue("asset", row.assetId);
  } else if (kind === "asset") {
    await db.update(assets).set({ summary, summaryAt: at }).where(eq(assets.id, id));
    const [row] = await db
      .select({ projectId: assets.projectId })
      .from(assets)
      .where(eq(assets.id, id));
    if (row) summarizer?.queue("project", row.projectId);
  } else {
    await db.update(projects).set({ summary, summaryAt: at }).where(eq(projects.id, id));
  }
}

// The catalog assigns the summary jobs with roles. Capability alone is not a
// choice: selecting by position once picked an enabled test fixture over the
// real vision model, and every frame summary failed with "Model is
// unavailable" while the fixture stayed in the table.
const summaryClient = completions.find((entry) =>
  entry.spec.roles.includes("summary-text"),
);
const visionClient = completions.find((entry) =>
  entry.spec.roles.includes("summary-vision"),
);
if (!summaryClient || !visionClient) {
  console.error(
    "[summary] disabled: " +
      [
        summaryClient ? undefined : "no enabled model carries the summary-text role",
        visionClient ? undefined : "no enabled model carries the summary-vision role",
      ]
        .filter(Boolean)
        .join("; "),
  );
}
// A one-sentence summary never needs deep reasoning; the cheapest declared
// effort keeps the provider's token window for the runs themselves.
const summaryControls = (
  spec: ModelSpec,
): { controls: { reasoningEffort: string } } | Record<string, never> => {
  const effort = spec.efforts[0];
  return effort === undefined ? {} : { controls: { reasoningEffort: effort } };
};
const summarizer =
  summaryClient && visionClient
    ? createSummarizer({
        loadFrame: loadFrameForSummary,
        loadAsset: loadAssetForSummary,
        loadProject: loadProjectForSummary,
        summarizeFrame: async (input) => {
          const started = Date.now();
          const result = await generateCompletion({
            model: visionClient.model,
            ...summaryControls(visionClient.spec),
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: buildFrameSummaryPrompt(input) },
                  {
                    type: "image",
                    image: { type: "data", data: input.png.toString("base64") },
                    mediaType: "image/png",
                  },
                ],
              },
            ],
          });
          const summary = clampSummary(result.output, SUMMARY_LIMIT.frame);
          void telemetry?.recordRunSpan({
            traceId: "summary",
            kind: "generation",
            name: "summarize-frame",
            startMs: started,
            endMs: Date.now(),
            input: input.frameName,
            output: summary,
            model: visionClient.spec.id,
            ...(result.usage !== undefined ? { usage: { ...result.usage } } : {}),
          });
          return summary;
        },
        summarizeText: async (prompt) => {
          const result = await generateCompletion({
            model: summaryClient.model,
            ...summaryControls(summaryClient.spec),
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          });
          return result.output;
        },
        save: saveSummary,
      })
    : undefined;

/** Queue the frames a run touched, their asset, and its project. */
async function queueRunSummaries(
  assetId: string,
  touched: Iterable<string>,
): Promise<void> {
  if (!summarizer) return;
  for (const frameId of touched) summarizer.queue("frame", frameId);
  summarizer.queue("asset", assetId);
  const [row] = await db
    .select({ projectId: assets.projectId })
    .from(assets)
    .where(eq(assets.id, assetId));
  if (row) summarizer.queue("project", row.projectId);
}

/** Fill entities that have no summary yet, bounded per boot. */
async function backfillSummaries(): Promise<void> {
  if (!summarizer) return;
  const [projectRows, assetRows, frameRows] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.summary, ""))
      .orderBy(asc(projects.updatedAt))
      .limit(50),
    db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.summary, ""))
      .orderBy(asc(assets.updatedAt))
      .limit(50),
    db
      .select({ id: frames.id })
      .from(frames)
      .where(eq(frames.summary, ""))
      .orderBy(asc(frames.updatedAt))
      .limit(50),
  ]);
  for (const row of frameRows) summarizer.queue("frame", row.id);
  for (const row of assetRows) summarizer.queue("asset", row.id);
  for (const row of projectRows) summarizer.queue("project", row.id);
}

// A store that cannot be acquired — usually a second worker on the same file —
// must surface as a 503 on every endpoint, not as a crash on boot. The promise
// resolves to undefined rather than rejecting, because a rejection with no
// handler at module scope is an unhandled rejection and Node exits on it.
let durableFailure: string | undefined;

// --- Tasks: watch a durable task, bind its children, persist progress ------

const taskWatchers = new Map<string, AbortController>();
const boundChildRuns = new Set<string>();

/** model and effort parsed from a registered agent id (…:<model>:<effort>). */
/** A plan child spawned after the user already approved. plan-retry has not. */
function planAlreadyApproved(key: string): boolean {
  return /^plan-\d+$/.test(key) || key === "plan-create";
}

/**
 * The review verdict the task's own output recorded, for the console. The
 * durable task record carries the output of a completed task; a failed or
 * cancelled one has none.
 */
function reviewOfTaskRecord(record: unknown): { review?: unknown } | undefined {
  const outcome = (record as { outcome?: { status?: string; output?: unknown } })
    ?.outcome;
  if (outcome?.status !== "completed") return undefined;
  const output = outcome.output as { review?: unknown } | undefined;
  return output?.review === undefined ? undefined : { review: output.review };
}

function modelEffortFromAgentId(agentId: string): { modelId: string; effort: string } {
  const parts = agentId.split(":");
  return {
    effort: parts.at(-1) ?? "medium",
    modelId: parts.at(-2) ?? "unknown",
  };
}

/** Frame ids a child owns: a worker its assignment, plan and review all frames. */
function framesForRole(
  plan: DrawPlan | null,
  role: string,
  workerKey: string | undefined,
  assetFrames: Array<{ id: string; name: string }>,
  prompt: string,
): string[] {
  if (plan === null) {
    // No plan means no frame assignment to read; only the plan/review children
    // have a meaningful single-frame default, and workers are never bound here
    // (the caller waits for the plan).
    return role === "worker" || role === "fix"
      ? []
      : assetFrames.slice(0, 1).map((frame) => frame.id);
  }
  const names =
    role === "worker"
      ? (plan.workers.find((worker) => worker.key === workerKey)?.frames ?? [])
      : role === "fix"
        ? // A fix child names its frame in the prompt; its key is fix-N, not a
          // plan worker key, so the prompt is the reliable source.
          plan.frames
            .filter((frame) => prompt.includes(frame.name))
            .map((frame) => frame.name)
        : plan.frames.map((frame) => frame.name);
  return names
    .map((name) => assetFrames.find((frame) => frame.name === name)?.id)
    .filter((id): id is string => id !== undefined);
}

/**
 * Child events mirror into the task stream so one subscription drives the
 * console tree; strokes stay out because each one carries a whole frame.
 */
/** The text a child has streamed, so a plan card can show the plan it wrote. */
const childText = new Map<string, string>();

/** The last complete JSON object in a text buffer, or null. */
function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.length; end > 1; end -= 1) {
    if (text[end - 1] !== "}") continue;
    for (
      let start = text.lastIndexOf("{", end - 1);
      start >= 0;
      start = text.lastIndexOf("{", start - 1)
    ) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // keep looking left for a brace that starts valid JSON
      }
    }
  }
  return null;
}

/**
 * The approval tool carries only a summary; the plan it approves was written in
 * the child's reply. The card the user sees is enriched here, so a small tool
 * call and a full card travel together.
 */
function enrichInteraction(
  childPublicId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const input = data.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return data;
  const fields = input as Record<string, unknown>;
  if (Array.isArray(fields.frames)) return data;
  const plan = lastJsonObject(childText.get(childPublicId) ?? "");
  if (plan === null || !Array.isArray(plan.frames)) return data;
  return { ...data, input: { ...fields, ...plan } };
}

function mirrorChildEvents(
  taskId: string,
  childPublicId: string,
  workerKey?: string,
): void {
  const set = listeners.get(childPublicId) ?? new Set<(event: PublicEvent) => void>();
  set.add((event) => {
    if (event.type === "canvas-stroke") return;
    if (event.type === "model_delta") {
      const inner = (
        event.data as { event?: { type?: unknown; text?: unknown; delta?: unknown } }
      )?.event;
      const kind = typeof inner?.type === "string" ? inner.type : undefined;
      if (kind === "text" || kind === "text_delta") {
        const piece = inner?.text ?? inner?.delta;
        if (typeof piece === "string") {
          childText.set(
            childPublicId,
            `${childText.get(childPublicId) ?? ""}${piece}`.slice(-24000),
          );
        }
      }
    }
    if (event.type === "error") {
      // A child that dies says why: the envelope carries the provider output
      // kind (invalid-tool-call, truncated-tool-call, ...), the offending tool
      // call id, and the finish reason, so a failure is one readable line.
      const data = event.data as { error?: unknown; usage?: unknown } | undefined;
      const detail = data?.error ?? data;
      console.error(
        `[child] ${workerKey ?? childPublicId} failed: ${JSON.stringify(detail).slice(0, 400)}`,
      );
    }
    const data =
      event.type === "interaction"
        ? enrichInteraction(childPublicId, event.data as Record<string, unknown>)
        : (event.data as Record<string, unknown>);
    publish(taskId, event.type, {
      ...data,
      runId: childPublicId,
      ...(workerKey ? { workerKey } : {}),
    });
  });
  listeners.set(childPublicId, set);
}

/**
 * The agent a child spawns on: the caller's pick when it names one, otherwise
 * the role's agent (workers paint, plan/review/fix supervise).
 */
function agentIdForChild(
  node: { key: string; input?: unknown },
  fallback: string,
): string {
  const chosen = (node.input as { agentId?: unknown } | undefined)?.agentId;
  if (typeof chosen === "string" && chosen.length > 0) return chosen;
  return agentIdForKeyRole(fallback, agentRoleForKey(node.key));
}

/** Swap the role segment of "<prefix>:<role>:<model>:<effort>". */
function agentIdForKeyRole(agentId: string, role: AgentRoleName): string {
  const parts = agentId.split(":");
  if (parts.length < 4) return agentId;
  const [prefix, , ...rest] = parts;
  return [prefix, role, ...rest].join(":");
}

async function bindTaskChild(
  runtime: DurableRuntime,
  durableTaskId: string,
  taskRowId: string,
  input: AssetDrawInput,
  plan: DrawPlan | null,
  node: { key: string; agentRunId?: string; status: string; input?: unknown },
): Promise<void> {
  const childRunId = node.agentRunId;
  if (childRunId === undefined || boundChildRuns.has(childRunId)) return;
  const earlyRole = roleOfKey(node.key);
  if (earlyRole === undefined) {
    console.error(
      `[bind] ${node.key}: no task role reads this key; the child stays unbound`,
    );
    return;
  }
  const earlyWorkerKey =
    earlyRole === "worker" || earlyRole === "fix" ? node.key.split("-")[0] : undefined;
  if (plan === null && (earlyRole === "worker" || earlyRole === "fix")) {
    // A worker's frame assignment lives in the plan. Binding before the plan
    // is readable would guess (the old path handed out the asset's first
    // frame silently, so a worker painted someone else's frame or none at
    // all); staying unbound lets the next scan bind it with the real names.
    console.log(`[bind] ${earlyWorkerKey ?? "?"} deferred: the plan is not readable yet`);
    return;
  }
  boundChildRuns.add(childRunId);
  // Idempotent across a restart: recovery may have bound this child and
  // started its follow loop already, and a second insert would duplicate the
  // row (live finding from the mid-execute kill test).
  if (getRun(childRunId) !== undefined) {
    mirrorChildEvents(durableTaskId, publicIdByDurable.get(childRunId) ?? "", node.key);
    return;
  }
  const [existingRow] = await db
    .select({ id: generationRuns.id })
    .from(generationRuns)
    .where(eq(generationRuns.durableRunId, childRunId));
  const role = roleOfKey(node.key) ?? earlyRole;
  const workerKey =
    role === "worker" || role === "fix" ? node.key.split("-")[0] : undefined;
  const agentId = agentIdForChild(node, input.agentId);
  const { modelId, effort } = modelEffortFromAgentId(agentId);
  const spawnPrompt = promptText(
    (node.input as { prompt?: unknown } | undefined)?.prompt,
  );
  const publicRunId = existingRow?.id ?? crypto.randomUUID();
  publicIdByDurable.set(childRunId, publicRunId);
  // A child without a trace context drops every span; name its trace by role
  // and carry the task id, worker key, and model so a whole tree is readable.
  telemetry?.setTraceContext(childRunId, {
    name:
      role === "plan" ? "draw-plan" : role === "review" ? "draw-review" : `draw-${role}`,
    userId: input.userId,
    sessionId: input.threadId,
    tags: ["pixelaition", "draw", role],
    metadata: {
      taskId: durableTaskId,
      role,
      ...(workerKey !== undefined ? { workerKey } : {}),
      modelId,
      reasoningEffort: effort,
      // The exact prompt the child ran with, on stable metadata: observation
      // inputs are per-event and cannot be used to judge context sufficiency.
      // The durable run keeps the canonical copy; this one is for reading a
      // session back, so it travels whole.
      prompt: spawnPrompt,
    },
  });

  // A workspace task starts unbound; the plan's assetId is the one its plan
  // child created, so children bind to the same asset.
  const boundAssetId = input.assetId ?? plan?.assetId ?? null;
  const asset = boundAssetId === null ? undefined : await loadAsset(boundAssetId);
  const assetFrames =
    asset?.frames.map((frame) => ({ id: frame.id, name: frame.name })) ?? [];
  const ownedFrameIds = framesForRole(plan, role, workerKey, assetFrames, spawnPrompt);
  const fixLayers =
    role === "fix"
      ? (/^Layers: (.+?)\.(?:\s|$)/m.exec(spawnPrompt)?.[1] ?? "")
          .split(",")
          .map((layer) => layer.trim())
          .filter((layer) => layer.length > 0)
      : [];
  if (role === "worker" || role === "fix") {
    const planned =
      plan?.workers.find((worker) => worker.key === workerKey)?.frames ?? [];
    console.log(
      `[bind] ${workerKey ?? "?"} ${role}: plan=${plan === null ? "null" : "yes"} planned=[${planned.join(",")}] asset=[${assetFrames.map((frame) => frame.name).join(",")}] owned=${ownedFrameIds.length}`,
    );
  }

  if (existingRow === undefined) {
    await db.insert(generationRuns).values({
      id: publicRunId,
      threadId: input.threadId,
      // respond/steer/cancel resolve a child by this column, exactly like a
      // single run; without it every interaction answers "not waiting".
      durableRunId: childRunId,
      requestId: childRunId,
      status: "running",
      modelId,
      reasoningEffort: effort,
      frameId: ownedFrameIds[0] ?? null,
      prompt: spawnPrompt,
      taskId: taskRowId,
      role,
      workerKey: node.key,
      frameIds: ownedFrameIds,
    });
  }

  if (
    asset !== undefined &&
    ownedFrameIds.length === 0 &&
    (role === "worker" || role === "fix")
  ) {
    // A writer with nothing to write is a fault of the task, not a quiet empty
    // child: it says so here, where the cause is still known.
    console.error(
      `[bind] ${node.key}: ${role} owns no frame (plan workers: ${JSON.stringify(
        plan?.workers.find((worker) => worker.key === workerKey)?.frames ?? [],
      )})`,
    );
  }
  if (asset !== undefined && ownedFrameIds.length > 0) {
    bindAssetRun({
      durableRunId: childRunId,
      publicRunId,
      assetId: asset.id,
      asset,
      originFrameId: ownedFrameIds[0] as string,
      request: input.request,
      approvedScope: plan === null ? undefined : assetFrames.map((frame) => frame.id),
      role,
      ...(workerKey ? { workerKey } : {}),
      ...(role === "worker" || role === "fix" ? { ownedFrameIds } : {}),
      // A fix is ordered with layers; the prompt names them, and the write
      // guard makes the list binding rather than advisory.
      ...(role === "fix" && fixLayers.length > 0
        ? { ownedLayerNames: new Set(fixLayers) }
        : {}),
      // plan-1 corrects JSON after approval; plan-create only adds the frames.
      // plan-retry is a child that never reached approval, so it may still ask.
      ...(role === "plan" && planAlreadyApproved(node.key) ? { planApproved: true } : {}),
      userId: input.userId,
      project: {
        projectId: asset.projectId,
        projectName: asset.projectName,
        projectAssets: await loadProjectSiblings(asset.projectId, asset.id),
        onLoadProjectAsset: async (assetId: string) =>
          loadProjectAssetForRead(undefined, asset.projectId, assetId),
      },
    });
  } else if (role === "plan") {
    // A workspace task starts with no asset; the plan child binds one lazily.
    bindWorkspaceRun({
      durableRunId: childRunId,
      publicRunId,
      userId: input.userId,
      style: defaultStyle,
      request: input.request,
      role: "plan",
      ...(planAlreadyApproved(node.key) ? { planApproved: true } : {}),
    });
  }

  // The supervisor's search results ride into the worker's view_image
  // allow-list, so it can actually look at the references the plan named.
  if (plan !== null && (role === "worker" || role === "fix") && workerKey !== undefined) {
    const bound = getRun(childRunId);
    if (bound !== undefined) {
      const allowed = searchImagesFor(bound);
      for (const url of referencesForWorker(plan, workerKey)) allowed.add(url);
    }
  }
  mirrorChildEvents(durableTaskId, publicRunId, node.key);
  void follow(runtime, childRunId, publicRunId, effort);
}

async function rollupTaskUsage(taskRowId: string, durableTaskId: string): Promise<void> {
  const children = await db
    .select({ durableRunId: generationRuns.durableRunId })
    .from(generationRuns)
    .where(eq(generationRuns.taskId, taskRowId))
    // Creation order: the newest phase's child (review, then fix) merges last,
    // so the task keeps the newest generation's context state.
    .orderBy(asc(generationRuns.createdAt));
  const seeded = usageFor(durableTaskId);
  const totals = { ...seeded };
  for (const child of children) {
    if (child.durableRunId === null) continue;
    // The in-memory map is dropped when a run ends; the row's persisted usage
    // is the durable record and survives restarts.
    const [row] = await db
      .select({ usage: generationRuns.usage })
      .from(generationRuns)
      .where(eq(generationRuns.durableRunId, child.durableRunId));
    const usage =
      (row?.usage as Partial<RunUsage> | null) ?? usageFor(child.durableRunId);
    mergeUsage(totals, usage);
  }
  await db.update(runTasks).set({ usage: totals }).where(eq(runTasks.id, taskRowId));
  publish(durableTaskId, "usage", { ...totals });
}

type SocialFollowUp = {
  prompt: string;
  modelId: string;
  reasoningEffort: string;
  userId: string;
  threadId: string;
  started?: boolean;
};

/**
 * A natural campaign request draws first. Once those pixel frames are saved,
 * the same asset gets the native-size phase: one compose run creates the
 * Instagram/LinkedIn frames from the pixels the drawing pass just made. The
 * follow-up is recorded on the task, so a restart can see it happened.
 */
async function startComposeFollowUp(
  runtime: DurableRuntime,
  taskId: string,
  taskShape: Record<string, unknown>,
  assetId: string,
  followUp: SocialFollowUp,
): Promise<void> {
  const target = selectRunTarget(specs, followUp.modelId, followUp.reasoningEffort);
  const targetSpec = target
    ? specs.find((spec) => spec.id === target.modelId)
    : undefined;
  if (!target || !targetSpec || !openai) {
    console.error("[compose-followup] the drawing model is no longer available");
    return;
  }
  const nextShape = {
    ...taskShape,
    followUp: { ...followUp, started: true },
  };
  await db.update(runTasks).set({ shape: nextShape }).where(eq(runTasks.id, taskId));

  const publicRunId = randomUUID();
  const requestId = randomUUID();
  const prompt = `${followUp.prompt}

---
The pixel frames for this request are already drawn and saved. Now compose only
the native-size marketing frames the request named (Instagram post, LinkedIn
cover, and similar) from those pixel frames. Do not create or repaint pixel
frames; use them as the source images. Keep the shared copy short and quiet.`;
  await db.insert(generationRuns).values({
    id: publicRunId,
    threadId: followUp.threadId,
    requestId,
    status: "queued",
    modelId: target.modelId,
    reasoningEffort: target.effort,
    prompt,
    mode: "compose",
  });

  const loaded = await loadSocialAssetForRun(assetId, followUp.userId);
  if (!loaded) {
    await db
      .update(generationRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(generationRuns.id, publicRunId));
    console.error("[compose-followup] the asset disappeared before the social phase");
    return;
  }
  const bind = (durableRunId: string) => {
    bindSocialAssetRunFor({
      durableRunId,
      publicRunId,
      loaded,
      userId: followUp.userId,
    });
  };
  bind("");
  let run: Awaited<ReturnType<typeof runtime.submit>>;
  try {
    run = await runtime.submit({
      agentId: drawAgentId("art-director", target),
      sessionId: composeSessionId(
        followUp.threadId,
        `asset:${assetId}`,
        target.modelId,
        targetSpec.api,
      ),
      requestId,
      prompt: buildSocialPrompt(prompt, loaded),
    });
  } catch (reason) {
    await db
      .update(generationRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(generationRuns.id, publicRunId));
    console.error(`[compose-followup] could not start: ${boundedReason(reason)}`);
    return;
  }
  bind(run.id);
  await db
    .update(generationRuns)
    .set({ durableRunId: run.id, status: "running" })
    .where(eq(generationRuns.id, publicRunId));
  publicIdByDurable.set(run.id, publicRunId);
  seedUsage(run.id, undefined);
  telemetry?.setTraceContext(run.id, {
    name: "image-compose",
    userId: followUp.userId,
    sessionId: followUp.threadId,
    tags: ["pixelaition", "image", "compose", "follow-up"],
    metadata: { assetId, modelId: target.modelId, reasoningEffort: target.effort },
  });
  void follow(runtime, run.id, publicRunId, target.effort);
}

async function watchTask(runtime: DurableRuntime, durableTaskId: string): Promise<void> {
  if (taskWatchers.has(durableTaskId)) return;
  const controller = new AbortController();
  taskWatchers.set(durableTaskId, controller);
  const [row] = await db
    .select()
    .from(runTasks)
    .where(eq(runTasks.durableTaskId, durableTaskId));
  if (!row) return;
  try {
    const handle = await runtime.getTask(durableTaskId);
    for await (const _event of handle.stream({ abortSignal: controller.signal })) {
      try {
        const snapshot = await handle.snapshot();
        const record = snapshot.task;
        const graph = await handle.graph();
        const input = record.input as AssetDrawInput;
        const checkpoint = record.checkpoint as { phase?: string; plan?: DrawPlan };
        const plan = checkpoint.plan ?? (row.plan as DrawPlan | null) ?? null;
        const terminal = ["completed", "failed", "cancelled"].includes(record.status);
        await db
          .update(runTasks)
          .set({
            phase: checkpoint.phase ?? row.phase,
            status: record.status,
            ...(checkpoint.plan !== undefined ? { plan: checkpoint.plan } : {}),
            ...(plan !== null && plan.assetId.length > 0
              ? { assetId: plan.assetId }
              : {}),
            ...(terminal ? { finishedAt: new Date() } : {}),
          })
          .where(eq(runTasks.id, row.id));
        publish(durableTaskId, "task-phase", {
          phase: checkpoint.phase ?? row.phase,
          status: record.status,
        });
        for (const node of graph.nodes) {
          if (node.id === record.id) continue;
          // slot-w1 is the retry wrapper. It has no agent of its own; the
          // agent children underneath are the rows the console shows.
          if (node.key.startsWith("slot-")) continue;
          await bindTaskChild(runtime, durableTaskId, row.id, input, plan, {
            key: node.key,
            ...(node.agentRunId !== undefined ? { agentRunId: node.agentRunId } : {}),
            status: node.status,
            input: node.input,
          });
          const nodePrompt =
            typeof (node.input as { prompt?: unknown } | undefined)?.prompt === "string"
              ? (node.input as { prompt: string }).prompt
              : "";
          const nodeRole = roleOfKey(node.key);
          const nodeFrames =
            plan === null || nodeRole === undefined
              ? []
              : nodeRole === "worker"
                ? (plan.workers.find((worker) => worker.key === node.key.split("-")[0])
                    ?.frames ?? [])
                : nodeRole === "fix"
                  ? plan.frames
                      .filter((frame) => nodePrompt.includes(frame.name))
                      .map((frame) => frame.name)
                  : plan.frames.map((frame) => frame.name);
          publish(durableTaskId, node.agentRunId ? "worker-status" : "worker-spawned", {
            workerKey: node.key,
            status: node.status,
            frames: nodeFrames,
          });
        }
        if (terminal) {
          await rollupTaskUsage(row.id, durableTaskId);
          publish(durableTaskId, "task-complete", {
            status: record.status,
            // The reviewer's closing judgement: `ok: false` is an artistic
            // verdict on a finished run, never a system failure.
            ...(reviewOfTaskRecord(record) ?? {}),
          });
          if (record.status === "completed") {
            const shape = (row.shape ?? {}) as {
              followUp?: SocialFollowUp;
              [key: string]: unknown;
            };
            const followUp = shape.followUp;
            const followAssetId = plan?.assetId ?? row.assetId;
            if (followUp && !followUp.started && followAssetId) {
              void startComposeFollowUp(runtime, row.id, shape, followAssetId, followUp);
            }
          }
          break;
        }
      } catch (reason) {
        // A transient failure on one cycle must not end the whole watcher and
        // leave the task row non-terminal (and the asset locked).
        console.error(`[task] watch ${durableTaskId} cycle: ${boundedReason(reason)}`);
      }
    }
  } catch (reason) {
    console.error(`[task] watch ${durableTaskId} stopped: ${boundedReason(reason)}`);
  } finally {
    taskWatchers.delete(durableTaskId);
  }
}

/**
 * One row per drawing task, created the moment the durable task exists so the
 * API and the recovery pass can find it even before a child run starts.
 */
async function recordTaskRow(input: {
  id: string;
  durableTaskId: string;
  threadId: string;
  assetId: string | null;
  shape: { workers: number; review: boolean };
}): Promise<void> {
  // The API already owns the row (id = the request's public run id) and its
  // shape; the worker records the durable id on it. A direct worker call with
  // no row falls back to an insert.
  await db
    .insert(runTasks)
    .values({
      id: input.id,
      threadId: input.threadId,
      assetId: input.assetId,
      status: "running",
      phase: "plan",
      shape: input.shape,
      durableTaskId: input.durableTaskId,
    })
    .onConflictDoUpdate({
      target: runTasks.id,
      set: { durableTaskId: input.durableTaskId, status: "running" },
    });
}

function readDurableDraw(durableId: string) {
  const sqlite = new DatabaseSync(durablePath, { readOnly: true });
  try {
    const row = sqlite
      .prepare("select record from anvia_durable_tasks where id = ?")
      .get(durableId) as { record?: string } | undefined;
    if (typeof row?.record !== "string") return undefined;
    return parseDurableRecord(row.record);
  } catch (reason) {
    console.error(
      `[prior] task ${durableId} could not be read: ${boundedReason(reason)}`,
    );
    return undefined;
  } finally {
    sqlite.close();
  }
}

const assetDraw = createAssetDrawTask(buildTaskDeps(db, readDurableDraw));
/** The runtime once it is open; tools that act on their own run wait for it here. */
let runtimeReady: DurableRuntime | undefined;
const runtimePromise: Promise<DurableRuntime | undefined> = DurableRuntime.open({
  store: new SqliteDurableStore(durablePath),
  ...(agents.length > 0
    ? {
        agents: agents.map((entry) => ({
          agent: entry.agent,
          version: "1",
          stream: true,
          toolRecovery: toolRecovery(entry.tools),
          ...(entry.compaction ? { compaction: entry.compaction } : {}),
        })),
      }
    : {}),
  tasks: [
    { registration: assetDraw.registration },
    { registration: workerAttemptTask.registration },
  ],
  // Four worker-attempt tasks may run beside the parent draw task. A waiting
  // parent releases its slot, so the cap has to fit the workers themselves.
  maxConcurrentRuns: 6,
  maxConcurrentTasks: 8,
  // Reference images travel as base64 media parts; the 1 MB default payload
  // cap would reject a run that carries two or three attachments.
  limits: { maxPayloadBytes: 8 * 1024 * 1024 },
})
  .then(async (runtime) => {
    runtimeReady = runtime;
    // Bindings and follow loops come first: resume() starts pending runs
    // immediately, and a run that executes a tool before its binding exists
    // would see an unbound run (every frame "unapproved") and ask the human
    // for scope it was already granted.
    await recoverInterruptedRuns(runtime);
    await recoverInterruptedTasks(runtime);
    await runtime.resume();
    // Backfill runs in the background: boot never waits on a model call.
    void backfillSummaries().catch((reason) => {
      console.error(`[summary] backfill failed: ${boundedReason(reason)}`);
    });
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

/**
 * Recovery classification for the tools an agent actually has: the durable
 * runtime rejects an entry for a tool the agent does not register, and the
 * asking-only agent carries a strict subset of the drawing toolset, so the
 * map is filtered by tool name.
 */
function toolRecovery(tools: ReadonlyArray<{ name: string }>) {
  const classified = {
    read_project: "safe" as const,
    read_frame: "safe" as const,
    read_region: "safe" as const,
    critique_frame: "safe" as const,
    check_animation: "safe" as const,
    plan: "safe" as const,
    present_plan: "safe" as const,
    preview_frame: "safe" as const,
    // Artboard inspection is read-only too. An interrupted preview must be
    // replayed, not parked behind "uncertain outcome" forever.
    list_formats: "safe" as const,
    read_set: "safe" as const,
    read_artboard: "safe" as const,
    preview_artboard: "safe" as const,
    check_artboard: "safe" as const,
    list_project_sprites: "safe" as const,
    // A repeated search or image fetch is a read: safe to replay.
    web_search: "safe" as const,
    view_image: "safe" as const,
    // A question is a suspension the runtime persists and resumes; a replay
    // after recovery re-publishes the card rather than asking twice.
    ask_user: "safe" as const,
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
  const present = new Set(tools.map((tool) => tool.name));
  return Object.fromEntries(
    Object.entries(classified).filter(([name]) => present.has(name)),
  );
}

const app = express();
// Reference images arrive as base64; the API caps them well below this.
app.use(express.json({ limit: "12mb" }));

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
      userImages: spec.userImages,
    })),
    agents: agents.map((entry) => entry.id),
  });
});

app.post("/internal/summaries/refresh", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({ kind: z.enum(["frame", "asset", "project"]), id: z.string().min(1) })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(422).json({ message: "kind and id are required." });
  }
  if (!summarizer) {
    return res.status(503).json({ message: "Add AGENT_API_KEY to summarize." });
  }
  summarizer.queue(body.data.kind, body.data.id);
  await summarizer.flush();
  res.status(204).end();
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
      // The decision chooses the mode; the run picks the matching agent.
      mode: z.enum(["draw", "ask", "compose"]).default("draw"),
      /** The social set a compose run lays out. */
      setId: z.string().optional(),
      // Jev's shape for the task: how many workers, whether a review round is
      // worth it. The API always sends it; a missing one fails loud below.
      shape: z
        .object({ workers: z.number().int().min(1).max(4), review: z.boolean() })
        .optional(),
      // Reference images ride as media parts; the durable runtime persists them
      // for restart and retry. The web app downscales before sending, and the
      // API validates the sizes again before forwarding.
      attachments: z
        .array(
          z.object({
            mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
            data: z.string().min(16),
          }),
        )
        .max(4)
        .optional(),
      // What the API's decision and guardrail calls already spent; the run's
      // usage starts from these totals.
      usage: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          total: z.number().optional(),
          cached: z.number().optional(),
          cost: z.number().optional(),
          jevCalls: z.number().optional(),
          jevCost: z.number().optional(),
        })
        .optional(),
    })
    .parse(req.body);
  const target = selectRunTarget(specs, body.modelId, body.reasoningEffort);
  if (!target) {
    return res.status(422).json({
      message: `Unknown model or effort: ${body.modelId} / ${body.reasoningEffort}.`,
    });
  }
  const targetSpec = specs.find((spec) => spec.id === target.modelId);
  // `selectRunTarget` returns only catalog pairs, so the spec is always
  // present here; an impossible miss is named rather than defaulted.
  if (targetSpec === undefined) {
    return res.status(422).json({
      message: `Unknown model or effort: ${body.modelId} / ${body.reasoningEffort}.`,
    });
  }
  // The API already refuses this; the worker re-checks so a direct internal
  // call cannot hand pixels to a model that cannot read them.
  if (
    body.attachments !== undefined &&
    body.attachments.length > 0 &&
    !seesUserImages(targetSpec)
  ) {
    return res.status(422).json({
      message: `Model ${target.modelId} cannot read attached images; pick a vision model or remove the attachments.`,
    });
  }
  const chosen = agentForTarget(target, body.mode);
  if (!chosen || !openai)
    return res.status(503).json({ message: "Add AGENT_API_KEY to generate." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;

  if (body.mode === "compose") {
    if (!body.assetId) {
      return res.status(422).json({ message: "A compose run needs an assetId." });
    }
    const legacy = body.setId
      ? await loadArtboardSetForRun(body.setId, body.assetId, body.userId)
      : undefined;
    const social = legacy
      ? undefined
      : await loadSocialAssetForRun(body.assetId, body.userId);
    if (body.setId && !legacy) {
      return res.status(404).json({ message: "That layout was not found." });
    }
    if (!legacy && !social) {
      return res.status(404).json({ message: "That asset was not found." });
    }
    const bind = (durableRunId: string) => {
      if (legacy) {
        bindArtboardRunFor({
          durableRunId,
          publicRunId: body.runId,
          loaded: legacy,
          userId: body.userId,
        });
      } else if (social) {
        bindSocialAssetRunFor({
          durableRunId,
          publicRunId: body.runId,
          loaded: social,
          userId: body.userId,
        });
      }
    };
    bind("");
    const promptText = legacy
      ? buildArtboardPrompt(body.prompt, legacy)
      : buildSocialPrompt(body.prompt, social!);
    const mediaParts = body.attachments ?? [];
    const prompt: AgentPrompt =
      mediaParts.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: promptText },
              ...mediaParts.map((attachment) => ({
                type: "image" as const,
                image: { type: "data" as const, data: attachment.data },
                mediaType: attachment.mediaType,
              })),
            ],
          }
        : promptText;
    let run: Awaited<ReturnType<typeof runtime.submit>>;
    try {
      run = await runtime.submit({
        agentId: drawAgentId("art-director", target),
        sessionId: composeSessionId(
          body.threadId,
          legacy?.set.id ?? `asset:${body.assetId}`,
          target.modelId,
          targetSpec.api,
        ),
        requestId: body.requestId,
        prompt,
      });
    } catch (reason) {
      if (reason instanceof DurableConflictError) {
        return res.status(409).json({
          message: "This asset already has an unfinished run; wait for it to finish.",
        });
      }
      return res.status(502).json({
        message: `The compose run could not start: ${boundedReason(reason)}`,
      });
    }
    // Rebind with the real durable id; the first bind exists so a very fast
    // first tool call cannot race the submission.
    bind(run.id);
    publicIdByDurable.set(run.id, body.runId);
    seedUsage(run.id, body.usage);
    telemetry?.setTraceContext(run.id, {
      name: "image-compose",
      userId: body.userId,
      sessionId: body.threadId,
      tags: ["pixelaition", "image", "compose"],
      metadata: {
        ...(body.setId ? { setId: body.setId } : {}),
        assetId: body.assetId,
        modelId: target.modelId,
        reasoningEffort: target.effort,
      },
    });
    void follow(runtime, run.id, body.runId, target.effort);
    return res.status(202).json({ durableRunId: run.id });
  }

  // An asset run binds its asset up front. A workspace run stays unbound until
  // a tool picks an asset, so its drawing tools fail closed in the meantime.
  let asset: LoadedAsset | undefined;
  let originFrameId: string | undefined;
  let frameName: string | undefined;
  let style: StyleGuide;
  let projectSummary: string | undefined;
  let recent: RecentRun[];
  if (body.scope === "workspace") {
    const projectId = body.projectId;
    if (!projectId)
      return res.status(422).json({ message: "A workspace run needs a projectId." });
    const project = await loadProject(projectId);
    if (!project) return res.status(404).json({ message: "Project was not found." });
    style = project.style;
    // The prompt names the confirmed project so the agent never re-asks it.
    projectSummary =
      project.summary.length > 0 ? `${project.name} — ${project.summary}` : project.name;
    recent = await recentRuns(db, { projectId });
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
    recent = await recentRuns(db, { assetId });
  }

  const promptText = buildRunPrompt({
    prompt: body.prompt,
    style,
    ...(frameName !== undefined ? { frameName } : {}),
    ...(asset
      ? {
          frames: asset.frames.map((frame) => ({
            name: frame.name,
            current: frame.id === originFrameId,
            kind: frame.kind,
            presetId: frame.presetId,
          })),
          palette: asset.palette,
          ...(asset.projectSummary.length > 0
            ? { projectSummary: asset.projectSummary }
            : {}),
          // The asset's name always travels, so a fresh asset with no summary
          // still reads as a pinned target and the agent never asks for it.
          assetSummary:
            asset.summary.length > 0 ? `${asset.name} — ${asset.summary}` : asset.name,
          ...(originFrameId !== undefined
            ? (() => {
                const frame = asset.frames.find((item) => item.id === originFrameId);
                return frame && frame.summary.length > 0
                  ? { frameSummary: frame.summary }
                  : {};
              })()
            : {}),
        }
      : {}),
    ...(projectSummary !== undefined && projectSummary.length > 0
      ? { projectSummary }
      : {}),
    ...(body.attachments !== undefined && body.attachments.length > 0
      ? { attachments: body.attachments.length }
      : {}),
    recent,
  });
  // An ask run is read-only, but it continues the thread: the earlier
  // requests, their reference images (when this model can view them), and the
  // agents' steps ride into its prompt the same way a drawing run gets them.
  const prior =
    body.mode === "ask"
      ? await loadPriorContextFor(db, readDurableDraw, {
          threadId: body.threadId,
          assetId: body.assetId ?? null,
          modelVision: seesUserImages(targetSpec),
        })
      : { text: "", attachments: [] };
  const promptWithPrior =
    prior.text.length > 0 ? `${prior.text}\n\n${promptText}` : promptText;
  // Attachments become media parts the model sees directly; a message without
  // them stays a plain string, which keeps old journals and replay simple.
  // Earlier reference images come first, in the order the prior text names.
  const mediaParts = [...prior.attachments, ...(body.attachments ?? [])];
  const prompt: AgentPrompt =
    mediaParts.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: promptWithPrior },
            ...mediaParts.map((attachment) => ({
              type: "image" as const,
              image: { type: "data" as const, data: attachment.data },
              mediaType: attachment.mediaType,
            })),
          ],
        }
      : promptWithPrior;

  // Every drawing request runs one durable asset-draw task; only ask mode
  // stays a single read-only run.
  if (body.mode === "draw") {
    const shape = body.shape ?? { workers: 2, review: true };
    // One task per thread, checked at the last moment: the API guard runs
    // before the child rows exist, so the worker enforces it too.
    const [activeTask] = await db
      .select({ id: runTasks.id })
      .from(runTasks)
      .where(
        and(
          eq(runTasks.threadId, body.threadId),
          // The API inserts this request's row before calling the worker;
          // excluding it keeps the guard about *other* unfinished tasks.
          ne(runTasks.id, body.runId),
          inArray(runTasks.status, ["queued", "running", "waiting"]),
        ),
      )
      .limit(1);
    if (activeTask !== undefined) {
      return res.status(409).json({
        message:
          "This frame already has an unfinished run; wait for it to finish or cancel it first.",
      });
    }
    let task: Awaited<ReturnType<typeof runtime.submitTask>>;
    try {
      task = await runtime.submitTask(assetDraw, {
        sessionId: body.threadId,
        requestId: body.requestId,
        input: {
          request: body.prompt,
          projectId: body.projectId ?? null,
          assetId: body.assetId ?? null,
          userId: body.userId,
          threadId: body.threadId,
          attachments: body.attachments ?? [],
          taskId: body.runId,
          modelVision: seesUserImages(targetSpec),
          // The supervisor's id; the plan child spawns on it and each
          // worker slot on its painter sibling (see agentIdForChild).
          agentId: drawAgentId("supervisor", target),
          maxWorkers: shape.workers,
          review: shape.review,
          maxPalette: asset ? paletteCapacity(asset.palette.length) : MAX_COLORS,
        },
      });
    } catch (reason) {
      if (reason instanceof DurableConflictError) {
        return res.status(409).json({
          message:
            "This frame already has an unfinished run; wait for it to finish or cancel it first.",
        });
      }
      // The SDK's message is generic ("Invalid task input."); the cause chain
      // carries the zod detail, so log it and name it to the caller.
      console.error("[task] submit rejected:", reason);
      return res.status(502).json({
        message: `The task could not start: ${boundedReason(reason)}`,
      });
    }
    await recordTaskRow({
      id: body.runId,
      durableTaskId: task.id,
      threadId: body.threadId,
      assetId: body.assetId ?? null,
      shape,
    });
    telemetry?.setTraceContext(task.id, {
      name: "draw-task",
      userId: body.userId,
      sessionId: body.threadId,
      tags: ["pixelaition", "draw", "task"],
      metadata: {
        ...(body.assetId ? { assetId: body.assetId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        modelId: target.modelId,
        reasoningEffort: target.effort,
        workers: String(shape.workers),
        review: String(shape.review),
      },
    });
    // The API's guardrail and decision calls already spent before the task
    // began; the rollup starts from that seed.
    seedUsage(task.id, body.usage);
    void watchTask(runtime, task.id);
    return res.status(202).json({ durableTaskId: task.id });
  }

  let run: Awaited<ReturnType<typeof runtime.submit>>;
  try {
    run = await runtime.submit({
      agentId: drawAgentId("ask", target),
      // One conversation per model and shape: the runtime continues a
      // session's latest completed run whatever agent produced it, and a
      // chat-shape turn's locally minted reasoning ids are not replayable
      // to the responses endpoint. See `askSessionId`.
      sessionId: askSessionId(body.threadId, target.modelId, targetSpec.api),
      requestId: body.requestId,
      prompt,
    });
  } catch (reason) {
    // One run per session: a second submission while the first is unfinished
    // is a conflict with a clear cause, not an outage.
    if (reason instanceof DurableConflictError) {
      return res.status(409).json({
        message:
          "This frame already has an unfinished run; wait for it to finish or cancel it first.",
      });
    }
    return res.status(502).json({
      message: `The run could not start: ${boundedReason(reason)}`,
    });
  }
  publicIdByDurable.set(run.id, body.runId);
  seedUsage(run.id, body.usage);
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
      mode: body.mode,
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
      userId: body.userId,
    });
    if (body.mode === "ask") {
      const social = await loadSocialAssetForRun(asset.id, body.userId);
      if (social && social.artboards.length > 0) {
        bindSocialAssetRunFor({
          durableRunId: run.id,
          publicRunId: body.runId,
          loaded: social,
          userId: body.userId,
          planApproved: true,
        });
      }
    }
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

app.get("/internal/tasks/:id/events", (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const taskId = req.params.id ?? "";
  const after = Number(req.query.after ?? 0);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  for (const event of events.get(taskId) ?? []) {
    if (event.sequence > after) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const sink = (event: PublicEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const set = listeners.get(taskId) ?? new Set();
  set.add(sink);
  listeners.set(taskId, set);
  req.on("close", () => {
    set.delete(sink);
    if (set.size === 0 && !events.has(taskId)) listeners.delete(taskId);
  });
});

app.post("/internal/tasks/:id/signal", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({
      name: z.string().min(1),
      requestId: z.string().min(1),
      value: z.unknown(),
    })
    .safeParse(req.body);
  if (!body.success)
    return res.status(400).json({ message: "The request is missing a required field." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  try {
    const handle = await runtime.getTask(req.params.id ?? "");
    await handle.signal(body.data.name, body.data.requestId, body.data.value as never);
  } catch (reason) {
    return res.status(404).json({
      message: `That task cannot take the signal: ${boundedReason(reason)}`,
    });
  }
  res.status(204).end();
});

app.post("/internal/tasks/:id/steer", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({
      // A steering message is the user's own words; it is not summarized.
      prompt: z.string().min(1),
      frameName: z.string().min(1).max(40).optional(),
      frames: z.array(z.string().min(1).max(40)).max(12).optional(),
      target: z.string().min(1).max(8).optional(),
      requestId: z.string().min(1),
    })
    .safeParse(req.body);
  if (!body.success)
    return res.status(400).json({ message: "The request is missing a required field." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const taskId = req.params.id ?? "";
  const frames =
    body.data.frames ?? (body.data.frameName !== undefined ? [body.data.frameName] : []);
  // The supervisor always receives the message (it owns the plan); when its
  // target worker is painting right now, the supervisor relays it straight
  // into that worker's run and the console says so.
  let relayed: string | undefined;
  if (body.data.target !== undefined) {
    const [taskRow] = await db
      .select({ id: runTasks.id })
      .from(runTasks)
      .where(eq(runTasks.durableTaskId, taskId));
    if (taskRow !== undefined) {
      const [child] = await db
        .select({
          durableRunId: generationRuns.durableRunId,
          status: generationRuns.status,
        })
        .from(generationRuns)
        .where(
          and(
            eq(generationRuns.taskId, taskRow.id),
            eq(generationRuns.workerKey, body.data.target),
            inArray(generationRuns.status, ["running", "waiting"]),
          ),
        );
      if (child?.durableRunId) {
        try {
          runtime.steer(
            child.durableRunId,
            { messages: [{ role: "user" as const, content: body.data.prompt }] },
            { requestId: body.data.requestId },
          );
          relayed = body.data.target;
        } catch (reason) {
          console.error(
            `[steer] relay to ${body.data.target} failed: ${boundedReason(reason)}`,
          );
        }
      }
    }
  }
  // The signal name must be free across restarts: derive the next index from
  // the task's delivered signals instead of an in-memory counter.
  let name = "steer-1";
  try {
    const handle = await runtime.getTask(taskId);
    const snapshot = await handle.snapshot();
    const delivered = Object.keys(
      (snapshot.task.signals ?? {}) as Record<string, unknown>,
    )
      .map((key) => Number(key.startsWith("steer-") ? key.slice(6) : Number.NaN))
      .filter((index) => Number.isInteger(index) && index > 0);
    name = `steer-${delivered.length === 0 ? 1 : Math.max(...delivered) + 1}`;
    await handle.signal(name, body.data.requestId, {
      message: body.data.prompt,
      ...(frames.length > 0 ? { frames } : {}),
      ...(body.data.target !== undefined ? { target: body.data.target } : {}),
      ...(relayed !== undefined ? { delivered: true } : {}),
    } as never);
  } catch (reason) {
    return res.status(404).json({
      message: `That task cannot take steering: ${boundedReason(reason)}`,
    });
  }
  publish(taskId, "supervisor-says", {
    message: body.data.prompt,
    ...(frames.length > 0 ? { frames } : {}),
    ...(relayed !== undefined ? { to: relayed } : { held: true }),
  });
  publish(taskId, "steering-routed", {
    routed: relayed ?? "supervisor",
    message: body.data.prompt,
    ...(frames.length > 0 ? { frameName: frames[0] } : {}),
    ...(relayed !== undefined ? { relayed: true } : {}),
  });
  res.status(202).json({ routed: relayed ?? "queued" });
});

app.post("/internal/tasks/:id/cancel", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const taskId = req.params.id ?? "";
  try {
    const handle = await runtime.getTask(taskId);
    await handle.cancel();
  } catch (reason) {
    return res.status(404).json({
      message: `That task cannot be cancelled: ${boundedReason(reason)}`,
    });
  }
  publish(taskId, "task-complete", { status: "cancelled" });
  res.status(204).end();
});

app.get("/internal/runs/:id/state", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const runId = req.params.id ?? "";
  const [row] = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, runId));
  if (!row?.durableRunId)
    return res.status(404).json({ message: "That run is unknown." });
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const snapshot = runtime.snapshot(row.durableRunId);
  const outcome = snapshot.run.outcome as
    { type?: string; interaction?: unknown } | undefined;
  res.json({
    status: snapshot.run.status,
    ...(outcome?.type === "interaction" && outcome.interaction !== undefined
      ? { interaction: outcome.interaction }
      : {}),
  });
});

app.post("/internal/runs/:id/steer", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({
      messages: z
        .array(
          z.object({
            text: z.string().min(1).max(4000),
            // The queue item's id doubles as the delivery dedup key, so a
            // retried batch can never steer the same message twice.
            requestId: z.string().min(1).max(120).optional(),
          }),
        )
        .min(1)
        .max(20),
    })
    .safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ message: "The steering request is malformed." });
  }
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const [row] = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, req.params.id ?? ""));
  if (!row?.durableRunId) {
    return res.status(404).json({ message: "That run is not available." });
  }
  if (!["queued", "running", "waiting"].includes(row.status)) {
    return res.status(409).json({ message: "That run is no longer active." });
  }
  const durableRunId = row.durableRunId;
  // Accept the whole batch, then deliver it one message per turn through the
  // serialized queue; the queue item id is the runtime's dedup key.
  const queue = steerQueues.get(durableRunId) ?? [];
  let accepted = 0;
  for (const message of body.data.messages) {
    const id = message.requestId ?? crypto.randomUUID();
    if (id === steerInFlight.get(durableRunId)) continue;
    if (queue.some((item) => item.id === id)) continue;
    queue.push({ id, text: message.text });
    accepted += 1;
  }
  if (queue.length > 0) steerQueues.set(durableRunId, queue);
  submitNextSteer(runtime, durableRunId);
  res.status(202).json({ queued: accepted });
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
  // An approved call on a frame approves the frame itself: the user granted
  // that scope, so the next call on it must not ask again — including after
  // a worker restart, which is why the scope is persisted.
  if (response.type === "tool-approval" && response.approved && binding) {
    const stored = interactions.get(row.id)?.get(body.data.interactionId);
    const input = stored?.data.input as { frameId?: unknown } | undefined;
    const frameId =
      typeof input?.frameId === "string" ? input.frameId : binding.currentFrameId;
    if (frameId !== undefined && !binding.approvedScope.has(frameId)) {
      binding.approvedScope.add(frameId);
      persistScope(row.id, [...binding.approvedScope]);
    }
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
    "model_note",
    "tool_started",
    "tool_completed",
    "status",
    "done",
    "interaction",
    "interaction-resolved",
    "asset-created",
    "asset-bound",
    "usage",
    "steering_queued",
    "steering_applied",
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
  // Deltas are for the live stream. The note is the whole turn, and it stays
  // even when the retained list has been trimmed down to the latest tool calls.
  for (const note of notesFor(runId)) {
    const already = stored.some(
      (event) =>
        event.type === "model_note" &&
        (event.data as { operationId?: unknown; channel?: unknown }).operationId ===
          note.operationId &&
        (event.data as { channel?: unknown }).channel === note.channel,
    );
    if (already) continue;
    stored.push({
      sequence: note.sequence,
      type: "model_note",
      data: sanitizeEvent("model_note", note),
    });
  }
  return stored.sort((a, b) => a.sequence - b.sequence);
}

type ModelNote = {
  operationId: string;
  channel: "thinking" | "message";
  text: string;
  sequence: number;
  published: boolean;
};

const modelNotes = new Map<string, Map<string, ModelNote>>();

function rememberModelPiece(runId: string, data: unknown, sequence: number): void {
  const body = data as {
    operationId?: unknown;
    event?: { type?: unknown; text?: unknown; delta?: unknown };
  };
  if (typeof body.operationId !== "string") return;
  const event = body.event;
  const text =
    typeof event?.text === "string"
      ? event.text
      : typeof event?.delta === "string"
        ? event.delta
        : "";
  if (text.length === 0) return;
  const kind = typeof event?.type === "string" ? event.type : "";
  const channel =
    kind === "reasoning" || kind.startsWith("reasoning") ? "thinking" : "message";
  const notes = modelNotes.get(runId) ?? new Map<string, ModelNote>();
  const key = `${body.operationId}:${channel}`;
  const previous = notes.get(key);
  notes.set(key, {
    operationId: body.operationId,
    channel,
    text: `${previous?.text ?? ""}${text}`.slice(-8000),
    sequence: previous?.sequence ?? sequence,
    published: previous?.published ?? false,
  });
  modelNotes.set(runId, notes);
}

function notesFor(runId: string): ModelNote[] {
  return [...(modelNotes.get(runId)?.values() ?? [])];
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
        // An applied follow-up releases the next queued message, so each one
        // gets its own turn instead of arriving as a batch.
        if (event.type === "steering_applied") {
          const appliedId = (event.data as { id?: unknown } | undefined)?.id;
          if (typeof appliedId === "string") {
            steerApplied(runtime, durableId, appliedId);
          }
        }
        // Runtime events are raw: a suspension's status event carries the whole
        // AgentInteractionRequest, call ids included. Sanitize before anything
        // leaves the worker; the SSE path forwards the published payload
        // byte-for-byte.
        if (event.type === "model_delta")
          rememberModelPiece(publicId, event.data, event.sequence);
        publish(publicId, event.type, sanitizeEvent(event.type, event.data));
        if (event.type === "model_completed") {
          const operationId = (event.data as { operationId?: unknown } | undefined)
            ?.operationId;
          for (const note of notesFor(publicId)) {
            if (note.published || note.operationId !== operationId) continue;
            const published = publish(publicId, "model_note", {
              operationId: note.operationId,
              channel: note.channel,
              text: note.text,
            });
            note.sequence = published.sequence;
            note.published = true;
          }
        }
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
        // The trail can be slow (a provider hiccup, a queued Jev call). The
        // run is over either way, so it settles on time and the screened text
        // lands when it arrives — a slow trail never holds a run "live" for
        // minutes while its children wait behind it.
        const raw = outcomeTextFrom(stored);
        const answer = raw ?? null;
        const screened = screenAnswer(durableId, raw);
        void screened
          .then((text) => {
            if (typeof text !== "string" || text === raw) return;
            return db
              .update(generationRuns)
              .set({ answer: text })
              .where(eq(generationRuns.id, publicId));
          })
          .catch((reason: unknown) => {
            console.error(
              `[follow] closing answer update failed: ${boundedReason(reason)}`,
            );
          });
        await db
          .update(generationRuns)
          .set({
            status:
              snapshot.run.status === "completed" ? "succeeded" : snapshot.run.status,
            finishedAt: new Date(),
            events: stored,
            answer,
            usage: { ...usageFor(durableId) },
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
          // Summaries follow the run: the frames it touched, their asset, and
          // the project. Failures there never touch the terminal state.
          void queueRunSummaries(assetId, binding.touchedFrames).catch((reason) => {
            console.error(`[summary] queue failed: ${boundedReason(reason)}`);
          });
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
    releaseArtboardRun(durableId);
    clearGateOutcomes(durableId);
    clearSteerQueue(durableId);
    usageByRun.delete(durableId);
    publicIdByDurable.delete(durableId);
    // Give a subscriber a moment to read the tail, then drop the retained events.
    if (finished) {
      setTimeout(() => forgetRun(publicId), 60_000).unref?.();
    }
  }
}

async function loadAsset(assetId: string, userId?: string) {
  const { assets, projects } = await import("@pixelaition/db");
  const [row] = await db
    .select({
      asset: assets,
      style: projects.style,
      projectSummary: projects.summary,
      projectName: projects.name,
    })
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
    projectName: row.projectName,
    projectSummary: row.projectSummary,
    copy: row.asset.copy as CopyDeck,
    frames: frameRows.map((frame) => ({
      id: frame.id,
      name: frame.name,
      summary: frame.summary,
      index: frame.index,
      layers: frame.layers as Array<{
        id: string;
        name: string;
        visible: boolean;
        pixels: string;
      }>,
      kind: frame.kind,
      width: frame.width,
      height: frame.height,
      presetId: frame.presetId,
      scene: frame.scene,
      copyOverride: frame.copyOverride,
      status: frame.status,
      version: frame.version,
    })),
  };
}

type LoadedAsset = NonNullable<Awaited<ReturnType<typeof loadAsset>>>;

/** The style guide a workspace run draws under, read from its project. */
async function loadProject(projectId: string) {
  const [row] = await db
    .select({ style: projects.style, summary: projects.summary, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) return undefined;
  return { style: row.style as StyleGuide, summary: row.summary, name: row.name };
}

/** A durable error message that fits one log line. */
function boundedReason(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Projects the run owner can see. Asset runs and workspace runs share this. */
async function listOwnedProjects(ownerId: string): Promise<ProjectSummary[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      summary: projects.summary,
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
    summary: row.summary,
    updatedAt: row.updatedAt.toISOString(),
    assetCount: row.assetCount,
  }));
}

/** Assets of one project the owner actually owns. A foreign id fails closed. */
async function listOwnedAssets(
  ownerId: string,
  projectId: string,
): Promise<AssetSummary[]> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, ownerId)));
  if (!project) throw new Error("That project is not available.");
  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      summary: assets.summary,
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
    summary: row.summary,
    width: row.width,
    height: row.height,
    frameCount: row.frameCount,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * A drawing model without vision still gets to look: the summary-vision model
 * describes the bytes, and the tool returns that text. A missing vision model
 * fails with the cause instead of pretending the picture was seen.
 */
async function describeReferenceImage(
  traceId: string,
  image: { data: string; mediaType: string },
): Promise<string> {
  if (!visionClient) {
    throw new Error("This model cannot view images: no vision model is configured.");
  }
  const started = Date.now();
  const result = await generateCompletion({
    model: visionClient.model,
    ...summaryControls(visionClient.spec),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this reference for a pixel artist in at most six sentences. Cover the silhouette, the pose, the main colours, and the separate parts (ears, mane, clothing, weapon, shadow). Do not invent pixel coordinates.",
          },
          {
            type: "image",
            image: { type: "data", data: image.data },
            mediaType: image.mediaType,
          },
        ],
      },
    ],
  });
  const text = result.output.trim();
  if (!text) throw new Error("The vision model returned an empty description.");
  const description = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  void telemetry?.recordRunSpan({
    traceId,
    kind: "generation",
    name: "view-image",
    startMs: started,
    endMs: Date.now(),
    input: image.mediaType,
    output: description,
    model: visionClient.spec.id,
    ...(result.usage !== undefined ? { usage: { ...result.usage } } : {}),
  });
  return description;
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
  /** Frames the user already approved; absent means only the origin frame. */
  approvedScope?: string[];
  /** The account that owns the asset. List tools enforce it. */
  userId: string;
  /** The task role this child plays, for ownership and the console tree. */
  role?: "plan" | "worker" | "review" | "fix";
  workerKey?: string;
  /** Frames this child may write; plan and review runs leave it unset. */
  ownedFrameIds?: string[];
  /** A correction of a plan the user already approved. */
  planApproved?: boolean;
  /** Where the asset lives, and which sibling assets this run may read. */
  project?: ProjectAccess;
}): void {
  const { durableRunId, publicRunId, assetId, asset, originFrameId, request } = options;
  const writes = frameWrites(
    {
      durableRunId,
      publicRunId,
      assetId,
      frames: asset.frames,
    },
    { db, publish, loadAsset },
  );
  bindRun(durableRunId, {
    assetId,
    assetName: asset.name,
    request,
    originFrameId,
    currentFrameId: originFrameId,
    frames: new Map(
      asset.frames
        .filter((item) => item.kind !== "social")
        .map((item) => [
          item.id,
          {
            name: item.name,
            index: item.index,
            buffer: frameToBuffer(
              item,
              item.width ?? asset.width,
              item.height ?? asset.height,
              asset.palette,
            ),
          },
        ]),
    ),
    palette: [...asset.palette],
    width: asset.width,
    height: asset.height,
    style: asset.style,
    approvedScope: new Set(options.approvedScope ?? [originFrameId]),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    userId: options.userId,
    onListProjects: listOwnedProjects,
    onListAssets: listOwnedAssets,
    onDescribeImage: (image) => describeReferenceImage(durableRunId, image),
    onStroke: writes.onStroke,
    onFrameChange: writes.onFrameChange,
    onScopeChange: (scope) => persistScope(publicRunId, scope),
    onJevCheck: (check) => recordGateCheck(durableRunId, check),
    ...(options.role ? { role: options.role } : {}),
    ...(options.workerKey ? { workerKey: options.workerKey } : {}),
    ...(options.ownedFrameIds ? { ownedFrameIds: new Set(options.ownedFrameIds) } : {}),
    ...(options.planApproved ? { planApproved: true } : {}),
    ...(options.project ?? {}),
    onSelectWriteFrame: async (frameId: string) => {
      // The console follows the frame being written, exactly as it follows a
      // stroke, so a fix on spin-4 is not shown on spin-1.
      publish(publicRunId, "frame-focus", { frameId });
      await db
        .update(generationRuns)
        .set({ frameId })
        .where(eq(generationRuns.id, publicRunId));
    },
    onSaveFrame: async (frameId: string) => {
      // Strokes persist as they happen; saving is the frame's completion mark.
      // It names the frame the writer finished, so once every frame it owns is
      // saved the run only finishes children still pointing at the current
      // frame instead of leaving an earlier one "in progress". A turn-limited
      // worker that owns two frames can therefore finish once per frame.
      publish(publicRunId, "frame-focus", { frameId });
      await db
        .update(generationRuns)
        .set({ frameId })
        .where(eq(generationRuns.id, publicRunId));
      if (runtimeReady !== undefined) {
        await finishEarlyIfSaved(
          runtimeReady,
          durableRunId,
          publicRunId,
          options.ownedFrameIds ?? [],
        );
      }
      summarizer?.queue("frame", frameId);
    },
  });
}

type LoadedArtboardSet = {
  set: typeof artboardSets.$inferSelect;
  artboards: Artboard[];
  asset: LoadedAsset;
};

function artboardFromRow(row: typeof artboards.$inferSelect): Artboard {
  return {
    id: row.id,
    setId: row.setId,
    presetId: row.presetId,
    name: row.name,
    width: row.width,
    height: row.height,
    pixelUnit: row.pixelUnit,
    scene: sceneSchema.parse(row.scene),
    copyOverride: row.copyOverride as CopyOverride,
    status: row.status as Artboard["status"],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadArtboardSetForRun(
  setId: string,
  assetId: string,
  userId: string,
): Promise<LoadedArtboardSet | undefined> {
  const [set] = await db
    .select()
    .from(artboardSets)
    .where(and(eq(artboardSets.id, setId), eq(artboardSets.assetId, assetId)));
  if (!set) return undefined;
  const rows = await db
    .select()
    .from(artboards)
    .where(eq(artboards.setId, setId))
    .orderBy(asc(artboards.createdAt), asc(artboards.id));
  const asset = await loadAsset(assetId, userId);
  if (!asset) return undefined;
  return { set, artboards: rows.map(artboardFromRow), asset };
}

function spritesForAsset(asset: LoadedAsset): Map<string, SpriteSource> {
  const sprites = new Map<string, SpriteSource>();
  for (const frame of asset.frames) {
    if (frame.kind === "social") continue;
    const buffer = frameToBuffer(
      frame,
      frame.width ?? asset.width,
      frame.height ?? asset.height,
      asset.palette,
    );
    sprites.set(`${asset.id}:${frame.id}`, {
      assetId: asset.id,
      assetName: asset.name,
      frameId: frame.id,
      frameName: frame.name,
      buffer,
    });
  }
  return sprites;
}

function setDtoFromRow(row: typeof artboardSets.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    assetId: row.assetId,
    name: row.name,
    copy: row.copy as CopyDeck,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function saveArtboardRecord(artboard: Artboard): Promise<Artboard> {
  const scene = sceneSchema.parse(artboard.scene);
  const [existing] = await db
    .select()
    .from(artboards)
    .where(and(eq(artboards.id, artboard.id), eq(artboards.version, artboard.version)));
  if (!existing) {
    throw new Error(
      `Artboard "${artboard.name}" changed while the agent was working; reload it before saving.`,
    );
  }
  await db.insert(artboardVersions).values({
    id: randomUUID(),
    setId: existing.setId,
    artboardId: existing.id,
    scope: "artboard",
    kind: "agent-update",
    author: "agent",
    runId: null,
    snapshot: { scene: existing.scene, name: existing.name },
  });
  const [row] = await db
    .update(artboards)
    .set({
      scene,
      name: artboard.name,
      copyOverride: artboard.copyOverride,
      status: artboard.status,
      version: artboard.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(artboards.id, artboard.id), eq(artboards.version, artboard.version)))
    .returning();
  if (!row) {
    throw new Error(
      `Artboard "${artboard.name}" changed while the agent was working; reload it before saving.`,
    );
  }
  await db
    .update(artboardSets)
    .set({ updatedAt: new Date() })
    .where(eq(artboardSets.id, artboard.setId));
  return artboardFromRow(row);
}

async function createArtboardRecord(input: {
  setId: string;
  presetId: string;
  name?: string;
  template?: string;
  copy?: CopyDeck;
  palette: string[];
  sprites: Map<string, SpriteSource>;
  assetId: string;
}): Promise<Artboard> {
  const preset: FormatPreset = getPreset(input.presetId);
  const template = (input.template ??
    preset.defaultTemplate) as FormatPreset["defaultTemplate"];
  const primary = [...input.sprites.values()].find(
    (source) => source.assetId === input.assetId,
  );
  const scene = buildTemplateScene({
    preset,
    template,
    copy: input.copy ?? {},
    palette: input.palette,
    ...(primary ? { sprite: primary } : {}),
  });
  const id = randomUUID();
  const [row] = await db
    .insert(artboards)
    .values({
      id,
      setId: input.setId,
      presetId: preset.id,
      name: input.name?.trim() || preset.label,
      width: preset.width,
      height: preset.height,
      pixelUnit: preset.pixelUnit,
      scene,
      copyOverride: {},
      status: "draft",
      version: 1,
    })
    .returning();
  if (!row) throw new Error("The artboard could not be created.");
  await db
    .update(artboardSets)
    .set({ updatedAt: new Date() })
    .where(eq(artboardSets.id, input.setId));
  return artboardFromRow(row);
}

async function setCopyRecord(
  setId: string,
  copy: CopyDeck,
): Promise<{ set: ReturnType<typeof setDtoFromRow>; artboards: Artboard[] }> {
  const [set] = await db
    .update(artboardSets)
    .set({ copy, updatedAt: new Date() })
    .where(eq(artboardSets.id, setId))
    .returning();
  if (!set) throw new Error("The set was not found.");
  const rows = await db.select().from(artboards).where(eq(artboards.setId, setId));
  const next: Artboard[] = [];
  for (const row of rows) {
    const current = artboardFromRow(row);
    const scene = syncCopyScene(current.scene, copy, current.copyOverride);
    if (JSON.stringify(scene) === JSON.stringify(current.scene)) {
      next.push(current);
      continue;
    }
    await db.insert(artboardVersions).values({
      id: randomUUID(),
      setId,
      artboardId: current.id,
      scope: "artboard",
      kind: "copy-sync",
      author: "agent",
      runId: null,
      snapshot: { scene: current.scene, name: current.name },
    });
    const [updated] = await db
      .update(artboards)
      .set({ scene, version: current.version + 1, updatedAt: new Date() })
      .where(eq(artboards.id, current.id))
      .returning();
    if (updated) next.push(artboardFromRow(updated));
  }
  return { set: setDtoFromRow(set), artboards: next };
}

function buildArtboardPrompt(request: string, loaded: LoadedArtboardSet): string {
  const boards = loaded.artboards
    .map(
      (artboard) =>
        `- ${artboard.name} [${artboard.presetId}] ${artboard.width}×${artboard.height} (${artboard.status})`,
    )
    .join("\n");
  return [
    "You are the art director and layout worker for one social kit. Compose it, then stop.",
    `Set: ${loaded.set.name}. Mark: ${loaded.asset.name} [${loaded.asset.width}×${loaded.asset.height}, ${loaded.asset.palette.length} colours].`,
    "The set is the deliverable: profile, cover, feed post, vertical video, thumbnail or banner, each at its native size.",
    "Call list_formats before choosing a layout. Call read_set to see the current boards and shared copy. Call list_project_sprites to reuse any sprite frame from this project; place_sprite accepts its assetId/frameId.",
    "Plan the family as one JSON object in your reply: {setName, concept, copy:{headline,subhead,eyebrow,cta,handle}, artboards:[{format, template, role}], review:true}. Then call present_artboard_plan once with a short summary. Do not create or edit any artboard before the user approves.",
    "After approval: create the planned boards that do not exist with create_artboard, keep the shared copy with set_copy, and compose each board with apply_template, set_text, place_sprite, set_background and shapes. Keep the mark and headline consistent across the family; adapt the layout, not the identity.",
    "Work visibly: call those tools one edit at a time. Every call updates the frame for the user; never hold the whole layout in your head and reveal it only at save.",
    "Stay inside safe areas, crops and exclusions. The deterministic checks decide geometry; never claim a fit you did not check. preview_artboard at scale 1 for detail and scale 4 for the thumbnail test.",
    "Every sprite scale is a whole number. Every colour is a palette index. Read list_formats.fonts for atlas sizes; set_text snaps a requested final size to the nearest atlas size plus whole-pixel scale and reports effectiveSize.",
    "Fix every check error before saving. Save each finished board with save_artboard immediately, then answer in the language of the request with a short summary of the family and what still needs the user's words. Do not call set_copy after composing: it re-syncs text and can undo per-board layout. If copy must change, change it before the boards.",
    `Current boards:\n${boards.length > 0 ? boards : "- (none yet; create them from the plan)"}`,
    `Request: ${request}`,
  ].join("\n");
}

function bindArtboardRunFor(options: {
  durableRunId: string;
  publicRunId: string;
  loaded: LoadedArtboardSet;
  userId: string;
  planApproved?: boolean;
}): void {
  const { loaded, durableRunId, publicRunId, userId } = options;
  const sprites = spritesForAsset(loaded.asset);
  bindArtboardRun(durableRunId, {
    setId: loaded.set.id,
    setName: loaded.set.name,
    projectId: loaded.set.projectId,
    assetId: loaded.asset.id,
    assetName: loaded.asset.name,
    palette: [...loaded.asset.palette],
    copy: loaded.set.copy as CopyDeck,
    artboards: new Map(loaded.artboards.map((artboard) => [artboard.id, artboard])),
    sprites,
    planApproved: options.planApproved ?? false,
    onSave: (artboard) => saveArtboardRecord(artboard),
    onCreate: (input) =>
      createArtboardRecord({
        setId: loaded.set.id,
        assetId: loaded.asset.id,
        palette: loaded.asset.palette,
        sprites,
        presetId: input.presetId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.copy !== undefined ? { copy: input.copy } : {}),
      }),
    onDelete: async (artboardId) => {
      await db.delete(artboards).where(eq(artboards.id, artboardId));
      await db
        .update(artboardSets)
        .set({ updatedAt: new Date() })
        .where(eq(artboardSets.id, loaded.set.id));
    },
    onSetCopy: (copy) => setCopyRecord(loaded.set.id, copy),
    onDescribeImage: (image) => describeReferenceImage(durableRunId, image),
    onLoadSprite: async (assetId, frameId) => {
      if (assetId !== loaded.asset.id) return undefined;
      if (frameId) return sprites.get(`${assetId}:${frameId}`);
      return [...sprites.values()].find((source) => source.assetId === assetId);
    },
  });
  // A compose run is not a drawing child; keep the console's frame focus on
  // the primary frame so a refresh has a stable anchor.
  void publicRunId;
  void userId;
}

type LoadedSocialAsset = {
  asset: LoadedAsset;
  artboards: Artboard[];
  copy: CopyDeck;
  sprites: Map<string, SpriteSource>;
};

function socialArtboardFromFrame(
  frame: LoadedAsset["frames"][number],
): Artboard | undefined {
  if (frame.kind !== "social" || !frame.presetId || !frame.scene) return undefined;
  const preset = getPreset(frame.presetId);
  return {
    id: frame.id,
    setId: "asset",
    presetId: frame.presetId,
    name: frame.name,
    width: frame.width ?? preset.width,
    height: frame.height ?? preset.height,
    pixelUnit: preset.pixelUnit,
    scene: sceneSchema.parse(frame.scene),
    copyOverride: (frame.copyOverride ?? {}) as CopyOverride,
    status:
      frame.status === "ready" || frame.status === "needs-fix" ? frame.status : "draft",
    version: frame.version ?? 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function spritesForProject(projectId: string): Promise<Map<string, SpriteSource>> {
  const projectAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.projectId, projectId));
  const sprites = new Map<string, SpriteSource>();
  for (const asset of projectAssets) {
    const frameRows = await db
      .select()
      .from(frames)
      .where(eq(frames.assetId, asset.id))
      .orderBy(asc(frames.index));
    for (const frame of frameRows) {
      if (frame.kind === "social") continue;
      const buffer = frameToBuffer(
        frame as unknown as Frame,
        frame.width ?? asset.width,
        frame.height ?? asset.height,
        asset.palette as string[],
      );
      sprites.set(`${asset.id}:${frame.id}`, {
        assetId: asset.id,
        assetName: asset.name,
        frameId: frame.id,
        frameName: frame.name,
        buffer,
      });
    }
  }
  return sprites;
}

async function loadSocialAssetForRun(
  assetId: string,
  userId: string,
): Promise<LoadedSocialAsset | undefined> {
  const asset = await loadAsset(assetId, userId);
  if (!asset) return undefined;
  const rows = await db
    .select()
    .from(frames)
    .where(and(eq(frames.assetId, assetId), eq(frames.kind, "social")))
    .orderBy(asc(frames.index), asc(frames.id));
  const artboards = rows
    .map((row) => socialArtboardFromFrame(row as LoadedAsset["frames"][number]))
    .filter((artboard): artboard is Artboard => artboard !== undefined);
  const sprites = await spritesForProject(asset.projectId);
  return { asset, artboards, copy: (asset.copy ?? {}) as CopyDeck, sprites };
}

async function saveSocialFrameRecord(artboard: Artboard): Promise<Artboard> {
  const scene = sceneSchema.parse(artboard.scene);
  const [existing] = await db
    .select()
    .from(frames)
    .where(and(eq(frames.id, artboard.id), eq(frames.version, artboard.version)));
  if (!existing || existing.kind !== "social") {
    throw new Error(
      `Social frame "${artboard.name}" changed while the agent was working; reload it before saving.`,
    );
  }
  const [row] = await db
    .update(frames)
    .set({
      name: artboard.name,
      scene,
      copyOverride: artboard.copyOverride,
      status: artboard.status,
      version: artboard.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(frames.id, artboard.id), eq(frames.version, artboard.version)))
    .returning();
  if (!row) throw new Error("That frame changed while it was saving.");
  await db
    .update(assets)
    .set({ updatedAt: new Date() })
    .where(eq(assets.id, row.assetId));
  await createVersion(db, {
    assetId: row.assetId,
    frameId: row.id,
    scope: "frame",
    kind: "edit",
    author: "agent",
    snapshot: {
      name: row.name,
      layers: [],
      social: {
        presetId: row.presetId,
        width: row.width,
        height: row.height,
        scene: row.scene,
        copyOverride: row.copyOverride,
        status: row.status,
      },
    },
  });
  return artboardFromFrameRow(row);
}

function artboardFromFrameRow(row: typeof frames.$inferSelect): Artboard {
  const preset = getPreset(row.presetId ?? "og-image");
  return {
    id: row.id,
    setId: row.assetId,
    presetId: row.presetId ?? preset.id,
    name: row.name,
    width: row.width ?? preset.width,
    height: row.height ?? preset.height,
    pixelUnit: preset.pixelUnit,
    scene: sceneSchema.parse(row.scene),
    copyOverride: row.copyOverride as CopyOverride,
    status: row.status === "ready" || row.status === "needs-fix" ? row.status : "draft",
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function createSocialFrameRecord(input: {
  assetId: string;
  presetId: string;
  name?: string;
  template?: string;
  copy?: CopyDeck;
  palette: string[];
  sprites: Map<string, SpriteSource>;
}): Promise<Artboard> {
  const preset = getPreset(input.presetId);
  const copy = input.copy ?? {};
  const source =
    [...input.sprites.values()].find((sprite) => sprite.assetId === input.assetId) ??
    [...input.sprites.values()][0];
  const scene = buildTemplateScene({
    preset,
    template: (input.template ??
      preset.defaultTemplate) as FormatPreset["defaultTemplate"],
    copy,
    palette: input.palette,
    ...(source ? { sprite: source } : {}),
  });
  const [last] = await db
    .select({ index: frames.index })
    .from(frames)
    .where(eq(frames.assetId, input.assetId))
    .orderBy(desc(frames.index))
    .limit(1);
  const [row] = await db
    .insert(frames)
    .values({
      id: randomUUID(),
      assetId: input.assetId,
      name: input.name?.trim() || preset.label,
      index: (last?.index ?? -1) + 1,
      layers: [],
      kind: "social",
      width: preset.width,
      height: preset.height,
      presetId: preset.id,
      scene,
      copyOverride: {},
      status: "draft",
      version: 1,
    })
    .returning();
  if (!row) throw new Error("The frame could not be created.");
  await db
    .update(assets)
    .set({ updatedAt: new Date() })
    .where(eq(assets.id, input.assetId));
  await createVersion(db, {
    assetId: row.assetId,
    frameId: row.id,
    scope: "frame",
    kind: "create",
    author: "agent",
    snapshot: {
      name: row.name,
      layers: [],
      social: {
        presetId: row.presetId,
        width: row.width,
        height: row.height,
        scene: row.scene,
        copyOverride: row.copyOverride,
        status: row.status,
      },
    },
  });
  return artboardFromFrameRow(row);
}

async function setSocialCopyRecord(
  assetId: string,
  copy: CopyDeck,
): Promise<{ set: ArtboardSet; artboards: Artboard[] }> {
  const [asset] = await db
    .update(assets)
    .set({ copy, updatedAt: new Date() })
    .where(eq(assets.id, assetId))
    .returning();
  if (!asset) throw new Error("The asset was not found.");
  const rows = await db
    .select()
    .from(frames)
    .where(and(eq(frames.assetId, assetId), eq(frames.kind, "social")));
  const next: Artboard[] = [];
  for (const row of rows) {
    const current = artboardFromFrameRow(row);
    const scene = syncCopyScene(current.scene, copy, current.copyOverride);
    if (JSON.stringify(scene) === JSON.stringify(current.scene)) {
      next.push(current);
      continue;
    }
    const [updated] = await db
      .update(frames)
      .set({ scene, version: current.version + 1, updatedAt: new Date() })
      .where(eq(frames.id, current.id))
      .returning();
    if (updated) next.push(artboardFromFrameRow(updated));
  }
  return {
    set: {
      id: assetId,
      projectId: asset.projectId,
      assetId,
      name: asset.name,
      copy,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
    },
    artboards: next,
  };
}

function buildSocialPrompt(request: string, loaded: LoadedSocialAsset): string {
  const boards = loaded.artboards
    .map(
      (artboard) =>
        `- ${artboard.name} [${artboard.presetId}] ${artboard.width}×${artboard.height} (${artboard.status})`,
    )
    .join("\n");
  return [
    "You are the art director and layout worker for one image asset. Compose its frames, then stop.",
    "Write to the user in image, frame and canvas language. Never call frames sprites, social media, a kit or artboards; those are internal storage/tool names.",
    `Asset: ${loaded.asset.name}. Base canvas: ${loaded.asset.width}×${loaded.asset.height}, ${loaded.asset.palette.length} colours.`,
    "The asset holds frames together. Some frames are pixel images used as ingredients; others are native-size canvases for covers, posts, thumbnails and stories.",
    "This phase only creates or edits native-size frames. Pixel-backed frames already drawn are read-only ingredients; do not create, resize or repaint them.",
    "Call list_formats before choosing a canvas size. Call read_set to see the current frames and shared copy. Call list_project_sprites to reuse any image frame from this project; place_sprite accepts its assetId/frameId.",
    "Use assetId and frameId exactly as list_project_sprites returns them. Never shorten, reconstruct or guess an id; if place_sprite refuses a source, re-read the list and retry once with the exact pair.",
    "Plan the family as one JSON object in your reply: {setName, concept, copy:{headline,subhead,eyebrow,cta,handle}, artboards:[{format, template, role}], review:true}. Then call present_artboard_plan once with a short summary. Do not create or edit any artboard before the user approves.",
    "After approval: create the planned frames with create_artboard, keep the shared copy with set_copy, and compose each with apply_template, set_text, place_sprite, set_background and shapes. Keep the mark and headline consistent; adapt the layout, not the identity.",
    "Work visibly: call those tools one edit at a time. Every call updates the frame for the user; never hold the whole layout in your head and reveal it only at save.",
    "Stay inside safe areas, crops and exclusions. The deterministic checks decide geometry; never claim a fit you did not check. preview_artboard at scale 1 for detail and scale 4 for the thumbnail test.",
    "Every sprite scale is a whole number. Every colour is a palette index. Read list_formats.fonts for atlas sizes; set_text snaps a requested final size to the nearest atlas size plus whole-pixel scale and reports effectiveSize.",
    "Fix every check error before saving. Save each finished frame with save_artboard immediately, then answer in the language of the request with a short summary and what still needs the user's words. Do not call set_copy after composing.",
    `Current frames:\n${boards.length > 0 ? boards : "- (none yet; create them from the plan)"}`,
    `Request: ${request}`,
  ].join("\n");
}

function bindSocialAssetRunFor(options: {
  durableRunId: string;
  publicRunId: string;
  loaded: LoadedSocialAsset;
  userId: string;
  planApproved?: boolean;
}): void {
  const { loaded, durableRunId, publicRunId } = options;
  bindArtboardRun(durableRunId, {
    setId: loaded.asset.id,
    setName: loaded.asset.name,
    projectId: loaded.asset.projectId,
    assetId: loaded.asset.id,
    assetName: loaded.asset.name,
    palette: [...loaded.asset.palette],
    copy: loaded.copy,
    artboards: new Map(loaded.artboards.map((artboard) => [artboard.id, artboard])),
    sprites: loaded.sprites,
    planApproved: options.planApproved ?? false,
    onChange: (artboard) => {
      publish(publicRunId, "frame-scene", { artboard });
    },
    onSave: (artboard) => saveSocialFrameRecord(artboard),
    onCreate: (input) =>
      createSocialFrameRecord({
        assetId: loaded.asset.id,
        presetId: input.presetId,
        palette: loaded.asset.palette,
        sprites: loaded.sprites,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        copy: input.copy ?? loaded.copy,
      }),
    onDelete: async (artboardId) => {
      await db
        .delete(frames)
        .where(and(eq(frames.id, artboardId), eq(frames.kind, "social")));
      await db
        .update(assets)
        .set({ updatedAt: new Date() })
        .where(eq(assets.id, loaded.asset.id));
      publish(publicRunId, "frame-deleted", { frameId: artboardId });
    },
    onSetCopy: async (copy) => {
      const result = await setSocialCopyRecord(loaded.asset.id, copy);
      for (const artboard of result.artboards) {
        publish(publicRunId, "frame-scene", { artboard });
      }
      return result;
    },
    onDescribeImage: (image) => describeReferenceImage(durableRunId, image),
    onLoadSprite: async (assetId, frameId) => {
      if (frameId) return loaded.sprites.get(`${assetId}:${frameId}`);
      return [...loaded.sprites.values()].find((source) => source.assetId === assetId);
    },
  });
  void publicRunId;
}

/**
 * A writer that saved every frame it touched has finished its work even if its
 * turn budget has not run out. The durable run is cancelled and a closing
 * status is written by hand, so every frame it painted ends on a terminal row
 * pointing at itself: a turn-limited worker that painted two frames and then
 * stopped by its budget left the first frame on a run row that pointed at the
 * second, and the editor kept showing that frame as an unsaved draft.
 */
async function finishEarlyIfSaved(
  runtime: DurableRuntime,
  durableRunId: string,
  publicRunId: string,
  ownedFrameIds: string[],
): Promise<void> {
  const painted = [...(getRun(durableRunId)?.touchedFrames ?? [])];
  if (ownedFrameIds.length === 0 || painted.length === 0) return;
  if (!ownedFrameIds.every((frameId) => painted.includes(frameId))) return;
  const handle = await runtime.getRun(durableRunId);
  const status = await handle.status();
  if (["completed", "failed", "cancelled"].includes(status.status)) return;
  await handle.cancel();
  const text = "Every owned frame was saved.";
  publish(publicRunId, "status", {
    status: "completed",
    outcome: { text },
  });
  const stored = consoleEvents(publicRunId, interactionsFor(publicRunId));
  await db
    .update(generationRuns)
    .set({
      status: "succeeded",
      finishedAt: new Date(),
      events: stored,
      answer: text,
      usage: { ...usageFor(durableRunId) },
    })
    .where(and(eq(generationRuns.id, publicRunId), eq(generationRuns.status, "running")));
}

/**
 * The project a task runs in: every asset is readable, but a sibling asset is
 * decoded only when a tool asks for it.
 */
type ProjectAccess = {
  projectId: string;
  projectName: string;
  projectAssets: ProjectAsset[];
  onLoadProjectAsset: (assetId: string) => Promise<ProjectAsset | undefined>;
};

/**
 * Siblings of one asset, with their frames already decoded: the style evidence
 * a worker or review reads across the project. Reads only.
 */
async function loadProjectSiblings(projectId: string, exceptAssetId: string) {
  const siblings = await db
    .select({
      id: assets.id,
      name: assets.name,
      width: assets.width,
      height: assets.height,
      palette: assets.palette,
      summary: assets.summary,
    })
    .from(assets)
    .where(and(eq(assets.projectId, projectId), ne(assets.id, exceptAssetId)));
  const decoded: ProjectAsset[] = [];
  for (const sibling of siblings) {
    const asset = await loadProjectAssetForRead(undefined, projectId, sibling.id);
    if (asset !== undefined) decoded.push(asset);
  }
  return decoded;
}

/** One asset of the run's project, decoded for reading; undefined when it is not. */
async function loadProjectAssetForRead(
  userId: string | undefined,
  projectId: string,
  assetId: string,
): Promise<ProjectAsset | undefined> {
  const loaded = await loadAsset(assetId, userId);
  if (!loaded || loaded.projectId !== projectId) return undefined;
  return {
    id: loaded.id,
    name: loaded.name,
    summary: loaded.summary,
    width: loaded.width,
    height: loaded.height,
    palette: loaded.palette,
    frames: loaded.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      summary: frame.summary,
      index: frame.index,
      buffer: frameToBuffer(
        { id: frame.id, name: frame.name, index: frame.index, layers: frame.layers },
        loaded.width,
        loaded.height,
        loaded.palette,
      ),
    })),
  };
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
  /** Frames the user already approved; a workspace run starts empty. */
  approvedScope?: string[];
  role?: "plan";
  planApproved?: boolean;
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
    writes = frameWrites(
      {
        durableRunId,
        publicRunId,
        assetId: asset.id,
        frames: asset.frames,
      },
      { db, publish, loadAsset },
    );
    await db
      .update(generationRuns)
      .set({ frameId: origin.id })
      .where(eq(generationRuns.id, publicRunId));
    // A task that began without an asset (the home's "new asset" runs) must
    // learn its target the moment a child creates it: bind the task row and
    // announce it on the task's own stream, or the home never opens the editor.
    const owner = await db
      .select({ taskId: generationRuns.taskId })
      .from(generationRuns)
      .where(eq(generationRuns.id, publicRunId))
      .limit(1);
    const ownerTaskId = owner[0]?.taskId ?? null;
    if (ownerTaskId !== null) {
      await db
        .update(runTasks)
        .set({ assetId: asset.id })
        .where(eq(runTasks.id, ownerTaskId));
      publish(ownerTaskId, "asset-bound", {
        assetId: asset.id,
        projectId: asset.projectId,
        name: asset.name,
      });
    }
    // Every binding (use_asset or create_asset) announces itself: the console
    // shows the target and the home assembles into the editor on this event.
    publish(publicRunId, "asset-bound", {
      assetId: asset.id,
      projectId: asset.projectId,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      frameCount: asset.frames.length,
    });
    return {
      id: asset.id,
      name: asset.name,
      summary: asset.summary,
      width: asset.width,
      height: asset.height,
      palette: [...asset.palette],
      style: asset.style,
      frames: framesByIndex.map((frame) => ({
        id: frame.id,
        name: frame.name,
        summary: frame.summary,
        index: frame.index,
        buffer: frameToBuffer(
          frame,
          frame.width ?? asset.width,
          frame.height ?? asset.height,
          asset.palette,
        ),
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
    approvedScope: new Set(options.approvedScope ?? []),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    userId,
    ...(options.role ? { role: options.role } : {}),
    ...(options.planApproved ? { planApproved: true } : {}),
    onListProjects: listOwnedProjects,
    onListAssets: listOwnedAssets,
    onDescribeImage: (image) => describeReferenceImage(durableRunId, image),
    onCreateAsset: async (ownerId, input: CreateAssetInput): Promise<RunAsset> => {
      const [project] = await db
        .select({ name: projects.name, style: projects.style, summary: projects.summary })
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
        // A fresh asset has no generated summary yet; the summarizer fills it.
        summary: "",
        summaryAt: null,
        projectName: project.name,
        projectSummary: project.summary,
        style: project.style as StyleGuide,
        copy: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        frames: asset.frames.map((frame) => ({
          id: frame.id,
          name: frame.name,
          summary: "",
          index: frame.index,
          layers: frame.layers,
          kind: "sprite" as const,
          width: asset.width,
          height: asset.height,
          presetId: null,
          scene: null,
          copyOverride: {},
          status: "ready",
          version: 1,
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
    onScopeChange: (scope) => persistScope(publicRunId, scope),
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
/**
 * A non-terminal task re-attaches its watcher before resume pumps it, so every
 * child it spawns or resumes finds its binding, exactly like a single run.
 */
async function recoverInterruptedTasks(runtime: DurableRuntime): Promise<void> {
  let rows: Array<typeof runTasks.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(runTasks)
      .where(inArray(runTasks.status, ["queued", "running", "waiting"]));
  } catch (reason) {
    console.error(`[recovery] tasks could not be listed: ${boundedReason(reason)}`);
    return;
  }
  for (const row of rows) {
    if (row.durableTaskId === null) continue;
    void watchTask(runtime, row.durableTaskId).catch((reason: unknown) => {
      console.error(
        `[recovery] task ${row.id} could not be re-attached: ${boundedReason(reason)}`,
      );
    });
    console.log(`[recovery] re-attached task ${row.id} (${row.status})`);
  }
}

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
    const approvedScope = Array.isArray(run.approvedScope)
      ? run.approvedScope.filter((id): id is string => typeof id === "string")
      : undefined;
    publicIdByDurable.set(durableRunId, run.id);
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
          ...(approvedScope !== undefined ? { approvedScope } : {}),
        });
        void follow(runtime, durableRunId, run.id, run.reasoningEffort).catch(
          (reason: unknown) => {
            console.error(`[recovery] run ${run.id} stopped: ${boundedReason(reason)}`);
          },
        );
        console.log(`[recovery] re-attached workspace run ${run.id} (${run.status})`);
        continue;
      }
      if (run.mode === "compose" && !run.setId) {
        const social = await loadSocialAssetForRun(assetId, userId);
        if (!social) {
          console.error(
            `[recovery] social asset ${assetId} for run ${run.id} was not found; leaving the run unrecovered`,
          );
          continue;
        }
        bindSocialAssetRunFor({
          durableRunId,
          publicRunId: run.id,
          loaded: social,
          userId,
          planApproved: social.artboards.some(
            (artboard) => artboard.version > 1 || artboard.status === "ready",
          ),
        });
        void follow(runtime, durableRunId, run.id, run.reasoningEffort).catch(
          (reason: unknown) => {
            console.error(`[recovery] run ${run.id} stopped: ${boundedReason(reason)}`);
          },
        );
        console.log(`[recovery] re-attached social run ${run.id} (${run.status})`);
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
      if (run.setId) {
        const loaded = await loadArtboardSetForRun(run.setId, assetId, userId);
        if (!loaded) {
          console.error(
            `[recovery] artboard set ${run.setId} for run ${run.id} was not found; the artboard tools will be unavailable`,
          );
        } else {
          bindArtboardRunFor({
            durableRunId,
            publicRunId: run.id,
            loaded,
            userId,
            // A scene at version > 1 means the user already approved the plan
            // and boards were written; otherwise the resumed agent re-asks.
            planApproved: loaded.artboards.some(
              (artboard) => artboard.version > 1 || artboard.status === "ready",
            ),
          });
        }
      }
      bindAssetRun({
        durableRunId,
        publicRunId: run.id,
        assetId,
        asset,
        originFrameId,
        request: run.prompt ?? undefined,
        ...(approvedScope !== undefined ? { approvedScope } : {}),
        // A recovered task child keeps its role and owned frames, so the
        // ownership and role gates survive a restart exactly as submitted.
        ...(run.role === "plan" ||
        run.role === "worker" ||
        run.role === "review" ||
        run.role === "fix"
          ? { role: run.role }
          : {}),
        ...(run.workerKey !== null && run.workerKey !== undefined
          ? { workerKey: run.workerKey }
          : {}),
        ...(run.role === "worker" || run.role === "fix"
          ? { ownedFrameIds: (run.frameIds as string[] | null) ?? [] }
          : {}),
        userId,
      });
      if (run.mode === "ask") {
        const social = await loadSocialAssetForRun(assetId, userId);
        if (social && social.artboards.length > 0) {
          bindSocialAssetRunFor({
            durableRunId,
            publicRunId: run.id,
            loaded: social,
            userId,
            planApproved: true,
          });
        }
      }
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

/**
 * A prompt that rode with reference images used to be stored as a placeholder.
 * The user's words are on the durable task; put them back on the plan child
 * so a refresh can show what was asked.
 */
async function repairAttachmentPrompts(): Promise<void> {
  const rows = await db
    .select({
      id: generationRuns.id,
      taskId: generationRuns.taskId,
      role: generationRuns.role,
    })
    .from(generationRuns)
    .where(eq(generationRuns.prompt, "(prompt with reference images)"));
  const plans = rows.filter((row) => row.role === "plan" && row.taskId !== null);
  if (plans.length === 0) return;
  const durablePath = process.env.DURABLE_DATABASE_PATH ?? "./data/anvia-runs.sqlite";
  const sqlite = new DatabaseSync(durablePath, { readOnly: true });
  try {
    const read = sqlite.prepare("select record from anvia_durable_tasks where id = ?");
    const requests = new Map<string, string | null>();
    for (const row of plans) {
      const taskId = row.taskId;
      if (taskId === null) continue;
      let request = requests.get(taskId);
      if (request === undefined) {
        const [task] = await db
          .select({ durableTaskId: runTasks.durableTaskId })
          .from(runTasks)
          .where(eq(runTasks.id, taskId));
        request = null;
        if (task?.durableTaskId) {
          const record = read.get(task.durableTaskId) as { record?: string } | undefined;
          if (typeof record?.record === "string") {
            const parsed = JSON.parse(record.record) as { input?: { request?: unknown } };
            if (
              typeof parsed.input?.request === "string" &&
              parsed.input.request.length > 0
            ) {
              request = parsed.input.request;
            }
          }
        }
        requests.set(taskId, request);
      }
      if (request === null) continue;
      await db
        .update(generationRuns)
        .set({ prompt: request })
        .where(eq(generationRuns.id, row.id));
    }
  } finally {
    sqlite.close();
  }
}

const port = Number(process.env.WORKER_PORT ?? 4002);
void repairAttachmentPrompts()
  .catch((reason: unknown) => {
    console.error(
      `[repair] attachment prompts were not restored: ${boundedReason(reason)}`,
    );
  })
  .finally(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(
        `worker listening on ${port}${completions.length > 0 ? ` with ${agents.length} drawing agents` : ""}`,
      );
    });
  });

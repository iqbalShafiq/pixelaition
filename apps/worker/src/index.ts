import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Agent } from "@anvia/core";
import { createQuestionTool } from "@anvia/core/tool";
import type { AgentPrompt } from "@anvia/core/agent";
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
  askInstructions,
  bindRun,
  clearGateOutcomes,
  createPixelTools,
  getRun,
  LangfuseTelemetry,
  openCodeGoHeaders,
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
  type JevUsage,
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
  type Frame,
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
import {
  buildFrameSummaryPrompt,
  clampSummary,
  createSummarizer,
  SUMMARY_LIMIT,
  type SummaryKind,
} from "./summarize.js";
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

/** The provider's normalized usage, as the agent observer reports it. */
type ModelUsageLike = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
};

/**
 * Per-run usage, independent of Langfuse: every model generation and every
 * Jev call adds to the run's totals, which stream to the console live and
 * persist on the run row so the user can see what a run costs.
 */
type RunUsage = {
  input: number;
  output: number;
  total: number;
  cached: number;
  cost: number;
  modelCalls: number;
  modelCost: number;
  jevCalls: number;
  jevCost: number;
};

const usageByRun = new Map<string, RunUsage>();
/** Durable run id → public run id, so usage events reach the right console. */
const publicIdByDurable = new Map<string, string>();

function emptyUsage(): RunUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cached: 0,
    cost: 0,
    modelCalls: 0,
    modelCost: 0,
    jevCalls: 0,
    jevCost: 0,
  };
}

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
  const totals = usageFor(durableRunId);
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.total += usage.total ?? 0;
  totals.cached += usage.cached ?? 0;
  totals.cost += usage.cost ?? 0;
  totals.jevCalls += usage.jevCalls ?? 0;
  totals.jevCost += usage.jevCost ?? 0;
  publishUsage(durableRunId);
}

function recordModelUsage(
  durableRunId: string,
  usage: ModelUsageLike | undefined,
  cost: number | undefined,
): void {
  if (!usage) return;
  const totals = usageFor(durableRunId);
  const cached =
    typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
  totals.input += Math.max(0, usage.inputTokens - cached);
  totals.output += usage.outputTokens;
  totals.total += usage.totalTokens;
  totals.cached += cached;
  totals.modelCalls += 1;
  if (typeof cost === "number") {
    totals.cost += cost;
    totals.modelCost += cost;
  }
  publishUsage(durableRunId);
}

function recordJevUsage(durableRunId: string, usage: JevUsage | undefined): void {
  if (!usage) return;
  const totals = usageFor(durableRunId);
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.total += usage.total ?? 0;
  totals.cost += usage.cost ?? 0;
  totals.jevCost += usage.cost ?? 0;
  totals.jevCalls += 1;
  publishUsage(durableRunId);
}

/**
 * Wraps the telemetry observer with per-run usage accounting. Model cost comes
 * from the provider's raw response (`usage.cost`), which the normalized usage
 * drops; Jev reports its own cost through the request-check hook.
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
                rawResponse?: { usage?: { cost?: number } };
              };
              const cost = response.rawResponse?.usage?.cost;
              recordModelUsage(
                args.runId,
                response.usage,
                typeof cost === "number" ? cost : undefined,
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
// The agent provider asks every client to identify itself and keep a stable
// session so it can route one conversation to the same upstream and keep its
// prompt cache warm; requests without the session header may start failing.
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

/** Web search turns on with its key; a missing key keeps the tools out. */
const webSearch = Boolean(process.env.TAVILY_API_KEY?.trim());

/** Read-only tools the asking-only agent may use: it answers, never paints. */
const ASK_TOOL_NAMES = new Set([
  "read_project",
  "read_frame",
  "read_region",
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

// Durable submits carry no model controls, so one agent is registered per
// model, reasoning effort, and mode and the run picks the trio the decision
// chose. The ask agent shares the model and context but cannot paint; each
// entry keeps its tool list so the recovery map matches exactly.
const agents = completions.flatMap(({ spec, model }) => {
  const drawingTools = [
    ...createPixelTools({ vision: spec.vision, webSearch }),
    createQuestionTool(),
  ];
  const askingTools = drawingTools.filter((tool) => ASK_TOOL_NAMES.has(tool.name));
  return spec.efforts.flatMap((effort) => [
    {
      id: `${agentPrefix}:${spec.id}:${effort}`,
      vision: spec.vision,
      tools: drawingTools,
      agent: new Agent({
        id: `${agentPrefix}:${spec.id}:${effort}`,
        model,
        instructions: pixelInstructions,
        tools: drawingTools,
        maxTurns: 120,
        controls: { reasoningEffort: effort },
        observability,
      }),
    },
    {
      id: `${agentPrefix}:ask:${spec.id}:${effort}`,
      vision: spec.vision,
      tools: askingTools,
      agent: new Agent({
        id: `${agentPrefix}:ask:${spec.id}:${effort}`,
        model,
        instructions: askInstructions,
        tools: askingTools,
        maxTurns: 8,
        controls: { reasoningEffort: effort },
        observability,
      }),
    },
  ]);
});

function agentForTarget(target: RunTarget, mode: "draw" | "ask"): Agent | undefined {
  const prefix = mode === "ask" ? `${agentPrefix}:ask` : agentPrefix;
  return agents.find(
    (entry) => entry.id === `${prefix}:${target.modelId}:${target.effort}`,
  )?.agent;
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

const runtimePromise: Promise<DurableRuntime | undefined> = DurableRuntime.open({
  store: new SqliteDurableStore(durablePath),
  ...(agents.length > 0
    ? {
        agents: agents.map((entry) => ({
          agent: entry.agent,
          version: "1",
          stream: true,
          toolRecovery: toolRecovery(entry.tools),
        })),
      }
    : {}),
  maxConcurrentRuns: 2,
  // Reference images travel as base64 media parts; the 1 MB default payload
  // cap would reject a run that carries two or three attachments.
  limits: { maxPayloadBytes: 8 * 1024 * 1024 },
})
  .then(async (runtime) => {
    // Bindings and follow loops come first: resume() starts pending runs
    // immediately, and a run that executes a tool before its binding exists
    // would see an unbound run (every frame "unapproved") and ask the human
    // for scope it was already granted.
    await recoverInterruptedRuns(runtime);
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
      mode: z.enum(["draw", "ask"]).default("draw"),
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
  // The API already refuses this; the worker re-checks so a direct internal
  // call cannot hand pixels to a model that cannot read them.
  const targetSpec = specs.find((spec) => spec.id === target.modelId);
  if (
    body.attachments !== undefined &&
    body.attachments.length > 0 &&
    targetSpec?.vision !== true
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

  const promptText = buildRunPrompt({
    prompt: body.prompt,
    style,
    ...(frameName !== undefined ? { frameName } : {}),
    ...(asset
      ? {
          frames: asset.frames.map((frame) => ({
            name: frame.name,
            current: frame.id === originFrameId,
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
  // Attachments become media parts the model sees directly; a message without
  // them stays a plain string, which keeps old journals and replay simple.
  const prompt: AgentPrompt =
    body.attachments !== undefined && body.attachments.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...body.attachments.map((attachment) => ({
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
      agentId: `${agentPrefix}${body.mode === "ask" ? ":ask" : ""}:${target.modelId}:${target.effort}`,
      sessionId: body.threadId,
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
    .select({ asset: assets, style: projects.style, projectSummary: projects.summary })
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
    projectSummary: row.projectSummary,
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
      // The palette rides along: a set_palette repaint must reach every open
      // editor, and the palette is the asset's, not this frame's.
      palette: [...buffer.palette],
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
      } else if (change.type === "palette") {
        // The palette belongs to the asset; persisting it here is what keeps
        // the run's painted pixels readable after the run (their indices
        // would otherwise point at a palette that no longer exists).
        await db
          .update(assets)
          .set({ palette: change.palette, updatedAt: new Date() })
          .where(eq(assets.id, assetId));
        const after = await loadAsset(assetId);
        if (!after) {
          throw new Error("The asset could not be read after the palette change.");
        }
        await createVersion(db, {
          assetId,
          scope: "asset",
          kind: "palette",
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
  /** Frames the user already approved; absent means only the origin frame. */
  approvedScope?: string[];
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
    approvedScope: new Set(options.approvedScope ?? [originFrameId]),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    onStroke: writes.onStroke,
    onFrameChange: writes.onFrameChange,
    onScopeChange: (scope) => persistScope(publicRunId, scope),
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
  /** Frames the user already approved; a workspace run starts empty. */
  approvedScope?: string[];
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
    approvedScope: new Set(options.approvedScope ?? []),
    touchedFrames: new Set(),
    strokes: [],
    issues: [],
    userId,
    onListProjects: async (ownerId): Promise<ProjectSummary[]> => {
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
    },
    onCreateAsset: async (ownerId, input: CreateAssetInput): Promise<RunAsset> => {
      const [project] = await db
        .select({ style: projects.style, summary: projects.summary })
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
        projectSummary: project.summary,
        style: project.style as StyleGuide,
        createdAt: new Date(),
        updatedAt: new Date(),
        frames: asset.frames.map((frame) => ({
          id: frame.id,
          name: frame.name,
          summary: "",
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
        ...(approvedScope !== undefined ? { approvedScope } : {}),
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

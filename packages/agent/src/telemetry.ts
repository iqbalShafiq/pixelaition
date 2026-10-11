import { createHash, randomBytes } from "node:crypto";
import type {
  AgentGenerationEndArgs,
  AgentGenerationStartArgs,
  AgentObserver,
  AgentRunEndArgs,
  AgentRunErrorArgs,
  AgentRunObserver,
  AgentRunStartArgs,
  AgentToolEndArgs,
  AgentToolErrorArgs,
  AgentToolStartArgs,
} from "@anvia/core/observability";

export type TelemetrySpanKind = "agent" | "generation" | "tool" | "span";

export type TelemetrySpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TelemetrySpanKind;
  name: string;
  startMs: number;
  endMs?: number;
  input?: string;
  output?: string;
  model?: string;
  usage?: Record<string, unknown>;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
};

export type TraceContext = {
  name: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

type OtlpAttribute = {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean }
    | { stringArrayValue: { values: Array<{ stringValue: string }> } };
};

function attribute(
  key: string,
  value: string | number | boolean | string[],
): OtlpAttribute {
  if (Array.isArray(value)) {
    return {
      key,
      value: {
        stringArrayValue: { values: value.map((item) => ({ stringValue: item })) },
      },
    };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

/** A stable 32-hex trace id derived from the durable run id. */
export function traceIdFor(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

function spanId(): string {
  return randomBytes(8).toString("hex");
}

function nanos(ms: number): string {
  return String(Math.round(ms * 1e6));
}

export function buildOtlpPayload(
  spans: TelemetrySpan[],
  context: TraceContext | undefined,
  serviceName: string,
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [attribute("service.name", serviceName)],
        },
        scopeSpans: [
          {
            spans: spans.map((span) => {
              const attributes: OtlpAttribute[] = [];
              const push = (key: string, value: string | number | boolean | string[]) => {
                attributes.push(attribute(key, value));
              };
              push(
                "langfuse.observation.type",
                span.kind === "agent" ? "agent" : span.kind,
              );
              if (context) {
                push("langfuse.trace.name", context.name);
                if (context.userId) push("langfuse.user.id", context.userId);
                if (context.sessionId) push("langfuse.session.id", context.sessionId);
                if (context.tags && context.tags.length > 0) {
                  push("langfuse.trace.tags", context.tags);
                }
                for (const [key, value] of Object.entries(context.metadata ?? {})) {
                  push(`langfuse.trace.metadata.${key}`, value);
                }
              }
              if (span.model) push("langfuse.observation.model.name", span.model);
              if (span.usage) {
                push("langfuse.observation.usage_details", JSON.stringify(span.usage));
              }
              if (span.input !== undefined)
                push("langfuse.observation.input", span.input);
              if (span.output !== undefined)
                push("langfuse.observation.output", span.output);
              if (span.level) push("langfuse.observation.level", span.level);
              if (span.statusMessage) {
                push("langfuse.observation.status_message", span.statusMessage);
              }
              return {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: 1,
                startTimeUnixNano: nanos(span.startMs),
                endTimeUnixNano: nanos(span.endMs ?? span.startMs + 1),
                attributes,
              };
            }),
          },
        ],
      },
    ],
  };
}

export type LangfuseTelemetryOptions = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string | undefined;
  serviceName: string;
  fetchImpl?: typeof fetch;
};

function messageText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Trace payloads stay readable and bounded; nothing unbounded goes upstream. */
export const IO_LIMIT = 4000;

/** The token counts Anvia reports; kept structural to stay decoupled. */
export type UsageLike = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
};

export function capped(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > IO_LIMIT ? `${text.slice(0, IO_LIMIT)}… (truncated)` : text;
}

function assistantOutput(
  choice:
    | readonly { type?: string; text?: string; toolName?: string; input?: unknown }[]
    | undefined,
): string {
  if (!choice) return "";
  const parts: string[] = [];
  for (const part of choice) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      parts.push(part.text);
    } else if (part.type === "tool-call" && typeof part.toolName === "string") {
      parts.push(
        `[tool] ${part.toolName}(${capped(JSON.stringify(part.input ?? {})) ?? ""})`,
      );
    }
  }
  return parts.join("\n");
}

/**
 * Langfuse recognises flat usage buckets named input/output/total and wants
 * them exclusive, so cached input is split out instead of double-counted.
 */
export function usageToDetails(
  usage: UsageLike | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const cached =
    typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0;
  const details: Record<string, number> = {
    input: Math.max(0, usage.inputTokens - cached),
    output: usage.outputTokens,
    total: usage.totalTokens,
  };
  if (cached > 0) details.input_cached_tokens = cached;
  return details;
}

type ActiveRun = {
  traceId: string;
  rootSpanId: string;
  spans: TelemetrySpan[];
  generations: Map<number, TelemetrySpan>;
  tools: Map<string, TelemetrySpan>;
};

/**
 * The Langfuse delivery layer, built directly on the documented OTLP endpoint
 * (`/api/public/otel/v1/traces`) with the v4 ingestion header. Trace ids are
 * derived from durable run ids so scores and metadata attach to the run's own
 * trace, and trace context is propagated onto every span, as Langfuse asks.
 */
export class LangfuseTelemetry {
  private readonly pending: TelemetrySpan[] = [];
  private readonly contexts = new Map<string, TraceContext>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly options: LangfuseTelemetryOptions) {}

  setTraceContext(runId: string, context: TraceContext): void {
    this.contexts.set(traceIdFor(runId), context);
  }

  observer(): AgentObserver {
    return {
      startRun: (args) => this.startRun(args),
    };
  }

  private startRun(args: AgentRunStartArgs): AgentRunObserver {
    const traceId = traceIdFor(args.runId);
    const rootSpan: TelemetrySpan = {
      traceId,
      spanId: spanId(),
      kind: "agent",
      name: args.trace?.name ?? "draw-sprite",
      startMs: Date.now(),
      input: messageText(args.prompt),
    };
    const run: ActiveRun = {
      traceId,
      rootSpanId: rootSpan.spanId,
      spans: [rootSpan],
      generations: new Map(),
      tools: new Map(),
    };
    this.active.set(traceId, run);

    return {
      startGeneration: (generation) => this.startGeneration(run, generation),
      startTool: (tool) => this.startTool(run, tool),
      end: async (end) => {
        this.endRun(run, end);
        await this.flush();
      },
      error: async (error) => {
        this.errorRun(run, error);
        await this.flush();
      },
    };
  }

  private startGeneration(run: ActiveRun, generation: AgentGenerationStartArgs) {
    const history =
      (generation.request as unknown as { chatHistory?: readonly unknown[] })
        .chatHistory ?? [];
    const last = history[history.length - 1];
    const span: TelemetrySpan = {
      traceId: run.traceId,
      spanId: spanId(),
      parentSpanId: run.rootSpanId,
      kind: "generation",
      name: "generate-draw",
      startMs: Date.now(),
      model: generation.modelInfo?.modelId,
      input: capped(messageText(last)),
    };
    run.spans.push(span);
    run.generations.set(generation.turn, span);
    return {
      end: (end: AgentGenerationEndArgs) => {
        span.endMs = Date.now();
        span.usage = usageToDetails((end.response as { usage?: UsageLike }).usage);
        const text = assistantOutput(
          (
            end.response as {
              choice?: readonly {
                type?: string;
                text?: string;
                toolName?: string;
                input?: unknown;
              }[];
            }
          ).choice,
        );
        span.output = capped(text.length > 0 ? text : undefined);
      },
    };
  }

  private startTool(run: ActiveRun, tool: AgentToolStartArgs) {
    const span: TelemetrySpan = {
      traceId: run.traceId,
      spanId: spanId(),
      parentSpanId: run.rootSpanId,
      kind: "tool",
      name: tool.toolName,
      startMs: Date.now(),
      input: capped(tool.args),
    };
    run.spans.push(span);
    run.tools.set(tool.internalCallId, span);
    return {
      end: (end: AgentToolEndArgs) => {
        span.endMs = Date.now();
        if (!end.skipped) span.output = capped(end.result);
      },
      error: (error: AgentToolErrorArgs) => {
        span.endMs = Date.now();
        span.level = "ERROR";
        span.statusMessage =
          error.error instanceof Error ? error.error.message : String(error.error);
      },
    };
  }

  private endRun(run: ActiveRun, end: AgentRunEndArgs): void {
    const root = run.spans[0];
    if (root) {
      root.endMs = Date.now();
      root.output = end.text;
      if (end.status !== "completed") {
        root.level = "WARNING";
        root.statusMessage = `run ${end.status}`;
      }
    }
    this.commit(run);
  }

  private errorRun(run: ActiveRun, error: AgentRunErrorArgs): void {
    const root = run.spans[0];
    if (root) {
      root.endMs = Date.now();
      root.level = error.status === "failed" ? "ERROR" : "WARNING";
      root.statusMessage =
        error.error instanceof Error ? error.error.message : String(error.error);
    }
    this.commit(run);
  }

  private commit(run: ActiveRun): void {
    this.active.delete(run.traceId);
    this.pending.push(...run.spans);
  }

  async recordScore(input: {
    runId: string;
    name: string;
    value: number;
    comment?: string;
  }): Promise<void> {
    await this.post("/api/public/scores", {
      traceId: traceIdFor(input.runId),
      name: input.name,
      value: input.value,
      dataType: "NUMERIC",
      ...(input.comment ? { comment: input.comment } : {}),
    });
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Records one standalone span (the prompt decision) on its own trace. */
  async recordSpan(
    input: {
      traceId: string;
      kind: TelemetrySpanKind;
      name: string;
      startMs: number;
      endMs: number;
      input?: string;
      output?: string;
      model?: string;
      usage?: Record<string, unknown>;
      level?: "DEFAULT" | "WARNING" | "ERROR";
      statusMessage?: string;
    },
    context: TraceContext,
  ): Promise<void> {
    this.pending.push({ ...input, spanId: spanId() });
    this.contexts.set(input.traceId, context);
    await this.flush();
  }

  /**
   * Records a span on a trace this process already started. The context was
   * set when the run was bound; a span without one is a programming error and
   * is dropped with a log instead of inventing context.
   */
  async recordRunSpan(input: {
    traceId: string;
    kind: TelemetrySpanKind;
    name: string;
    startMs: number;
    endMs: number;
    input?: string;
    output?: string;
    model?: string;
    usage?: Record<string, unknown>;
    level?: "DEFAULT" | "WARNING" | "ERROR";
    statusMessage?: string;
  }): Promise<void> {
    const context = this.contexts.get(input.traceId);
    if (!context) {
      console.error(`[telemetry] no trace context for ${input.traceId}; span dropped.`);
      return;
    }
    await this.recordSpan(input, context);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const spans = this.pending.splice(0, this.pending.length);
    const byTrace = new Map<string, TelemetrySpan[]>();
    for (const span of spans) {
      const list = byTrace.get(span.traceId) ?? [];
      list.push(span);
      byTrace.set(span.traceId, list);
    }
    for (const [traceId, traceSpans] of byTrace) {
      await this.post(
        "/api/public/otel/v1/traces",
        buildOtlpPayload(
          traceSpans,
          this.contexts.get(traceId),
          this.options.serviceName,
        ),
      );
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const base = this.options.baseUrl?.replace(/\/$/, "") ?? "https://cloud.langfuse.com";
    const auth = Buffer.from(
      `${this.options.publicKey}:${this.options.secretKey}`,
    ).toString("base64");
    const response = await (this.options.fetchImpl ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch((error: unknown) => {
      console.error("[telemetry] delivery failed", error);
      return undefined;
    });
    if (response && !response.ok) {
      console.error(
        "[telemetry] delivery rejected",
        response.status,
        await response.text(),
      );
    }
  }
}

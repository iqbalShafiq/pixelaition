import { describe, expect, it } from "vitest";
import {
  buildOtlpPayload,
  capped,
  LangfuseTelemetry,
  traceIdFor,
  usageToDetails,
  type TelemetrySpan,
} from "./telemetry.js";

const span: TelemetrySpan = {
  traceId: "t",
  spanId: "s",
  kind: "generation",
  name: "generate-draw",
  startMs: 1_000,
  endMs: 2_500,
  model: "muse-spark-1.3-contributor",
  usage: { input: 10, output: 3 },
  input: "hello",
  output: "world",
};

function attributesOf(payload: ReturnType<typeof buildOtlpPayload>, spanIndex = 0) {
  const attributes =
    payload.resourceSpans[0]?.scopeSpans[0]?.spans[spanIndex]?.attributes ?? [];
  return Object.fromEntries(
    attributes.map((entry) => {
      const [kind, raw] = Object.entries(entry.value)[0] ?? [];
      if (kind === "stringArrayValue") {
        const values = (raw as { values: Array<{ stringValue: string }> }).values.map(
          (item) => item.stringValue,
        );
        return [entry.key, values];
      }
      return [entry.key, raw];
    }),
  );
}

describe("telemetry", () => {
  it("derives a stable 32-hex trace id from the run id", () => {
    const one = traceIdFor("0fadaccb-5622-4bf8-9d9a-75bc1ba18067");
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdFor("0fadaccb-5622-4bf8-9d9a-75bc1ba18067")).toBe(one);
    expect(traceIdFor("other")).not.toBe(one);
  });

  it("maps a generation span to langfuse attributes", () => {
    const payload = buildOtlpPayload([span], undefined, "pixelaition-worker");
    const otlp = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(otlp?.name).toBe("generate-draw");
    expect(otlp?.startTimeUnixNano).toBe("1000000000");
    expect(otlp?.endTimeUnixNano).toBe("2500000000");
    const attributes = attributesOf(payload);
    expect(attributes["langfuse.observation.type"]).toBe("generation");
    expect(attributes["langfuse.observation.model.name"]).toBe(
      "muse-spark-1.3-contributor",
    );
    expect(attributes["langfuse.observation.usage_details"]).toBe(
      '{"input":10,"output":3}',
    );
    expect(attributes["langfuse.observation.input"]).toBe("hello");
    expect(attributes["langfuse.observation.output"]).toBe("world");
  });

  it("propagates trace context to every span", () => {
    const second: TelemetrySpan = {
      ...span,
      spanId: "s2",
      kind: "tool",
      name: "paint_stroke",
    };
    const payload = buildOtlpPayload(
      [span, second],
      {
        name: "draw-sprite",
        userId: "user-1",
        sessionId: "thread-2",
        tags: ["pixelaition", "draw"],
        metadata: { assetId: "asset-9" },
      },
      "pixelaition-worker",
    );
    for (const index of [0, 1]) {
      const attributes = attributesOf(payload, index);
      expect(attributes["langfuse.trace.name"]).toBe("draw-sprite");
      expect(attributes["langfuse.user.id"]).toBe("user-1");
      expect(attributes["langfuse.session.id"]).toBe("thread-2");
      expect(attributes["langfuse.trace.tags"]).toEqual(["pixelaition", "draw"]);
      expect(attributes["langfuse.trace.metadata.assetId"]).toBe("asset-9");
    }
    const toolAttributes = attributesOf(payload, 1);
    expect(toolAttributes["langfuse.observation.type"]).toBe("tool");
  });

  it("keeps error spans loud", () => {
    const failed: TelemetrySpan = {
      ...span,
      kind: "tool",
      name: "paint_stroke",
      level: "ERROR",
      statusMessage: "That layer is not on this frame.",
    };
    const attributes = attributesOf(buildOtlpPayload([failed], undefined, "probe"));
    expect(attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(attributes["langfuse.observation.status_message"]).toBe(
      "That layer is not on this frame.",
    );
  });

  it("maps usage into exclusive langfuse buckets", () => {
    expect(
      usageToDetails({
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 6,
        cacheCreationInputTokens: 0,
      }),
    ).toEqual({ input: 4, output: 4, total: 14, input_cached_tokens: 6 });
    expect(
      usageToDetails({
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toEqual({ input: 5, output: 2, total: 7 });
    expect(usageToDetails(undefined)).toBeUndefined();
  });

  it("caps oversized payloads", () => {
    const long = "x".repeat(10_000);
    const cappedText = capped(long);
    expect(cappedText?.endsWith("… (truncated)")).toBe(true);
    expect((cappedText ?? "").length).toBeLessThanOrEqual(10_000);
    expect(capped("short")).toBe("short");
    expect(capped(undefined)).toBeUndefined();
  });

  it("delivers a standalone span with basic auth and the v4 header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const telemetry = new LangfuseTelemetry({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://langfuse.test",
      serviceName: "pixelaition-api",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await telemetry.recordSpan(
      {
        traceId: traceIdFor("request-1"),
        kind: "generation",
        name: "decide-request",
        startMs: 1_000,
        endMs: 1_100,
        input: "draw a slime",
        output: '{"intent":"draw"}',
        model: "muse-spark-1.3-contributor",
      },
      {
        name: "decide",
        userId: "user-1",
        sessionId: "thread-1",
        tags: ["pixelaition", "decide"],
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://langfuse.test/api/public/otel/v1/traces");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-langfuse-ingestion-version"]).toBe("4");
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    );
    expect(telemetry.pendingCount()).toBe(0);
  });

  it("records a full run lifecycle with real io, usage, and one trace", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const telemetry = new LangfuseTelemetry({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://langfuse.test",
      serviceName: "pixelaition-worker",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    telemetry.setTraceContext("run-1", {
      name: "draw-sprite",
      userId: "user-1",
      sessionId: "thread-1",
      tags: ["pixelaition", "draw"],
    });
    const runObserver = await telemetry.observer().startRun!({
      runId: "run-1",
      prompt: { role: "user", content: "draw" },
      history: [],
      maxTurns: 24,
    } as never);
    const generation = await runObserver?.startGeneration!({
      turn: 1,
      request: {
        chatHistory: [{ role: "user", content: "hi" }],
        documents: [],
        tools: [],
      },
      modelInfo: { provider: "openai", modelId: "muse-spark-1.3-contributor" },
    } as never);
    await generation?.end!({
      turn: 1,
      response: {
        choice: [{ type: "text", text: "hello" }],
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cachedInputTokens: 6,
          cacheCreationInputTokens: 0,
        },
      },
    } as never);
    const tool = await runObserver?.startTool!({
      turn: 1,
      toolName: "paint_stroke",
      args: '{"points":1}',
      internalCallId: "c1",
    } as never);
    await tool?.end!({
      turn: 1,
      toolName: "paint_stroke",
      args: '{"points":1}',
      internalCallId: "c1",
      result: "committed",
      skipped: false,
    } as never);
    const toolTurn = await runObserver?.startGeneration!({
      turn: 2,
      request: { chatHistory: [{ role: "tool", content: [] }], documents: [], tools: [] },
      modelInfo: { provider: "openai", modelId: "muse-spark-1.3-contributor" },
    } as never);
    await toolTurn?.end!({
      turn: 2,
      response: {
        choice: [{ type: "tool-call", toolName: "fill_rect", input: { color: 1 } }],
        usage: {
          inputTokens: 3,
          outputTokens: 1,
          totalTokens: 4,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    } as never);
    await runObserver?.end!({
      status: "completed",
      text: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 6,
        cacheCreationInputTokens: 0,
      },
      messages: [],
    } as never);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as ReturnType<
      typeof buildOtlpPayload
    >;
    const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(4);
    // Construction order: root agent, generation turn 1, tool, generation turn 2.
    const rootAttributes = attributesOf(body, 0);
    const firstGeneration = attributesOf(body, 1);
    const toolAttributes = attributesOf(body, 2);
    const secondGeneration = attributesOf(body, 3);
    expect(String(firstGeneration?.["langfuse.observation.input"])).toContain("hi");
    expect(firstGeneration?.["langfuse.observation.output"]).toBe("hello");
    expect(firstGeneration?.["langfuse.observation.usage_details"]).toBe(
      '{"input":4,"output":4,"total":14,"input_cached_tokens":6}',
    );
    expect(secondGeneration?.["langfuse.observation.output"]).toBe(
      '[tool] fill_rect({"color":1})',
    );
    expect(toolAttributes?.["langfuse.observation.input"]).toBe('{"points":1}');
    expect(toolAttributes?.["langfuse.observation.output"]).toBe("committed");
    expect(rootAttributes?.["langfuse.observation.type"]).toBe("agent");
    expect(rootAttributes?.["langfuse.observation.output"]).toBe("done");
    for (const index of [0, 1, 2, 3]) {
      expect(attributesOf(body, index)["langfuse.session.id"]).toBe("thread-1");
    }
  });
});

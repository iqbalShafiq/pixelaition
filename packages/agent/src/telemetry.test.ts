import { describe, expect, it } from "vitest";
import { buildOtlpPayload, traceIdFor, type TelemetrySpan } from "./telemetry.js";

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
});

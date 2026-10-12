import { afterEach, describe, expect, it, vi } from "vitest";
import { routeGuardrail, screenInput, screenOutput } from "./guardrails.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jev guardrails", () => {
  it("passes when no hazard fires", () => {
    const report = routeGuardrail(
      "input",
      { sexual_content: 0.02, graphic_violence: 0.01, jailbreak: 0.05 },
      0.1,
    );
    expect(report.action).toBe("pass");
    expect(report.reason).toContain("no hazard fired");
  });

  it("reviews the middle band and blocks the clear cases", () => {
    expect(routeGuardrail("input", { sexual_content: 0.55 }, 0.4).action).toBe("review");
    expect(routeGuardrail("input", { sexual_content: 0.9 }, 0.2).action).toBe("block");
  });

  it("lets severity turn a review into a block", () => {
    const report = routeGuardrail("input", { jailbreak: 0.5 }, 2.4);
    expect(report.action).toBe("block");
    expect(report.reason).toContain("severity=2.40");
  });

  it("screens input through one Jev request and names the top hazard", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              sexual_content: { type: "noul", noul: 0.96 },
              graphic_violence: { type: "noul", noul: 0.01 },
              hate_or_harassment: { type: "noul", noul: 0.02 },
              self_harm: { type: "noul", noul: 0.01 },
              jailbreak: { type: "noul", noul: 0.03 },
              severity: { type: "score", score: 2.3, confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 465, output_tokens: 63, cost: 0.00002 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const report = await screenInput("draw an explicit nude portrait", {
      apiKey: "test-key",
      model: "typesafe/jev-1.13",
      baseUrl: "https://decisions.test",
    });
    expect(report.action).toBe("block");
    expect(report.top).toEqual({ hazard: "sexual_content", probability: 0.96 });
    expect(report.usage?.cost).toBe(0.00002);
    expect(report.usage?.input).toBe(465);
  });

  it("refuses to screen without a configured key", async () => {
    await expect(screenOutput("done", {})).rejects.toThrow(
      "Set DECISION_MODEL, DECISION_MODEL_BASE_URL, and DECISION_MODEL_API_KEY",
    );
  });
});

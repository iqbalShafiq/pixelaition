import { afterEach, describe, expect, it, vi } from "vitest";
import { routeSteering, STEERING_CONFIDENCE } from "./steering.js";

afterEach(() => vi.unstubAllGlobals());

const context = {
  workers: [
    { key: "w1", frames: ["idle", "attack"] },
    { key: "w2", frames: ["jalan-a"] },
  ],
  frameNames: ["idle", "attack", "jalan-a"],
};

function stubJev(answers: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

const env = { apiKey: "k", model: "m", baseUrl: "https://decisions.test" };

describe("routeSteering", () => {
  it("trusts a confident worker answer and maps the frame", async () => {
    stubJev({
      target: { type: "choice", choice: "w2", confidence: 0.9 },
      frames: { type: "choice", choice: "jalan-a", confidence: 0.8 },
    });
    await expect(
      routeSteering("bayangannya kurang gelap", context, env),
    ).resolves.toEqual({
      target: "w2",
      frames: ["jalan-a"],
      confidence: 0.8,
      source: "jev",
    });
  });
  it("falls back to the supervisor on an unknown target", async () => {
    stubJev({
      target: { type: "choice", choice: "w9", confidence: 0.9 },
      frames: { type: "choice", choice: "none", confidence: 0.9 },
    });
    const route = await routeSteering("make it nicer", context, env);
    expect(route.target).toBe("supervisor");
    expect(route.frames).toEqual([]);
    expect(route.confidence).toBeLessThanOrEqual(STEERING_CONFIDENCE);
  });
  it("carries a low confidence through so the caller asks", async () => {
    stubJev({
      target: { type: "choice", choice: "w1", confidence: 0.4 },
      frames: { type: "choice", choice: "idle", confidence: 0.5 },
    });
    const route = await routeSteering("something about a frame", context, env);
    expect(route.confidence).toBeLessThan(STEERING_CONFIDENCE);
  });
});

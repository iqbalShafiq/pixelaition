import { afterEach, describe, expect, it, vi } from "vitest";
import { decideHomeTarget, HomeDecisionError } from "./home.js";

const env = {
  apiKey: "k",
  model: "typesafe/jev-1.13",
  baseUrl: "https://decisions.test",
};
const projects = [
  { id: "p1", name: "knights", summary: "armored heroes", assetCount: 2 },
  { id: "p2", name: "potions", summary: "bottles and flasks", assetCount: 1 },
];
const assetsByProject = new Map([
  [
    "p2",
    [
      {
        id: "a1",
        name: "red potion",
        summary: "a red bottle with a cork",
        width: 32,
        height: 32,
      },
    ],
  ],
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decideHomeTarget", () => {
  it("asks intent and project together, then the asset", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const answers =
        bodies.length === 1
          ? {
              intent: { type: "choice", choice: "draw", confidence: 0.9 },
              project: { type: "choice", choice: "p2", confidence: 0.82 },
            }
          : { asset: { type: "choice", choice: "a1", confidence: 0.77 } };
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const target = await decideHomeTarget("gambar botol ramuan", env, {
      projects,
      assetsByProject,
    });
    expect(target).toEqual({
      intent: "draw",
      project: { id: "p2", confidence: 0.82 },
      asset: { id: "a1", confidence: 0.77 },
      source: "jev",
    });
    expect((bodies[0] as { state: { projects: unknown[] } }).state.projects).toHaveLength(
      2,
    );
    expect((bodies[0] as { state: { projects: unknown[] } }).state.projects).toEqual(
      projects,
    );
  });

  it("skips the asset call when the project is new or the intent asks", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              intent: { type: "choice", choice: "ask", confidence: 0.9 },
              project: { type: "choice", choice: "new", confidence: 0.6 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const target = await decideHomeTarget("apa isi project ini?", env, {
      projects,
      assetsByProject,
    });
    expect(target.asset).toBeUndefined();
    expect(target.project.id).toBe("new");
    expect(target.intent).toBe("ask");
  });

  it("refuses more than the project cap with a named cause", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      id: `p${index}`,
      name: `p${index}`,
      summary: "",
      assetCount: 0,
    }));
    await expect(
      decideHomeTarget("draw", env, { projects: many, assetsByProject: new Map() }),
    ).rejects.toBeInstanceOf(HomeDecisionError);
  });

  it("proposes a new project when the user has none", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          answers: {
            intent: { type: "choice", choice: "draw", confidence: 0.8 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const target = await decideHomeTarget("gambar slime", env, {
      projects: [],
      assetsByProject: new Map(),
    });
    expect(target.project.id).toBe("new");
    expect(target.asset).toBeUndefined();
    // One question, not a one-option choice: the project question is skipped.
    expect(bodies).toHaveLength(1);
    expect(
      (bodies[0] as { questions: Record<string, unknown> }).questions,
    ).not.toHaveProperty("project");
  });

  it("skips the asset call when the chosen project has no assets", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          answers: {
            intent: { type: "choice", choice: "draw", confidence: 0.9 },
            project: { type: "choice", choice: "p1", confidence: 0.85 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const target = await decideHomeTarget("gambar slime", env, {
      projects,
      assetsByProject: new Map(),
    });
    expect(target.project.id).toBe("p1");
    expect(target.asset).toEqual({ id: "new", confidence: 1 });
    expect(bodies).toHaveLength(1);
  });

  it("falls back to new for an unknown project choice, never a guess", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              intent: { type: "choice", choice: "draw", confidence: 0.8 },
              project: { type: "choice", choice: "p-does-not-exist", confidence: 0.7 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const target = await decideHomeTarget("draw", env, { projects, assetsByProject });
    expect(target.project.id).toBe("new");
    expect(target.asset).toBeUndefined();
  });
});

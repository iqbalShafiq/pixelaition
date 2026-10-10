# Multi-Model Composer Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the composer offer a configured list of models (DeepSeek V4.1 Flash and Muse Spark 1.3 Contributor on OpenCode Go) with each model's real reasoning-effort options, and make the chosen model + effort drive the actual run.

**Architecture:** `OPENAI_MODELS` is a JSON catalog of `{ id, api, efforts }`. The worker registers one Durable agent per model and effort (`pixel-draw:<modelId>:<effort>`), keeping the existing "agentId selects the controls" pattern because Durable submissions carry no model controls. The API serves that catalog to the web composer, which swaps the effort dropdown per selected model.

**Tech Stack:** TypeScript, Express, Drizzle, Anvia (`@anvia/core`, `@anvia/openai`), Vitest, React + TanStack Query, Tailwind.

**Spec:** No separate spec file; the requirements are captured in this plan (OpenCode Go endpoint families and effort lists verified against https://opencode.ai/v2/docs/console/go/ and the model catalog metadata).

## Global Constraints

- Node.js >= 22.16, pnpm 10.
- TDD for all new logic: watch each test fail before implementing (per `test-driven-development`).
- Conventional Commits (enforced by commitlint + husky).
- Secrets stay server-side; nothing secret uses a `VITE_` prefix.
- Durable submissions carry no model controls: the effort (and now model) must be encoded in the registered `agentId`, never written into the prompt.
- Pixel mutations still go through `applyCommand` in `@pixelaition/pixel`; this plan touches none of that.
- Do not modify the managed turborepo block in `AGENTS.md`.
- Verified effort options (official catalog metadata):
  - `deepseek-v4.1-flash` -> `["low", "high", "max"]`, served by `/chat/completions`
  - `muse-spark-1.3-contributor` -> `["minimal", "low", "medium", "high", "xhigh"]`, served by `/responses`
- OpenCode Go base URL: `https://opencode.ai/zen/go/v1`; the user supplies `OPENAI_API_KEY` themselves (leave it empty).

## Review Focus

- `OPENAI_MODELS` malformed or missing -> the app falls back to the single `OPENAI_MODEL` catalog and generic efforts instead of crashing or showing an empty dropdown. (Tests: Task 1.)
- `OPENAI_MODELS` entry without `api` -> defaults follow the old heuristic (openrouter -> chat, everything else -> responses) so existing OpenRouter setups do not silently switch endpoint families. (Tests: Task 1.)
- A stored preference (`lastModelId` / `lastReasoningEffort`) that is no longer offered -> the composer resets to the first model and its first effort instead of submitting an unusable pair. (Wiring: Tasks 3 and 4; worker-side fallback tested in Task 1 via `selectRunTarget`.)
- Unknown model or effort submitted (stale client) -> the worker maps to the first configured model and its first effort; the run never fails on selection. (Tests: Task 1.)
- Worker unreachable from the API -> `/api/models` still answers from the env catalog or the provider list, with generic efforts as the last resort, instead of returning 500. (Wiring: Task 3, using Task 1's `effortsFor`.)

---

### Task 1: Shared model catalog (packages/agent)

**Files:**

- Create: `packages/agent/src/models.ts`
- Create: `packages/agent/src/models.test.ts`
- Modify: `packages/agent/src/index.ts` (add exports)

**Interfaces:**

- Consumes: `zod` (already a dependency of `@pixelaition/agent`).
- Produces (imported by Tasks 2, 3, 4):
  - `genericEfforts: readonly ["none","low","medium","high"]`
  - `type ModelApi = "chat" | "responses"`
  - `type ModelSpec = { id: string; api?: ModelApi; efforts?: string[] }`
  - `type RunTarget = { modelId: string; effort: string }`
  - `parseModelSpecs(raw: string | undefined): ModelSpec[]`
  - `effortsFor(efforts: string[] | undefined): string[]`
  - `defaultApiFor(baseUrl: string | undefined): ModelApi`
  - `selectRunTarget(specs: ModelSpec[], modelId: string, effort: string): RunTarget`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  defaultApiFor,
  effortsFor,
  genericEfforts,
  parseModelSpecs,
  selectRunTarget,
} from "./models.js";

const catalog = JSON.stringify([
  { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
  {
    id: "muse-spark-1.3-contributor",
    api: "responses",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
]);

describe("model specs", () => {
  it("parses a JSON catalog with per-model api and efforts", () => {
    expect(parseModelSpecs(catalog)).toEqual([
      { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
      {
        id: "muse-spark-1.3-contributor",
        api: "responses",
        efforts: ["minimal", "low", "medium", "high", "xhigh"],
      },
    ]);
  });

  it("returns no specs when the value is missing or malformed", () => {
    expect(parseModelSpecs(undefined)).toEqual([]);
    expect(parseModelSpecs("  ")).toEqual([]);
    expect(parseModelSpecs("deepseek-v4.1-flash")).toEqual([]);
    expect(parseModelSpecs('[{"api":"chat"}]')).toEqual([]);
  });

  it("keeps specs that omit api and efforts for later defaults", () => {
    expect(parseModelSpecs('[{"id":"deepseek-v4.1-flash"}]')).toEqual([
      { id: "deepseek-v4.1-flash" },
    ]);
  });

  it("falls back to the generic effort set", () => {
    expect(effortsFor(undefined)).toEqual([...genericEfforts]);
    expect(effortsFor([])).toEqual([...genericEfforts]);
    expect(effortsFor(["low", "high", "max"])).toEqual(["low", "high", "max"]);
  });

  it("defaults the api family from the base url", () => {
    expect(defaultApiFor("https://openrouter.ai/api/v1")).toBe("chat");
    expect(defaultApiFor("https://opencode.ai/zen/go/v1")).toBe("responses");
    expect(defaultApiFor(undefined)).toBe("responses");
  });

  it("picks the requested model and effort when both are known", () => {
    const specs = parseModelSpecs(catalog);
    expect(selectRunTarget(specs, "muse-spark-1.3-contributor", "xhigh")).toEqual({
      modelId: "muse-spark-1.3-contributor",
      effort: "xhigh",
    });
  });

  it("falls back to the first model and its first effort", () => {
    const specs = parseModelSpecs(catalog);
    expect(selectRunTarget(specs, "unknown-model", "medium")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "low",
    });
    expect(selectRunTarget(specs, "deepseek-v4.1-flash", "xhigh")).toEqual({
      modelId: "deepseek-v4.1-flash",
      effort: "low",
    });
  });

  it("refuses to select without a catalog", () => {
    expect(() => selectRunTarget([], "deepseek-v4.1-flash", "low")).toThrow(
      /at least one model spec/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent test -- src/models.test.ts`
Expected: FAIL — cannot resolve `./models.js` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/agent/src/models.ts`:

```ts
import { z } from "zod";

/** The effort options used when a model does not declare its own. */
export const genericEfforts = ["none", "low", "medium", "high"] as const;

export type ModelApi = "chat" | "responses";

export type ModelSpec = {
  id: string;
  /** Which OpenAI endpoint family serves the model. */
  api?: ModelApi;
  /** The reasoning-effort options the composer offers for this model. */
  efforts?: string[];
};

export type RunTarget = { modelId: string; effort: string };

const catalogSchema = z.array(
  z.object({
    id: z.string().min(1),
    api: z.enum(["chat", "responses"]).optional(),
    efforts: z.array(z.string().min(1)).min(1).optional(),
  }),
);

/**
 * Parses OPENAI_MODELS, a JSON array of { id, api?, efforts? }. A malformed
 * value yields no specs so the caller can fall back to OPENAI_MODEL.
 */
export function parseModelSpecs(raw: string | undefined): ModelSpec[] {
  const text = raw?.trim();
  if (!text) return [];
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** A model's effort options, with the generic set as the fallback. */
export function effortsFor(efforts: string[] | undefined): string[] {
  return efforts && efforts.length > 0 ? [...efforts] : [...genericEfforts];
}

/**
 * OpenRouter only serves its chat-completions endpoint; every other
 * OpenAI-compatible endpoint the worker talks to defaults to responses.
 */
export function defaultApiFor(baseUrl: string | undefined): ModelApi {
  return baseUrl?.includes("openrouter.ai") ? "chat" : "responses";
}

/**
 * Resolves one run's model and effort against the configured specs. Unknown
 * values fall back to the first model, then to the model's first effort,
 * because a Durable submission only carries an agent id.
 */
export function selectRunTarget(
  specs: ModelSpec[],
  modelId: string,
  effort: string,
): RunTarget {
  const model = specs.find((spec) => spec.id === modelId) ?? specs[0];
  if (!model) throw new Error("selectRunTarget needs at least one model spec");
  const options = effortsFor(model.efforts);
  return {
    modelId: model.id,
    effort: options.includes(effort) ? effort : (options[0] ?? "none"),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test`
Expected: PASS — all `models.test.ts` tests green, existing agent tests still green.

- [ ] **Step 5: Export the new surface**

Append to `packages/agent/src/index.ts`:

```ts
export {
  defaultApiFor,
  effortsFor,
  genericEfforts,
  parseModelSpecs,
  selectRunTarget,
} from "./models.js";
export type { ModelApi, ModelSpec, RunTarget } from "./models.js";
```

- [ ] **Step 6: Verify the package typechecks**

Run: `pnpm --filter @pixelaition/agent typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/models.ts packages/agent/src/models.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): share the model catalog parser and run-target selection"
```

---

### Task 2: Worker registers one agent per model and effort

**Files:**

- Modify: `apps/worker/src/index.ts:8-18` (imports), `:77-136` (model + agent setup), `:197-208` (health + agents route), `:210-267` (runs route), `:380-385` (boot log).

**Interfaces:**

- Consumes: `parseModelSpecs`, `effortsFor`, `defaultApiFor`, `selectRunTarget`, `type ModelSpec`, `type RunTarget` from Task 1.
- Produces: `GET /internal/agents` -> `{ models: Array<{ id: string; efforts: string[] }>; agents: string[] }` (consumed by Task 3). Agent ids are `pixel-draw:<modelId>:<effort>`.

- [ ] **Step 1: Replace the imports from `@pixelaition/agent`**

In `apps/worker/src/index.ts`, change

```ts
import {
  bindRun,
  createPixelTools,
  getRun,
  pixelInstructions,
  releaseRun,
} from "@pixelaition/agent";
```

to

```ts
import {
  bindRun,
  createPixelTools,
  defaultApiFor,
  effortsFor,
  getRun,
  parseModelSpecs,
  pixelInstructions,
  releaseRun,
  selectRunTarget,
  type ModelSpec,
  type RunTarget,
} from "@pixelaition/agent";
```

- [ ] **Step 2: Replace the single-model setup with the catalog**

Replace the block from `const modelId = ...` through `function agentForEffort(...)` (currently lines 83-136) with:

```ts
const fallbackModelId = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
const parsedSpecs = parseModelSpecs(process.env.OPENAI_MODELS);
// One configured model is enough; this fallback keeps single-model setups,
// which only set OPENAI_MODEL, working unchanged.
const specs: ModelSpec[] =
  parsedSpecs.length > 0 ? parsedSpecs : [{ id: fallbackModelId }];

// The control is declared explicitly so the options survive model ids Anvia
// does not know, such as an OpenRouter slug. The adapter maps it to the
// provider field.
const completions = openai
  ? specs.map((spec) => ({
      spec,
      model: openai.completionModel({
        modelId: spec.id,
        api: spec.api ?? defaultApiFor(baseUrl),
        controls: defineCompletionModelControls({
          [REASONING_EFFORT_CONTROL_ID]: {
            type: "select",
            label: "Reasoning effort",
            options: effortsFor(spec.efforts),
          },
        }),
      }),
    }))
  : [];

const observer = langfuse?.observer({ redactInputs: true });

// Durable submits carry no model controls, so one agent is registered per
// model and reasoning effort and the run picks the pair the composer chose.
const agents = completions.flatMap(({ spec, model }) =>
  effortsFor(spec.efforts).map((effort) => ({
    id: `${agentPrefix}:${spec.id}:${effort}`,
    agent: new Agent({
      id: `${agentPrefix}:${spec.id}:${effort}`,
      model,
      instructions: pixelInstructions,
      tools: createPixelTools(),
      maxTurns: 12,
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
```

- [ ] **Step 3: Update `/health` and `/internal/agents`**

In `/health`, change `model: Boolean(model),` to `model: completions.length > 0,`.

Replace the `/internal/agents` body with:

```ts
res.json({
  models: specs.map((spec) => ({ id: spec.id, efforts: effortsFor(spec.efforts) })),
  agents: agents.map((entry) => entry.id),
});
```

- [ ] **Step 4: Select the agent by model and effort in `/internal/runs`**

Replace

```ts
const chosen = agentForEffort(body.reasoningEffort);
if (!chosen || !openai)
  return res.status(503).json({ message: "Add OPENAI_API_KEY to generate." });
```

with

```ts
const target = selectRunTarget(specs, body.modelId, body.reasoningEffort);
const chosen = agentForTarget(target);
if (!chosen || !openai)
  return res.status(503).json({ message: "Add OPENAI_API_KEY to generate." });
```

Then delete the old effort filter block

```ts
  const effort = efforts.includes(body.reasoningEffort)
    ? body.reasoningEffort
    : (efforts[0] ?? "none");
  const run = await runtime.submit({
    agentId: `${agentPrefix}:${effort}`,
```

and submit with the resolved target instead:

```ts
  const run = await runtime.submit({
    agentId: `${agentPrefix}:${target.modelId}:${target.effort}`,
```

Finally, change `void follow(runtime, run.id, body.runId, effort);` to `void follow(runtime, run.id, body.runId, target.effort);`.

- [ ] **Step 5: Update the boot log condition**

Change

```ts
console.log(
  `worker listening on ${port}${model ? ` with ${agents.length} drawing agents` : ""}`,
);
```

to use `completions.length > 0` in place of `model`.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @pixelaition/worker typecheck && pnpm --filter @pixelaition/worker lint`
Expected: exit 0.

- [ ] **Step 7: Probe the live agent registry**

Run the worker on a scratch port with a dummy key (no provider call happens at boot):

```sh
cd apps/worker
OPENAI_API_KEY=dummy \
OPENAI_BASE_URL=https://opencode.ai/zen/go/v1 \
OPENAI_MODELS='[{"id":"deepseek-v4.1-flash","api":"chat","efforts":["low","high","max"]},{"id":"muse-spark-1.3-contributor","api":"responses","efforts":["minimal","low","medium","high","xhigh"]}]' \
WORKER_INTERNAL_TOKEN=probe \
WORKER_PORT=4187 \
DURABLE_DATABASE_PATH="$TMPDIR/opencode/anvia-probe.sqlite" \
DATABASE_URL=postgresql://pixelaition:pixelaition@localhost:5432/pixelaition \
pnpm exec tsx src/index.ts &
sleep 2
curl -s -H "authorization: Bearer probe" http://localhost:4187/internal/agents
curl -s http://localhost:4187/health
kill %1
```

Expected: models array has `deepseek-v4.1-flash` with `["low","high","max"]` and `muse-spark-1.3-contributor` with `["minimal","low","medium","high","xhigh"]`; agents array has 8 ids; health shows `"model":true`.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat(worker): register one agent per model and reasoning effort"
```

---

### Task 3: API serves the catalog with per-model efforts

**Files:**

- Modify: `apps/api/src/app.ts:20` (import), `:105-111` (route), `:563-614` (listModels + listReasoningEfforts).

**Interfaces:**

- Consumes: `parseModelSpecs`, `effortsFor` from Task 1; worker route from Task 2.
- Produces: `GET /api/models` -> `{ models: Array<{ id: string; efforts: string[] }>; modelReady: boolean }` (consumed by Task 4). The `reasoningEfforts` field is removed.

- [ ] **Step 1: Extend the import**

Change `import { decidePrompt } from "@pixelaition/agent";` to:

```ts
import { decidePrompt, effortsFor, parseModelSpecs } from "@pixelaition/agent";
```

- [ ] **Step 2: Replace the catalog functions**

Replace everything from `let modelCache` through the end of `listReasoningEfforts` (currently lines 563-614) with:

```ts
let providerCache: { at: number; models: Array<{ id: string }> } | undefined;

async function providerModels(): Promise<Array<{ id: string }>> {
  if (providerCache && Date.now() - providerCache.at < 5 * 60 * 1000) {
    return providerCache.models;
  }
  const base = process.env.OPENAI_BASE_URL?.replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY;
  const fallback = process.env.OPENAI_MODEL ? [{ id: process.env.OPENAI_MODEL }] : [];
  if (!base || !key) return fallback;
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    const models = (body.data ?? []).map((model) => ({ id: model.id })).slice(0, 200);
    providerCache = { at: Date.now(), models: models.length > 0 ? models : fallback };
    return providerCache.models;
  } catch {
    return fallback;
  }
}

let workerCatalogCache:
  { at: number; models: Array<{ id: string; efforts: string[] }> } | undefined;

/**
 * The worker owns each model's reasoning-effort options, because only it
 * declares the controls. An unreachable worker returns undefined and the
 * caller falls back to the env catalog, then to the generic set.
 */
async function workerCatalog(): Promise<
  Array<{ id: string; efforts: string[] }> | undefined
> {
  if (workerCatalogCache && Date.now() - workerCatalogCache.at < 5 * 60 * 1000) {
    return workerCatalogCache.models;
  }
  const base = process.env.WORKER_INTERNAL_URL ?? "http://localhost:4002";
  try {
    const response = await fetch(`${base}/internal/agents`, {
      headers: { authorization: `Bearer ${process.env.WORKER_INTERNAL_TOKEN ?? ""}` },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      models?: Array<{ id: string; efforts?: string[] }>;
    };
    const models = (body.models ?? [])
      .filter((model) => model.id)
      .map((model) => ({ id: model.id, efforts: effortsFor(model.efforts) }));
    if (models.length === 0) return undefined;
    workerCatalogCache = { at: Date.now(), models };
    return models;
  } catch {
    return undefined;
  }
}

/**
 * The composer catalog. OPENAI_MODELS pins the list and its order; otherwise
 * the provider's /models list decides. Each entry carries the efforts the
 * worker registered for it.
 */
async function listModels(): Promise<Array<{ id: string; efforts: string[] }>> {
  const specs = parseModelSpecs(process.env.OPENAI_MODELS);
  const ids =
    specs.length > 0
      ? specs.map((spec) => spec.id)
      : (await providerModels()).map((model) => model.id);
  const reported = await workerCatalog();
  return ids.map((id) => ({
    id,
    efforts:
      reported?.find((model) => model.id === id)?.efforts ??
      effortsFor(specs.find((spec) => spec.id === id)?.efforts),
  }));
}
```

- [ ] **Step 3: Update the route**

Replace the `/api/models` handler body with:

```ts
app.get("/api/models", async (_req, res) => {
  res.json({
    models: await listModels(),
    modelReady: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
});
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @pixelaition/api typecheck && pnpm --filter @pixelaition/api lint`
Expected: exit 0.

- [ ] **Step 5: Probe the live endpoint**

With the dev stack running (restart it first so the API picks up the new code and `.env` — see Task 5), sign up a scratch user and read the catalog:

```sh
COOKIES="$TMPDIR/opencode/pxl-cookies.txt"
curl -s -c "$COOKIES" -H 'content-type: application/json' \
  -d '{"name":"Dev","email":"dev@example.com","password":"devpassword123"}' \
  http://localhost:3000/api/auth/sign-up/email
curl -s -b "$COOKIES" http://localhost:3000/api/models
```

Expected: `models` has exactly `deepseek-v4.1-flash` (`["low","high","max"]`) and `muse-spark-1.3-contributor` (`["minimal","low","medium","high","xhigh"]`), and `modelReady` is `false` until the user pastes their key. (If Better Auth rejects the sign-up payload, create the account through the web UI instead and reuse the browser cookies.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat(api): serve the composer catalog with per-model efforts"
```

---

### Task 4: Web composer swaps efforts per selected model

**Files:**

- Modify: `apps/web/src/screens/editor.tsx:101-109` (catalog query type), `:196-201` (add validity effects after the preferences effect), `:704-705` (models/efforts derivation).

**Interfaces:**

- Consumes: `GET /api/models` from Task 3.
- Produces: `Composer` receives `models: string[]` and `efforts: string[]` for the currently selected model. `composer.tsx` needs no change; its generic fallback still covers an empty list.

- [ ] **Step 1: Update the catalog query type**

Replace the catalog `useQuery` with:

```ts
const catalog = useQuery({
  queryKey: ["models"],
  queryFn: () =>
    api<{
      models: Array<{ id: string; efforts: string[] }>;
      modelReady: boolean;
    }>("/api/models"),
});
```

- [ ] **Step 2: Keep the selections valid when the catalog loads or changes**

Directly after the existing preferences effect (which ends with `}, [preferences.data]);`), add:

```ts
// A stored preference can name a model or effort that is no longer offered;
// the composer must always show a selectable pair.
useEffect(() => {
  const options = catalog.data?.models ?? [];
  if (options.length === 0) return;
  if (!options.some((item) => item.id === modelId)) setModelId(options[0]?.id ?? "");
}, [catalog.data, modelId]);

useEffect(() => {
  const options = catalog.data?.models.find((item) => item.id === modelId)?.efforts ?? [];
  if (options.length > 0 && !options.includes(effort)) setEffort(options[0] ?? "");
}, [catalog.data, modelId, effort]);
```

- [ ] **Step 3: Derive the composer lists per model**

Replace

```ts
const models = catalog.data?.models.map((item) => item.id) ?? [];
const efforts = catalog.data?.reasoningEfforts ?? [];
```

with

```ts
const models = catalog.data?.models.map((item) => item.id) ?? [];
const efforts = catalog.data?.models.find((item) => item.id === modelId)?.efforts ?? [];
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/screens/editor.tsx
git commit -m "feat(web): offer each model's reasoning efforts in the composer"
```

---

### Task 5: Environment and docs

**Files:**

- Modify: `.env` (local only, gitignored), `.env.example`, `README.md`, `AGENTS.md:24`.

**Interfaces:**

- Consumes: everything above.
- Produces: the running stack configured for OpenCode Go with only the two models listed.

- [ ] **Step 1: Point the local `.env` at OpenCode Go**

In `.env` set:

```
OPENAI_BASE_URL=https://opencode.ai/zen/go/v1
OPENAI_API_KEY=
OPENAI_MODEL=deepseek-v4.1-flash
OPENAI_MODELS=[{"id":"deepseek-v4.1-flash","api":"chat","efforts":["low","high","max"]},{"id":"muse-spark-1.3-contributor","api":"responses","efforts":["minimal","low","medium","high","xhigh"]}]
```

Leave `OPENAI_API_KEY` empty; the user pastes their OpenCode Go key themselves. Leave `TYPESAFE_API_KEY`, `DECISION_MODEL`, and `EVAL_MODEL` as they are.

- [ ] **Step 2: Document the variable in `.env.example`**

After the `OPENAI_MODEL=` line, add:

```
# Optional. The composer's model choices as JSON: id, api family (chat or
# responses), and the reasoning-effort options each model offers. Order is
# kept. When empty, the provider's /models list is shown with generic efforts.
# OPENAI_MODELS=[{"id":"deepseek-v4.1-flash","api":"chat","efforts":["low","high","max"]},{"id":"muse-spark-1.3-contributor","api":"responses","efforts":["minimal","low","medium","high","xhigh"]}]
```

Also extend the first comment in `.env.example` (line 1) to mention the Go endpoint:

```
# OpenAI-compatible chat. Point this at OpenRouter or any compatible endpoint,
# for example the OpenCode Go endpoint at https://opencode.ai/zen/go/v1.
```

- [ ] **Step 3: Update `README.md`**

In the "Run it" paragraph that explains `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`, add one sentence after the existing one:

```
Set `OPENAI_MODELS` to a JSON array of `{ id, api, efforts }` to pin the composer's model choices and each model's reasoning-effort options; without it, the provider's model list is shown with a generic effort set.
```

In the worker paragraph (the one ending "...because a Durable submission carries no model controls"), change "It registers one agent per reasoning effort" to "It registers one agent per model and reasoning effort".

- [ ] **Step 4: Update `AGENTS.md` line 24**

Change

```
Reasoning effort is set by registering one agent per effort and choosing the `agentId`, never by writing the effort into the prompt.
```

to

```
Reasoning effort is set by registering one agent per model and effort and choosing the `agentId`, never by writing the effort into the prompt.
```

- [ ] **Step 5: Restart the dev stack and verify end to end**

Kill the running `pnpm dev` background process, then start it again so the worker and API reload the new code and `.env`:

```sh
pnpm dev
```

Then re-run the probes:

```sh
TOKEN=$(grep '^WORKER_INTERNAL_TOKEN=' .env | cut -d= -f2)
curl -s -H "authorization: Bearer $TOKEN" http://localhost:4002/internal/agents
```

Expected: two models with the verified effort lists; 8 agent ids `pixel-draw:<model>:<effort>`.

Then repeat the `/api/models` probe from Task 3 Step 5. Expected: the two models in order, `modelReady: false` until the user pastes the key.

- [ ] **Step 6: Run the full check suite**

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all tasks successful; 0 failures.

- [ ] **Step 7: Commit the docs**

```bash
git add .env.example README.md AGENTS.md
git commit -m "docs: document OPENAI_MODELS and per-model reasoning efforts"
```

---

## Notes for the executor

- The `.env` file is gitignored; never commit it.
- `pnpm eval:judge` still uses `OPENAI_MODEL` (DeepSeek on Go is chat-only, so judge-style runs need a responses-capable model; not covered by this plan).
- After the final restart, the user only needs to paste their OpenCode Go API key into `OPENAI_API_KEY` and restart `pnpm dev` once more for Generate to work.

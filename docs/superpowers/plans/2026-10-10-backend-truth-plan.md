# Backend Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Postgres the single source of truth for drawing models and efforts, delete every deterministic fallback (including the proprietary `/decisions` endpoint usage), and make Langfuse tracing audited against the official best-practices page.

**Architecture:** New `models` table seeded by a Drizzle migration. Worker registers one Durable agent per model×effort from the DB; API serves and validates against the DB. The prompt decision becomes a structured completion (`generateCompletion` + zod `outputSchema`) against a real model — the `@anvia/openai` `decisionModel` is removed because it calls a proprietary `{baseUrl}/decisions` endpoint that OpenCode Go does not serve (verified: 404). Langfuse run attribution is added through the official `langfuse` SDK because `@anvia/durable` submissions cannot carry trace options (verified against installed types).

**Tech Stack:** TypeScript, Drizzle + PostgreSQL, Express, `@anvia/core` completion APIs, `@anvia/durable`, `@anvia/langfuse`, official `langfuse` SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-backend-truth-design.md`

## Global Constraints

- Node >= 22.16, pnpm 10; Conventional Commits (commitlint + husky run on every commit).
- TDD: every new pure unit gets a failing test first; deleted fallbacks delete their tests too (never adapt them).
- **Never read `.env` contents.** Inject it with `pnpm exec dotenv -e .env -- <cmd>` when a command needs secrets; inspect only non-secret lines you wrote yourself (`grep '^DECISION_MODEL=' .env`).
- Fail loud: missing config → 503 with the missing variable name; unknown model/effort → 422; provider failure → 502 carrying the provider message. No silent substitutions anywhere.
- OpenCode Go contract: every LLM request carries `x-opencode-session` + `user-agent: pixelaition/0.1` (`openCodeGoHeaders`); keep `maxTurns: 24`.
- Langfuse work follows the `langfuse` skill: fetch current docs before writing tracing code (never from memory), then run the real path and audit the trace against the freshly fetched best-practices page.
- The turborepo-managed block in `AGENTS.md` is never touched.

## Review Focus

- A malformed or empty `models` table must produce empty catalogs and loud errors, never a guess (Task 1 probes; Task 4 422/503 paths).
- The decision rewrite must work for a **responses** model (Muse) and never fall back to local regex on provider failure (Task 2 tests; Task 6 real run).
- Migration must apply on the existing database where `generation_runs.model_id` already holds old ids (Task 1, free-text column, no FK).
- Trace enrichment must merge into the observer's trace, not create a second trace per run (Task 3/6 verification fetches by the durable run id).
- No secret (API key, worker token, Langfuse key) appears in logs, traces, or error messages (Task 4 redaction; Task 6 log review).

---

### Task 1: Models table and seed migration

**Files:**

- Modify: `packages/db/src/schema.ts` (append the table; export it through the existing index)
- Create: generated migration under `packages/db/drizzle/` plus appended seed SQL
- Modify: `packages/db/src/index.ts` only if `export * from "./schema.js"` is absent

**Interfaces:**

- Produces: `models` table with `id: text pk`, `api: text notNull`, `efforts: jsonb notNull`, `position: integer notNull`, `enabled: boolean notNull default true`, `createdAt`/`updatedAt`. Seed rows: `deepseek-v4.1-flash` (chat, `["low","high","max"]`, 0), `muse-spark-1.3-contributor` (responses, `["minimal","low","medium","high","xhigh"]`, 1).

- [ ] **Step 1: Add the table**

Append to `packages/db/src/schema.ts` after `generationRuns`:

```ts
export const models = pgTable("models", {
  id: text("id").primaryKey(),
  api: text("api").notNull(),
  efforts: jsonb("efforts").notNull(),
  position: integer("position").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @pixelaition/db generate`
Expected: a new `0001_*.sql` in `packages/db/drizzle/` plus an updated `meta/_journal.json`.

- [ ] **Step 3: Append the seed SQL to the generated migration**

Append to the new migration file (the `->` lines are the file's own comment style; keep SQL only):

```sql
--> statement-breakpoint
INSERT INTO "models" ("id", "api", "efforts", "position") VALUES
  ('deepseek-v4.1-flash', 'chat', '["low","high","max"]'::jsonb, 0),
  ('muse-spark-1.3-contributor', 'responses', '["minimal","low","medium","high","xhigh"]'::jsonb, 1);
```

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:migrate`
Then: `docker exec pixelaition-db-1 psql -U pixelaition -d pixelaition -t -c "select id, api, efforts, position, enabled from models order by position;"`
Expected: exactly two rows, correct efforts arrays, `enabled = t`.

- [ ] **Step 5: Schema test**

Extend `packages/db/src/schema.test.ts` with one assertion that `models.efforts` and `models.position` exist (follow the existing test's style of asserting on the table's column map).
Run: `pnpm --filter @pixelaition/db test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): seed the drawing model catalog"
```

---

### Task 2: Agent package — exact selection, structured decision, required eval model

**Files:**

- Modify: `packages/agent/src/models.ts`, `packages/agent/src/models.test.ts`, `packages/agent/src/index.ts`
- Rewrite: `packages/agent/src/decide.ts`, `packages/agent/src/decide.test.ts`
- Modify: `packages/agent/src/evals/judge.ts`
- Delete: `packages/agent/scratch-decide.ts` (research probe, tracked for deletion)

**Interfaces:**

- Produces: `type ModelSpec = { id: string; api: "chat" | "responses"; efforts: string[] }`, `selectRunTarget(specs: ModelSpec[], modelId: string, effort: string): RunTarget | undefined` (exact match only), `DecisionNotConfiguredError`, `decidePrompt(prompt, env: { typesafeApiKey?; openaiApiKey?; openaiBaseUrl?; decisionModel?; decisionApi?: "chat" | "responses" }) : Promise<DrawDecision>` with `DrawDecision["source"]: "jev" | "model"`.
- Deletes: `genericEfforts`, `parseModelSpecs`, `effortsFor`, `defaultApiFor`, `decideFromPrompt`, `specificityFloor`, and the `specificityFloor` export line in `index.ts`; the Jev path keeps working through its own client.

- [ ] **Step 1: Rewrite the model-spec tests (RED)**

Replace the fallback-specific tests in `packages/agent/src/models.test.ts` with:

```ts
it("selects only exact model and effort pairs", () => {
  const specs: ModelSpec[] = [
    { id: "deepseek-v4.1-flash", api: "chat", efforts: ["low", "high", "max"] },
  ];
  expect(selectRunTarget(specs, "deepseek-v4.1-flash", "max")).toEqual({
    modelId: "deepseek-v4.1-flash",
    effort: "max",
  });
  expect(selectRunTarget(specs, "deepseek-v4.1-flash", "medium")).toBeUndefined();
  expect(selectRunTarget(specs, "muse-spark-1.3-contributor", "high")).toBeUndefined();
  expect(selectRunTarget([], "deepseek-v4.1-flash", "low")).toBeUndefined();
});
```

Keep the `openCodeGoHeaders` tests untouched.

- [ ] **Step 2: Watch them fail**

Run: `pnpm --filter @pixelaition/agent test -- src/models.test.ts`
Expected: FAIL — `selectRunTarget` no longer accepts the old shape / returns remaps.

- [ ] **Step 3: Implement exact selection**

In `packages/agent/src/models.ts` delete everything except `openCodeGoHeaders` and add:

```ts
export type ModelSpec = { id: string; api: "chat" | "responses"; efforts: string[] };
export type RunTarget = { modelId: string; effort: string };

/** Exact match only: an unknown pair returns undefined and the caller fails loud. */
export function selectRunTarget(
  specs: ModelSpec[],
  modelId: string,
  effort: string,
): RunTarget | undefined {
  const model = specs.find((spec) => spec.id === modelId);
  if (!model || !model.efforts.includes(effort)) return undefined;
  return { modelId: model.id, effort };
}
```

Update `packages/agent/src/index.ts`: drop `defaultApiFor`, `effortsFor`, `genericEfforts`, `parseModelSpecs`, `specificityFloor`; export `selectRunTarget`, `openCodeGoHeaders`, `type ModelSpec`, `type RunTarget`, plus the new decision surface from Step 4.

- [ ] **Step 4: Rewrite the decision tests (RED)**

Replace `packages/agent/src/decide.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import { DecisionNotConfiguredError, decidePrompt, toDecision } from "./decide.js";

describe("draw decisions", () => {
  it("refuses to decide without a configured model", async () => {
    await expect(decidePrompt("a 32x32 potion bottle", {})).rejects.toBeInstanceOf(
      DecisionNotConfiguredError,
    );
  });

  it("propagates provider failures instead of deciding offline", async () => {
    await expect(
      decidePrompt("a 32x32 potion bottle", {
        openaiApiKey: "not-a-real-key",
        openaiBaseUrl: "http://127.0.0.1:9/v1",
        decisionModel: "muse-spark-1.3-contributor",
        decisionApi: "responses",
      }),
    ).rejects.toThrow();
  });

  it("maps a structured decision onto the draw intent", () => {
    expect(toDecision({ intent: "variant", confidence: 0.82 }, "model")).toEqual({
      intent: "variant",
      confidence: 0.82,
      source: "model",
    });
    expect(
      toDecision({ intent: "clarify", confidence: 0.9, question: "What size?" }, "model"),
    ).toEqual({
      intent: "clarify",
      confidence: 0.9,
      question: "What size?",
      source: "model",
    });
  });
});
```

- [ ] **Step 5: Watch them fail**

Run: `pnpm --filter @pixelaition/agent test -- src/decide.test.ts`
Expected: FAIL — `DecisionNotConfiguredError` / `toDecision` do not exist.

- [ ] **Step 6: Implement the decision rewrite**

Rewrite `packages/agent/src/decide.ts` (Jev path preserved; the model path is a structured completion; nothing catches):

```ts
import { randomUUID } from "node:crypto";
import { generateCompletion } from "@anvia/core/completion";
import { choice, check, decide } from "@anvia/core/decision";
import type { DecisionModel } from "@anvia/core/decision";
import { JEV_LATEST, JevClient } from "@anvia/jev";
import { OpenAIClient } from "@anvia/openai";
import { z } from "zod";
import { openCodeGoHeaders } from "./models.js";

export type DrawIntent = "draw" | "edit" | "variant" | "clarify";
export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  question?: string;
  source: "jev" | "model";
};

/** Generation refuses to start until a real decision model is configured. */
export class DecisionNotConfiguredError extends Error {
  constructor() {
    super("Set DECISION_MODEL (or TYPESAFE_API_KEY) before generating.");
    this.name = "DecisionNotConfiguredError";
  }
}

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist on the frame.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const;

const intentQuestion = choice({
  instructions:
    "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists.",
  options: intentOptions,
});

const specificQuestion = check({
  instructions:
    "Answer yes when the request names a concrete subject and enough detail to draw it. Answer no when it is a placeholder such as 'draw something'.",
});

const decisionOutput = z.object({
  intent: z.enum(["draw", "edit", "variant", "clarify"]),
  confidence: z.number().min(0).max(1),
  question: z.string().min(1).max(300).optional(),
});
type DecisionOutput = z.infer<typeof decisionOutput>;

const decisionInstructions = [
  "Decide how to handle one pixel-art request.",
  "Answer draw, edit, or variant when the request is concrete.",
  "Answer clarify when it is too vague to draw from, and then ask exactly one short question.",
].join(" ");

export function toDecision(
  raw: DecisionOutput,
  source: DrawDecision["source"],
): DrawDecision {
  return {
    intent: raw.intent,
    confidence: raw.confidence,
    ...(raw.intent === "clarify" && raw.question ? { question: raw.question } : {}),
    source,
  };
}

function jevModel(apiKey: string): DecisionModel<unknown> {
  return new JevClient({ apiKey }).decisionModel({ modelId: JEV_LATEST });
}

async function askJev(
  model: DecisionModel<unknown>,
  prompt: string,
): Promise<DrawDecision> {
  const result = await decide({
    model,
    state: { prompt },
    questions: { intent: intentQuestion, specific: specificQuestion },
  });
  const { intent, specific } = result.answers;
  const chosen = intent.choice;
  if (chosen === "clarify" || specific.probability < 0.7) {
    return {
      intent: "clarify",
      confidence: Math.min(intent.confidence ?? 1, specific.probability),
      question:
        "What should the pixel asset show, and about how many pixels wide should it be?",
      source: "jev",
    };
  }
  return {
    intent: chosen in intentOptions ? chosen : "draw",
    confidence: intent.confidence ?? specific.probability,
    source: "jev",
  };
}

export async function decidePrompt(
  prompt: string,
  env: {
    typesafeApiKey?: string | undefined;
    openaiApiKey?: string | undefined;
    openaiBaseUrl?: string | undefined;
    decisionModel?: string | undefined;
    decisionApi?: "chat" | "responses" | undefined;
  },
): Promise<DrawDecision> {
  if (env.typesafeApiKey?.trim()) {
    return askJev(jevModel(env.typesafeApiKey.trim()), prompt);
  }
  const apiKey = env.openaiApiKey?.trim();
  const modelId = env.decisionModel?.trim();
  if (!apiKey || !modelId || !env.decisionApi) throw new DecisionNotConfiguredError();
  const baseUrl = env.openaiBaseUrl?.trim();
  const headers = openCodeGoHeaders(baseUrl, randomUUID());
  const client = new OpenAIClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
  });
  const model = client.completionModel({
    modelId: modelId as never,
    api: env.decisionApi,
  });
  const result = await generateCompletion({
    model,
    prompt,
    instructions: decisionInstructions,
    outputSchema: decisionOutput,
  });
  return toDecision(result.output, "model");
}
```

(If `result.output`'s inferred type mismatches `DecisionOutput`, read `CompletionResult` in `@anvia/core/completion`'s index and adjust the destructuring — the schema is the contract.)

- [ ] **Step 7: Make EVAL_MODEL required**

In `packages/agent/src/evals/judge.ts`, replace the model chain:

```ts
const modelId = process.env.EVAL_MODEL?.trim();
if (!modelId) {
  console.error(
    "EVAL_MODEL is required for judge evaluations. Set it to a model that supports structured outputs.",
  );
  process.exit(1);
}
```

and use `modelId` below (no `||` chain).

- [ ] **Step 8: Delete the research probe and run everything**

Run: `rm packages/agent/scratch-decide.ts`
Run: `pnpm --filter @pixelaition/agent test && pnpm --filter @pixelaition/agent typecheck && pnpm --filter @pixelaition/agent lint`
Expected: green; the two decision tests exercise the real client (no mocks) and prove there is no offline fallback.

- [ ] **Step 9: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): exact model selection and a real decision model"
```

---

### Task 3: Worker reads the catalog from Postgres and enriches Langfuse traces

**Files:**

- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/package.json` (add `langfuse`)
- Follow: `~/.agents/skills/langfuse/references/instrumentation.md` workflow

**Interfaces:**

- Consumes: `models` table (Task 1), `selectRunTarget`, `openCodeGoHeaders` (Task 2).
- Produces: `/internal/agents` → `{ models: [{ id, efforts }], agents: string[] }` from the DB; `/internal/runs` → 422 on unknown pair; trace enrichment attached per run.

- [ ] **Step 1: Read the current Langfuse docs (skill requirement)**

Fetch `https://langfuse.com/llms.txt`, then the tracing/ingestion pages it lists for the JS SDK. Determine the current constructor (`new Langfuse({ publicKey, secretKey, baseUrl })`) and the trace-upsert API (create/update a trace by id, then flush). Also fetch `https://langfuse.com/docs/observability/best-practices` now — it is re-fetched again in Task 6 for the audit.

- [ ] **Step 2: Add the SDK**

Run: `pnpm --filter @pixelaition/worker add langfuse`

- [ ] **Step 3: Replace the env catalog with the DB**

In `apps/worker/src/index.ts`:

- Imports: add `asc`, `eq` from `drizzle-orm`, `models` from `@pixelaition/db`, `Langfuse` from `langfuse`; from `@pixelaition/agent` import `selectRunTarget`, keep `openCodeGoHeaders`, drop `parseModelSpecs`/`effortsFor`/`defaultApiFor`.
- Delete `fallbackModelId`, `parsedSpecs`, and the `[{ id: fallbackModelId }]` fallback. Replace with:

```ts
const modelRows = await db
  .select()
  .from(models)
  .where(eq(models.enabled, true))
  .orderBy(asc(models.position));
const specs: ModelSpec[] = modelRows.map((row) => ({
  id: row.id,
  api: row.api === "chat" ? "chat" : "responses",
  efforts: (row.efforts as string[]) ?? [],
}));
```

- `completions`/`agents` build from `specs` exactly as today (one agent per model×effort, id `pixel-draw:<modelId>:<effort>`, `maxTurns: 24`).
- `/health`: `model: completions.length > 0`.
- `/internal/runs`: replace the selection block:

```ts
const target = selectRunTarget(specs, body.modelId, body.reasoningEffort);
if (!target) {
  return res.status(422).json({
    message: `Unknown model or effort: ${body.modelId} / ${body.reasoningEffort}.`,
  });
}
const chosen = agentForTarget(target);
```

(keep the existing 503 when `!chosen || !openai`), and submit with `agentId: \`${agentPrefix}:${target.modelId}:${target.effort}\``and`follow(..., target.effort)`.

- [ ] **Step 4: Enrich traces (per the fetched docs)**

Add, next to the `@anvia/langfuse` client:

```ts
const traceClient =
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
    ? new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        ...(process.env.LANGFUSE_BASE_URL
          ? { baseUrl: process.env.LANGFUSE_BASE_URL }
          : {}),
      })
    : undefined;
```

After `runtime.submit` resolves, upsert the run's trace attributes by the durable run id (`run.id` is the trace id the `@anvia/langfuse` observer uses — the existing `score({ traceId: snapshot.run.id })` call depends on it; Task 6 verifies the merge):

```ts
traceClient?.trace({ id: run.id }).update({
  sessionId: body.threadId,
  userId: body.userId,
  tags: ["pixelaition", "draw"],
  metadata: {
    assetId: body.assetId,
    frameId: frame.id,
    modelId: target.modelId,
    reasoningEffort: target.effort,
  },
});
```

In `follow`'s terminal branch, flush both clients (`await langfuse.flush(); await traceClient?.flushAsync?.();` — use the flush method names the fetched docs specify).

- [ ] **Step 5: Typecheck, lint, and probe against the seeded DB**

Run: `pnpm --filter @pixelaition/worker typecheck && pnpm --filter @pixelaition/worker lint`
Then probe with the dev stack's env injected (no `.env` reading):

```sh
TOKEN=$(grep '^WORKER_INTERNAL_TOKEN=' .env | cut -d= -f2)
curl -s -H "authorization: Bearer $TOKEN" http://localhost:4002/internal/agents
```

Expected: two models with the seeded effort lists and 8 `pixel-draw:<model>:<effort>` ids.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): draw from the database catalog and attribute traces"
```

---

### Task 4: API — DB catalog, loud validation, traced decisions

**Files:**

- Modify: `apps/api/src/app.ts`, `apps/api/package.json` (add `langfuse`)

**Interfaces:**

- Consumes: `models` table, `decidePrompt` + `DecisionNotConfiguredError` (Task 2).
- Produces: `GET /api/models` → `{ models: [{ id, efforts }], modelReady }` from the DB only; `POST /api/runs` → 422 unknown pair, 503 `DECISION_UNCONFIGURED`, 502 `DECISION_FAILED`; decision trace named `decide`.

- [ ] **Step 1: Replace the catalog functions**

In `apps/api/src/app.ts` delete `providerCache`, `providerModels`, `workerCatalogCache`, `workerCatalog`, and the fallback chain inside `listModels`. Replace with:

```ts
async function listModels(): Promise<Array<{ id: string; efforts: string[] }>> {
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.enabled, true))
    .orderBy(asc(models.position));
  return rows.map((row) => ({ id: row.id, efforts: (row.efforts as string[]) ?? [] }));
}
```

Imports: add `asc`, `models`; drop `effortsFor`, `parseModelSpecs`.

- [ ] **Step 2: Validate the pair and require a decision model**

In `POST /api/runs`, after ownership: read the catalog (reuse `listModels()`), then:

```ts
const pair = catalog.find((model) => model.id === body.modelId);
if (!pair || !pair.efforts.includes(body.reasoningEffort)) {
  return fail(
    res,
    422,
    "MODEL_NOT_AVAILABLE",
    "Pick a model and effort from the catalog.",
  );
}
const decisionModel = process.env.DECISION_MODEL?.trim();
const decisionApi = catalog.find((model) => model.id === decisionModel)?.api;
const hasJev = Boolean(process.env.TYPESAFE_API_KEY?.trim());
if (!hasJev && (!decisionModel || !decisionApi)) {
  return fail(
    res,
    503,
    "DECISION_UNCONFIGURED",
    "Set DECISION_MODEL to a model from the catalog before generating.",
  );
}
```

Move `ensureThread` **before** the decision call (the thread id is the trace session for the decision). Then wrap the decision:

```ts
const decided = await decidePrompt(body.prompt, {
  typesafeApiKey: process.env.TYPESAFE_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  decisionModel,
  decisionApi: decisionApi as "chat" | "responses" | undefined,
}).catch((reason: unknown) => reason);
if (decided instanceof Error) {
  const message =
    decided instanceof DecisionNotConfiguredError
      ? "Set DECISION_MODEL (or TYPESAFE_API_KEY) before generating."
      : decided.message;
  return decided instanceof DecisionNotConfiguredError
    ? fail(res, 503, "DECISION_UNCONFIGURED", message)
    : fail(res, 502, "DECISION_FAILED", message);
}
```

The `clarify` branch keeps returning 422 `PROMPT_NEEDS_DETAIL` with `decided.question`.

- [ ] **Step 3: Trace the decision call (docs first)**

Fetch the Langfuse JS SDK tracing page (same fetch as Task 3 Step 1; confirm constructor/trace API), run `pnpm --filter @pixelaition/api add langfuse`, then wrap the call above with a `decide` trace:

```ts
const decisionTrace = traceClient?.trace({
  name: "decide",
  sessionId: thread.id,
  userId: res.locals.userId as string,
  tags: ["pixelaition", "decide"],
  metadata: { modelId: decisionModel ?? "jev", assetId: body.assetId },
});
const generation = decisionTrace?.generation({ name: "decision", model: decisionModel ?? "jev" });
// after the call:
generation?.end({ output: decided, usage: /* from the decide result if exposed */ });
await traceClient?.flushAsync?.();
```

Where `traceClient` is built exactly like the worker's. Set the trace input to the user prompt only. If the fetched docs show a different update/end surface, follow the docs.

- [ ] **Step 4: Typecheck, lint, and probe**

Run: `pnpm --filter @pixelaition/api typecheck && pnpm --filter @pixelaition/api lint`
Then with the dev stack restarted (Task 5 restarts it):

- `POST /api/runs` with an unknown model id → 422 `MODEL_NOT_AVAILABLE`.
- Temporarily blanking `DECISION_MODEL` is **not** done via `.env` reading; test the 503 by asserting the code path in review, or by running the API once with `DECISION_MODEL=` inline override on a scratch port.
- Real Muse run passes through the structured decision (Task 6).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): validate against the database catalog and trace decisions"
```

---

### Task 5: Env and documentation cleanup

**Files:**

- Modify: `.env` (targeted sed only), `.env.example`, `README.md`, `AGENTS.md`

- [ ] **Step 1: Remove the dead variables**

```sh
sed -i '' '/^OPENAI_MODELS=/d; /^OPENAI_MODEL=/d' .env
grep -c '^OPENAI_MODELS=\|^OPENAI_MODEL=' .env || echo "removed"
grep '^DECISION_MODEL=' .env
```

Expected: `0` matches for the removed keys; `DECISION_MODEL=muse-spark-1.3-contributor` still present.

- [ ] **Step 2: Update `.env.example`**

Remove the `OPENAI_MODEL=` line and the whole `OPENAI_MODELS` comment block. Under the OpenAI section keep `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `EVAL_MODEL` and add:

```
# Required for pnpm eval:judge. A model that supports structured outputs.
EVAL_MODEL=
```

and for the decision:

```
# Required for Generate. Must name a model from the seeded catalog.
DECISION_MODEL=
```

(replace the old optional phrasing on `DECISION_MODEL`).

- [ ] **Step 3: Update `README.md`**

- Provider paragraph: models and their reasoning efforts come from the `models` table, changed through migrations; `DECISION_MODEL` is required for Generate; `EVAL_MODEL` is required for `pnpm eval:judge`; remove the `OPENAI_MODEL`/`OPENAI_MODELS` sentences.
- Worker paragraph: "It registers one agent per model and reasoning effort from the seeded catalog."

- [ ] **Step 4: Update `AGENTS.md`**

- Replace the `OPENAI_MODELS`-era bullet `A Durable submission carries no model controls. Reasoning effort is set by registering one agent per model and effort...` with the same sentence plus: models and efforts come from the `models` table (migrations only).
- Add one bullet: `When the app cannot do something for real — a missing key, an unknown model or effort, an unreachable provider — it says so with a naming error. Deterministic fallbacks and silent substitutions are forbidden.`

- [ ] **Step 5: Restart the stack and re-verify**

Restart `pnpm dev` (kill listeners on 3000/3001/4002 first, start it again) so the worker/API pick up the new code and env, then re-run the probes:

```sh
TOKEN=$(grep '^WORKER_INTERNAL_TOKEN=' .env | cut -d= -f2)
curl -s -H "authorization: Bearer $TOKEN" http://localhost:4002/internal/agents
```

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md AGENTS.md
git commit -m "docs: models live in the database and fallbacks are gone"
```

---

### Task 6: Full verification with a real run and the Langfuse audit loop

**Files:** none (verification only; findings become fixes)

- [ ] **Step 1: The suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green, including the rewritten agent tests.

- [ ] **Step 2: A real Muse run end to end**

Sign in and create a fresh asset, then run and stream (the same flow verified during planning):

```sh
J="$TMPDIR/opencode/pxl-trial"
P="0532f8a2-0d96-4d7e-b64c-44316409ca8d" # the "char" project
curl -s -c "$J/cookies.txt" -H 'content-type: application/json' \
  -d '{"email":"shafiq@testing.com","password":"Test@123"}' \
  http://localhost:3000/api/auth/sign-in/email
curl -s -b "$J/cookies.txt" -H 'content-type: application/json' -d '{"name":"truth-trial"}' \
  "http://localhost:3000/api/projects/$P/assets" -o "$J/asset.json"
AID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id' "$J/asset.json")
FID=$(curl -s -b "$J/cookies.txt" "http://localhost:3000/api/assets/$AID" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).frames[0].id')
curl -s -b "$J/cookies.txt" -H 'content-type: application/json' \
  -d "{\"assetId\":\"$AID\",\"frameId\":\"$FID\",\"prompt\":\"a round blue slime with a white highlight on top\",\"modelId\":\"muse-spark-1.3-contributor\",\"reasoningEffort\":\"xhigh\"}" \
  "http://localhost:3000/api/runs" -o "$J/run.json"
RID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runId' "$J/run.json")
curl -sN -b "$J/cookies.txt" "http://localhost:3000/api/runs/$RID/stream" \
  | perl -MTime::HiRes=time -ne 'printf "%.3f %s", time(), $_; if (/"type":"done"/){ exit 0 }' > "$J/stream.log"
grep -o '"type":"[^"]*"' "$J/stream.log" | sort | uniq -c
awk '/canvas-stroke/{n++; l=$1} END{print "strokes:", n}' "$J/stream.log"
```

Expected: `completed` status, progressive `canvas-stroke` events, DB pixels > 0 (decode `frames.layers->0->>'pixels'` with node as done during planning).

- [ ] **Step 3: Fetch and audit the trace (langfuse skill loop)**

Inject credentials via dotenv (never printed):

```sh
pnpm exec dotenv -e .env -- npx langfuse-cli api traces list --limit 5 --json
```

Then fetch the run's trace by the durable run id, re-fetch `https://langfuse.com/docs/observability/best-practices` fresh, and audit: model, usage, names, hierarchy, observation types, redaction, session/user/tags/metadata present on the **same** trace (no duplicate trace for the enrichment). Fix gaps, re-run, re-fetch, repeat until clean. Record the final trace id in the commit or summary.

- [ ] **Step 4: Failure-path probes**

- Unknown pair → 422 (curl).
- Provider failure → 502 with the provider message (temporarily point a scratch run at `http://127.0.0.1:9/v1` via inline env is not possible for the running stack; instead assert the code path review plus the agent test from Task 2 covers it).
- Log review: `grep -iE "pk-lf|sk-lf|Bearer |OPENAI_API_KEY" <dev log>` returns nothing.

- [ ] **Step 5: Final commit** (only if verification produced fixes)

```bash
git add -A
git commit -m "fix: close the gaps the live audit found"
```

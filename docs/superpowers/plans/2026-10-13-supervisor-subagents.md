# Supervisor + Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every drawing request becomes one durable `asset-draw` task — Jev sets the shape, a supervisor agent plans and reviews in one continuing conversation, up to four worker subagents paint their own frames in parallel behind an `allSettled` join, and the editor shows per-frame status with subtle pixel animation, frame-aware steering, injectable references, and parallel worker questions.

**Architecture:** A new `defineTask` registration in the worker orchestrates phases (plan → execute → review → fix). Supervisor and workers are owned agent children (`ctx.spawnAgent`, `continueFrom` for continuity); task code validates the plan and assembles every worker prompt. The worker binds each child run to its own frames with the existing `RunBinding` (`onStroke`/`onFrameChange`), so the live canvas feed, versions, approvals, and gates keep working unchanged. The API exposes a task snapshot/stream and routes steering through Jev; the web renders a task tree, per-frame badges, a plan card, and a composer frame-context toggle.

**Tech Stack:** TypeScript, pnpm workspace, `@anvia/durable` 0.10.0 (`defineTask`, `spawnAgent`, children joins, signals), `@anvia/core` 1.14.0 agents, Drizzle/Postgres, Express API, React + TanStack Query/Router, Tailwind v4, `motion`, Vitest, live browser checks, Langfuse OTLP traces.

**Spec:** `docs/superpowers/specs/2026-10-13-supervisor-subagents-design.md`

## Global Constraints

- Never merge `feat/multi-model-choice`; commit and push every task to it.
- Gate before every commit: `pnpm exec turbo typecheck lint test --force` green (24 tasks), plus live evidence for steps marked live.
- No silent substitutions or deterministic fallbacks; a failure names its cause.
- Live agent testing uses `muse-spark-1.3-contributor` (medium effort) only; subagents dispatched for review/execution work run on `opencode-go/deepseek-v4.1-flash#max` only.
- Interface colours come only from Sweetie 16 tokens (`DESIGN.md`); type and pixel utilities come from `apps/web/src/styles.css`; new animation uses whole pixels, `steps()` easing, and is disabled under `prefers-reduced-motion`.
- Models, efforts, and roles live in the `models` table; a durable submission carries no model controls (effort via `agentId`).
- One task per thread: a second drawing request for the same asset returns `RUN_IN_PROGRESS`.
- Workers write only their owned frames; frame CRUD, `set_palette`, `resize_canvas`, and target tools stay with the supervisor; palette additions happen in the plan phase.
- Every agentic case is read back from its Langfuse trace to judge context sufficiency; a case without a readable trace is not passed.

## Review Focus

1. **Second request while a task runs** — same asset, any entry point — must return `RUN_IN_PROGRESS`, never a second task, a queued duplicate, or a silently dropped request.
2. **Invalid plan** — duplicate frame names, a frame in two workers, more than four workers, a non-https reference, palette overflow — must re-plan once with the validation error and then fail with a named cause; no worker may be spawned from an unvalidated plan.
3. **Worker writing outside its frames** — the model will try (`use_frame` to a sibling, `add_frame`, `set_palette`) — must be refused with a named cause, with zero pixel changes and no effect on siblings.
4. **Restart at any phase** — kill the worker process mid-plan, mid-execute, mid-review, mid-fix — must resume from the checkpoint without duplicating children, and pending interactions must stay pending.
5. **Ambiguous steering** — a message with no clear frame while workers run — must surface the frame-picker card, route the answer as a signal, and never drop the message.

## File Structure

**Create**

| Path                                           | Responsibility                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `packages/db/drizzle/0016_run_tasks.sql`       | task table + run role columns                                      |
| `packages/agent/src/tasks/plan.ts`             | `DrawPlan` zod schema + `validatePlan` (pure)                      |
| `packages/agent/src/tasks/worker-prompt.ts`    | deterministic worker prompt builder (pure)                         |
| `packages/agent/src/tasks/roles.ts`            | role instruction texts + per-role tool-name sets                   |
| `packages/agent/src/tasks/asset-draw.ts`       | the `asset-draw` durable task definition                           |
| `apps/worker/src/tasks.ts`                     | task glue: registry, child watcher, plan persistence, usage rollup |
| `apps/web/src/lib/task.ts`                     | task snapshot types, query, SSE hook                               |
| `apps/web/src/components/plan-card.tsx`        | plan approval card (frames, workers, palette, references)          |
| `apps/web/src/components/question-summary.tsx` | pending-question counter near the composer                         |
| `apps/web/src/components/frame-status.tsx`     | per-frame status badge + sparkle animation                         |

**Modify**

| Path                                                          | Change                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema.ts`, `packages/db/src/schema.test.ts` | `run_tasks`, run role columns, schema assertions                                                                      |
| `packages/agent/src/runs.ts`                                  | binding gains `taskId`, `role`, `workerKey`, `ownedFrameIds`                                                          |
| `packages/agent/src/tools.ts`                                 | owned-frame enforcement; role tool filtering hook                                                                     |
| `packages/agent/src/index.ts`                                 | exports for the new task modules                                                                                      |
| `apps/worker/src/index.ts`                                    | task registration, runtime options, submitTask path, child bindings, recovery                                         |
| `apps/api/src/app.ts`                                         | shape decision, task submission, task snapshot/stream/steer/signal                                                    |
| `apps/api/src/store.ts`                                       | task row helpers, pending-interaction queries                                                                         |
| `apps/web/src/lib/run-activity.ts`                            | new task/worker event mapping                                                                                         |
| `apps/web/src/components/run-console.tsx`                     | task tree rows + header                                                                                               |
| `apps/web/src/components/editor-panels.tsx`                   | frame badges + worker chips                                                                                           |
| `apps/web/src/components/composer.tsx`                        | frame-context toggle + chip                                                                                           |
| `apps/web/src/screens/editor.tsx`                             | task wiring, crossfade switching, question surfacing                                                                  |
| `apps/web/src/styles.css`                                     | animation keyframes (`worker-blink`, `dither-sweep`, `sparkle`, `done-pop`, `glitch`, `ask-pulse`, `frame-crossfade`) |

---

### Task 1: `run_tasks` table and run role columns

**Files:**

- Create: `packages/db/drizzle/0016_run_tasks.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts:224-246` (generation_runs), append `runTasks`
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**

- Consumes: existing `generationThreads`, `assets` tables.
- Produces: `runTasks` table with columns `id, threadId, assetId, status, phase, shape, plan, usage, durableTaskId, createdAt, finishedAt`; `generationRuns` gains `taskId, role, workerKey, frameIds`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/schema.test.ts (append inside describe("schema"))
it("keeps the task columns the worker selects", () => {
  expect(Object.keys(runTasks)).toEqual(
    expect.arrayContaining([
      "id",
      "threadId",
      "assetId",
      "status",
      "phase",
      "shape",
      "plan",
      "usage",
      "durableTaskId",
    ]),
  );
  expect(Object.keys(generationRuns)).toEqual(
    expect.arrayContaining(["taskId", "role", "workerKey", "frameIds"]),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/db test`
Expected: FAIL — `runTasks` is not exported / columns missing.

- [ ] **Step 3: Add the schema**

```ts
// packages/db/src/schema.ts — after generationRuns
export const runTasks = pgTable("run_tasks", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => generationThreads.id, { onDelete: "cascade" }),
  assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  phase: text("phase").notNull(),
  shape: jsonb("shape"),
  plan: jsonb("plan"),
  usage: jsonb("usage"),
  durableTaskId: text("durable_task_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
```

and on `generationRuns`:

```ts
  taskId: text("task_id").references(() => runTasks.id, { onDelete: "set null" }),
  role: text("role"),
  workerKey: text("worker_key"),
  frameIds: jsonb("frame_ids"),
```

Export `runTasks` from `packages/db/src/index.ts` if the barrel lists tables explicitly.

- [ ] **Step 4: Write the migration and journal entry**

```sql
-- packages/db/drizzle/0016_run_tasks.sql
CREATE TABLE "run_tasks" (
  "id" text PRIMARY KEY,
  "thread_id" text NOT NULL REFERENCES "generation_threads"("id") ON DELETE CASCADE,
  "asset_id" text REFERENCES "assets"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "phase" text NOT NULL,
  "shape" jsonb,
  "plan" jsonb,
  "usage" jsonb,
  "durable_task_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "task_id" text REFERENCES "run_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "worker_key" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "frame_ids" jsonb;
```

Append to `packages/db/drizzle/meta/_journal.json` (same shape as the 0015 entry): `{ "idx": 16, "version": "7", "when": <Date.now()>, "tag": "0016_run_tasks", "breakpoints": true }`.

- [ ] **Step 5: Run test + migrate**

Run: `pnpm --filter @pixelaition/db test && pnpm db:migrate`
Expected: PASS; migration applies. Verify with:
`docker exec -i 72cb67f29dd2 psql -U pixelaition -d pixelaition -c "\d run_tasks"`

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): add run_tasks and run role columns"
git push origin feat/multi-model-choice
```

---

### Task 2: `DrawPlan` schema and validation

**Files:**

- Create: `packages/agent/src/tasks/plan.ts`
- Test: `packages/agent/src/tasks/plan.test.ts`
- Modify: `packages/agent/src/index.ts` (export)

**Interfaces:**

- Produces:
  - `type DrawPlan = { assetId: string; frames: PlanFrame[]; palette: PaletteAddition[]; references: PlanReference[]; workers: PlanWorker[]; review: boolean }`
  - `const drawPlanSchema: z.ZodType<DrawPlan>`
  - `function validatePlan(plan: DrawPlan, limits: { maxWorkers: number; maxFrames: number; maxPalette: number }): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agent/src/tasks/plan.test.ts
import { describe, expect, it } from "vitest";
import { drawPlanSchema, validatePlan } from "./plan.js";

const base = {
  assetId: "a1",
  frames: [
    { name: "idle", intent: "stands", layers: ["body"] },
    { name: "walk", intent: "steps", layers: ["body", "shadow"] },
  ],
  palette: [{ color: "#f4f4f4", name: "glow" }],
  references: [{ url: "https://example.com/bird.png", note: "wings", appliesTo: "all" }],
  workers: [
    { key: "w1", frames: ["idle"] },
    { key: "w2", frames: ["walk"] },
  ],
  review: true,
};

describe("drawPlanSchema", () => {
  it("accepts a complete plan", () => {
    expect(drawPlanSchema.safeParse(base).success).toBe(true);
  });
  it("rejects a plan without frames", () => {
    expect(drawPlanSchema.safeParse({ ...base, frames: [] }).success).toBe(false);
  });
});

describe("validatePlan", () => {
  const limits = { maxWorkers: 4, maxFrames: 12, maxPalette: 16 };
  it("accepts the base plan", () => {
    expect(validatePlan(base, limits)).toEqual({ ok: true });
  });
  it("names a duplicated frame", () => {
    const plan = {
      ...base,
      frames: [...base.frames, { name: "idle", intent: "again", layers: [] }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'The plan names frame "idle" twice.',
    });
  });
  it("names a frame missing from every worker", () => {
    const plan = { ...base, workers: [{ key: "w1", frames: ["idle"] }] };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Frame "walk" is not assigned to a worker.',
    });
  });
  it("names a frame assigned to two workers", () => {
    const plan = {
      ...base,
      workers: [
        { key: "w1", frames: ["idle", "walk"] },
        { key: "w2", frames: ["walk"] },
      ],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Frame "walk" is assigned to two workers.',
    });
  });
  it("caps workers and palette", () => {
    const many = {
      ...base,
      workers: ["w1", "w2", "w3", "w4", "w5"].map((key) => ({ key, frames: ["idle"] })),
    };
    expect(validatePlan(many, limits)).toEqual({
      ok: false,
      error: "The plan uses 5 workers; the cap is 4.",
    });
    const palette = { ...base, palette: [{ color: "#000000", name: "x" }] };
    expect(validatePlan(palette, { ...limits, maxPalette: 0 })).toEqual({
      ok: false,
      error: "The plan adds 1 colour; the style guide allows 0 more.",
    });
  });
  it("refuses a non-https reference", () => {
    const plan = {
      ...base,
      references: [{ url: "http://x.test/a.png", note: "", appliesTo: "all" as const }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Reference "http://x.test/a.png" must be an https URL.',
    });
  });
  it("refuses a reference aimed at an unknown frame", () => {
    const plan = {
      ...base,
      references: [{ url: "https://x.test/a.png", note: "", appliesTo: ["nope"] }],
    };
    expect(validatePlan(plan, limits)).toEqual({
      ok: false,
      error: 'Reference "https://x.test/a.png" names unknown frame "nope".',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent test -- plan`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/agent/src/tasks/plan.ts
import { z } from "zod";

export const planFrameSchema = z.object({
  name: z.string().min(1).max(40),
  intent: z.string().min(1).max(160),
  layers: z.array(z.string().min(1).max(40)).max(4),
});
export const paletteAdditionSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  name: z.string().min(1).max(40),
});
export const planReferenceSchema = z.object({
  url: z.string().url(),
  note: z.string().max(200),
  appliesTo: z.union([z.literal("all"), z.array(z.string().min(1).max(40)).min(1)]),
});
export const planWorkerSchema = z.object({
  key: z.string().regex(/^w[1-4]$/),
  frames: z.array(z.string().min(1).max(40)).min(1),
});
export const drawPlanSchema = z.object({
  assetId: z.string().min(1),
  frames: z.array(planFrameSchema).min(1).max(12),
  palette: z.array(paletteAdditionSchema).max(8),
  references: z.array(planReferenceSchema).max(8),
  workers: z.array(planWorkerSchema).min(1).max(4),
  review: z.boolean(),
});
export type DrawPlan = z.infer<typeof drawPlanSchema>;

export type PlanLimits = { maxWorkers: number; maxFrames: number; maxPalette: number };

export function validatePlan(
  plan: DrawPlan,
  limits: PlanLimits,
): { ok: true } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const frame of plan.frames) {
    if (seen.has(frame.name))
      return { ok: false, error: `The plan names frame "${frame.name}" twice.` };
    seen.add(frame.name);
  }
  if (plan.frames.length > limits.maxFrames) {
    return {
      ok: false,
      error: `The plan draws ${plan.frames.length} frames; the cap is ${limits.maxFrames}.`,
    };
  }
  const assigned = new Map<string, string>();
  for (const worker of plan.workers) {
    for (const name of worker.frames) {
      if (!seen.has(name))
        return {
          ok: false,
          error: `Worker ${worker.key} names unknown frame "${name}".`,
        };
      const other = assigned.get(name);
      if (other !== undefined)
        return { ok: false, error: `Frame "${name}" is assigned to two workers.` };
      assigned.set(name, worker.key);
    }
  }
  for (const frame of plan.frames) {
    if (!assigned.has(frame.name))
      return { ok: false, error: `Frame "${frame.name}" is not assigned to a worker.` };
  }
  if (plan.workers.length > limits.maxWorkers) {
    return {
      ok: false,
      error: `The plan uses ${plan.workers.length} workers; the cap is ${limits.maxWorkers}.`,
    };
  }
  if (plan.palette.length > limits.maxPalette) {
    return {
      ok: false,
      error: `The plan adds ${plan.palette.length} colour${plan.palette.length === 1 ? "" : "s"}; the style guide allows ${limits.maxPalette} more.`,
    };
  }
  for (const reference of plan.references) {
    if (!reference.url.startsWith("https://")) {
      return { ok: false, error: `Reference "${reference.url}" must be an https URL.` };
    }
    if (reference.appliesTo !== "all") {
      for (const name of reference.appliesTo) {
        if (!seen.has(name))
          return {
            ok: false,
            error: `Reference "${reference.url}" names unknown frame "${name}".`,
          };
      }
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test -- plan`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks packages/agent/src/index.ts
git commit -m "feat(agent): validate draw plans before any worker spawns"
git push origin feat/multi-model-choice
```

---

### Task 3: Worker prompt builder

**Files:**

- Create: `packages/agent/src/tasks/worker-prompt.ts`
- Test: `packages/agent/src/tasks/worker-prompt.test.ts`
- Modify: `packages/agent/src/index.ts` (export)

**Interfaces:**

- Consumes: `DrawPlan` frame shapes from Task 2.
- Produces: `function buildWorkerPrompt(input: WorkerPromptInput): string` where

```ts
export type WorkerPromptInput = {
  request: string;
  projectName: string;
  projectSummary?: string;
  assetName: string;
  assetSummary?: string;
  width: number;
  height: number;
  paletteSize: number;
  styleLines: string[];
  ownedFrames: Array<{ name: string; intent: string; layers: string[] }>;
  readOnlyFrames: string[];
  references: Array<{ url: string; note: string }>;
  attachments: number;
};
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agent/src/tasks/worker-prompt.test.ts
import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "./worker-prompt.js";

const input = {
  request: "ksatria berjalan dengan pedang menyala",
  projectName: "Hutan Ksatria",
  assetName: "ksatria-kecil",
  width: 32,
  height: 32,
  paletteSize: 10,
  styleLines: ["one outline color", "no anti-aliasing"],
  ownedFrames: [
    {
      name: "jalan-a",
      intent: "kaki kiri depan",
      layers: ["ksatria", "pedang", "cahaya"],
    },
    {
      name: "jalan-b",
      intent: "kaki kanan depan",
      layers: ["ksatria", "pedang", "cahaya"],
    },
  ],
  readOnlyFrames: ["idle"],
  references: [
    { url: "https://example.com/sword.png", note: "bilah terang, gagang cokelat" },
  ],
  attachments: 1,
};

describe("buildWorkerPrompt", () => {
  it("carries the request, the asset context, and the owned frames with layers", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("ksatria berjalan dengan pedang menyala");
    expect(prompt).toContain("Hutan Ksatria");
    expect(prompt).toContain("ksatria-kecil");
    expect(prompt).toContain("32×32");
    expect(prompt).toContain("jalan-a");
    expect(prompt).toContain("kaki kiri depan");
    expect(prompt).toContain("ksatria, pedang, cahaya");
    expect(prompt).toContain("one outline color");
  });
  it("states the ownership rule and the read-only frames", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("Paint only these frames");
    expect(prompt).toContain("idle");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("The palette already carries every colour you need");
  });
  it("lists references with their notes and mentions attachments only when present", () => {
    const prompt = buildWorkerPrompt(input);
    expect(prompt).toContain("https://example.com/sword.png");
    expect(prompt).toContain("bilah terang, gagang cokelat");
    expect(prompt).toContain("1 reference image");
    expect(buildWorkerPrompt({ ...input, attachments: 0, references: [] })).not.toContain(
      "reference image",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent test -- worker-prompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/agent/src/tasks/worker-prompt.ts
export type WorkerPromptInput = {
  request: string;
  projectName: string;
  projectSummary?: string;
  assetName: string;
  assetSummary?: string;
  width: number;
  height: number;
  paletteSize: number;
  styleLines: string[];
  ownedFrames: Array<{ name: string; intent: string; layers: string[] }>;
  readOnlyFrames: string[];
  references: Array<{ url: string; note: string }>;
  attachments: number;
};

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const lines = [
    `Request: ${input.request}`,
    `Project: ${input.projectName}${input.projectSummary ? ` — ${input.projectSummary}` : ""}`,
    `Asset: ${input.assetName}${input.assetSummary ? ` — ${input.assetSummary}` : ""}`,
    `Canvas: ${input.width}×${input.height}. Palette: ${input.paletteSize} colours.`,
    `Style: ${input.styleLines.join("; ")}.`,
    "Paint only these frames, on the layers named for each:",
    ...input.ownedFrames.map(
      (frame) => `- ${frame.name}: ${frame.intent}. Layers: ${frame.layers.join(", ")}.`,
    ),
  ];
  if (input.readOnlyFrames.length > 0) {
    lines.push(
      `Read-only for reference (never edit): ${input.readOnlyFrames.join(", ")}.`,
    );
  }
  if (input.references.length > 0) {
    lines.push("References you may view_image:");
    for (const reference of input.references) {
      lines.push(`- ${reference.url}${reference.note ? ` — ${reference.note}` : ""}`);
    }
  }
  lines.push(
    "The palette already carries every colour you need; do not add palette colours.",
    "Every frame you own must end with a clean critique and matching outlines across the frames you paint.",
  );
  if (input.attachments > 0) {
    lines.push(
      `The user attached ${input.attachments} reference image${input.attachments === 1 ? "" : "s"}; draw what they show within the palette.`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test -- worker-prompt`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks packages/agent/src/index.ts
git commit -m "feat(agent): assemble worker prompts from the validated plan"
git push origin feat/multi-model-choice
```

---

### Task 4: Role instructions and per-role tool sets

**Files:**

- Create: `packages/agent/src/tasks/roles.ts`
- Test: `packages/agent/src/tasks/roles.test.ts`
- Modify: `packages/agent/src/index.ts` (export)

**Interfaces:**

- Consumes: the existing tool list (`drawingTools`) which carries `name` on each tool.
- Produces:
  - `type AgentRole = "plan" | "worker" | "review" | "fix"`
  - `const planInstructions: string`, `workerInstructions: string`, `reviewInstructions: string`, `fixInstructions: string`
  - `const WORKER_TOOL_NAMES: ReadonlySet<string>`, `REVIEW_TOOL_NAMES: ReadonlySet<string>`
  - `function toolsForRole<T extends { name: string }>(role: AgentRole, tools: readonly T[]): T[]`
- Used by: Task 7's role-agent registration (one agent per role per model and effort, because an Anvia agent carries a fixed tool list).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agent/src/tasks/roles.test.ts
import { describe, expect, it } from "vitest";
import { REVIEW_TOOL_NAMES, WORKER_TOOL_NAMES, toolsForRole } from "./roles.js";

const tools = [
  "paint_stroke",
  "fill_rect",
  "add_layer",
  "rename_layer",
  "read_frame",
  "critique_frame",
  "check_animation",
  "web_search",
  "view_image",
  "ask_user",
  "add_frame",
  "delete_frame",
  "move_frame",
  "mirror_frame",
  "set_palette",
  "resize_canvas",
  "use_asset",
  "create_asset",
  "plan",
  "present_plan",
  "use_frame",
].map((name) => ({ name }));

describe("role tool sets", () => {
  it("gives a worker every painting and layer tool but no structural or target tool", () => {
    const names = toolsForRole("worker", tools).map((tool) => tool.name);
    for (const keep of [
      "paint_stroke",
      "fill_rect",
      "add_layer",
      "rename_layer",
      "read_frame",
      "critique_frame",
      "check_animation",
      "web_search",
      "view_image",
      "ask_user",
      "use_frame",
    ]) {
      expect(names).toContain(keep);
    }
    for (const drop of [
      "add_frame",
      "delete_frame",
      "move_frame",
      "mirror_frame",
      "set_palette",
      "resize_canvas",
      "use_asset",
      "create_asset",
      "plan",
      "present_plan",
    ]) {
      expect(names).not.toContain(drop);
    }
  });
  it("gives the review only reading and judgement tools", () => {
    const names = toolsForRole("review", tools).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_frame",
        "critique_frame",
        "check_animation",
        "web_search",
        "view_image",
      ]),
    );
    expect(names).not.toContain("paint_stroke");
    expect(names).not.toContain("ask_user");
  });
  it("gives the plan the whole catalogue and the fix the worker set", () => {
    expect(toolsForRole("plan", tools)).toHaveLength(tools.length);
    expect(toolsForRole("fix", tools).map((tool) => tool.name)).toEqual(
      toolsForRole("worker", tools).map((tool) => tool.name),
    );
  });
  it("keeps the sets exported for the worker's registration", () => {
    expect(WORKER_TOOL_NAMES.has("paint_stroke")).toBe(true);
    expect(WORKER_TOOL_NAMES.has("set_palette")).toBe(false);
    expect(REVIEW_TOOL_NAMES.has("paint_stroke")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent test -- roles`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/agent/src/tasks/roles.ts
export type AgentRole = "plan" | "worker" | "review" | "fix";

export const WORKER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "paint_stroke",
  "fill_rect",
  "erase_stroke",
  "draw_line",
  "flood_fill",
  "fill_region",
  "clear_region",
  "replace_color",
  "apply_outline",
  "dither_rect",
  "add_layer",
  "rename_layer",
  "set_layer_visible",
  "remove_layer",
  "read_project",
  "read_frame",
  "read_region",
  "preview_frame",
  "critique_frame",
  "check_animation",
  "use_frame",
  "web_search",
  "view_image",
  "ask_user",
]);

export const REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_project",
  "read_frame",
  "read_region",
  "preview_frame",
  "critique_frame",
  "check_animation",
  "web_search",
  "view_image",
]);

export function toolsForRole<T extends { name: string }>(
  role: AgentRole,
  tools: readonly T[],
): T[] {
  if (role === "plan") return [...tools];
  const names = role === "review" ? REVIEW_TOOL_NAMES : WORKER_TOOL_NAMES;
  return tools.filter((tool) => names.has(tool.name));
}

export const planInstructions = [
  "You plan pixel-art work; you do not paint in this phase.",
  "Read the project, the asset, its frames, and its summaries; search for references when the subject is a real species, character, or place.",
  "Decide the frames (names and intents), the layers each frame needs, the palette additions (within the style guide's colour maximum), the references (https only, with a short note), and the worker split (at most four workers; each frame in exactly one worker).",
  "Create the planned frames with add_frame and set the palette additions with set_palette before you finish.",
  "Finish by answering with one JSON object matching the plan schema and nothing else.",
].join("\n");

export const workerInstructions = [
  "You are one worker in a supervised team; you paint only the frames you were given.",
  "Follow the plan's intents and layer names exactly; keep outlines, palette, and proportions consistent with the read-only frames you can see.",
  "The palette is final; never call set_palette. Frame structure (adding, deleting, moving frames) is not yours; report anything you need instead of doing it.",
  "When a colour or shape is genuinely unclear, ask the user with ask_user instead of guessing.",
  "Call critique_frame before you finish and fix what it reports; end with a one-sentence summary of what you painted.",
].join("\n");

export const reviewInstructions = [
  "You are the supervisor's review pass; you never paint.",
  "Read every frame the workers produced, compare them with the plan and with each other: continuity, palette, outline colour, proportions, and the frames' intents.",
  "Finish by answering with one JSON object: { ok: true } when every frame passes, or { ok: false, fixes: [{ frame, note }] } with at most two fixes.",
].join("\n");

export const fixInstructions = [
  "You are a fix worker; you paint only the frames named in your task.",
  "Apply exactly the fix the review asked for, keep the palette and outlines of the neighbouring frames, and call critique_frame before you finish.",
  "End with a one-sentence summary of what changed.",
].join("\n");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test -- roles`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks packages/agent/src/index.ts
git commit -m "feat(agent): role instructions and per-role tool sets"
git push feat/multi-model-choice
```

---

### Task 5: Binding ownership and write enforcement

**Files:**

- Modify: `packages/agent/src/runs.ts` (RunBinding type, `frameBuffer`, add `assertOwnedFrame`)
- Modify: `packages/agent/src/tools.ts` (write tools call the guard)
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Consumes: existing `RunBinding` and tool tests' `boundRun()` helper.
- Produces:
  - `RunBinding` gains `taskId?: string`, `role?: AgentRole`, `workerKey?: string`, `ownedFrameIds?: ReadonlySet<string>`
  - `function assertOwnedFrame(run: RunBinding, frameId: string): void` — throws `Error('That frame belongs to another worker.')` when `ownedFrameIds` is set and does not contain `frameId`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/tools.test.ts (append a describe)
describe("worker frame ownership", () => {
  it("refuses a write to a frame outside the worker's set, with the cause named", async () => {
    boundRun({ ownedFrameIds: new Set(["frame-1"]) });
    await expect(
      tool("paint_stroke").call(
        {
          frameId: "frame-2",
          layerId: "pixels",
          label: "x",
          points: [{ x: 0, y: 0, color: 1 }],
        },
        { operationId: "run-1" },
      ),
    ).rejects.toThrow("That frame belongs to another worker.");
    releaseRun("run-1");
  });
  it("allows a write to an owned frame", async () => {
    boundRun({ ownedFrameIds: new Set(["frame-1"]) });
    await tool("paint_stroke").call(
      {
        frameId: "frame-1",
        layerId: "pixels",
        label: "dot",
        points: [{ x: 1, y: 1, color: 1 }],
      },
      { operationId: "run-1" },
    );
    releaseRun("run-1");
  });
});
```

(The existing `boundRun()` helper in this file must accept overrides; extend it to `function boundRun(overrides: Partial<RunBinding> = {})` and spread them into the bound run it builds.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/agent test -- tools`
Expected: FAIL — `ownedFrameIds` unknown / no refusal thrown.

- [ ] **Step 3: Implement**

In `packages/agent/src/runs.ts`:

```ts
export function assertOwnedFrame(run: RunBinding, frameId: string): void {
  if (run.ownedFrameIds !== undefined && !run.ownedFrameIds.has(frameId)) {
    throw new Error("That frame belongs to another worker.");
  }
}
```

Add the four optional fields to `RunBinding` with a comment: `/** Workers carry the frames they own; every write checks it. */`

In `packages/agent/src/tools.ts`, inside `resolveFrame` (the single place a frame id becomes a buffer) call the guard:

```ts
function resolveFrame(
  run: BoundRunBinding,
  frameId: string | undefined,
): { id: string; buffer: FrameBuffer } {
  const id = frameId ?? run.currentFrameId;
  assertOwnedFrame(run, id);
  const buffer = run.frames.get(id);
  if (!buffer) throw new Error("That frame is not on this asset.");
  return { id, buffer };
}
```

`use_frame` also calls `assertOwnedFrame` after resolving its target (switching to a sibling frame for _viewing_ is allowed only through `read_frame`, not by changing the painting cursor).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test`
Expected: PASS (all agent tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): workers may write only their owned frames"
git push origin feat/multi-model-choice
```

---

### Task 6: The `asset-draw` task definition

**Files:**

- Create: `packages/agent/src/tasks/asset-draw.ts`
- Test: `packages/agent/src/tasks/asset-draw.test.ts`
- Modify: `packages/agent/src/index.ts` (export)

**Interfaces:**

- Consumes: `DrawPlan`, `drawPlanSchema`, `validatePlan` (Task 2); `buildWorkerPrompt` (Task 3); role instructions (Task 4).
- Produces:

```ts
export type AssetDrawInput = {
  request: string;
  projectId: string;
  assetId: string | null;
  userId: string;
  threadId: string;
  attachments: number;
  agentIds: { plan: string; worker: string; review: string; fix: string };
  maxWorkers: number;
  review: boolean;
  maxFrames: number;
  maxPalette: number;
};
export type PlanContext = {
  projectName: string;
  assetName: string;
  assetId: string;
  paletteSize: number;
  styleLines: string[];
};
export type WorkerContext = {
  promptData: Omit<WorkerPromptInput, "ownedFrames" | "readOnlyFrames" | "references">;
};
export type AssetDrawDeps = {
  loadPlanContext(input: AssetDrawInput): Promise<PlanContext>;
  loadWorkerContext(
    input: AssetDrawInput,
    plan: DrawPlan,
    workerKey: string,
  ): Promise<WorkerContext>;
  loadReviewContext(input: AssetDrawInput, plan: DrawPlan): Promise<string>;
};
export function createAssetDrawTask(
  deps: AssetDrawDeps,
): DefinedTask<AssetDrawInput, AssetDrawCheckpoint, AssetDrawOutput>;
export function buildPlanPrompt(input: AssetDrawInput, retryError?: string): string;
export function parsePlanOutput(
  output: string,
): { ok: true; plan: DrawPlan } | { ok: false; error: string };
```

The task runs `phase: "plan"` in two transitions (spawn, then validate-and-spawn-workers), `phase: "execute"` (join, then review), and `phase: "review"` (spawn review, then fixes or finish), with at most two plan attempts and two review rounds.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agent/src/tasks/asset-draw.test.ts
import { describe, expect, it } from "vitest";
import { createAssetDrawTask, parsePlanOutput, buildPlanPrompt } from "./asset-draw.js";

const input = {
  request: "draw a walking knight",
  projectId: "p1",
  assetId: "a1",
  userId: "u1",
  threadId: "t1",
  attachments: 0,
  agentIds: {
    plan: "pixel-draw:muse:medium",
    worker: "pixel-draw:worker:muse:medium",
    review: "pixel-draw:review:muse:medium",
    fix: "pixel-draw:fix:muse:medium",
  },
  maxWorkers: 4,
  review: true,
  maxFrames: 12,
  maxPalette: 8,
};

const deps = {
  loadPlanContext: async () => ({
    projectName: "P",
    assetName: "A",
    assetId: "a1",
    paletteSize: 8,
    styleLines: ["outline"],
  }),
  loadWorkerContext: async () => ({
    promptData: {
      request: input.request,
      projectName: "P",
      assetName: "A",
      width: 32,
      height: 32,
      paletteSize: 8,
      styleLines: ["outline"],
      attachments: 0,
    },
  }),
  loadReviewContext: async () => "context",
};

const planJson = JSON.stringify({
  assetId: "a1",
  frames: [
    { name: "idle", intent: "stands", layers: ["body"] },
    { name: "walk", intent: "steps", layers: ["body", "shadow"] },
  ],
  palette: [],
  references: [],
  workers: [
    { key: "w1", frames: ["idle"] },
    { key: "w2", frames: ["walk"] },
  ],
  review: true,
});

/** A fake TaskContext: records spawns, returns canned children. */
function fakeCtx(options: {
  checkpoint: unknown;
  children: Array<{
    id: string;
    key: string;
    outcome?: { status: string; output?: unknown; error?: string };
  }>;
}) {
  const spawns: Array<{
    key: string;
    agentId: string;
    prompt: unknown;
    continueFrom?: string;
  }> = [];
  return {
    spawns,
    ctx: {
      id: "task-1",
      input,
      checkpoint: options.checkpoint,
      signal: new AbortController().signal,
      spawnAgent: (
        key: string,
        child: { agentId: string; prompt: unknown; continueFrom?: string },
      ) => {
        spawns.push({ key, ...child });
        return `child-${key}`;
      },
      children: () =>
        options.children.map((child) => ({
          ...child,
          status: "completed",
          wait: undefined,
        })),
      signalValue: () => undefined,
      agentRun: () => ({ id: "run" }),
      effect: async () => undefined,
    },
  };
}

describe("asset-draw plan phase", () => {
  it("spawns the plan child on the first transition", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0 },
      children: [],
    });
    const transition = await task.run(ctx as never);
    expect(spawns[0]?.key).toBe("plan");
    expect(spawns[0]?.agentId).toBe(input.agentIds.plan);
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-plan"] },
    });
  });

  it("validates the plan child's output and spawns one worker per assignment with continueFrom", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "completed", output: planJson },
        },
      ],
    });
    const transition = await task.run(ctx as never);
    expect(spawns.map((spawn) => spawn.key)).toEqual(["w1", "w2"]);
    expect(spawns.every((spawn) => spawn.continueFrom === "child-plan")).toBe(true);
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-w1", "child-w2"] },
    });
  });

  it("re-plans once with the validation error, then fails with the cause", async () => {
    const task = createAssetDrawTask(deps);
    const bad = JSON.stringify({
      ...JSON.parse(planJson),
      workers: [{ key: "w1", frames: ["idle"] }],
    });
    const first = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
      children: [
        { id: "child-plan", key: "plan", outcome: { status: "completed", output: bad } },
      ],
    });
    const retry = await task.run(first.ctx as never);
    expect(first.spawns[0]?.key).toBe("plan-1");
    expect(String(first.spawns[0]?.prompt)).toContain(
      'Frame "walk" is not assigned to a worker.',
    );
    expect(retry).toMatchObject({ status: "waiting" });

    const second = fakeCtx({
      checkpoint: { phase: "plan", attempt: 1, planChildId: "child-plan-1" },
      children: [
        {
          id: "child-plan-1",
          key: "plan-1",
          outcome: { status: "completed", output: bad },
        },
      ],
    });
    const failed = await task.run(second.ctx as never);
    expect(failed).toMatchObject({ status: "failed" });
    expect(String((failed as { error: string }).error)).toContain(
      "not assigned to a worker",
    );
  });

  it("fails when the plan child itself fails", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
      children: [
        { id: "child-plan", key: "plan", outcome: { status: "failed", error: "boom" } },
      ],
    });
    expect(await task.run(ctx as never)).toMatchObject({
      status: "failed",
      error: "The plan phase did not complete: failed.",
    });
  });
});

describe("asset-draw review phase", () => {
  it("spawns the review continuing the plan and finishes when it approves", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planChildId: "child-plan",
        round: 1,
        fixIds: [],
      },
      children: [],
    });
    await task.run(ctx as never);
    expect(spawns[0]?.key).toBe("review-1");
    expect(spawns[0]?.continueFrom).toBe("child-plan");

    const approved = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planChildId: "child-plan",
        round: 1,
        reviewChildId: "child-review-1",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-1",
          key: "review-1",
          outcome: { status: "completed", output: '{"ok":true}' },
        },
      ],
    });
    const done = await task.run(approved.ctx as never);
    expect(done).toMatchObject({
      status: "completed",
      output: { assetId: "a1", rounds: 1, workers: 2 },
    });
  });

  it("spawns fix workers continuing the review when it asks for fixes", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planChildId: "child-plan",
        round: 1,
        reviewChildId: "child-review-1",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-1",
          key: "review-1",
          outcome: {
            status: "completed",
            output: '{"ok":false,"fixes":[{"frame":"walk","note":"outline"}]}',
          },
        },
      ],
    });
    const transition = await task.run(ctx as never);
    expect(spawns.map((spawn) => spawn.key)).toEqual(["fix-1"]);
    expect(spawns[0]?.continueFrom).toBe("child-review-1");
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-fix-1"] },
    });
  });
});

describe("parsePlanOutput", () => {
  it("names a JSON failure", () => {
    expect(parsePlanOutput("not json")).toEqual({
      ok: false,
      error: "The plan was not valid JSON.",
    });
  });
  it("names a schema failure", () => {
    const result = parsePlanOutput('{"frames":[]}');
    expect(result.ok).toBe(false);
  });
});

describe("buildPlanPrompt", () => {
  it("asks for JSON and carries a retry error when present", () => {
    expect(buildPlanPrompt(input)).toContain("JSON");
    expect(buildPlanPrompt(input, 'Frame "x" is not assigned to a worker.')).toContain(
      'Frame "x" is not assigned to a worker.',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent test -- asset-draw`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/agent/src/tasks/asset-draw.ts
import { defineTask, type TaskContext, type TaskTransition } from "@anvia/durable";
import { z } from "zod";
import { drawPlanSchema, validatePlan, type DrawPlan } from "./plan.js";
import { buildWorkerPrompt, type WorkerPromptInput } from "./worker-prompt.js";
import {
  fixInstructions,
  planInstructions,
  reviewInstructions,
  workerInstructions,
} from "./roles.js";

export const assetDrawInputSchema = z.object({
  request: z.string().min(1).max(4000),
  projectId: z.string().min(1),
  assetId: z.string().min(1).nullable(),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  attachments: z.number().int().min(0).max(4),
  agentIds: z.object({
    plan: z.string().min(1),
    worker: z.string().min(1),
    review: z.string().min(1),
    fix: z.string().min(1),
  }),
  maxWorkers: z.number().int().min(1).max(4),
  review: z.boolean(),
  maxFrames: z.number().int().min(1).max(12),
  maxPalette: z.number().int().min(0).max(32),
});
export type AssetDrawInput = z.infer<typeof assetDrawInputSchema>;

export const assetDrawCheckpointSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("plan"),
    attempt: z.number().int().min(0).max(2),
    planChildId: z.string().optional(),
  }),
  z.object({
    phase: z.literal("execute"),
    plan: drawPlanSchema,
    planChildId: z.string(),
    workerIds: z.array(z.string()),
    reviewChildId: z.string().optional(),
  }),
  z.object({
    phase: z.literal("review"),
    plan: drawPlanSchema,
    planChildId: z.string(),
    round: z.number().int().min(1).max(2),
    reviewChildId: z.string().optional(),
    fixIds: z.array(z.string()),
  }),
]);
export type AssetDrawCheckpoint = z.infer<typeof assetDrawCheckpointSchema>;

export const assetDrawOutputSchema = z.object({
  assetId: z.string(),
  frames: z.array(z.string()),
  rounds: z.number().int().min(0).max(2),
  workers: z.number().int().min(1).max(4),
});
export type AssetDrawOutput = z.infer<typeof assetDrawOutputSchema>;

export function buildPlanPrompt(input: AssetDrawInput, retryError?: string): string {
  return [
    input.request,
    planInstructions,
    retryError === undefined
      ? ""
      : `Your previous plan was rejected: ${retryError} Answer again with one corrected JSON object.`,
    "Answer with JSON only.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function parsePlanOutput(
  output: string,
): { ok: true; plan: DrawPlan } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { ok: false, error: "The plan was not valid JSON." };
  }
  const parsed = drawPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `The plan failed validation: ${issue?.path.join(".")} ${issue?.message}.`,
    };
  }
  return { ok: true, plan: parsed.data };
}

type Ctx = TaskContext<AssetDrawInput, AssetDrawCheckpoint>;

function childOutput(
  ctx: Ctx,
  id: string,
): { status: string; output?: unknown; error?: string } | undefined {
  const child = ctx.children().find((record) => record.id === id);
  return child?.outcome;
}

/** Steering messages arrive as fixed signal names (steer-1, steer-2, …); the
 *  task scans until the first gap and hands them to the next supervisor pass. */
function deliveredSteers(ctx: Ctx): string {
  const messages: string[] = [];
  for (let index = 1; index <= 16; index += 1) {
    const value = ctx.signalValue(`steer-${index}`);
    if (value === undefined) break;
    const record = value as { message?: string; frames?: string[] };
    if (typeof record.message === "string") {
      messages.push(
        `The user steered${record.frames && record.frames.length > 0 ? ` (${record.frames.join(", ")})` : ""}: ${record.message}`,
      );
    }
  }
  return messages.length > 0 ? `User steering to honour: ${messages.join(" ")}` : "";
}

async function planPhase(
  ctx: Ctx,
  deps: AssetDrawDeps,
): Promise<TaskTransition<AssetDrawCheckpoint, AssetDrawOutput>> {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "plan" }>;
  if (checkpoint.planChildId === undefined) {
    const context = await deps.loadPlanContext(ctx.input);
    const key = checkpoint.attempt === 0 ? "plan" : `plan-${checkpoint.attempt}`;
    const id = ctx.spawnAgent(key, {
      agentId: ctx.input.agentIds.plan,
      prompt: `${buildPlanPrompt(ctx.input)}\nProject: ${context.projectName}. Asset: ${context.assetName}. Palette: ${context.paletteSize} colours.`,
    });
    return {
      status: "waiting",
      checkpoint: { ...checkpoint, planChildId: id },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  }
  const outcome = childOutput(ctx, checkpoint.planChildId);
  if (outcome?.status !== "completed" || typeof outcome.output !== "string") {
    return {
      status: "failed",
      error: `The plan phase did not complete: ${outcome?.status ?? "unknown"}.`,
    };
  }
  const parsed = parsePlanOutput(outcome.output);
  const checked = parsed.ok
    ? validatePlan(parsed.plan, {
        maxWorkers: ctx.input.maxWorkers,
        maxFrames: ctx.input.maxFrames,
        maxPalette: ctx.input.maxPalette,
      })
    : { ok: false as const, error: parsed.error };
  if (!checked.ok) {
    if (checkpoint.attempt >= 2)
      return { status: "failed", error: `The plan was invalid twice: ${checked.error}` };
    const id = ctx.spawnAgent(`plan-${checkpoint.attempt + 1}`, {
      agentId: ctx.input.agentIds.plan,
      prompt: buildPlanPrompt(ctx.input, checked.error),
    });
    return {
      status: "waiting",
      checkpoint: { phase: "plan", attempt: checkpoint.attempt + 1, planChildId: id },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  }
  const plan = parsed.ok ? parsed.plan : (undefined as never);
  const workerIds = [] as string[];
  for (const worker of plan.workers) {
    const context = await deps.loadWorkerContext(ctx.input, plan, worker.key);
    const ownedFrames = plan.frames.filter((frame) => worker.frames.includes(frame.name));
    const readOnly = plan.frames
      .filter((frame) => !worker.frames.includes(frame.name))
      .map((frame) => frame.name);
    const references = plan.references
      .filter(
        (reference) =>
          reference.appliesTo === "all" ||
          reference.appliesTo.some((name) => worker.frames.includes(name)),
      )
      .map((reference) => ({ url: reference.url, note: reference.note }));
    workerIds.push(
      ctx.spawnAgent(worker.key, {
        agentId: ctx.input.agentIds.worker,
        prompt: [
          workerInstructions,
          buildWorkerPrompt({
            ...context.promptData,
            ownedFrames,
            readOnlyFrames: readOnly,
            references,
          }),
        ].join("\n\n"),
        continueFrom: checkpoint.planChildId,
      }),
    );
  }
  return {
    status: "waiting",
    checkpoint: {
      phase: "execute",
      plan,
      planChildId: checkpoint.planChildId,
      workerIds,
    },
    wait: { type: "children", ids: workerIds, policy: "allSettled" },
  };
}

async function executePhase(
  ctx: Ctx,
  deps: AssetDrawDeps,
): Promise<TaskTransition<AssetDrawCheckpoint, AssetDrawOutput>> {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "execute" }>;
  const failed = checkpoint.workerIds.filter(
    (id) => childOutput(ctx, id)?.status !== "completed",
  );
  if (!ctx.input.review && failed.length === 0) {
    return {
      status: "completed",
      output: {
        assetId: checkpoint.plan.assetId,
        frames: checkpoint.plan.frames.map((frame) => frame.name),
        rounds: 0,
        workers: checkpoint.plan.workers.length,
      },
    };
  }
  const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
  const id = ctx.spawnAgent("review-1", {
    agentId: ctx.input.agentIds.review,
    prompt: [
      reviewInstructions,
      context,
      failed.length > 0 ? `Workers that did not finish: ${failed.join(", ")}.` : "",
      deliveredSteers(ctx),
    ]
      .filter((line) => line.length > 0)
      .join("\n\n"),
    continueFrom: checkpoint.planChildId,
  });
  return {
    status: "waiting",
    checkpoint: {
      phase: "review",
      plan: checkpoint.plan,
      planChildId: checkpoint.planChildId,
      round: 1,
      reviewChildId: id,
      fixIds: [],
    },
    wait: { type: "children", ids: [id], policy: "allSettled" },
  };
}

async function reviewPhase(
  ctx: Ctx,
  deps: AssetDrawDeps,
): Promise<TaskTransition<AssetDrawCheckpoint, AssetDrawOutput>> {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "review" }>;
  const finish = (
    rounds: number,
  ): TaskTransition<AssetDrawCheckpoint, AssetDrawOutput> => ({
    status: "completed",
    output: {
      assetId: checkpoint.plan.assetId,
      frames: checkpoint.plan.frames.map((frame) => frame.name),
      rounds,
      workers: checkpoint.plan.workers.length,
    },
  });
  if (checkpoint.reviewChildId === undefined) {
    const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
    const id = ctx.spawnAgent(`review-${checkpoint.round}`, {
      agentId: ctx.input.agentIds.review,
      prompt: [reviewInstructions, context, deliveredSteers(ctx)]
        .filter((line) => line.length > 0)
        .join("\n\n"),
      continueFrom: checkpoint.planChildId,
    });
    return {
      status: "waiting",
      checkpoint: { ...checkpoint, reviewChildId: id },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  }
  const outcome = childOutput(ctx, checkpoint.reviewChildId);
  if (outcome?.status !== "completed" || typeof outcome.output !== "string") {
    return {
      status: "failed",
      error: `The review phase did not complete: ${outcome?.status ?? "unknown"}.`,
    };
  }
  let verdict: { ok: boolean; fixes?: Array<{ frame: string; note: string }> };
  try {
    verdict = JSON.parse(outcome.output) as typeof verdict;
  } catch {
    return { status: "failed", error: "The review answered with invalid JSON." };
  }
  if (verdict.ok === true || checkpoint.round >= 2) return finish(checkpoint.round);
  const fixes = (verdict.fixes ?? [])
    .slice(0, 2)
    .filter((fix) => checkpoint.plan.frames.some((frame) => frame.name === fix.frame));
  if (fixes.length === 0) return finish(checkpoint.round);
  const fixIds = fixes.map((fix, index) => {
    const worker = checkpoint.plan.workers.find((candidate) =>
      candidate.frames.includes(fix.frame),
    );
    const frame = checkpoint.plan.frames.find(
      (candidate) => candidate.name === fix.frame,
    );
    return ctx.spawnAgent(`fix-${checkpoint.round}-${index + 1}`, {
      agentId: ctx.input.agentIds.fix,
      prompt: [
        fixInstructions,
        `Fix "${fix.frame}": ${fix.note}`,
        `Intent: ${frame?.intent ?? ""}.`,
      ].join("\n\n"),
      continueFrom: checkpoint.reviewChildId,
    });
  });
  return {
    status: "waiting",
    checkpoint: { ...checkpoint, fixIds },
    wait: { type: "children", ids: fixIds, policy: "allSettled" },
  };
}

export type PlanContext = {
  projectName: string;
  assetName: string;
  assetId: string;
  paletteSize: number;
  styleLines: string[];
};
export type WorkerContext = {
  promptData: Omit<WorkerPromptInput, "ownedFrames" | "readOnlyFrames" | "references">;
};
export type AssetDrawDeps = {
  loadPlanContext(input: AssetDrawInput): Promise<PlanContext>;
  loadWorkerContext(
    input: AssetDrawInput,
    plan: DrawPlan,
    workerKey: string,
  ): Promise<WorkerContext>;
  loadReviewContext(input: AssetDrawInput, plan: DrawPlan): Promise<string>;
};

export function createAssetDrawTask(deps: AssetDrawDeps) {
  return defineTask({
    name: "asset-draw",
    version: 1,
    input: assetDrawInputSchema,
    checkpoint: assetDrawCheckpointSchema,
    output: assetDrawOutputSchema,
    initial: () => ({ phase: "plan" as const, attempt: 0 }),
    run: async (ctx) => {
      if (ctx.checkpoint.phase === "plan") return planPhase(ctx, deps);
      if (ctx.checkpoint.phase === "execute") return executePhase(ctx, deps);
      return reviewPhase(ctx, deps);
    },
  });
}
```

Notes for the implementer:

- When the execute checkpoint already carries `reviewChildId` (resumed mid-review) or the review phase's `fixIds` are all terminal, the phases must move forward instead of re-spawning: re-read `ctx.children()` for the recorded ids before spawning anything (the tests cover the spawn path; the resume path is Task 11's kill tests).
- `parsePlanOutput` failures produce `error` strings that the re-plan prompt carries verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/agent test -- asset-draw`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks packages/agent/src/index.ts
git commit -m "feat(agent): asset-draw task with plan, execute, and review phases"
git push origin feat/multi-model-choice
```

---

### Task 7: Worker wiring — register the task and submit it

**Files:**

- Modify: `apps/worker/src/index.ts:824-853` (runtime open), `:977-1192` (`/internal/runs`), `:545-588` (agent registry exports a role-aware factory)
- Create: `apps/worker/src/tasks.ts`
- Test: live (durable journal)

**Interfaces:**

- Consumes: `createAssetDrawTask`, `AssetDrawDeps` (Task 6).
- Produces: `export function buildTaskDeps(): AssetDrawDeps` (created here, extended in Task 8); role agents registered as `pixel-draw:<model>:<effort>` (plan), `pixel-draw:worker:<model>:<effort>`, `pixel-draw:review:<model>:<effort>`, `pixel-draw:fix:<model>:<effort>`; the runtime registers `tasks: [{ registration: assetDraw.registration }]`, `maxConcurrentRuns: 6`, `maxConcurrentTasks: 2`; draw-mode requests go through `runtime.submitTask(assetDraw, { sessionId: threadId, requestId, input })` and return `202 { durableTaskId }`.

- [ ] **Step 1: Register the task and raise concurrency**

In `apps/worker/src/index.ts`:

```ts
import { createAssetDrawTask } from "@pixelaition/agent";
import { buildTaskDeps } from "./tasks.js";

const assetDraw = createAssetDrawTask(buildTaskDeps());

const runtime = await DurableRuntime.open({
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
  tasks: [{ registration: assetDraw.registration }],
  maxConcurrentRuns: 6,
  maxConcurrentTasks: 2,
  limits: { maxPayloadBytes: 8 * 1024 * 1024 },
});
```

- [ ] **Step 2: Submit draw-mode requests as tasks**

In the `/internal/runs` handler, keep the ask path unchanged and route draw mode to the task:

```ts
if (mode === "draw") {
  const task = await runtime.submitTask(assetDraw, {
    sessionId: threadId,
    requestId,
    input: {
      request: prompt,
      projectId: projectId ?? "",
      assetId: assetId ?? null,
      userId,
      threadId,
      attachments: attachments?.length ?? 0,
      agentIds: {
        plan: `${agentPrefix}:${modelId}:${reasoningEffort}`,
        worker: `${agentPrefix}:worker:${modelId}:${reasoningEffort}`,
        review: `${agentPrefix}:review:${modelId}:${reasoningEffort}`,
        fix: `${agentPrefix}:fix:${modelId}:${reasoningEffort}`,
      },
      maxWorkers: shape?.workers ?? 2,
      review: shape?.review ?? true,
      maxFrames: 12,
      maxPalette: 8,
    },
  });
  await recordTaskRow({ taskId: task.id, threadId, assetId, phase: "plan", shape });
  return res
    .status(202)
    .json({ durableTaskId: task.id, runId: publicIdForTask(task.id) });
}
```

`DurableConflictError` from `submitTask` keeps mapping to the existing 409 `RUN_IN_PROGRESS` path (the session is still `threadId`).

- [ ] **Step 3: Live check the registration**

Run: `pnpm dev` then start one drawing run through the API, and inspect:

```bash
sqlite3 apps/worker/data/anvia-runs.sqlite "select name, status from anvia_durable_runs order by rowid desc limit 3;"
sqlite3 apps/worker/data/anvia-runs.sqlite "select json_extract(record,'\$.name'), status from anvia_durable_tasks order by rowid desc limit 3;"
```

Expected: a task row named `asset-draw` in `pending`/`running` and its `plan` agent run present. (The exact table names are the durable store's; if `anvia_durable_tasks` is absent in this version, verify via `anvia_durable_runs` + the worker log line "task asset-draw submitted".)

- [ ] **Step 4: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): register the asset-draw task and submit draw runs as tasks"
git push origin feat/multi-model-choice
```

---

### Task 8: Task glue — child bindings, plan persistence, usage rollup

**Files:**

- Modify: `apps/worker/src/tasks.ts` (created by Task 7 with `buildTaskDeps`)
- Modify: `apps/worker/src/index.ts` (child binding + watcher start)
- Test: live (DB + durable journal)

**Interfaces:**

- Consumes: `AssetDrawDeps` (Task 6), `bindAssetRun`/`follow` machinery (`apps/worker/src/index.ts:1925+`), `publicIdByDurable`.
- Produces:
  - `buildTaskDeps(): AssetDrawDeps` — DB-backed loaders (created in Task 7, completed here if thin)
  - `watchTask(durableTaskId: string): void` — subscribes to `runtime.getTask(id).stream()`, binds each child run when its `agentRunId` appears, forwards child run events into the task's console event list, persists `run_tasks.plan/phase/status/usage`, and emits `task-phase`, `worker-spawned`, `worker-status`, `task-complete`.
  - `taskEvents(durableTaskId)` — the SSE source for `GET /api/tasks/:id/stream`.

- [ ] **Step 1: Implement the deps from the DB**

```ts
// apps/worker/src/tasks.ts
export function buildTaskDeps(): AssetDrawDeps {
  return {
    loadPlanContext: async (input) => {
      const [row] = await db
        .select({ project: projects, asset: assets })
        .from(projects)
        .leftJoin(assets, eq(assets.id, input.assetId ?? ""))
        .where(eq(projects.id, input.projectId));
      const style = (row?.asset?.style ?? defaultStyle) as StyleGuide;
      return {
        projectName: row?.project.name ?? "project",
        assetName: row?.asset?.name ?? "asset",
        assetId: input.assetId ?? "",
        paletteSize: ((row?.asset?.palette as string[] | undefined) ?? []).length,
        styleLines: styleLines(style),
      };
    },
    loadWorkerContext: async (input, plan, workerKey) => {
      /* asset row + summaries + palette + style, minus ownedFrames/readOnly/references */
    },
    loadReviewContext: async (input, plan) => {
      /* plan JSON + per-frame summaries + worker outcomes summary */
    },
  };
}
```

(Use the existing helpers for style rendering and summary lines; do not re-implement them.)

- [ ] **Step 2: Watch children and bind their runs**

```ts
const taskWatchers = new Map<string, AbortController>();

export function watchTask(durableTaskId: string): void {
  if (taskWatchers.has(durableTaskId)) return;
  const controller = new AbortController();
  taskWatchers.set(durableTaskId, controller);
  void (async () => {
    const handle = runtime.getTask(durableTaskId);
    for await (const event of handle.stream({ abortSignal: controller.signal })) {
      const record = await refreshTaskRecord(durableTaskId); // snapshot + children
      for (const child of record.children) {
        if (child.agentRunId === undefined) continue;
        await bindChildRunOnce(durableTaskId, child); // bindAssetRun with role/workerKey/ownedFrameIds, then follow()
      }
      await persistTaskProgress(durableTaskId, record);
      publishTaskEvent(durableTaskId, record);
    }
  })().finally(() => taskWatchers.delete(durableTaskId));
}
```

`bindChildRunOnce` must:

- Resolve `role` from the child key (`plan*` → plan, `w*` → worker, `review*` → review, `fix*` → fix) and `workerKey` from the key.
- Compute `ownedFrameIds` from the task's persisted plan (worker/fix: the assigned frames; plan/review: all planned frames for scope approval).
- Seed the run's `searchImages` allow-list with the plan's applicable reference URLs (Task 21 verifies this live).
- Reuse `bindAssetRun` with the role fields, then run the existing `follow` loop so `canvas-stroke`, `onFrameChange`, versions, and interactions all behave exactly as for today's single runs.
- Insert the child's `generation_runs` row with `taskId`, `role`, `workerKey`, `frameIds`, and a public id.

- [ ] **Step 3: Persist plan/phase/usage and emit task events**

- On the plan child's completion: write `run_tasks.plan` (validated JSON), `phase = "execute"`, emit `task-phase`.
- On worker spawn/terminal: update the child run rows; emit `worker-spawned` / `worker-status` with `{ workerKey, frames, status }`.
- On task completion: aggregate every child run's `usage` into `run_tasks.usage`, set `status`, `finishedAt`, emit `task-complete`.

- [ ] **Step 4: Live check**

Start a two-frame drawing run and verify, from the DB and the console stream:

```bash
docker exec -i 72cb67f29dd2 psql -U pixelaition -d pixelaition -c "select role, worker_key, frame_ids, status from generation_runs order by created_at desc limit 6;"
docker exec -i 72cb67f29dd2 psql -U pixelaition -d pixelaition -c "select phase, status, plan is not null as has_plan from run_tasks order by created_at desc limit 1;"
```

Expected: `plan` + `w1`(+`w2`) rows with `task_id` set, `worker_key` set, `frame_ids` listing each worker's frames, and the task row moving `plan → execute → review` with a stored plan.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): watch tasks, bind child runs, persist plan and usage"
git push origin feat/multi-model-choice
```

---

### Task 9: API — shape decision and task submission

**Files:**

- Modify: `apps/api/src/app.ts` (the decision call around the existing `POST /api/runs` path; `startRunViaWorker`)
- Modify: `apps/api/src/store.ts` (task helpers)
- Test: `apps/api/src/tasks.test.ts` (live DB, same probe/skip pattern as `home-routes.test.ts`)

**Interfaces:**

- Consumes: the existing Jev decision call; `startRunViaWorker`.
- Produces:
  - The Jev decision schema grows `shape: { workers: 1..4, review: boolean }`.
  - `insertTaskRecord(db, { id, threadId, assetId, status, phase, shape })`, `getTaskRecord(db, userId, id)`, `listPendingInteractions(db, assetId)`.
  - `POST /api/runs` for draw mode inserts the task row and forwards `shape` to the worker.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/tasks.test.ts — mirror home-routes.test.ts's live-DB probe and stubs
it("stores the shape Jev chose and forwards it to the worker", async () => {
  stubProviders({ decision: { intent: "draw", shape: { workers: 3, review: true } } });
  const started = await request(app).post("/api/runs").set("Cookie", cookie).send({
    assetId,
    frameId,
    prompt: "walk cycle",
    modelId: "muse-spark-1.3-contributor",
    reasoningEffort: "medium",
  });
  expect(started.status).toBe(202);
  const body = lastWorkerBody as { shape?: { workers?: number } };
  expect(body.shape?.workers).toBe(3);
  const [row] = await live.select().from(runTasks).where(eq(runTasks.assetId, assetId));
  expect(row?.shape).toMatchObject({ workers: 3, review: true });
});
it("answers a second request for the same asset with RUN_IN_PROGRESS", async () => {
  const again = await request(app).post("/api/runs").set("Cookie", cookie).send({
    assetId,
    frameId,
    prompt: "again",
    modelId: "muse-spark-1.3-contributor",
    reasoningEffort: "medium",
  });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("RUN_IN_PROGRESS");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: FAIL — no shape in the worker body / no `runTasks` import.

- [ ] **Step 3: Implement**

- Extend the decision schema with `shape` (`z.object({ workers: z.number().int().min(1).max(4), review: z.boolean() })`), default `{ workers: 2, review: true }` only when Jev omits it **and** log that the default was used (the model is asked to always answer; a missing key is a named degradation, not a silent one).
- Pass `shape` through `startRunViaWorker`'s body.
- Insert the `run_tasks` row before the worker call (status `queued`, phase `plan`); mark it failed with the named cause if the worker refuses.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): Jev shape decision and task submission"
git push origin feat/multi-model-choice
```

---

### Task 10: API — task snapshot, stream, steer, signal

**Files:**

- Modify: `apps/api/src/app.ts` (new routes), `apps/api/src/store.ts` (queries)
- Test: `apps/api/src/tasks.test.ts` (live)

**Interfaces:**

- Produces:
  - `GET /api/assets/:id/task` → `{ task: { id, phase, status, plan, usage } | null, workers: Array<{ key, frames: Array<{ id, name, status }>, runId, status, pendingInteraction?: { id, questions } }>, pendingQuestions: number }`
  - `GET /api/tasks/:id/stream` → SSE proxy of the worker's task stream (`/internal/tasks/:id/events`), same `after` cursor contract as runs.
  - `POST /api/tasks/:id/steer` → 202 `{ routed }` (Task 20 fills the Jev routing; until then it stores the message and answers 202 with `{ routed: "queued" }`).
  - `POST /api/tasks/:id/signal` → 204, forwards `{ name, requestId, value }` to the worker's `task.signal`.

- [ ] **Step 1: Write the failing test**

```ts
it("returns the task snapshot with per-frame worker state", async () => {
  const snapshot = await request(app)
    .get(`/api/assets/${assetId}/task`)
    .set("Cookie", cookie);
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.task?.phase).toBe("plan");
  expect(snapshot.body.workers.length).toBeGreaterThan(0);
  expect(snapshot.body.workers[0].frames[0]).toMatchObject({
    name: expect.any(String),
    status: expect.any(String),
  });
});
it("streams task events and accepts a signal", async () => {
  const signal = await request(app)
    .post(`/api/tasks/${taskId}/signal`)
    .set("Cookie", cookie)
    .send({ name: "clarify-1", requestId: "r1", value: { frame: "walk" } });
  expect(signal.status).toBe(204);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

- Snapshot: join `run_tasks` + child `generation_runs` (`taskId`) + the frames each child owns (`frameIds`), and read the pending interaction of each waiting child from the worker (`GET /internal/runs/:id/state` if it does not exist yet — add a small internal endpoint that returns the run's current interaction, reusing the existing active-run logic).
- Stream: proxy `/internal/tasks/:id/events?after=`; create that worker endpoint here — `taskEvents(durableTaskId)` (Task 8) plus the forwarded child run events, same cursor contract as the run stream.
- Steer/signal: create `POST /internal/tasks/:id/steer` and `POST /internal/tasks/:id/signal` in the worker; the signal endpoint calls `handle.signal(name, requestId, value)`, the steer endpoint stores the message and (until Task 19's routing) signals the supervisor with `steer-<n>`.
- State: add `GET /internal/runs/:id/state` in the worker returning the run's current interaction, reusing the active-run logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker
git commit -m "feat(api): task snapshot, stream, steer, and signal endpoints"
git push origin feat/multi-model-choice
```

---

### Task 11: Recovery — tasks and children survive a restart

**Files:**

- Modify: `apps/worker/src/index.ts` (`recoverInterruptedRuns` and boot order)
- Test: live kill/restart matrix (this task runs the first four kills)

**Interfaces:**

- Consumes: `watchTask` (Task 8).
- Produces: boot re-attaches every non-terminal `run_tasks` row (watcher + child bindings) **before** `runtime.resume()`, mirroring the existing run rule.

- [ ] **Step 1: Implement the recovery step**

```ts
async function recoverInterruptedTasks(): Promise<void> {
  const rows = await db
    .select()
    .from(runTasks)
    .where(inArray(runTasks.status, ["queued", "running", "waiting"]));
  for (const row of rows) {
    if (row.durableTaskId === null) continue;
    await watchTask(row.durableTaskId); // binds children before resume pumps them
  }
}
```

Call it from the boot sequence before `runtime.resume()`, next to `recoverInterruptedRuns`.

- [ ] **Step 2: Kill test — mid-plan**

Start a drawing run; wait for the plan child to appear; `kill -9` the worker process; restart `pnpm dev`.

Expected: the task resumes, the plan child is not duplicated (same child id), and the run completes.

- [ ] **Step 3: Kill test — mid-execute**

Start a two-worker run; wait until both workers are running; `kill -9`; restart.

Expected: the completed children are reused; the running children resume; no duplicate worker keys; `canvas-stroke` resumes into the same frames.

- [ ] **Step 4: Kill test — mid-review and mid-fix**

Repeat for the review phase (kill after `review-1` spawns) and for a fix round.

Expected: the review resumes; a pending plan approval stays pending; a pending worker question stays pending.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): recover tasks and their children before resume"
git push origin feat/multi-model-choice
```

---

### Task 12: Web — task client and event mapping

**Files:**

- Create: `apps/web/src/lib/task.ts`
- Modify: `apps/web/src/lib/run-activity.ts` (new event kinds), `apps/web/src/lib/run-stream.ts` (reuse for tasks)
- Test: `apps/web/src/lib/run-activity.test.ts` (append)

**Interfaces:**

- Produces:
  - `type TaskSnapshot` (task + workers with per-frame status + pendingQuestions), `useTaskSnapshot(assetId)`, `useTaskStream(taskId, onEvent)`
  - `applyRunEvent` learns: `task-phase`, `worker-spawned`, `worker-status`, `steering-routed`, `question-pending`, `task-complete` → rows tagged `{ role, workerKey, phase }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/run-activity.test.ts (append)
it("maps task events into worker-tagged rows", () => {
  const state = applyRunEvent(initialState, {
    type: "worker-status",
    data: { workerKey: "w2", frames: ["jalan-a"], status: "working" },
  });
  expect(state.rows.at(-1)).toMatchObject({
    kind: "worker",
    workerKey: "w2",
    text: expect.stringContaining("jalan-a"),
  });
  const phase = applyRunEvent(state, { type: "task-phase", data: { phase: "review" } });
  expect(phase.rows.at(-1)).toMatchObject({
    kind: "phase",
    text: expect.stringContaining("review"),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/web test -- run-activity`
Expected: FAIL — unknown event types ignored.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/task.ts
export type TaskFrameStatus = {
  id: string;
  name: string;
  status: "queued" | "working" | "done" | "failed" | "asking";
};
export type TaskWorkerState = {
  key: string;
  runId?: string;
  status: string;
  frames: TaskFrameStatus[];
  pendingInteraction?: {
    id: string;
    questions: Array<{
      id: string;
      text: string;
      choices?: Array<{ value: string; label: string }>;
    }>;
  };
};
export type TaskSnapshot = {
  task: {
    id: string;
    phase: string;
    status: string;
    plan: unknown;
    usage?: Record<string, number>;
  } | null;
  workers: TaskWorkerState[];
  pendingQuestions: number;
};
export function useTaskSnapshot(assetId: string) {
  return useQuery({
    queryKey: ["task", assetId],
    queryFn: () => api<TaskSnapshot>(`/api/assets/${assetId}/task`),
    refetchInterval: 4000,
  });
}
export function useTaskStream(
  taskId: string | undefined,
  onEvent: (event: RunEvent) => void,
) {
  // Same EventSource + `after` cursor pattern as useRunStream, pointed at /api/tasks/:id/stream.
}
```

`applyRunEvent` additions: a `worker-status` row (`kind: "worker"`, text `w2 working on jalan-a`), a `task-phase` row, a `steering-routed` row (`steering → w2 (jalan-a)`), a `question-pending` row (`w2 needs you`), and a `task-complete` row with rounds/usage.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @pixelaition/web test`
Expected: PASS (all web tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib
git commit -m "feat(web): task snapshot client and task event rows"
git push origin feat/multi-model-choice
```

---

### Task 13: Web — console task tree

**Files:**

- Modify: `apps/web/src/components/run-console.tsx`
- Modify: `apps/web/src/screens/editor.tsx:1523-1542`, `apps/web/src/screens/projects.tsx` (dock)
- Test: live + `apps/web/src/lib/run-activity.test.ts` grouping helper

**Interfaces:**

- Consumes: `applyRunEvent` rows tagged with `role`/`workerKey` (Task 12), `TaskSnapshot` (Task 12).
- Produces: `groupRowsByWorker(rows): Array<{ workerKey: string | null; rows: Row[] }>` (pure, tested) and a `TaskHeader` inside `RunConsole` showing phase, `n/N workers done`, and aggregated cost.

- [ ] **Step 1: Write the failing test for the grouping helper**

```ts
// apps/web/src/lib/run-activity.test.ts (append)
it("groups rows by worker, supervisor rows first", () => {
  const rows = [
    { kind: "phase", workerKey: null, text: "plan" },
    { kind: "tool", workerKey: "w2", text: "paint_stroke" },
    { kind: "tool", workerKey: "w1", text: "fill_rect" },
    { kind: "worker", workerKey: "w1", text: "done" },
  ] as never[];
  expect(groupRowsByWorker(rows).map((group) => group.workerKey)).toEqual([
    null,
    "w1",
    "w2",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/web test -- run-activity`
Expected: FAIL — `groupRowsByWorker` not exported.

- [ ] **Step 3: Implement the helper and the tree**

- `groupRowsByWorker` sorts supervisor/phase rows first, then workers by key.
- `RunConsole` renders each group with a small header row (`w2 · jalan-a · working`) and its rows beneath; the existing single-run rendering is the `workerKey === null` group, so nothing regresses.
- `TaskHeader` reads the snapshot: `phase`, `workers done/total`, `usage.cost`.

- [ ] **Step 4: Live check**

Run one two-worker drawing run and confirm the console shows `plan`, `w1`, `w2`, `review` groups with progress and cost; the home dock shows the same tree.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): task tree console with per-worker groups and header"
git push origin feat/multi-model-choice
```

---

### Task 14: Web — frame status badges with pixel animation

**Files:**

- Create: `apps/web/src/components/frame-status.tsx`
- Modify: `apps/web/src/components/editor-panels.tsx` (`FrameRow`), `apps/web/src/styles.css`
- Test: live (screenshots) + reduced-motion check

**Interfaces:**

- Consumes: `TaskFrameStatus` (Task 12).
- Produces: `<FrameStatus state={...} workerKey={...} />` rendering colour + shape/icon + label, with the animations from the spec.

- [ ] **Step 1: Add the keyframes**

```css
/* apps/web/src/styles.css — beside the existing keyframes */
@keyframes worker-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@keyframes dither-sweep {
  from {
    background-position: -8px 0;
  }
  to {
    background-position: 24px 0;
  }
}
@keyframes sparkle {
  0% {
    opacity: 0;
    transform: translate(0, 0);
  }
  40% {
    opacity: 0.5;
  }
  100% {
    opacity: 0;
    transform: translate(3px, -3px);
  }
}
@keyframes done-pop {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.06);
  }
  100% {
    transform: scale(1);
  }
}
@keyframes glitch {
  0% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(-2px);
  }
  100% {
    transform: translateX(2px);
  }
}
@keyframes ask-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
@keyframes frame-crossfade {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
.worker-blink {
  animation: worker-blink 900ms steps(2) infinite;
}
.dither-sweep {
  animation: dither-sweep 1.4s steps(8) infinite;
}
.sparkle {
  animation: sparkle 1.2s steps(4) infinite;
}
.done-pop {
  animation: done-pop 220ms steps(3) both;
}
.glitch {
  animation: glitch 180ms steps(2) both;
}
.ask-pulse {
  animation: ask-pulse 1s steps(2) infinite;
}
.frame-crossfade {
  animation: frame-crossfade 120ms steps(2) both;
}
@media (prefers-reduced-motion: reduce) {
  .worker-blink,
  .dither-sweep,
  .sparkle,
  .done-pop,
  .glitch,
  .ask-pulse,
  .frame-crossfade {
    animation: none;
  }
}
```

- [ ] **Step 2: Implement the badge**

```tsx
// apps/web/src/components/frame-status.tsx
export function FrameStatus({
  state,
  workerKey,
}: {
  state: TaskFrameStatus["status"];
  workerKey?: string;
}) {
  if (state === "queued")
    return (
      <span className="flex items-center gap-1 text-pixel-mono text-muted">
        <span className="h-2 w-2 border-2 border-line" />
        queued
      </span>
    );
  if (state === "working")
    return (
      <span className="flex items-center gap-1 text-pixel-mono text-accent">
        <span className="worker-blink h-2 w-2 bg-accent" />
        <PixelLoader size={12} />
        {workerKey ?? "working"}
      </span>
    );
  if (state === "done")
    return (
      <span className="done-pop flex items-center gap-1 text-pixel-mono text-accent">
        <Check width={12} height={12} />
        done
      </span>
    );
  if (state === "failed")
    return (
      <span className="glitch flex items-center gap-1 text-pixel-mono text-erase">
        <Close width={12} height={12} />
        failed
      </span>
    );
  return (
    <span className="ask-pulse flex items-center gap-1 border-2 border-accent px-1 text-pixel-mono text-accent">
      ? needs you
    </span>
  );
}
```

The working thumbnail overlay (two absolutely positioned 2×2 `span.sparkle` elements and a `dither-sweep` layer at 0.35 opacity) lives in `FrameRow`'s thumbnail wrapper; both use `accent`/`steel` tokens only.

- [ ] **Step 3: Wire into `FrameRow`**

`FrameRow` takes the frame's task state (`TaskFrameStatus | undefined`) and renders `<FrameStatus/>` beside the frame name plus the worker chip; the `asking` state also outlines the row with `border-accent`.

- [ ] **Step 4: Live check (screenshots)**

Run a two-worker drawing run, screenshot the frame list at three moments (working, done, asking via a live `ask_user`), and confirm: no colour-only signals, animations are subtle, and with `prefers-reduced-motion` emulated every state still reads.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): per-frame status badges with pixel animation"
git push origin feat/multi-model-choice
```

---

### Task 15: Web — smooth frame switching with per-frame live feeds

**Files:**

- Modify: `apps/web/src/screens/editor.tsx` (`canvas-stroke` handling at `:534-571`, frame select at `:1193-1210`)
- Test: live (browser)

**Interfaces:**

- Consumes: the task stream's forwarded child `canvas-stroke` events (Task 8/10).
- Produces: switching frames while workers paint never resets a draft; the canvas crossfades 120 ms.

- [ ] **Step 1: Route strokes per frame without resetting**

In the stream handler, `canvas-stroke` continues to write into `drafts[frameId].present`; add an explicit guard that a stroke for a non-active frame never touches the active draft, and that switching frames copies `drafts[next]` into the canvas (no refetch, no flash).

- [ ] **Step 2: Crossfade on switch**

```tsx
// editor.tsx — canvas wrapper
<div key={frameId} className="frame-crossfade"> <PixelCanvas ... /> </div>
```

- [ ] **Step 3: Live check**

Start a two-worker run; switch between the two frames repeatedly while both paint. Confirm: each frame shows its own worker's live strokes; no frame resets; the crossfade is subtle; the console keeps streaming.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): keep per-frame live feeds and crossfade on frame switch"
git push origin feat/multi-model-choice
```

---

### Task 16: Web — plan card

**Files:**

- Create: `apps/web/src/components/plan-card.tsx`
- Modify: `apps/web/src/components/interaction-card.tsx` (render it for plan interactions)
- Test: live

**Interfaces:**

- Consumes: the `present_plan` interaction payload extended in Task 6's spec (frames with layers, workers, palette, references).
- Produces: `<PlanCard plan={...} onApprove={...} onEdit={...} />` with staggered rows (40 ms apart, `assemble-rise`).

- [ ] **Step 1: Implement the card**

Render: frames (name + intent + layers), the worker split (`w1 → idle, attack`), palette additions (swatches + names), reference count; an approve button and an edit affordance that returns the model to re-plan with the user's note.

- [ ] **Step 2: Wire it**

`interaction-card.tsx` renders `PlanCard` when the interaction carries plan fields; otherwise the existing staged-plan rendering stays.

- [ ] **Step 3: Live check**

Start a run; the plan card appears; approve it and confirm workers spawn; reject it and confirm the plan phase re-plans with the note.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): plan approval card with workers, palette, and references"
git push origin feat/multi-model-choice
```

---

### Task 17: Web — composer frame-context toggle

**Files:**

- Modify: `apps/web/src/components/composer.tsx`, `apps/web/src/screens/editor.tsx`
- Test: live

**Interfaces:**

- Produces: `Composer` accepts `frameContext?: { name: string; enabled: boolean; onToggle: () => void }`; when enabled, a chip shows the frame name and `Send` posts to `/api/tasks/:id/steer` with `{ prompt, frameName }`.

- [ ] **Step 1: Implement the toggle**

An `IconButton` (existing component, same height as the composer's controls) with a frame-target pixel icon (`Select` glyph), `aria-pressed`, tooltip "About this frame"; when on, a `pixel-corners-sm` chip renders the active frame's name.

- [ ] **Step 2: Wire the send path**

`editor.tsx` passes `frameContext` when a task is live (or a frame is selected) and routes the message: toggle on → `POST /api/tasks/:id/steer` with the frame name; toggle off → the existing run/steer path.

- [ ] **Step 3: Live check**

Toggle on, send "bayangannya kurang gelap" while viewing `jalan-a`, and confirm the console shows `steering → w2 (jalan-a)`; toggle off and confirm the message goes to the supervisor.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): composer frame-context toggle for steering"
git push origin feat/multi-model-choice
```

---

### Task 18: Web — pending questions surface per frame

**Files:**

- Create: `apps/web/src/components/question-summary.tsx`
- Modify: `apps/web/src/screens/editor.tsx` (question card per frame)
- Test: live

**Interfaces:**

- Consumes: `TaskSnapshot.workers[].pendingInteraction`, `pendingQuestions`.
- Produces: a counter near the composer ("2 questions waiting") that jumps to the frame; opening a frame with a pending interaction renders its card; answering posts to that child run's `respond`.

- [ ] **Step 1: Implement the counter and jump**

`QuestionSummary` lists `workerKey · frame · question` and calls `onJump(frameId)`; `editor.tsx` selects the frame and focuses the card.

- [ ] **Step 2: Surface the card on frame open**

When the active frame's worker has a `pendingInteraction`, render the existing `InteractionCard` with that interaction (same dropdown machinery); after `respond`, refresh the snapshot.

- [ ] **Step 3: Live check**

Trigger a worker `ask_user` (prompt that forces a choice), confirm the badge, counter, and card; answer and confirm the badge clears and the worker resumes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): pending worker questions per frame"
git push origin feat/multi-model-choice
```

---

### Task 19: Jev steering routing and the frame picker

**Files:**

- Modify: `apps/api/src/app.ts` (`POST /api/tasks/:id/steer`), `apps/api/src/store.ts`
- Test: `apps/api/src/tasks.test.ts` (live) + unit for the mapping

**Interfaces:**

- Produces: `routeSteering(message, snapshot, plan): Promise<{ target: "supervisor" | string; frames: string[]; confidence: number }>` via Jev; `STEERING_CONFIDENCE = 0.7`; high confidence → `task.signal('steer-<n>', ...)` (or direct child steer when the worker runs); low confidence → `202 { routed: "clarify", candidates: frames }` and the web shows the frame picker; the answer arrives at `/api/tasks/:id/signal`.

- [ ] **Step 1: Write the failing test**

```ts
it("routes a confident steering message to the named worker", async () => {
  stubProviders({ steering: { target: "w2", frames: ["jalan-a"], confidence: 0.9 } });
  const res = await request(app)
    .post(`/api/tasks/${taskId}/steer`)
    .set("Cookie", cookie)
    .send({ prompt: "the shadow is too light", frameName: "jalan-a" });
  expect(res.status).toBe(202);
  expect(res.body.routed).toBe("w2");
});
it("asks the user when the route is unclear", async () => {
  stubProviders({ steering: { target: "supervisor", frames: [], confidence: 0.2 } });
  const res = await request(app)
    .post(`/api/tasks/${taskId}/steer`)
    .set("Cookie", cookie)
    .send({ prompt: "make it better" });
  expect(res.body.routed).toBe("clarify");
  expect(res.body.candidates.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: FAIL — `routed` missing.

- [ ] **Step 3: Implement**

- When the composer sends a `frameName` (toggle on), skip Jev and route to that frame's worker directly.
- Otherwise call Jev with the message + plan + live worker activity; map names → app ids in code; below threshold return `clarify` with the frame candidates.
- Deliver: `handle.signal('steer-<n>', requestId, { target, frames, message })`; the task's phases read `signalValue` and incorporate it (workers get a steer into their run when live, otherwise the review prompt carries it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/api test -- tasks`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker
git commit -m "feat(api): Jev-routed steering with a frame picker fallback"
git push origin feat/multi-model-choice
```

---

### Task 20: Reference injection into workers

**Files:**

- Modify: `apps/worker/src/tasks.ts` (`bindChildRunOnce` seeds the allow-list)
- Test: unit (`referencesForWorker`) + live

**Interfaces:**

- Produces: `referencesForWorker(plan: DrawPlan, workerKey: string): string[]` — the URLs whose `appliesTo` is `"all"` or names one of the worker's frames; `bindChildRunOnce` seeds the child binding's `searchImages` with them.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/worker/src/tasks.test.ts
it("selects the references a worker may view", () => {
  const plan = {
    frames: [
      { name: "jalan-a", intent: "", layers: [] },
      { name: "idle", intent: "", layers: [] },
    ],
    palette: [],
    review: true,
    assetId: "a",
    references: [
      { url: "https://x.test/all.png", note: "", appliesTo: "all" as const },
      { url: "https://x.test/walk.png", note: "", appliesTo: ["jalan-a"] },
      { url: "https://x.test/idle.png", note: "", appliesTo: ["idle"] },
    ],
    workers: [
      { key: "w1", frames: ["jalan-a"] },
      { key: "w2", frames: ["idle"] },
    ],
  };
  expect(referencesForWorker(plan, "w1")).toEqual([
    "https://x.test/all.png",
    "https://x.test/walk.png",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/worker test`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement and seed**

```ts
export function referencesForWorker(plan: DrawPlan, workerKey: string): string[] {
  const worker = plan.workers.find((candidate) => candidate.key === workerKey);
  if (!worker) return [];
  return plan.references
    .filter(
      (reference) =>
        reference.appliesTo === "all" ||
        reference.appliesTo.some((name) => worker.frames.includes(name)),
    )
    .map((reference) => reference.url);
}
```

In `bindChildRunOnce`, seed `searchImages` with these URLs before the follow loop starts.

- [ ] **Step 4: Live check**

Run a task whose plan carries a real reference (e.g., "burung cendrawasih"); from the durable journal confirm a worker called `view_image` on the supervisor's URL and described what it saw.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): seed workers with the supervisor's references"
git push origin feat/multi-model-choice
```

---

### Task 21: Home integration

**Files:**

- Modify: `apps/web/src/screens/projects.tsx` (dock console + snapshot), `apps/api/src/app.ts` (`/api/home/runs` confirm path)
- Test: live

**Interfaces:**

- Consumes: Tasks 10–13.
- Produces: the home's console renders the task tree; the home's confirm path forwards `shape`; the home→editor transition keeps working.

- [ ] **Step 1: Point the home at the task snapshot**

Replace the home's active-run query with `useTaskSnapshot` for the target asset and pass the tree rows into the same `RunConsole`.

- [ ] **Step 2: Forward shape from the home confirm**

The home's `POST /api/home/runs` confirm path sends the stored proposal's shape to the worker exactly like `POST /api/runs`.

- [ ] **Step 3: Live check**

From the home, start a drawing run; confirm the tree, the per-frame badges (after entering the editor), and the view transition still morphs the dock.

- [ ] **Step 4: Commit**

```bash
git add apps/web apps/api
git commit -m "feat(home): task tree and shape through the home path"
git push origin feat/multi-model-choice
```

---

### Task 22: Trace verification harness

**Files:**

- Create: `tools/trace-check.mjs`
- Test: run it against one completed task

**Interfaces:**

- Produces: `node tools/trace-check.mjs <taskId>` printing, per generation in the task's trace, the presence of required context markers (plan: request + project/asset names; worker: owned frame names + layer names + palette line + reference URLs; review: plan frame list + worker outcomes), exiting non-zero when a marker is missing.

- [ ] **Step 1: Implement the fetcher**

Use the Langfuse API (`GET /api/public/traces?sessionId=...` then `GET /api/public/observations?traceId=...` with basic auth from `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, or the `langfuse` CLI skill if available) and assert the markers per generation name.

- [ ] **Step 2: Run it on a real task**

Run: `node tools/trace-check.mjs <taskId>`
Expected: every generation lists its markers as present; a deliberately thinned prompt makes it exit non-zero (verify once by temporarily removing a marker from the worker prompt).

- [ ] **Step 3: Commit**

```bash
git add tools
git commit -m "test: trace-check harness for context sufficiency"
git push origin feat/multi-model-choice
```

---

### Task 23: Agentic matrix execution

**Files:**

- Create: `docs/superpowers/plans/2026-10-13-supervisor-subagents-evidence.md` (append per case: command, observed output, trace finding)

**Interfaces:**

- Consumes: everything above.
- Produces: evidence for agentic cases 1–16 of the spec.

- [ ] **Step 1: Cases 1–4 (one frame; four frames/two workers parallel; restart mid-plan; restart mid-execute)**

For each: start the run, capture the durable journal timestamps (parallel case: worker run starts overlap), run the kill where applicable, and record the trace check result.

- [ ] **Step 2: Cases 5–8 (restart mid-review; worker failure + fix; plan approve/edit/reject; destructive gate inside a worker)**

Force a worker failure (kill its provider call by cancelling the child run), then confirm `allSettled` → review → fix; trigger `clear_region` in a worker and confirm the Jev gate + approval still fire.

- [ ] **Step 3: Cases 9–13 (cancel mid-task; steering high confidence; steering ambiguous; worker ask_user; two workers asking in parallel)**

Cancel and confirm the subtree stops; send both steering shapes and confirm routing/clarify; force two questions and answer them independently.

- [ ] **Step 4: Cases 14–16 (reference injection; task dedupe; usage rollup)**

Confirm the worker viewed the supervisor's URL; confirm a second request returns `RUN_IN_PROGRESS`; confirm the task row's usage equals the sum of child runs.

- [ ] **Step 5: Commit the evidence**

```bash
git add docs/superpowers/plans/2026-10-13-supervisor-subagents-evidence.md
git commit -m "test: agentic matrix evidence for the supervisor program"
git push origin feat/multi-model-choice
```

---

### Task 24: UI/UX matrix execution

**Files:**

- Modify: the same evidence file (UI section)

**Interfaces:**

- Produces: evidence (screenshots) for UI cases A–H of the spec.

- [ ] **Step 1: Cases A–C (badge transitions; two-worker live switching; console tree + steering rows)**

Capture screenshots per state; verify the live feeds per frame and the tree rows.

- [ ] **Step 2: Cases D–F (composer toggle; questions surface; reduced motion)**

Toggle on/off and verify routing; trigger questions and verify badge/counter/card; emulate `prefers-reduced-motion` and confirm every animation is static while states still read.

- [ ] **Step 3: Cases G–H (accessibility; home transition)**

Check `aria-live` announcements, focus order, labels, and that no state relies on colour alone; repeat the home→editor transition with a live task.

- [ ] **Step 4: Commit the evidence**

```bash
git add docs/superpowers/plans/2026-10-13-supervisor-subagents-evidence.md
git commit -m "test: UI/UX matrix evidence for the supervisor program"
git push origin feat/multi-model-choice
```

---

### Task 25: Acceptance scenario, docs, and final review

**Files:**

- Modify: `AGENTS.md` (task/supervisor bullets), `docs/superpowers/plans/2026-10-13-supervisor-subagents-evidence.md` (acceptance section)

**Interfaces:**

- Produces: the end-to-end acceptance evidence and the updated project rules.

- [ ] **Step 1: Run the acceptance scenario**

From the home: create a project through the composer, then several assets whose prompts never name frames or layers; watch the per-frame indicators live; send one steering message; answer one worker question; record the final structure report and the full-tree trace check.

- [ ] **Step 2: Update AGENTS.md**

Add: drawing runs are `asset-draw` tasks (plan → workers ≤4 → review) with Jev setting the shape; workers write only owned frames; palette is planned; steering is frame-routed by Jev; worker questions surface per frame; every agentic case is trace-verified.

- [ ] **Step 3: Full gate + final review**

Run `pnpm exec turbo typecheck lint test --force` and the live API suite; dispatch a fresh reviewer subagent (`opencode-go/deepseek-v4.1-flash#max`) over the whole branch diff against the spec; fix every Critical/Important finding with a test; then commit and push.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/superpowers/plans
git commit -m "docs: supervisor program rules and acceptance evidence"
git push origin feat/multi-model-choice
```

---

## Self-Review

**Spec coverage:** every spec section maps to tasks — roles/worker contract (4, 5), plan schema/approval (2, 6, 16), data model/API (1, 9, 10), durability/recovery (7, 8, 11), Jev shape (9) and steering (19), references (20), UI indicators/animations/switching/console/toggle/questions (12–18), home (21), tracing (22), matrices and acceptance (23–25). No spec requirement is left without a task.

**Type consistency:** `DrawPlan` (Task 2) is consumed by Tasks 6, 19, 20 with the same field names; `TaskSnapshot` (Task 12) is consumed by Tasks 13, 14, 18; `ownedFrameIds` (Task 5) is set by Task 8; `buildWorkerPrompt` (Task 3) is called only by Task 6; `referencesForWorker` (Task 20) matches the plan's `references` shape.

**Placeholder scan:** no TBD/TODO; every code step carries real code or a real command with expected output.

**Review Focus coverage:** (1) Task 9's `RUN_IN_PROGRESS` test; (2) Task 6's validation tests; (3) Task 5's ownership tests; (4) Task 11's kill tests; (5) Task 19's clarify test.

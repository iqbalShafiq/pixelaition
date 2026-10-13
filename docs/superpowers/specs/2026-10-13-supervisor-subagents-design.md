# Supervisor + Subagents — Design

**Status:** Awaiting review
**Date:** 2026-10-13
**Scope:** One program that turns every drawing request into a durable supervisor task: a plan phase the user approves, parallel per-frame worker subagents (max four), a review phase that continues the supervisor's own conversation, frame-aware steering routed by Jev, injectable web references, parallel human clarifications from workers, per-frame status indicators with subtle pixel animation, and smooth frame switching while workers paint. Extends the 2026-10-12 home workspace spec and the 2026-10-11 agent spec.

## Goal

1. **One path for drawing.** Every drawing request (editor or home) runs a durable `asset-draw` task: plan → execute → review → fixes → summary. No second, simpler path to maintain.
2. **The supervisor decides art, Jev decides shape.** Jev sets the budget (worker count 1–4, whether a review round is worth it) from the request and context; the supervisor agent decides frames, layers, palette additions, references, and worker assignments; task code validates both before anything is spawned.
3. **Workers run in parallel, durably.** One worker owns 1..k frames; workers paint concurrently; the supervisor is told when every worker is terminal (durable `allSettled` join) and reviews the whole result.
4. **The user watches and steers.** The frame list shows per-frame state (queued, working, done, failed, asking) with WCAG-compliant indicators and subtle pixel animation; the canvas follows each frame's own worker live; switching frames stays smooth.
5. **Steering is frame-aware.** A message while workers run is routed by Jev to the right frame's worker; when ambiguous, the app asks the user with the live frame list. The composer gets a frame-context toggle for messages about the frame in view.
6. **Workers can ask.** `ask_user` from a worker suspends that worker; the frame list marks the frame, and the question card surfaces when the user opens that frame. Several workers may ask in parallel.
7. **References travel.** The supervisor's `web_search` results can be injected to some or all workers, including `view_image` access.
8. **Everything is real-tested.** Agentic matrix, UI/UX matrix, and kill/restart tests per phase — no claim without a live run.

## Non-goals

- No parallel structural edits. Frame create/delete/move/rename, `set_palette`, and `resize_canvas` stay with the supervisor; workers paint only their own frames.
- No detached children, no cross-asset parallelism. One task per asset thread; the existing `RUN_IN_PROGRESS` rule becomes one task per thread.
- No user-facing workflow toggle. Jev decides the shape; the composer's frame-context toggle is a message-scope control, not a workflow control.
- No change to ask-mode runs (read-only, plain runs, maxTurns 8).
- No in-process parallel primitives for drawing work (`Pipeline.parallel`, `.runBatch`, `agent.asTool()` are not durable and are rejected for this workflow).
- No provider-quota workaround in this program (explicit user decision: quota is not a design constraint here).
- No cross-run `view_image` trust beyond the task tree (URLs must still come from a `web_search`; the task may seed a worker with the supervisor's URLs).

## Decisions already made (from the design discussion)

1. **Always-task architecture** (user): even a one-frame request plans first and ends with a review decision; uniform path, adaptive cost.
2. **Jev decides shape, not art**: workers 1–4 and whether review is needed; the supervisor may still request a review when it flags uncertainty.
3. **Supervisor is one continuing conversation**: plan and review are two owned agent children of the same task, the review continuing the plan's conversation (`continueFrom`).
4. **Workers ≤ 4, independent of frame count**; one worker may own several frames; join is `allSettled`; a failed worker does not cancel its siblings.
5. **Worker toolset**: complete painting and layer tools on owned frames; structural/asset tools supervisor-only; palette additions planned in the plan phase.
6. **References injectable**: plan references carry `appliesTo` (`"all"` or frame names); the task seeds each worker's `view_image` allow-list.
7. **Steering**: Jev picks the target frame with confidence; high confidence routes directly, ambiguity asks the user (app-owned card, live frame list); the answer arrives as a task signal.
8. **Workers may `ask_user`**; per-frame indicators; the question card surfaces on frame open.
9. **The plan card always appears** (including one-frame plans).
10. **Three implementation phases**, each shippable, gated, and live-tested.

## Research grounding

**Anvia durable primitives (verified in the installed `@anvia/durable@0.10.0` and docs).**

- `defineTask({ name, version, input, checkpoint, output, initial, run })` runs one phase at a time from a committed checkpoint; `runtime.submitTask(definition, { sessionId, requestId, input })` deduplicates by that scope, so one task per thread is the same conflict rule as today.
- `ctx.spawnAgent(key, { agentId, prompt, maxModelTurns?, continueFrom? })` returns a task id; creation of the child task and its agent run is atomic. Children are ordinary durable agent runs in isolated sessions, so siblings never collide with the one-run-per-session rule.
- `continueFrom` must name a completed (or turn-limited) agent child of the same task and the same agent; several siblings may continue the same finished child (each gets a copy of the conversation). Verified in the package source.
- Joins: `wait: { type: "children", ids, policy: "allSettled" | "failFast" }`; a waiting parent releases its scheduler slot and resumes after every selected child is terminal. `ctx.children()` returns records with `agentRunId`, `status`, `wait`, `outcome`.
- Controls: `wait: { type: "signal", name }` plus `task.signal(name, requestId, value)` for task-level clarifications and steering; `wait: { type: "timer" }`; `ctx.effect(key, input, callback, policy)` for journaled external effects.
- Observation: `task.graph()` / `runtime.taskGraph(id)` (ownership tree with `owns`/`waits` edges) and `task.stream({ after })` (committed changes, including later children). To approve or reconcile an owned agent, read the child's `agentRunId` and use `runtime.getRun(runId)` with `respond()` — the same interaction machinery the app already uses.
- Limits: trees ≤ 1000 nodes and depth 32; `maxConcurrentTasks` is separate capacity for task phases (waiting phases release their slot); `maxConcurrentRuns` defaults to 4 (this app currently sets 2).
- Task graphs (`submitGraph`) are static DAGs known up front; rejected because our plan is model-decided at runtime. `Pipeline.parallel`/`.runBatch` are in-process and explicitly non-durable; rejected.

**Current app facts.**

- `DurableRuntime.open` (apps/worker/src/index.ts:824) uses `maxConcurrentRuns: 2`, registers 18 agents (draw + ask per model and effort), and runs `recoverInterruptedRuns` before `resume()`.
- Runs are submitted with `sessionId = threadId`; a second submit throws `DurableConflictError` → worker 409 → API `RUN_IN_PROGRESS`.
- `RunBinding` (packages/agent/src/runs.ts:135) carries `frames`, `palette`, `approvedScope`, `touchedFrames`, `onStroke`, `onFrameChange`; `onStroke` publishes `canvas-stroke` (per-frame live feed) and persists `frames.layers`; `onFrameChange` persists structural changes and versions.
- The web already allows switching frames while a run is active; only structural edits are locked. `canvas-stroke` handling is already per frame (`drafts[frameId]`), and `runFrameId` marks the frame being painted.
- `generation_runs` has no parent/child columns; nothing models tasks.

**UI/UX research.**

- Timing (refactoring-ui micro-interaction references): micro-feedback 100–150 ms; simple transitions 150–250 ms; complex 250–350 ms; loading/progress indicators may be slower because they represent real waiting. Easing: ease-out for entrances, ease-in for exits.
- The app's pixel language uses discrete `steps()` easing (`pixel-loader 600ms steps(3)`, `overlay-enter 160ms steps(3)`, `sheet-enter 200ms steps(4)`, `assemble-rise 200ms ease-out`); `motionToken = { duration: 0.16, ease: "easeOut" }`; `prefers-reduced-motion` blocks already exist. New animation must follow this language.
- Status indicators (Carbon Design System): icon, shape, and badge variants; for WCAG, at least three of four elements — color, shape, icon, text label — must be present. Color alone is never the signal.
- Community patterns (Dribbble): AI-agent status indicators with subtle jitter/pulse; per-item status dots in lists; pixel-art playful upload interfaces with status indicators. Sparkle/one-shot bursts read as "finished"; loops read as "working".

## Roles

| Role              | Who                                                | Decides                                                                                 | Tools                                     |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| Shape             | **Jev** (cheap model, 1 call)                      | `workers` 1–4, `review` needed, run mode (existing), target (existing)                  | structured decision                       |
| Art & assignments | **Supervisor** (agent child `plan`, then `review`) | frames, names, intents, layers, palette additions, references, worker split, fix orders | full toolset in plan; read-only in review |
| Orchestration     | **Task code** (not an LLM)                         | validation, spawning, joins, retries, checkpoints, summaries                            | deterministic                             |
| Execution         | **Workers** (agent children, ≤ 4)                  | how each owned frame is painted                                                         | painting + layer tools on owned frames    |

The supervisor never writes worker prompts: the task assembles them from the validated plan. The docs are explicit — a model must not choose task names or unvalidated prompts.

## Workflow

```
prompt
  │
  ├─ Jev: guardrail → mode (draw/ask) → shape { workers: 1..4, review: bool }
  │
  └─ TASK asset-draw (durable, checkpoint per phase)
       │
       ├─ PHASE plan ── spawn child "plan" (supervisor agent, plan instructions)
       │     • reads project/asset/frames + summaries; may web_search references
       │     • ends with present_plan whose schema carries the full structured
       │       plan (frames with layers, worker split, palette additions,
       │       references) — the card renders validated data, never prose
       │     • after approval it commits the structure (creates the planned
       │       frames, applies palette additions) and finishes with the
       │       DrawPlan JSON; the task validates that JSON against the
       │       approved plan (a mismatch is a named failure; no worker spawns)
       │
       ├─ PHASE execute ── spawn worker children (continueFrom "plan"), wait allSettled
       │     worker w1 → frames A, C        ← running concurrently
       │     worker w2 → frames B, D
       │     • workers paint only their frames; ask_user allowed; steering allowed
       │
       ├─ PHASE review ── spawn child "review" (continueFrom "plan")
       │     • reads every frame, checks continuity, palette, outline, proportions
       │     • output: ok | fixes[{ frame, note }]
       │     • fixes → spawn fix workers (≤2, continueFrom "review") → wait → review again
       │       (at most 2 review rounds)
       │
       └─ COMPLETE: summary + aggregated usage on the task row
```

Example — "ksatria berjalan dengan pedang menyala, ada bayangannya": Jev sets `workers: 2, review: true`. The plan proposes four frames (`idle, jalan-a, jalan-b, attack`), layers (`ksatria, pedang, cahaya, bayangan`), two palette additions for the glow, and assignments (w1: idle+attack, w2: jalan-a+jalan-b). The user approves the card. Two workers paint in parallel; the frame list shows both working, the user switches frames and watches each canvas fill. The review reads all four frames, finds `attack`'s outline inconsistent, spawns one fix worker, reviews again, completes.

### Plan output schema (validated by task code)

```ts
type DrawPlan = {
  frames: Array<{ name: string; intent: string; layers: string[] }>; // 1..12, unique names
  palette: Array<{ color: string; name: string }>; // additions only, within style max
  references: Array<{ url: string; note: string; appliesTo: "all" | string[] }>;
  workers: Array<{ key: string; frames: string[] }>; // 1..min(4, frames.length)
  review: boolean; // supervisor may force a review
};
```

Validation: every frame in exactly one worker; worker keys stable (`w1`..`w4`); `appliesTo` names existing frames or `"all"`; URLs https + public; palette additions within the style guide's color maximum. An invalid plan gets one bounded re-plan attempt with the validation error in the prompt, then the task fails with a named cause. The `present_plan` tool schema grows optional fields (`layers`, `workerKey`, `palette`, `references`) so the approval card is rendered from schema-validated data; the task then checks the plan child's final JSON against the approved input.

## Context channels to workers

1. **Assembled prompt (primary)** — deterministic template built by the task: the user request, asset context (project, asset, palette after additions, style guide, canvas size, summaries), the worker's slice of the plan (frame names, intents, required layers, reference notes), the rules (own frames only, other frames read-only, palette already prepared), and the user's attachments (an `AgentPrompt` may be a full user message, so reference images ride along).
2. **`continueFrom: "plan"`** — each worker inherits the supervisor's plan conversation (reasoning, reads, searches). Discipline: the plan phase stays lean (maxTurns 12) so the transcript stays cheap; if the transcript exceeds a token budget, the task falls back to prompt-only.
3. **Read tools** — workers can `read_project` / `read_frame` any frame for reference; context by reference, not by copy.

## Worker tool contract

| Group             | Tools                                                                                                                              | Worker                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Painting/editing  | paint_stroke, fill_rect, erase_stroke, draw_line, flood_fill, fill_region, clear_region, replace_color, apply_outline, dither_rect | ✅ on owned frames                               |
| Layers            | add_layer, rename_layer, set_layer_visible, remove_layer                                                                           | ✅ on owned frames                               |
| Reading & quality | read_project, read_frame, read_region, preview_frame, critique_frame, check_animation, use_frame                                   | ✅ (use_frame limited to owned frames)           |
| Web               | web_search, view_image                                                                                                             | ✅ (own searches + seeded references)            |
| Asking            | ask_user                                                                                                                           | ✅                                               |
| Structure         | add_frame, delete_frame, move_frame, rename_frame, mirror_frame                                                                    | ❌ supervisor (race on frame indices)            |
| Asset             | set_palette, resize_canvas                                                                                                         | ❌ supervisor (shared state; palette is planned) |
| Target & plan     | use_asset, create_asset, plan, present_plan                                                                                        | ❌ supervisor                                    |

Enforcement lives in the tool layer: the worker binding carries `ownedFrameIds`; a write outside that set fails with a named cause ("That frame belongs to another worker."). Approving the plan card approves every planned frame's scope for the plan run and all workers, so workers never re-ask for scope; destructive tools still pass the per-call Jev request check.

## Data model

- New table `run_tasks`: `id`, `threadId`, `assetId`, `status`, `phase`, `plan` jsonb (validated DrawPlan + approval state), `shape` jsonb (Jev's decision), `usage` jsonb (aggregated), `createdAt`, `finishedAt`.
- `generation_runs` gains: `taskId` (nullable FK), `role` (`plan` | `worker` | `review` | `fix`), `workerKey`, `frameIds` jsonb.
- Public ids: the task gets a public id; each child run keeps the existing run id machinery (`publicIdByDurable` map, respond/cancel/steer endpoints work unchanged per child).
- API additions: `GET /api/assets/:id/task` (snapshot: phase, workers with frames/status/runId/pendingInteraction, plan, pendingQuestions, usage), `GET /api/tasks/:id/stream` (SSE proxy of the task stream), `POST /api/tasks/:id/steer` (Jev routing), `POST /api/tasks/:id/signal` (clarification answers).
- New console events: `task-phase`, `worker-spawned`, `worker-status`, `steering-routed`, `question-pending`, `task-complete`. Existing `canvas-stroke`, `asset-bound`, `asset-created` keep working per child run.

## Durability & reliability

- Checkpoints per phase; child keys derive from stable data (`w1`…`w4`, `review-1`, `fix-1`), never timestamps — replay returns the same child.
- Restart mid-phase: completed children are reused, running children are recovered by the durable runtime, pending interactions stay pending, signals already delivered stay delivered.
- Cancel: `task.cancel()` fences the subtree and cancels owned agent runs; external effects cannot be undone.
- Failure policy: `allSettled` for workers (a failed frame does not kill siblings); the review decides whether to fix, and a second failed attempt ends with the failure named in the summary.
- Concurrency: `maxConcurrentRuns: 6` (4 workers + plan/review/fix headroom), `maxConcurrentTasks: 2`; waiting phases and suspended workers release their slots.
- Usage: every child's usage event rolls into the task row and the console's usage summary, so cost stays visible per task.
- Recovery boot order keeps the existing rule: bind recovered runs before `runtime.resume()`.

## Jev extensions

1. **Shape decision** (extends the existing decide call): reads the prompt, project/asset summaries, recent exchanges, and frame count; returns `{ workers: 1..4, review: boolean }` with a confidence. Bounds are enforced in code; a missing key or unreachable provider fails with the named cause as today.
2. **Steering routing** (phase 2): reads the steering message, the plan, and live worker activity; returns `{ target: workerKey | "supervisor", frameNames: string[], confidence }`. Above the confidence threshold the message routes directly (worker run steering, or a task signal for the supervisor's next phase); below it the app asks the user with the live frame list, and the answer arrives as a task signal. Model-provided frame ids are never trusted — names are mapped to app ids.

## UI/UX

**Frame list indicators.** Every frame row carries color + shape/icon + text label (WCAG: never color alone):

| State   | Indicator                                                    | Animation                                                                                                                                                                           |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| queued  | hollow 8 px square, `line`, label "queued"                   | none                                                                                                                                                                                |
| working | filled square, `accent`, PixelLoader 12 px, worker chip `w2` | `worker-blink` 900 ms `steps(2)` infinite; thumb: `dither-sweep` 1.4 s `steps(8)` infinite at 0.35 opacity + two `sparkle` loops (1.2 s `steps(4)`, staggered 600 ms, ≤0.5 opacity) |
| done    | square with check glyph, `accent`, label "done"              | one-shot `done-pop` (scale 1→1.06→1, 220 ms `steps(3)`) + one-shot sparkle trail (3 sparkles, left→right, 90 ms stagger, 500 ms `steps(4)`, translate 4–8 px, fade)                 |
| failed  | square with cross glyph, `erase`, label "failed"             | one-shot `glitch` (2-frame ±2 px jitter, 180 ms `steps(2)`)                                                                                                                         |
| asking  | square with `?`, `accent`, label "needs you"                 | `ask-pulse` 1 s `steps(2)` infinite (opacity 1↔0.55), accent border                                                                                                                 |

- Sparkles are 2×2 px spans in `accent`/`steel` (Sweetie 16 tokens only), drawn in whole pixels.
- `aria-live="polite"` announces transitions ("jalan-a done", "worker 2 needs you", "task complete") — the non-visual channel WCAG wants.
- Reduced motion: every loop and one-shot becomes static; the label and color/shape still carry the state.

**Canvas.** Per-frame drafts already exist; switching frames crossfades the canvas 120 ms `steps(2)` while live strokes continue into the target frame's draft. The viewed frame never resets when switching during generation.

**Console.** Rows form a tree: `plan` (with the plan summary), `worker w1..w4` (each row shows its frames and tool activity), `review`, `fix`. Steering rows show their routing ("steering → w2 (jalan-a)"). A task header shows phase + progress ("2/4 workers done") + aggregated usage.

**Composer frame-context toggle.** An icon toggle (same height as the other composer controls, reusing the existing icon-button pattern) sets the message's scope. Off (default): the message targets the supervisor/general. On: a chip shows the frame in view (`jalan-a`), and the message is anchored to that frame — steering to its worker when a task is live, or a frame-scoped discussion/run otherwise. The chip follows frame selection; `aria-pressed` and a tooltip name the mode.

**Plan card.** Always appears (including one-frame plans). Shows the frames with intents, the worker split, palette additions, and reference count; rows stagger in (40 ms apart, 200 ms `steps(3)`); approve or edit.

**Pending questions.** Frame rows show the `asking` badge; a compact counter near the composer ("2 questions waiting") lists them and jumps to the frame; opening a frame surfaces its question card (existing InteractionCard + live dropdowns) with a 200 ms `steps(4)` rise. Answering posts to the child run that asked.

**Timing constants** (from the micro-interaction research, adapted to the pixel language): micro-feedback 120 ms; simple transitions 160–200 ms; entrances 200 ms; work loops 0.9–1.4 s; one-shot celebrations ≤ 500 ms.

## Testing plan (real, per case)

**Agentic matrix** (live runs, evidence from the durable journal and DB):

| #   | Case                                         | Evidence                                                              |
| --- | -------------------------------------------- | --------------------------------------------------------------------- |
| 1   | One-frame request                            | plan → 1 worker → review decision; cost recorded                      |
| 2   | Four frames, two workers, genuinely parallel | overlapping child run timestamps in the durable journal               |
| 3   | Restart mid-plan                             | kill worker process; plan resumes without duplicate children          |
| 4   | Restart mid-execute                          | completed children reused; running child recovered                    |
| 5   | Restart mid-review                           | review resumes from checkpoint                                        |
| 6   | Worker failure                               | `allSettled`; review sees the failure; fix worker runs                |
| 7   | Plan approval                                | approve / edit / reject all behave; rejecting ends with a named state |
| 8   | Destructive gate in a worker                 | Jev request check + approval still fire per call                      |
| 9   | Cancel mid-task                              | subtree fenced; statuses clear                                        |
| 10  | Steering, high confidence                    | Jev routes to the right worker; console shows the route               |
| 11  | Steering, ambiguous                          | frame-picker card; answer arrives as a signal and routes              |
| 12  | Worker `ask_user`                            | answer resumes the same worker; frame badge clears                    |
| 13  | Two workers asking in parallel               | both badges; independent answers; both resume                         |
| 14  | Reference injection                          | worker `view_image` opens the supervisor's URL and describes it       |
| 15  | Task dedupe                                  | second request for the same asset → `RUN_IN_PROGRESS`                 |
| 16  | Usage aggregation                            | task row equals the sum of child runs                                 |

**UI/UX matrix** (browser-driven, screenshots/video):

| #   | Case                                                                               |
| --- | ---------------------------------------------------------------------------------- |
| A   | Badge transitions queued→working→done/failed/asking with the specified animations  |
| B   | Two workers painting; frame switching shows each frame's live feed without reset   |
| C   | Console tree rows, steering routing row, task header progress and usage            |
| D   | Composer toggle on/off; chip follows frame selection; routing respects it          |
| E   | Question badge + counter + card surfaced on frame open; answering clears all three |
| F   | `prefers-reduced-motion`: every animation static, states still readable            |
| G   | Accessibility: aria-live announcements, focus order, labels, no color-only signals |
| H   | Home→editor transition still works with the task console                           |

**Durability matrix**: `kill -9` the worker at each phase (plan/execute/review/fix), restart, and verify resume, no duplicated children, pending approvals still pending, and signals intact.

**Acceptance scenario**: the 2026-10-12 trial shape, repeated end-to-end with the new task path: a home-created project, several assets whose prompts never name frames/layers, per-frame indicators observed live, one steering message, one worker question answered, and a final structure report.

## Phasing

| Phase               | Contents                                                                                                                                                                                                                        | Gate                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **1 — Foundation**  | Task + roles + plan validation + worker contract + palette planning + plan card + data model + task API/SSE + indicators + switching + console tree + durability + agentic matrix 1–9, 15, 16 + UI A–C, F–H + durability matrix | full gate, live evidence |
| **2 — Interaction** | Reference injection + steering (Jev routing, signals, frame-picker card) + composer toggle + agentic 10–11, 14 + UI D                                                                                                           | full gate, live evidence |
| **3 — Humans**      | Worker `ask_user` + parallel questions + badges/counter/surfacing + agentic 12–13 + UI E                                                                                                                                        | full gate, live evidence |

Each phase commits and pushes separately; a later phase never starts before the previous phase's live evidence exists. Each phase gets its own implementation plan; the first plan covers Phase 1 only.

## Risks & open questions

1. **Steering a running child**: the durable runtime exposes steering for runs; the design assumes child runs steer like any run. Phase 2 verifies live; the fallback is queueing the message for the review phase (still useful, not real-time).
2. **Parallel suspended children**: several workers waiting on questions must all resume independently. Phase 3 verifies with the real provider.
3. **Plan transcript size**: `continueFrom` copies the plan conversation into every worker. Mitigated by a lean plan (maxTurns ~6) and a prompt-only fallback if the transcript exceeds its budget.
4. **Task definition versioning**: `asset-draw` starts at version 1; any later change needs a pure `migrate(input, checkpoint, fromVersion)`.
5. **Existing runs**: the migration adds nullable columns, so pre-existing runs stay valid; the API switches new drawing requests to the task path only.

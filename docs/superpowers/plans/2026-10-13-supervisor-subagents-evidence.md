# Supervisor + Subagents — Live Evidence

Evidence recorded during the inline execution of `2026-10-13-supervisor-subagents.md`.
Every line names the check, the observed result, and where the trace stands.
Cases marked "earlier" were verified live during the task that built them; the
ledger (`.superpowers/sdd/2026-10-13-supervisor-subagents/progress.md`) carries
the same record with rulings.

## Agentic

| #   | Case                               | Evidence                                                                                                                                                                                                   |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One-frame request                  | Task 8 live: plan → 1 worker → review; frames painted                                                                                                                                                      |
| 2   | Several frames, one worker, review | Run A (`a93d920b`): plan chose 4 frames (lari-a..d), worker painted all four, review ran, task completed; usage rolled up (1.16M tokens on the run, 939.9k cached shown in the console)                    |
| 2b  | Two workers in parallel            | Not yet observed: Jev's shape and the plan chose one worker for every trial prompt so far; the code spawns one child per plan worker and `maxConcurrentRuns: 6` allows it. **Deferred: one 2-worker run.** |
| 3   | Restart mid-plan                   | Task 11 kill matrix: mid-execute kill verified; mid-plan kill covered by the same recovery path (watcher + child binding) but not run separately. **Deferred.**                                            |
| 4   | Restart mid-execute                | Task 11: `kill -9` mid-paint → recovery re-attached run + task, no duplicated children, pending gate stayed pending, task completed through review                                                         |
| 5   | Restart mid-review                 | Covered by the same recovery path; not run separately. **Deferred.**                                                                                                                                       |
| 6   | Worker failure → review → fix      | Task 8 live: worker hit maxTurns 120 → allSettled → review ran and the task completed (no fix round was ordered; the fix path has unit coverage in asset-draw tests)                                       |
| 7   | Plan approval                      | Run A: the plan child's `set_palette` gate paused, the approval resumed it; the plan card renders workers/palette/references (unit-level parser coverage). **Deferred: a card screenshot.**                |
| 8   | Destructive gate in a worker       | Run A: 28 `clear_region` gates paused and resumed through approvals                                                                                                                                        |
| 9   | Cancel mid-task                    | Endpoint added and unit-checked; **deferred: a live cancel.**                                                                                                                                              |
| 10  | Steering, high confidence          | Router unit tests; **deferred: live.**                                                                                                                                                                     |
| 11  | Steering, ambiguous                | Picker card code + router unit test; **deferred: live.**                                                                                                                                                   |
| 12  | Worker `ask_user`                  | The worker tool set includes `ask_user`; the snapshot surfaces its interaction and the editor answers the child run. **Deferred: live.**                                                                   |
| 13  | Two workers asking in parallel     | **Deferred** (needs case 2b).                                                                                                                                                                              |
| 14  | Reference injection                | `referencesForWorker` unit test; seeding in `bindTaskChild`; **deferred: a live view_image.**                                                                                                              |
| 15  | Task dedupe                        | Task 9 live: a second request answered `RUN_IN_PROGRESS` (API and worker guards)                                                                                                                           |
| 16  | Usage rollup                       | Task 8 live: `run_tasks.usage` equals the sum of the child runs                                                                                                                                            |

## Tracing (Langfuse)

- Harness: `node tools/trace-check.mjs <durableTaskId>` (durable id, not the public row id).
- Run A: `draw-plan` 16 observations OK; `draw-review` 14 observations OK.
- **Finding, fixed**: observation inputs were pushed raw and Langfuse showed `[object Object]`; telemetry now stringifies (RED→GREEN test) — commit `d14aff4`.
- **Finding, fixed**: the child's spawn prompt now rides on the trace's metadata (`d79a005`) because observation inputs are per-event (a tool result after the first turn) and could not answer "what did the worker run with".
- **Deferred**: re-run the worker-trace check against a run started after `d79a005`; the Langfuse public API rate-limits reads (the harness paces and retries once).

## UI/UX

| #   | Case                       | Evidence                                                                                                                                                   |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Badge transitions          | Editor screenshot during Run A: frame list rendered 8 `w1` badges while the worker painted; console showed `AGENT WORKING · 8.5S` with tool rows and usage |
| B   | Frame switching under load | Per-frame drafts and per-child stroke streams are wired; **deferred: the switch-with-two-workers observation.**                                            |
| C   | Console tree               | Screenshot: `thinking`, `fill_rect · 9x1`, `usage · $0.00000 · 1162.7k tok · 1119.8k cached`, `apply_outline · color 1`                                    |
| D   | Composer toggle            | Screenshot: the frame-context icon renders left of the attach control at the same height; the chip and routing are code-wired                              |
| E   | Question surfacing         | Component + editor effect wired; **deferred: live.**                                                                                                       |
| F   | Reduced motion             | CSS block disables every task animation; **deferred: an emulated-media screenshot.**                                                                       |
| G   | Accessibility              | Badges carry colour + shape + label; `aria-live` announcements are **deferred**.                                                                           |
| H   | Home transition            | Home console now streams the task tree; **deferred: a live home run.**                                                                                     |

## Acceptance scenario

Run A is the closest end-to-end pass: a new prompt from the API produced a 4-frame
plan, one worker painted all four frames with the wind-trail layers the plan named,
the review ran, the task completed, the console and frame badges updated live, and
the plan/review traces carried their context. The full acceptance (home-created
project, several assets, steering, a worker question) is **deferred** and listed
above case by case.

## Whole-branch review (fresh subagent, `opencode-go/deepseek-v4.1-flash#max`)

Reviewed `e3d70ab..b41ea4e` against the spec, plan, evidence, and ledger. Fixed in one pass (`1f77246`, each with a test where cheap):

- **Critical** fix children never bound (their key is not a plan worker key) → frames come from the prompt.
- **Critical** workspace/home tasks never bound their workers → children bind to `plan.assetId`.
- **Important** execute-phase matched spawn ids against child keys → workers always read as failed, `review:false` ignored, the review told every worker failed → now matches worker keys (`workerKeys` in the checkpoint).
- **Important** duplicate worker keys passed validation → rejected.
- **Important** workers could not read sibling frames → the ownership check moved to write paths (`editFrame`, `paintStroke`, `use_frame`).
- **Important** the plan committed structure before approval → instructions now commit after.
- **Important** usage rollup read volatile memory → sums the persisted rows.
- **Important** one child error killed the watcher → per-cycle catch.
- **Important** frame badges rendered done as "needs you" → status mapping fixed.
- **Important** the editor route had no active-task guard → added.

**Deferred (Important, open — not fixed in this pass):**

1. Steering never reaches a live worker: the worker always signals the supervisor and `deliveredSteers` is read only when a review spawns, so a steer sent during execute arrives late and one sent during review is lost. Fix direction: steer the target worker's run directly when its `target` names a live child.
2. `steerSignalCount` is in-memory; after a restart the next message re-signals `steer-1` and the durable store rejects it (502). Fix direction: derive the next free name from the task record's delivered signals.
3. After a reload the editor does not seed `taskId`, so worker questions and frame-context steering are unreachable while the badge/counter still show.
4. Frames added during the plan are invisible in the editor until an incidental refetch (no invalidation on frame-add/task-phase).
5. The clarify picker's "whole asset" button closes without re-sending and swallows send errors.

**Deferred (Minor):** `useTaskStream` has no unmount close; `trace-check.mjs` can exit 0 on unreadable traces; the re-plan prompt drops attachments; `ask_user` is outside the role gate; `source:"default"` is stored but never logged; a task does not seed the decision/guardrail spend; `taskSnapshot` excludes failed/cancelled tasks; RunConsole has no task header (phase, n/N done, aggregate usage).

## Follow-up: supervisor-first steering, honest badges, durable questions

Changed by the user's follow-up review (commits `87fc50f`, + `activeTaskId`):

- **You always talk to the supervisor.** An anchored message ("About this frame") is a hint; the supervisor keeps it and relays. Live run `f63c98ef`: anchored to `lari-a` → routed to w1 → **relayed straight into w1's live run** (`steer-1.delivered = true`), HTTP `202 {routed:"w1"}`, and the console narrates ("supervisor → w1: …" / "relayed → w1 (lari-a)") or says it will apply the note in the review when no worker is live.
- **Two workers in parallel — case 2b verified**: w1 and w2 both `running` on the same asset, each with its own frames; the frame list showed w1 and w2 badges on different frames.
- **Steering survives restarts**: the next steer name is derived from the task's delivered signals (the in-memory counter is gone).
- **Reload rejoins**: after a browser reload mid-task the editor re-renders the live tree ("Rejoined a run that was still going") and `activeTaskId` (from the snapshot) keeps questions, badges, and frame-context steering wired whether the session started the task or rejoined it.
- **Honest badges**: live states render only while the task runs; `done` is an unseen nudge that clears when the frame is opened and never lingers after the task ends (the earlier "some frames done, some not" came from stale snapshot statuses).
- **Supervisor questions surface whatever frame is open**; worker questions surface on their frame.
- Choreography: a spawn publishes the supervisor's order ("paint jalan-a, jalan-b"), worker groups land with the assemble-rise animation, and the task header carries the aggregate usage.

(Commits for this follow-up: `87fc50f` + the `activeTaskId` commit.)

**Still open** (unchanged): the five deferred Important items from the review, minus the two closed here (steering relay, signal naming); the editor's post-reload console still shows the rejoined child's stream rather than the full task tree (open the task stream on rejoin), and the clarify picker's "whole asset" button still needs a re-send.

## Follow-up 2 (commits `7f24a1b`, + this commit)

- Rejoin is task-first: after a reload the console shows the supervisor tree again (child streams still feed each frame's canvas), and `activeTaskId` keeps questions and frame-context steering wired.
- The clarify picker resends: "whole asset" posts the message unanchored; both picker paths surface send failures instead of swallowing them.
- New frames appear when the task moves phase (or binds an asset): the asset query is invalidated on `task-phase`/`asset-bound`/`task-complete`.
- Minors closed: the task stream closes on unmount; the trace harness fails on an unreadable trace.

**Still open:** the review's remaining minors (re-plan drops attachments, `source:"default"` never logged, a task does not seed the decision spend, `taskSnapshot` excludes failed/cancelled tasks, RunConsole lacks an explicit phase/n-of-N header).

## Follow-up 3 (all remaining minors closed)

- Re-plan continues the first plan's conversation: the user's attachment images survive a rejected plan (unit test).
- The plan's own `review: true` forces a review even when Jev said no (unit test); a failed worker always gets one.
- A task seeds the guardrail/decision spend onto its own usage; the rollup starts from that seed and adds the child rows.
- The task snapshot surfaces the latest task of any status (failed/cancelled included), so the editor never shows a stale earlier task.
- `ask_user` passes the role gate: the review cannot ask; workers and the plan can.
- A defaulted shape (`source: "default"`) is logged instead of hidden.
- The console header names the phase and finished/total workers; usage stays in the summary.
- (Earlier) the task stream closes on unmount; the trace harness fails on an unreadable trace.

**Open:** none from the review. Live-deferred matrix cases still listed above (fix round, workspace/home binding, cancel, reference view_image, parallel-question pair, reduced-motion emulation, home transition) — each has code + unit coverage and a named live check.

## Live matrix closers

- **Case 9 — cancel mid-task** ✓: `POST /api/tasks/:id/cancel` → `204`; the task row, its plan child, and the durable task all read `cancelled`, and the asset unlocked.
- **Workspace/home task binds its own asset (Critical fix #2)** ✓: a `scope: "workspace"` task started with `assetId: null`; the plan child created the asset (`run_tasks.asset_id` filled from the plan) and the worker child bound to it and painted.
- **Case 2b — two workers in parallel** ✓ (recorded above): w1 and w2 both `running`, each owning different frames.
- **Case 10 — steering relay** ✓ (recorded above): anchored `lari-a` → routed to w1 → relayed into the live run (`delivered: true`), `202 {routed:"w1"}`.

**Still live-deferred** (code + unit coverage in place): a review-ordered fix round, `view_image` of a supervisor reference, two workers asking at once, emulated `prefers-reduced-motion` screenshots, and the home→editor transition with a live task.

## Frames UI + demo video (follow-up 4)

- The frame list shows four rows and then scrolls on its own; the layer list scrolls in its own box (commit `69440b8`).
- Recording the demo surfaced a real editor crash: a pending **tool-approval** carries no `questions`, so `question-summary.tsx` indexed `questions[0]` of undefined and the editor error-boundaried as soon as the plan card appeared. Fixed (the summary now names approvals and questions), committed with the scroll change.
- `~/Desktop/pixelaition-demo-final.mp4` (6:54, 1920×1080, 88 MB): home → target confirmed on camera → plan card approved → two workers paint in parallel (with a worker's `clear_region` approval answered on its own frame) → review orders two fixes → second review passes → finished asset → frames browsed, closing on a 12-frame family whose list scrolls after four rows.
- Master capture: viewport 1920×1080 at `deviceScaleFactor: 2` rendered into a 1920×1080 video (an exact 2:1 downsample; a video size larger than the viewport lands the page in one corner). Waiting stretches run at 2× (3× for stretches over 150 s) with a pixel speed chip, the cursor and its click ripple are drawn by the page, and phase captions ride the actions.

## Follow-up 5 (the editor shows the work; the plan's frames really appear)

Fixes shipped (`69440b8`, `b7e74b9`, `882482d`):

- The task stream refreshes the asset, so planned and freshly painted frames appear in the frame list while a run is live (the panel used to sit on a stale single "idle" frame).
- Only a worker or a fix child badges a frame; the supervisor's inherited scope and the reviewer never mark a frame as working. The supervisor's progress stays in the composer/console.
- A working frame carries the agent's own cursor jittering inside its square plus a paint ring (whole-pixel steps, `prefers-reduced-motion` off).
- Roles read as Agent 1 / Agent 2 / Supervisor / Reviewer on every surface.
- The clarification card caps its height and scrolls the plan body; the drag handle is a standard button; the layer list fills the panel and scrolls only past the viewport; selecting or playing a frame scrolls its row into view.
- A motion request needs key frames: the supervisor is told, the plan is validated against it, and a supervisor that insists on one frame is taken at its word on the retry.
- Root cause of the empty cendrawasih: the plan child ended its turn right after `present_plan` came back approved and never called `add_frame`, so the asset kept only its default frame. The approval now carries the next step, the task reads the asset's frame names, sends the plan child back once to create what is missing, and fails with the names if they still are not there (tested).

Recording: `~/Desktop/pixelaition-demo-v2.mp4` (1:46, 1920×1080) — home, target confirmed, plan approved, two agents painting their own frames (the recorder hops to whichever frame is being painted), review, done. No dead air, no foreign asset in the tail. The take predates `882482d`, so its asset still ends on the plan's default frame; the provider was returning stream failures during every later attempt ("Completion provider stream ended before its tool call was complete"), so the fresh take with the frames that are now enforced has to wait for the provider.

## Provider failures traced: thinking mode needs its reasoning back

The run behind `298af3d5` (deepseek-v4.1-flash, effort high) finished with
`task completed` but a red step: `worker:failed`, its retry `failed`, and
`fix:failed`. The durable summaries name the cause:

```
400 The `reasoning_text` in the thinking mode must be passed back to the API.
502 Bad Gateway (cloudflare)
```

So the model's **thinking mode** requires the reasoning text of the previous
turn to travel back with the next request. The OpenAI-style adapter we call
through does not round-trip reasoning, so every follow-up turn in a tool loop
is rejected mid-stream — which is exactly what the SDK reports as
"stream ended before its tool call was complete" / "invalid tool call" on
other models too. It is not a flaky provider and not our retry logic (the
retry itself worked: `worker:failed` -> `w2-retry-1` -> `failed`).

Fix paths, in order of reach:

1. Run drawing agents on an effort that does not think (muse's `minimal` is
   the only non-thinking step in the catalog today) — no reasoning to send
   back, so the 400 cannot happen. Needs a live run to confirm.
2. Teach the adapter to include the reasoning part of the previous assistant
   turn (a change in the provider adapter, outside this repository).
3. Keep bounded retries, but never retry a failure whose cause is this 400:
   the task sees only child status, so classification needs the child's
   error text to reach the task checkpoint first.

Until one of those lands, a "completed" task may still show failed steps for
the frames the review then fixed — the asset is right, the tree is honest.

## Runs that look stuck are usually a missing worker

Every "the task failed in one second" and "the plan card never came" episode in
this stretch traced back to the worker process being gone (port 4002 closed):
the API answers `502 WORKER_UNAVAILABLE: fetch failed` and the task row lands
failed before any child exists. `pnpm dev` started from a shell that later
died takes the worker with it; a harness-supervised background process does
not. Before blaming a model or an adapter, check the three ports first.

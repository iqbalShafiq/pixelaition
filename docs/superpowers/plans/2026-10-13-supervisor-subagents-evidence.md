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

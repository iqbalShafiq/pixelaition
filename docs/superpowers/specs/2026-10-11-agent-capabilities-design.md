# Agent Capabilities Expansion — Design

**Status:** Awaiting review
**Date:** 2026-10-11
**Scope:** Master spec. Seven phases (A–G from the capability review, plus plan-first rich clarification, per-frame/asset versioning, and the workspace agent with a home composer). One spec, one master plan, phased execution.

## Goal

Make the agent a first-class citizen of the app. Today it can paint one bound frame with seven tools and cannot see its own output, manage frames or layers, ask the user anything mid-run, or route work to a project. After this program the agent can observe everything the editor shows, plan and confirm multi-frame work with the user, keep animation continuity honest, work across frames and layers, and start from the home screen knowing which projects and assets the user owns.

## Non-goals

- Multi-user collaboration, realtime co-editing, or CRDTs.
- Automatic image-generation fallbacks (no diffusion models; the agent draws with tools or it fails with a named cause).
- Mobile-specific redesign; existing sheet behavior extends.
- MCP client integration; the agent stays an in-process Anvia agent.

## Decisions already made

1. **Plan-first policy (chosen option 1).** The agent always writes a plan for multi-step work and the plan is visible in the run console. Human clarification appears only when it is needed: multi-frame work, edits that reach frames beyond the request's frame, destructive operations, or genuine ambiguity.
2. **Human clarification is app-owned on top of Anvia interactions.** Anvia v1 gives us `createQuestionTool` (`ask_user`) and `requiresApproval`, with durable suspend/resume (`run.respond`). Its contract is a flat question list (single-choice + free text) and an approval with JSON input. Multi-select, always-available free text, image previews, and approve-with-edits are implemented by the app UI riding on that contract — the documented "app-owned compatibility workflow".
3. **Versioning is per frame, aggregated per asset.** Frame snapshots are the atom; asset-level entries cover metadata and frame-set changes. Restore is never destructive (it writes a new version).
4. **The workspace agent is the same agent with a lazy target.** A workspace run starts with no asset binding; it gains one through tools (`use_asset`) after reading or creating projects/assets.

## Research grounding

- Anthropic, _Writing effective tools for AI agents_ — few high-impact tools, token-efficient returns, teaching errors, evaluations.
- Anthropic, _Effective context engineering_ and _harnesses for long-running agents_ — explicit plans, structured notes.
- SketchAgent (MIT, CVPR 2025) — sequential strokes on a numbered grid; the canvas is re-rendered and fed back for dialogue-driven edits.
- _Draw me a swordsman_ (2025) — Aseprite MCP experiments: primitives alone produce blocky art; artists' missing features include onion skin; strong use cases are spritesheets, palette work, dimension checks.
- Aseprite MCP servers (divii, willibrandon/pixel-mcp, MCP Pro) — tool categories: drawing, layers, frames/animation, palettes, dithering/shading/outline, analysis (color stats, animation validation), export.
- Self-QA loops (render → screenshot → vision critique) and EdiVal-Agent — visual feedback catches errors invisible in raw data.
- MCP Elicitation (2025-11-25 spec) — flat primitives, single-select and multi-select enums, titled enums, defaults, free text; no images in-band.
- AG-UI interrupts — run ends with an interrupt outcome and `responseSchema`; resume carries per-interrupt responses; `humanInTheLoop.approveWithEdits`.
- Figma version history — timeline, named checkpoints, preview before restore, restore-as-new-checkpoint.

## Process (how all phases get built safely)

1. This spec is reviewed by the user.
2. `writing-plans` produces one master plan with a section per phase (task lists, file paths, tests, verification commands).
3. Execution is phase by phase. Each phase ends with its own gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, plus browser verification for UI work and a focused live run for agent work. Only then does the next phase start.
4. Each phase ships as its own conventional commits (e.g. `feat(agent): …`, `feat(web): …`). The tree stays green between phases; no phase depends on unfinished work from a later phase.
5. Migrations are additive and numbered; new pixel mutations go through `applyCommand`; no deterministic fallbacks anywhere (per `AGENTS.md`).

## Cross-cutting conventions

- **Tool contracts.** `createTool` with zod schemas; outputs are strict JSON or `ToolOutput.content` parts; errors are bounded sentences naming the cause (`That layer is not on this frame.`), never stack traces.
- **Recovery classes.** Every new tool is classified for `toolRecovery()`: reads and plan tools `safe`; mutations `idempotent`; interaction tools `safe`.
- **Run console.** Every new tool gets a row icon and summary in `run-activity.ts`; the mapping module stays pure with unit tests.
- **Telemetry.** New tools appear in run traces through existing OTLP spans; no new secrets.
- **Evals.** `packages/agent` deterministic eval grows a case per new tool family; judge criteria updated where user-visible copy changes.
- **UI.** All new UI follows `DESIGN.md` tokens (Sweetie 16 through the token table), 2px borders, no radius, motion 120–200ms ease-out with `prefers-reduced-motion`.

---

## Phase 1 — Observation & foundation

**Goal:** the agent can see everything the editor shows before it paints: the project, any frame, any region, and (where the model supports it) the rendered image.

### Tools

| Tool                        | Contract                                                                                                                                                         | Notes                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_project` (fix)        | returns `{ assetId, name, width, height, palette: [{index, hex}], style, frames: [{id, name, index}], currentFrame: {id, name}, layers: [{id, name, visible}] }` | Today it claims to return frame names and does not; fix that.                                                                                                                                               |
| `read_frame` (fix + extend) | `{ frameId?, layerId?, view?: "composite" \| "layer" }` → `{ frameId, view, width, height, rows: string[], colors: [{index, hex, count}] }`                      | Rows become run-length encoded (`"0x5 3x10 0x17"`), fixing the ambiguous `join("")` for palettes ≥10 colors and cutting tokens. Default view is the composite of visible layers; `layerId` reads one layer. |
| `read_region`               | `{ frameId?, x, y, width, height, view? }` → RLE rows + colors                                                                                                   | For zoomed inspection without paying for the whole frame.                                                                                                                                                   |
| `preview_frame`             | `{ frameId?, mode?: "frame" \| "strip", scale?: 1..10 }` → `ToolOutput.content([text, image])`                                                                   | Renders through `packages/export` (`frameToPng` / raster); `strip` renders every frame side by side as a contact sheet. Registered only for models with image input (see spike).                            |

### Spike: vision capability

Before shipping `preview_frame`, verify with a real request whether `muse-spark-1.3-contributor` and `deepseek-v4.1-flash` accept image input through OpenCode Go. Result recorded in the spec addendum and encoded as a new `models.vision` boolean (migration 0004, default false, seeded true only for verified models). If no catalog model is vision-capable, Phase 1 ships without `preview_frame` registration, and the filmstrip is delivered as data (RLE + continuity metrics in Phase 2) until a vision model is added; the tool code may ship behind the flag.

### Data / API / worker / web

- No schema changes beyond `models.vision` (0004).
- Worker: `createPixelTools` gains the new reads; `toolRecovery` entries added; instructions updated (read before painting; use `read_region` for detail).
- Console icons: `read_region`, `preview_frame` (Eye / ImageIcon).

### Tests & acceptance

- Unit: RLE encode/decode round-trip; palette legend; composite vs layer read on a two-layer frame; region bounds rejection.
- Acceptance: on the muse-anim asset the agent can read the project (frame list), read a frame in RLE, read a region, and — if vision is verified — preview a frame and describe it.

---

## Phase 2 — Multi-frame work & animation continuity

**Goal:** the agent can create, duplicate, reorder, rename, and delete frames, paint across them, and check that the animation reads as connected.

### Tools

| Tool              | Contract                                                                                                                                                                     | Notes                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `use_frame`       | `{ frameId }` → sets the run's default frame                                                                                                                                 | Reduces argument repetition; every drawing tool also takes optional `frameId` defaulting to the current one.                   |
| `add_frame`       | `{ name?, duplicateOfFrameId? }` → `{ frameId, name, index }`                                                                                                                | Blank frame or a duplicate, matching the editor's rules.                                                                       |
| `rename_frame`    | `{ frameId, name }`                                                                                                                                                          |                                                                                                                                |
| `move_frame`      | `{ frameId, index }`                                                                                                                                                         | Reuses the dense-renumber transaction from the editor.                                                                         |
| `delete_frame`    | `{ frameId }`                                                                                                                                                                | Last-frame rule: deleting the only frame replaces it with a fresh blank frame (same as the editor). Approval-gated in Phase 3. |
| `check_animation` | `{ frameIds? }` → per consecutive pair: changed-pixel count, diff bounding box, opaque-centroid shift, silhouette bbox drift; plus loop check last→first and per-frame stats | Deterministic, unit-tested. Thresholds documented as constants (e.g. centroid shift > 2 px flags).                             |

### Run model

- `RunBinding` becomes multi-frame: `{ assetId, originFrameId, currentFrameId, frames: Map<frameId, {name, buffer}>, palette, width, height, style, approvedScope?: Set<frameId> }`. `bindRun` loads every frame of the asset (32×32 assets are tiny).
- `onStroke` persists the frame actually edited (`frames.id = editedFrameId`), and the `canvas-stroke` event already carries `frameId`.
- Editor: while a run is active for the asset, **all** frames are locked for editing (the agent may touch any of them); the `drawing` marker shows on the frame currently being painted. The API's 409 guard extends to every frame mutation of the asset while a run is active.

### Tests & acceptance

- Unit: frame CRUD tool handlers against a bound run; dense renumber; `check_animation` metrics on crafted frame pairs (identical frames → zero drift; shifted sprite → centroid delta).
- Live: a four-frame hop cycle generated in one run on muse-anim with `check_animation` clean at the end; editor shows strokes live per frame.

---

## Phase 3 — Plan-first & rich human clarification

**Goal:** the agent plans visibly; when it needs the user it asks with a rich card — single choice, multi-select, always a free-text field, previews, approve-with-edits — and the run parks durably until the answer arrives.

### Tools

| Tool                            | Contract                                                                                                                                | Recovery   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `plan`                          | `{ steps: string[] }` → returns the stored plan                                                                                         | safe       |
| `present_plan`                  | `{ summary, frames: [{ frameId?, name, description }] }`, `requiresApproval: true`                                                      | safe       |
| `ask_user`                      | Anvia `createQuestionTool()` (≤4 questions, choices + `allowCustom`)                                                                    | safe       |
| drawing tools                   | gain dynamic approval: `requiresApproval: (args) => args.frameId && !approvedScope.has(args.frameId) && args.frameId !== originFrameId` | idempotent |
| `delete_frame`, `resize_canvas` | `requiresApproval: true`                                                                                                                | idempotent |

`present_plan` is how the multi-frame flow starts: the agent proposes frames; approval returns the confirmed plan and the confirmed scope. A proposed frame with a `frameId` targets an existing frame and joins `approvedScope` when approved; a proposed frame without one will be created by the run — `add_frame` adds each newly created frame to `approvedScope` automatically, so painting a frame the run just created never re-asks. Editing the plan in the card produces a **staged override** (Anvia approval responses cannot mutate input): the override is persisted on the run row (`generation_runs.override jsonb`, migration 0005) keyed by the interaction's `internalCallId`, validated, and consumed by `present_plan`'s execute, which returns the edited plan and writes `approvedScope` into the run binding. Rejection returns `{approved: false, reason}` and the agent adapts or stops.

### Interaction UX (editor)

- A new **interaction card** renders inside the run console above the composer: title, the agent's question(s) or plan, choices as radio (single) or checkbox (multi), **a free-text field always visible**, and frame previews when the interaction carries frame ids.
- Frame ids come from the interaction's tool input: for approvals, `interaction.input`; for `ask_user`, the UI joins `toolCallId` → the `tool_started` stream event's input. Previews use the editor's existing thumbnail renderer; clicking opens the frame.
- Multi-select convention: a question whose `id` ends in `_multi` renders checkboxes; the answer serializes the selected values as a JSON array string in `value`. The server validates the JSON and falls back to treating it as custom text (bounded).
- Buttons: primary "Continue" (disabled until every question is answered), "Cancel run" secondary. Keyboard: Enter submits, Escape focuses the composer.

### Durable wiring

- Worker `follow()` already polls every 200 ms; when `snapshot.run.status === "waiting"` it reads `snapshot.run.outcome.interaction` (an `AgentInteractionOutcome`), publishes a new stream event `interaction`, and persists it: `generation_runs.status = "waiting"` plus the sanitized interaction inside `events` (deduplicated by `interactionId`). Terminal handling is unchanged.
- New internal endpoint `POST /internal/runs/:id/respond` → `runtime.run(durableId).respond(interactionId, response)`; the API adds `POST /api/runs/:id/respond` (ownership-checked) which forwards it. Responses are the canonical shapes: `{type:"tool-approval", approved, reason?}` and `{type:"tool-question", answers:[{questionId, value}]}`.
- Editor: `active-run` returns `waiting` runs with their interaction; the console restores the pending card after refresh; answering resumes the stream (events continue after the interaction cursor). Stop still cancels a waiting run.
- Restart safety: the durable store holds the continuation; the worker re-publishes the pending interaction after restart by reading the snapshot (idempotent by `interactionId`).

### Tests & acceptance

- Unit: interaction event mapping in `run-activity.ts`; multi-select serialization/validation; staged-override consume path; dynamic approval predicate.
- Contract test: `assertAgentInteractionResponse` behavior for answers outside `choices` when `allowCustom` is false (record the result; the UI always sends valid values).
- Live: "make a 4-frame hop cycle" → plan appears → `present_plan` card shows the frame list → user edits the scope (removes one frame, adds a note) → run continues and edits exactly the confirmed frames → painting an unapproved frame triggers a second approval card.

---

## Phase 4 — Versioning (per frame, per asset)

**Goal:** every change is recoverable with context: who changed what, when, and which run did it.

### Data model (migration 0006)

`versions` table: `id`, `assetId` (cascade), `frameId` (nullable, cascade), `scope: "frame" | "asset"`, `kind: "edit" | "run" | "restore" | "frame-add" | "frame-delete" | "frame-move" | "rename" | "resize" | "palette" | "layer"`, `author: "user" | "agent"`, `runId` (nullable), `label` (nullable, ≤80), `snapshot` jsonb (frame: layers; asset: metadata + frame ids), `createdAt`.

### Creation & retention rules

- A version is written whenever a change is persisted: agent run terminal (one per touched frame, `author: "agent"`, `runId`), user flush (debounced save), frame add/delete/move/rename, resize, palette change, restore.
- **Coalescing:** consecutive changes by the same author and kind on the same frame within 120 s merge into the newest version (snapshot replaced, count bumped in `label`-less entries). Runs never coalesce with user edits.
- **Retention:** keep the newest 200 versions per asset; unlabeled ones prune first; labeled checkpoints survive.
- **Restore is a change:** restoring writes the old snapshot as the new current state and records `kind: "restore"` with a reference to the restored version in the label. Blocked while a run is active for the asset (409).

### API & UI

- `GET /api/assets/:id/versions?scope=&frameId=&limit=&cursor=` → newest first.
- `PATCH /api/assets/:id/versions/:versionId` → label only.
- `POST /api/assets/:id/versions/:versionId/restore` → applies the snapshot, returns the asset.
- UI: a **History** panel in the right rail (and sheet on narrow): frame timeline when a frame is selected — thumbnail, author badge (`You` / `Agent · muse-spark · xhigh`), relative time, label edit, restore with confirmation. An asset tab aggregates frame entries by run plus asset-level kinds. Selecting a version previews it in the canvas with an onion-style diff overlay against the current frame; "Restore" restores, "Close" returns.
- Thumbnails render client-side from the snapshot (same code as frame thumbs); no new render endpoint.

### Tests & acceptance

- Unit (store): coalescing window, prune order (unlabeled first), restore-as-new, run grouping; API tests for cursor paging.
- UI: mapping module tests; live: draw, run the agent, restore a pre-run version, confirm a new `restore` entry appears and the run history stays linked.

---

## Phase 5 — Drawing primitives & quality

**Goal:** the agent reaches parity with the editor's tools and has deterministic helpers for the pixel-art qualities the critique can check.

### Tools

| Tool                           | Contract                                                                       | Command                                                            |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `erase_stroke`                 | `{ layerId, label, points }`                                                   | existing `erase`                                                   |
| `draw_line`                    | `{ layerId, label, from, to, color }`                                          | existing `line`                                                    |
| `flood_fill`                   | `{ layerId, x, y, color }`                                                     | existing `fill`                                                    |
| `fill_region` / `clear_region` | `{ layerId, x, y, width, height, color? }`                                     | existing `region`                                                  |
| `replace_color`                | `{ from, to, layerId? }`                                                       | new `replaceColor` command                                         |
| `resize_canvas`                | `{ width, height }`                                                            | existing `resize`; approval-gated                                  |
| `apply_outline`                | `{ layerId?, color? }`                                                         | new `outline` command (silhouette ring in the style outline color) |
| `dither_rect`                  | `{ layerId, x, y, width, height, colorA, colorB, pattern: "checker" \| "50" }` | new `dither` command                                               |

### Critique expansion (`packages/pixel/src/critique.ts`)

- Stray pixels: isolated opaque pixels with no orthogonal opaque neighbor.
- Outline placement: outline color pixels not adjacent to transparency (internal outline) and silhouette gaps.
- Margins: artwork touching the canvas edge; fully empty border rows/cols where a margin is expected.
- All deterministic, each with unit tests; `critique_frame` returns the extended issue list; instructions keep "finish only when issues is empty".

### Tests & acceptance

- Unit: each new command (bounds, palette validation, undo), critique cases.
- Live: agent draws a 3-shade rock with `apply_outline` + `dither_rect`, critique clean.

---

## Phase 6 — Layers, workflow & infra

**Goal:** layer parity, a scratchpad, run context, and headroom for longer jobs.

### Tools

| Tool                | Contract                  | Command                            |
| ------------------- | ------------------------- | ---------------------------------- |
| `add_layer`         | `{ name? }` (≤4 layers)   | existing `addLayer`                |
| `rename_layer`      | `{ layerId, name }`       | existing `renameLayer`             |
| `set_layer_visible` | `{ layerId, visible }`    | existing `setLayerVisible`         |
| `remove_layer`      | `{ layerId }` (≥1 layer)  | existing `removeLayer`             |
| `think`             | Anvia `createThinkTool()` | scratchpad; console row `thinking` |

- **Run history in context:** the worker prompt gains a short block with the last 3 finished runs for the asset (prompt + answer, truncated to 200 chars each) so follow-ups like "make it bigger" have context.
- **maxTurns:** raised from 24 to 40, documented in the spec addendum; per-run override stays a future option.
- **Evals:** deterministic cases for layer tools and the think tool; judge prompt instructions updated for plan-first copy.

### Acceptance

- Live: a two-layer build (outline layer + color layer) with correct visibility toggles; follow-up "tambahkan bayangan" resolves against the previous run's context.

---

## Phase 7 — Workspace agent & home composer

**Goal:** a composer on the home screen; the agent knows the user's projects and assets and can propose or create the right home for new work.

### Run scope

- `generation_threads` (migration 0007): `assetId` becomes nullable, `projectId` nullable added; a thread carries one of them (check constraint).
- `POST /api/runs` accepts `{ scope: "workspace", projectId?, prompt, modelId, reasoningEffort }`; the worker binds a workspace run with no asset.
- `RunBinding` becomes optional (`binding?`): drawing tools fail with "Choose or create an asset first." until `use_asset` binds one. `use_asset({ assetId })` loads frames/palette/style exactly like an asset run (origin frame = first frame).

### Tools

| Tool            | Contract                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `list_projects` | → `[{ id, name, updatedAt, assetCount }]`                                |
| `list_assets`   | `{ projectId }` → `[{ id, name, width, height, frameCount, updatedAt }]` |
| `create_asset`  | `{ projectId, name, width, height, palette? }` → asset + bound           |
| `use_asset`     | `{ assetId }` → binds the run                                            |

Existing plan/question/approval tools work unchanged; `present_plan` covers "put this in project X, asset Y, 4 frames" proposals. Creating an asset is additive; destructive follow-ups keep their gates.

### UI

- **Home composer:** the same composer component on the home screen, centered; runs stream into a console below it (same `run-activity` mapping). On completion the console links to the touched asset ("Open muse-anim").
- Home shows recent runs (existing run history, asset-scoped entries resolve their asset link).
- The workspace console reuses the interaction card; previews only appear once an asset is bound.

### Tests & acceptance

- API: workspace run creation, thread constraint, ownership checks for projects/assets.
- Live: from the home composer, "buat slime hijau 32px dengan 4 frame hop, taruh di project Pixelaition" → agent lists projects → `present_plan` card with project/asset proposal → confirm → asset created, frames drawn, `check_animation` clean, console links to the new asset.

---

## Open questions & spikes

1. **Vision capability** (Phase 1 spike) — whether Muse Spark / DeepSeek accept images via OpenCode Go; result seeds `models.vision`.
2. **`assertAgentInteractionResponse` strictness** — behavior when a custom answer is sent for a question without `allowCustom`; the UI always sends valid values, but the contract test records the truth.
3. **Staged override persistence** — the override lives on `generation_runs.override` so a worker restart mid-waiting can still consume it; validated again at execute time.
4. **Filmstrip limits** — cap preview scale and total bytes (e.g. ≤ 1 MB per image) so a 20-frame strip stays safe.
5. **Retention defaults** (Phase 4) — 200 versions/asset, 120 s coalescing window; revisit if it feels noisy in use.

## References

- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://sketch-agent.csail.mit.edu
- https://ljvmiranda921.github.io/notebook/2025/07/20/draw-me-a-swordsman
- https://github.com/willibrandon/pixel-mcp
- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://docs.ag-ui.com/concepts/interrupts
- https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
- Anvia v1 declarations in-repo: `@anvia/core` `createQuestionTool` / `requiresApproval` / `AgentInteractionRequest`; `@anvia/durable` `DurableRun.respond` / `snapshot.run.outcome.interaction` / status `waiting`.

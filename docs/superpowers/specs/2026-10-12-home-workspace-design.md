# Home Workspace — Design

**Status:** Awaiting review
**Date:** 2026-10-12
**Scope:** One program that turns the home screen into a real workspace: generated entity summaries, a home decision where Jev picks the target from the user's live projects, an always-shown confirmation before any run exists, agent-side clarification with live dropdowns, a searchable library layout, and a typed "the agent assembles the editor" transition. Extends the Phase 12 sketch of the 2026-10-11 agent spec.

## Goal

1. **The home is a workspace, not a form.** Projects and assets are visible, searchable, and one click from the editor; the composer sits where the editor's composer sits; recent runs stop crowding the page.
2. **The user never picks a project by hand.** Jev reads the user's projects, assets, and generated summaries and proposes a target; the user confirms or overrides — a confirmation card always appears before a run exists, even when Jev is confident.
3. **The agent can ask.** When a target is genuinely unclear, the running agent calls `ask_user` and the app renders live project/asset dropdowns, "create new" options, and free text on the standard Anvia interaction contract.
4. **The move to the editor feels assembled.** A typed View Transition choreography carries the target card, asset thumbnail, console, and composer from the home into the editor with a subtle, staged motion — as if the agent rearranged the page.

## Non-goals

- No automatic target guessing without confirmation, ever. No silent fallback when a summary, a decision, or a transition is unavailable.
- No server-side full-text search; the library filters client-side (users have tens of entities, not thousands).
- No redesign of the editor itself beyond accepting the transition names and auto-rejoining a run.
- No cross-user or shared projects; ownership rules stay as they are.
- No frame picker on the confirmation card in v1; an edit lands on the asset's current (first) frame and the editor owns frame switching.

## Decisions already made

1. **Always confirm (user decision).** Every home prompt that would generate returns a proposal first; the confirmation card is mandatory even at high confidence. Ask-only prompts get the same card because a workspace thread requires a project (the `generation_threads` check constraint).
2. **Jev picks dynamically.** One Jev `choice` question carries every project of the user (verified: the Decisions API accepted 16 options with per-option probabilities); a second question carries the chosen project's assets. No default project, no recency heuristic.
3. **Summaries are generated and read-only.** `projects.summary`, `assets.summary`, `frames.summary` (new columns). The user-authored `projects.description` stays separate and is never overwritten.
4. **Same composer, same agent.** The home keeps the one `Composer` component and the one drawing-agent family; the home extends them with the clarification tool and summary-aware reads instead of growing a second path.
5. **Recent runs move to a right rail** on desktop and a collapsible section on mobile.
6. **Transitions are typed View Transitions** (`viewTransition` on TanStack Router navigate, `document.startViewTransition({ update, types })`), reduced-motion aware, with a normal-navigation fallback.
7. **The confirmation is app-owned UI on the Anvia contract.** The proposal card is rendered by the app (deterministic, instant); the in-run `ask_user` tool stays for mid-run questions. Both ride the same durable suspend/resume machinery.

## Research grounding

- **Decisions API option count.** A probe with 16 choice options (15 projects + "none of these") returned a clean answer with probabilities for every option and reported usage (551 in / 147 out, $0.000023). Dynamic project choice in one question is viable; token cost grows linearly with options, so the design caps at 50 with a named cause.
- **Question tool limits.** `createQuestionTool` accepts 1–4 questions, each with 2–4 choices and `allowCustom`; answers resume via `runtime.respond` with `{ type: "tool-question", answers: [{ questionId, value }] }`. Long lists therefore cannot ride `choices`; the app enriches known question ids with live dropdowns while the model's choices stay visible as suggestions.
- **Router.** `@tanstack/react-router` 1.170.41 exposes `viewTransition?: boolean | ViewTransitionOptions`, and route navigations run through `document.startViewTransition({ update, types })` — typed transitions are supported; unsupported browsers fall back to normal navigation.
- **Image input.** Durable prompts carry image parts and the model sees them (verified live: attachment on an empty canvas answered "Magenta"; `view_image` returned a searched image the model described correctly). The frame summarizer can send a rendered PNG.
- **Direct completions.** `@anvia/core/completion` exports `generateCompletion`, including the structured-output overload — the text summarizer can ask for `{ summary }` JSON directly.
- **Binding choke point.** The worker's `register()` inside `bindWorkspaceRun` is the single place a workspace run acquires an asset; `create_asset` publishes `asset-created` events, and the editor can already rejoin an active run — that is the hook for event-driven navigation.
- **Current home pain points.** No search; assets hidden inside project cards; a required project select; recent runs mid-page; no direct path to an asset; the composer is inline instead of docked.

## Process (how all phases get built safely)

Every phase: unit tests first where the logic is pure, then the static gate (`pnpm typecheck`, `pnpm lint`, `pnpm test`), then a live check against the dev stack with `muse-spark-1.3-contributor`, then a Conventional Commit pushed to `feat/multi-model-choice`. Live UI checks use the browser tools (console errors, screenshots, DOM assertions). Evals (`pnpm eval:jev`) extend rather than replace the existing suites.

## Cross-cutting conventions

- Failures name the cause (`MODEL_CANNOT_READ_IMAGES`, `RUN_IN_PROGRESS`, `PROJECT_LIMIT_FOR_DECISION`, …). No silent substitution anywhere.
- Summaries never block a decision: absent means absent from the options text, not a guessed value.
- New UI uses DESIGN.md tokens and the existing primitives (`Card`, `Field`, `TextInput`, `SelectControl`, `IconButton`, `Tooltip`, `Composer`, `RunConsole`, `SpriteThumb`); no new colors, no soft shadows, no rounded corners.
- New text is English, matching the app's current voice; code, comments, and docs stay English.
- Durable invariants hold: one run per thread, bindings before `resume()`, approvals and questions survive restarts.

## Phase 1 — Entity summaries

### Data

Migration `0012_entity_summaries.sql`:

```sql
ALTER TABLE "projects" ADD COLUMN "summary" text DEFAULT '' NOT NULL;
ALTER TABLE "projects" ADD COLUMN "summary_at" timestamp with time zone;
ALTER TABLE "assets"   ADD COLUMN "summary" text DEFAULT '' NOT NULL;
ALTER TABLE "assets"   ADD COLUMN "summary_at" timestamp with time zone;
ALTER TABLE "frames"   ADD COLUMN "summary" text DEFAULT '' NOT NULL;
ALTER TABLE "frames"   ADD COLUMN "summary_at" timestamp with time zone;
```

### Generator (`apps/worker/src/summarize.ts`)

- `summarizeFrame(assetId, frameId)` — renders the frame with the same rasterizer `preview_frame` uses (`frameToPng`), sends it to the vision model (muse) with `generateCompletion` structured output `{ summary: string }`, prompt: "One sentence, ≤ 160 characters, describing what this pixel-art frame shows; name colors and the subject; no markdown." Context: asset name, frame name, canvas size, palette size.
- `summarizeAsset(assetId)` — deepseek chat, structured `{ summary }`, ≤ 240 characters: name, dimensions, palette size, frame names + frame summaries, plus the user's project description. Prompt forbids inventing content the frames do not show.
- `summarizeProject(projectId)` — deepseek chat, structured `{ summary }`, ≤ 240 characters: name, user description, style notes, asset names + asset summaries.
- Each call records a Langfuse span (`summarize-frame|asset|project`) with model, tokens, and USD cost. These calls are server overhead, not run usage; they do not enter the console's usage row.

### Triggers

1. **After a run completes** (worker terminal handling): the frames the run touched, their asset, and its project are queued for re-summarization; a 5-second debounce coalesces bursts (a run that edits three frames causes three frame calls, one asset call, one project call — never more).
2. **Boot backfill**: `recoverInterruptedRuns` runs first; a separate `backfillSummaries()` walks entities with `summary = ''` (bounded to 50 per boot, oldest updated first) and fills them.
3. **On create/rename**: `POST /internal/summaries/refresh` (worker-internal, token-authorized) accepts `{ kind, id }`; the API calls it after asset/project create and after rename operations. Rejections are logged with the cause; the old summary stays.

### Failure behavior

A failed summary logs `[summary] <kind> <id>: <reason>` and leaves the previous value; the decision context simply carries whatever exists. A frame whose PNG exceeds the preview byte cap is summarized from its RLE instead (text call) with a note in the span — this is a delivery choice, not a substituted result.

## Phase 2 — Home decision

### `packages/agent/src/home.ts`

```ts
export type HomeTarget = {
  intent: DrawIntent; // draw | edit | variant | ask
  project: { id: string | "new"; confidence: number };
  asset?: { id: string | "new"; confidence: number };
  source: "jev";
};

export async function decideHomeTarget(
  prompt: string,
  env: JevEnv,
  context: {
    projects: Array<{ id: string; name: string; summary: string; assetCount: number }>;
    assetsByProject: Map<
      string,
      Array<{ id: string; name: string; summary: string; width: number; height: number }>
    >;
    history?: DecisionHistoryEntry[];
  },
): Promise<HomeTarget>;
```

- **Call 1 (one request):** `intent` (choice, the existing criteria) and `project` (choice over `projects` plus `new`) asked together. Options text: `"<name> — <summary> (<n> assets)"`; `new` reads "Start a new project for this request".
- **Call 2 (only when intent ≠ ask and project ≠ new):** `asset` (choice over that project's assets plus `new`). Options text: `"<name> — <summary> (<w>×<h>)"`; `new` reads "Create a new asset in this project". The API pre-loads assets for every project into `assetsByProject` (bounded by the 50-project cap and tens of assets each) so the decision stays a pure function.
- Confidence comes from the provider; the mapping is direct (no derived confidence). Threshold 0.7 only decides what is pre-selected in the confirmation card — the card always appears.
- **Project cap:** more than 50 projects returns a named error `PROJECT_LIMIT_FOR_DECISION`; the API then builds a proposal with `project: "new"`-style "let the agent choose" and the web shows the reason in the card.
- The prompt is still screened by the existing input guardrail before this call, and the existing `decidePrompt` stays for editor runs.

### Eval additions (`packages/agent/src/evals/jev.ts`)

A `home (target)` suite with fixtures that carry two or three projects with summaries: an obvious match, a summary-driven match (name does not contain the keyword), a "new project" case, and an asset-level match. Success = exact project/asset id, measured against the same baseline pattern.

## Phase 3 — Proposal and always-confirm flow

### Data

Migration `0012` also adds:

```sql
CREATE TABLE "run_proposals" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "prompt" text NOT NULL,
  "intent" text NOT NULL,
  "project_id" text,
  "asset_id" text,
  "project_confidence" real,
  "asset_confidence" real,
  "guardrail" jsonb,
  "decision" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);
```

### `POST /api/runs` — two phases

**Phase A (no `proposalId`).** Existing guardrail → `decideHomeTarget` (home scope only) → persist a proposal (15-minute expiry) → `200 { proposalId, proposal }`:

```ts
proposal: {
  intent: "draw" | "edit" | "variant" | "ask";
  project: { id: string | "new"; name?: string; confidence: number };
  asset?: { id: string | "new"; name?: string; confidence: number };
  reason?: string;                                                   // e.g. the 50-project cap
}
```

No run row, no worker call. The guardrail and decision spend is stored on the proposal and later seeded into the run's usage, so the console still shows the full cost. The card's dropdowns read the existing `GET /api/projects` and `GET /api/projects/:id` queries; the proposal carries no entity lists.

**Phase B (with `proposalId` + `confirm`).** Verify ownership, expiry, and not-consumed; then:

```ts
confirm: {
  projectId: string | "new";       // existing project id, or "new"
  assetId?: string | "new" | null; // null = ask run without an asset
  projectName?: string;            // required when "new"
  assetName?: string;              // required when assetId === "new"
  mode: "generate" | "agent";      // "agent" = let the running agent choose/ask
}
```

- `mode: "agent"` starts a workspace run with no target pinned; the agent reads `list_projects`/`list_assets` (now summary-aware) and calls `ask_user` when it needs a decision.
- `mode: "generate"` starts an asset run (`projectId` + `assetId`) or a workspace run in a project (asset `"new"`, the agent creates it with the confirmed name). A new asset is created with the project's style defaults (width, height, palette) unless the prompt names dimensions; a new project is created from `projectName` and the workspace run then creates its asset with a name from the prompt or an `ask_user` question.
- Ownership is re-checked server-side; a foreign id is a 404 `NOT_FOUND`, never a redirect.
- The existing run pipeline is unchanged from `insertRun` onward, including worker proxying, the 409 conflict passthrough, and usage seeding.
- `ask` intent uses the same card; the asset field may be left null.

### Web: `ConfirmTargetCard`

New component (`apps/web/src/components/confirm-target-card.tsx`), same visual language as `InteractionCard`:

- Header: "Confirm target" with the agent glyph; body text composed by the app: "I'll draw in **knights** · **potion** (fairly sure). Go?" — suggestions marked, low confidence shown as "not sure yet".
- Fields: project dropdown (all projects, searchable when > 8, plus "＋ Project baru" and free text), asset dropdown (the chosen project's assets, plus "＋ Asset baru", "tanpa asset", free text), name inputs when a "new" option is chosen.
- Buttons: **Generate** (mode `generate`), **Biar agent pilih** (mode `agent`), **Batal**.
- The card lives in the console region above the composer and opens the console when it appears.

## Phase 4 — Agent clarification

- Add `createQuestionTool()` as `ask_user` to both the drawing and asking agents (worker agent registration).
- Instructions (drawing agent): "When the target project or asset is not pinned, call `ask_user` before binding: one question for the project and, once chosen, one for the asset; offer your suggestions as choices and never guess. When a new asset needs a name, ask for it." The ask agent gets the same tool for its clarifying question.
- UI enrichment in `interaction-card.tsx` `QuestionBody`, by question-id convention (documented in AGENTS.md):
  - `project` → searchable dropdown of the user's projects + "＋ Buat project baru" (value `new`) + free text.
  - `asset` → dropdown of the project chosen in the same card (or all assets when the project answer is free text), + "＋ Buat asset baru" (`new`), + "tanpa asset" (`none`), + free text.
  - `asset_name` → text input (free text), shown when the asset answer is `new`.
  - Every other question keeps today's rendering (choices as checkboxes/radios + free text).
- Answer values are the ids / `new` / `none` / free text; the agent then calls `use_asset` or `create_asset` and continues painting in the same run. The suspend/resume path is unchanged.
- The model's own `choices` remain visible as suggested chips next to the dropdown.

## Phase 5 — Home layout and library

Wide layout (≥ 1100px):

```
┌ top bar: brand · library search · sign out ───────────────┐
│ library toolbar (search, group toggle)   │ recent runs   │
│ library content                          │ rail          │
│  · "recent"  → asset-first grid          │               │
│  · "by project" → project cards with     │               │
│    expandable asset rows                 │               │
└───────────────────────────────────────────────────────────┘
        [ run console ]        ← expands upward
        [ composer dock ]      ← fixed, centered, max-w 40rem
```

- **Composer dock** uses the same `Composer` component, fixed at the bottom center with the same 40rem width as the editor; content scrolls behind it with bottom padding (~11rem). The project select is removed; the model/effort selects, attachment control, and Send remain. While a run is live on the home the composer shows Stop (typed text stays for the next message); the steering queue remains an editor behavior in v1 — lifting it to the home is a follow-up, not part of this program.
- **Library**: toolbar with a search field (filters projects and assets by name + summary, debounced 150ms) and a grouping toggle ("Recent" / "By project"). Asset-first grid cards: `SpriteThumb`, name, project chip, `w×h`, relative updated time; click → editor (typed transition). Project cards: name, summary, asset count, expandable asset chips, inline "new asset".
- **Recent runs rail** (right, `xl` and up): the existing recent-runs rows (prompt, status, time, `Open <asset>`), compact; below `xl` it becomes a collapsible section under the library.
- **Empty states**: no projects → the dock invites the first prompt ("describe your sprite — Jev will handle the project and asset"); empty library after filtering → a quiet "nothing matches".
- Components: new `library-grid.tsx`, `recent-runs-rail.tsx`, `confirm-target-card.tsx`; everything else reused.
- Data: `GET /api/projects` gains `summary` and `assetCount`; `GET /api/projects/:id` gains `summary` per asset; no new endpoints needed for the library.

## Phase 6 — Attachment chip polish

- Chips: `pixel-corners-sm`, 32px thumbnail (`image-rendering: pixelated`), truncated name, `w×h` + bytes in the tooltip, remove button with `aria-label`; hover raises the chip to `bg-raised`.
- The hint/error line gets an info glyph — a new `Info` export in `pixel-icons.tsx` (`CircleInfo` from pixelarticons, audit table updated) — with `text-pixel-mono text-muted`; errors stay until the next add/remove.
- A dashed "＋ Add" chip appears while under the four-image cap and triggers the same file input; the drag-over accent border stays.

## Phase 7 — Transition choreography

### Typed transitions

- Navigation after confirmation (pinned asset) and after a library card click uses `navigate({ ..., viewTransition: { types: ["editor"] } })`; browsers without the API navigate normally. The exact option object is verified against the installed router during implementation (spike below).

### Names and choreography

| Element                              | Home name         | Editor name  | Motion                                 |
| ------------------------------------ | ----------------- | ------------ | -------------------------------------- |
| Chosen asset thumbnail / target card | `asset-flight`    | canvas panel | thumb 0.9→1 into a 1.02→1 panel, 260ms |
| Run console                          | `console-flight`  | console      | fade + 12px rise, 200ms, 40ms delay    |
| Composer dock                        | `composer-flight` | composer     | fade + 12px rise, 200ms, 80ms delay    |
| Everything else                      | root              | root         | 160ms crossfade                        |

- CSS lives in `apps/web/src/styles.css` under `::view-transition-group(...)` with `:active-view-transition-type(editor)` scoping; `@media (prefers-reduced-motion: reduce)` collapses durations and drops the morph names.
- **"The agent assembles the page" flavor**: before navigating, the console appends the binding row ("→ knights · potion") and the target card pulses once (accent border, 120ms); the asset thumbnail takes an accent outline as the transition starts. Nothing else moves.

### Navigation timing

- **Pinned target** (mode `generate` with an existing asset): navigate immediately after the run starts (202); the editor rejoins the active run through the existing `active-run` polling + stream.
- **`mode: "agent"` or a "new" asset**: the home listens on the run stream for `asset-created` (or the binding fallback) and navigates once, with the same transition; a manual navigation by the user cancels the pending auto-navigation.
- **Ask runs**: no navigation; the answer renders in the home console.

## Phase 8 — Audit, docs, and evals

- `AGENTS.md`: summaries invariant; home confirm flow; `ask_user` + question-id conventions; transition names and reduced-motion rule; the 50-project decision cap.
- `README.md`: the home flow in one paragraph; no new env.
- Evals: the `home (target)` suite (Phase 2) plus a live UI acceptance pass:

  1. Home prompt → confirmation card appears with Jev's pick pre-filled; no run exists before confirm (assert `/api/runs/recent` unchanged).
  2. Generate (pinned) → run starts → typed transition → editor shows the run and the asset; console carries the cost of guardrail + decision + run.
  3. "Biar agent pilih" → workspace run asks via `ask_user`; the card renders project/asset dropdowns; answering resumes; the agent creates or binds and paints; auto-navigation fires once.
  4. Ask prompt → card → confirm → the answer renders in the home console; no navigation.
  5. Summaries: after a run, `frames.summary` / `assets.summary` / `projects.summary` change (assert in Postgres); the decision options carry them (assert via the Jev eval).
  6. Library search filters by name and summary; an asset card opens the editor with the transition.
  7. Reduced-motion emulation: navigation still works with the morphs disabled.
  8. No console errors; the static gate stays green (24/24, no cache).

## Open questions & spikes

- **Spike A (router):** exact `ViewTransitionOptions` shape on 1.170.41 and whether React 19 state updates during navigation need `flushSync` wrappers; confirm `types` reach `document.startViewTransition`.
- **Spike B (structured output):** does the OpenCode Go chat endpoint honor structured outputs for `generateCompletion` with deepseek? If not, the summarizer parses plain text (a parsing choice, not a substitution) and the span records which path ran.
- **Spike C (cost):** measure a 50-option decision call; if token growth is unacceptable, lower the cap with a named cause and surface it in the card.
- **Open:** should the confirmation card offer a frame picker for `edit` intents? Deferred; the editor owns frames in v1.

## References

- `docs/superpowers/specs/2026-10-11-agent-and-pixel-theme-design.md` — Phase 12 (workspace agent & home composer), the app-owned clarification convention.
- `docs/superpowers/specs/2026-10-10-backend-truth-design.md` — decision/guardrail truth and failure rules.
- Anvia `@anvia/core` 1.14 — `createQuestionTool`, interactions, `generateCompletion`.
- `@anvia/durable` 0.10 — suspend/resume, media prompts, payload limits.
- TanStack Router 1.170.41 — `viewTransition` option.
- Live probes from 2026-10-12: 16-option Jev choice; attachment vision on an empty canvas ("Magenta"); searched image description via `view_image`.

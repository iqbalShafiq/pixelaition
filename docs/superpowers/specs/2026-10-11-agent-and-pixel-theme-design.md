# Agent Capabilities & Pixel Theme — Design

**Status:** Awaiting review
**Date:** 2026-10-11
**Scope:** Master spec for two tracks, one program. **Part I — Pixel Theme** (Phases 1–5) ships first: typography, component primitives, iconography, atmosphere and pages, audit. **Part II — Agent Capabilities** (Phases 6–12) follows: observation tools, multi-frame work and animation continuity, plan-first rich human clarification on Anvia interactions, per-frame and per-asset versioning, drawing primitives and quality checks, layers and run context, and the workspace agent with a home composer. One spec, one master implementation plan, phased execution.

## Goal

Two goals, one program:

1. **Make Pixelaition look unmistakably pixel/retro on every page** — pixel fonts across chrome and body, chunky component treatments (bevels, hard shadows, stepped corners, pixel windows), a pixel icon set, and page-level atmosphere — while keeping text legible and accessible.
2. **Make the agent a first-class citizen of the app** — it can observe everything the editor shows, plan and confirm multi-frame work with the user, keep animation continuity honest, work across frames and layers, and start from the home screen knowing which projects and assets the user owns.

The pixel theme ships first so the agent's new UI (interaction card, History panel, home composer) is built once, on the new primitives.

## Non-goals

- Multi-user collaboration, realtime co-editing, or CRDTs.
- Automatic image-generation fallbacks (no diffusion models; the agent draws with tools or it fails with a named cause).
- CRT/scanline gimmicks that hurt readability; no decorative effects on body text.
- Mobile-specific redesign; existing sheet behavior extends.
- MCP client integration; the agent stays an in-process Anvia agent.

## Decisions already made

1. **Plan-first policy (option 1).** The agent always writes a plan for multi-step work and the plan is visible in the run console. Human clarification appears only when needed: multi-frame work, edits reaching frames beyond the request's frame, destructive operations, or genuine ambiguity.
2. **Human clarification is app-owned on top of Anvia interactions.** `createQuestionTool` (`ask_user`) and `requiresApproval` provide the durable suspend/resume; multi-select, always-available free text, image previews, and approve-with-edits are implemented by the app UI riding on that contract (the documented "app-owned compatibility workflow").
3. **Versioning is per frame, aggregated per asset.** Frame snapshots are the atom; asset-level entries cover metadata and frame-set changes. Restore is never destructive.
4. **The workspace agent is the same agent with a lazy target.** A workspace run starts with no asset binding and gains one via `use_asset` after reading or creating projects/assets.
5. **Hybrid typography.** Pixel fonts for chrome, labels, headings, numbers and body; long-form text stays legible at ≥16px. Concretely: Silkscreen for display, Pixelify Sans for body/labels, Departure Mono for numbers and logs.
6. **Pixel theme first.** Part I ships before Part II; the agent UI then uses the new primitives.

## Research grounding

**Pixel theme**

- Font candidates verified on npm: `@fontsource/silkscreen`, `@fontsource/pixelify-sans`, `@fontsource/vt323`, `@fontsource/press-start-2p`, `@fontsource/dotgothic16`, `@fontsource/handjet`, `@fontsource/jersey-10/15/25`, `@fontsource/tiny5`, `@fontsource/micro-5`, `@fontsource/geist-pixel`. Departure Mono (OFL) is not on Fontsource and is vendored as woff2.
- Departure Mono is designed for crisp UI at **multiples of 11px**; Silkscreen is crisp at **multiples of 8px**; Pixelify Sans carries 400–700 weights and stays readable at small sizes. Pixel fonts are blurry at fractional sizes — snap sizes to their design grids.
- Playdate (modern 1-bit console): font strokes ≥2px, generous x-height, distinct letterforms; constraints as character. Accessibility research: body ≥16px, pixel faces are poor for long paragraphs, 9px is the practical floor for micro text.
- Component techniques: 98.css/NES.css bevels and pressed states; hard `box-shadow` (no blur) offset shadows; 9-slice `border-image` for pixel window frames that keep corners sharp at any size; `steps()` timing for retro motion; `pixelarticons` (v2.4.2, MIT) — 1036 icons on a 24×24 grid as React components.

**Agent capabilities**

- Anthropic, _Writing effective tools for AI agents_; _Effective context engineering_; _harnesses for long-running agents_.
- SketchAgent (MIT, CVPR 2025) — sequential strokes, canvas re-rendered and fed back for dialogue-driven edits.
- _Draw me a swordsman_ (2025) — Aseprite MCP experiments; primitives alone produce blocky art; strong use cases are spritesheets, palette work, dimension checks.
- Aseprite MCP servers — tool categories: drawing, layers, frames/animation, palettes, dithering/shading/outline, analysis (color stats, animation validation), export.
- MCP Elicitation (2025-11-25) — flat primitives, single/multi-select enums, titled enums, defaults, free text; no images in-band.
- AG-UI interrupts — interrupt outcome + `responseSchema`, resume with per-interrupt responses, `humanInTheLoop.approveWithEdits`.
- Figma version history — timeline, named checkpoints, preview before restore, restore-as-new.
- Anvia v1 in-repo declarations: `createQuestionTool`, `requiresApproval` (dynamic), `AgentInteractionRequest` (`tool-question` | `tool-approval`), `AgentInteractionOutcome`; `@anvia/durable` `run.respond`, `snapshot.run.outcome.interaction`, status `waiting`.

## Process (how all phases get built safely)

1. This spec is reviewed by the user.
2. `writing-plans` produces one master plan with a section per phase (tasks, file paths, tests, verification commands).
3. Execution is phase by phase, Part I before Part II. Each phase ends with its gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, plus browser verification for UI work (screenshot review per page in Phase 5) and a focused live run for agent work. Only then does the next phase start.
4. Each phase ships as its own conventional commits. The tree stays green between phases; no phase depends on unfinished work from a later phase.
5. Migrations are additive and numbered; new pixel mutations go through `applyCommand`; no deterministic fallbacks anywhere (per `AGENTS.md`).

## Cross-cutting conventions

- **Tool contracts.** `createTool` with zod schemas; outputs are strict JSON or `ToolOutput.content` parts; errors are bounded sentences naming the cause, never stack traces.
- **Recovery classes.** Every new tool is classified for `toolRecovery()`: reads and plan tools `safe`; mutations `idempotent`.
- **Run console.** Every new tool gets a row icon and summary in `run-activity.ts`; the mapping module stays pure with unit tests.
- **Telemetry.** New tools appear in run traces through existing OTLP spans; no new secrets.
- **Evals.** `packages/agent` deterministic eval grows a case per new tool family; judge criteria updated where user-visible copy changes.
- **UI.** All new UI follows `DESIGN.md` tokens (Sweetie 16 through the token table), 2px borders, no radius; pixel motion uses `steps()` and honors `prefers-reduced-motion`.

---

# Part I — Pixel Theme

## Phase 1 — Typography

**Goal:** every string in the app is set in a pixel face, crisp at integer sizes, still legible.

### Font roles

| Token            | Face                                                        | Use                                                          | Grid rule                                                    |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `--font-display` | **Silkscreen** (400/700)                                    | logo, page titles, dialog/sheet titles, hero copy            | sizes in multiples of 8 (16/24/32), uppercase, tracked       |
| `--font-body`    | **Pixelify Sans** (400–700)                                 | body copy, labels, buttons, menus, tooltips, inputs          | ≥12px for short strings, **≥16px for body**, line-height 1.5 |
| `--font-mono`    | **Departure Mono** (400, vendored woff2 + OFL license file) | numbers, coordinates, hex, keyboard hints, run console, logs | multiples of 11 (11/22)                                      |

- Add `@fontsource/silkscreen` and `@fontsource/pixelify-sans`; vendor Departure Mono into `apps/web/src/assets/fonts/` with an `@font-face` and the license file.
- IBM Plex Sans/Mono imports are removed **after** every surface is migrated (end of Phase 1); fallback stacks end in `ui-sans-serif` / `ui-monospace`.
- **Crispness:** pixel-font elements get `-webkit-font-smoothing: none; text-rendering: geometricPrecision; font-feature-settings: normal;` — verified at 100% and 200% zoom on retina and non-retina. No fractional sizes, no `transform: scale()` on text.
- Micro-labels currently at 10–11px move to Pixelify Sans 12px (Silkscreen below 16px is reserved for the logo mark only); the audit in Phase 5 can promote selected labels to Silkscreen 16px where space allows.

### Work

- Replace `--font-sans` / `--font-mono` tokens and the `font-mono` utility usage across `ui.tsx`, panels, composer, console, toolbar, auth and home.
- Define the type scale in `styles.css` (`.text-pixel-display`, `.text-pixel-label`, `.text-pixel-body`, `.text-pixel-mono`) so components never hand-roll sizes.
- Update `DESIGN.md` typography section in Phase 5, not here.

### Tests & acceptance

- No logic tests; visual acceptance: every route uses the new faces (grep: no `IBM Plex` after cleanup), sizes are grid-snapped, no blur at 100%/200% zoom, inputs stay ≥16px (iOS zoom rule preserved).

## Phase 2 — Component primitives

**Goal:** the shared primitives in `ui.tsx` and `styles.css` carry the pixel look, so every page inherits it.

### New utilities (`styles.css`)

- `shadow-pixel-sm/md/lg` — hard offset shadows (`2px/3px/4px 0` in `navy`, no blur).
- `bevel` / `bevel-in` — 2px inset highlight/shadow pairs (98.css style) for raised and sunken surfaces.
- `pixel-window` — 9-slice `border-image` from a small SVG data-URI (stepped corner frame) with a `pixel-window-bar` title strip variant for dialogs/toasts.
- `dither-sm/md` — 2px/4px checker overlays (Sweetie 16 pairs) for hero and empty states.
- `steps-2/3/4` — animation timing utilities wrapping `steps()`.

### Components

| Component                           | Treatment                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Button (primary/danger/ghost/quiet) | hard shadow, pressed state translates 2px and shrinks shadow to 1px, focus ring accent                     |
| IconButton                          | same treatment at small sizes                                                                              |
| Input / Textarea                    | `bevel-in` sunken well, focus accent border, unchanged 16px font floor                                     |
| Checkbox / Radio                    | pixel check/dot glyphs drawn on an 8×8 grid (SVG path, not lucide), beveled box                            |
| Menu / Popover                      | pixel-window frame, hard shadow, open/close with `steps(3)`                                                |
| Dialog / ConfirmDialog              | pixel-window with title bar strip; ConfirmDialog keeps the danger coral accent edge                        |
| Sheet                               | stepped slide with `steps(4)`                                                                              |
| Toast                               | pixel-window, stepped slide-in, stepped fade-out                                                           |
| Tooltip                             | 2px box with hard shadow; no tail                                                                          |
| Select / chips                      | small bevel + hard shadow; pressed state like Button                                                       |
| Slider (hue strip)                  | pixel knob (8×16 bevel) and square track ends                                                              |
| Progress / usage bar                | segmented cells (one cell per unit)                                                                        |
| Loader                              | 3-frame pixel spinner sprite via `background-position` + `steps(3)`; used by the run chip and pending rows |
| Scrollbars                          | square thumb with 2px border and bevel; subtle dither track                                                |
| Focus ring                          | keep 2px accent; stepped corners on boxes                                                                  |

### Tests & acceptance

- Component-level: existing web tests stay green (primitives are presentational).
- Visual acceptance: a kitchen-sink section of the editor's right rail (`ViewPanel`, palette, style) and one dialog/toast/menu each photographed and reviewed; pressed/disabled/hover states verified; `prefers-reduced-motion` disables the stepped motion.

## Phase 3 — Iconography

**Goal:** icons read as pixel art, not smooth vectors.

- Add `pixelarticons` (24×24 grid, filled). Swap the primary action icons: toolbar tools, panel actions (add/rename/duplicate/delete/reorder), menu items, play, export, sheet toggles, run-console tool icons.
- Icons render at 16 or 24 only (their grid); audit contrast on `raised`/`field` surfaces (filled glyphs vs the old 2px strokes).
- Where pixelarticons has no equivalent (e.g. the brush-size PixelDot), draw a custom 16×16 rect-based SVG in the same language. Lucide remains only as a temporary fallback and is removed when the mapping is complete.
- Keep every `aria-label` and tooltip unchanged; icon swap must not change hit areas (36/28/24 boxes stay).

### Acceptance

- A mapping table (lucide → pixelarticons or custom) checked into the plan; grep shows no `lucide-react` imports after the phase except none; icons crisp at 16/24.

## Phase 4 — Atmosphere & pages

**Goal:** every page reads pixel at a glance.

- **Shared atmosphere:** `dither` overlays on hero and empty states; `pixel-grid` stays as the substrate; logo `PIXELAITION` in Silkscreen with a hard shadow and a small pixel-glyph mark.
- **Auth pages:** pixel-window cards, stepped focus, hard-shadow primary button.
- **Home:** project cards become pixel windows with hover lift (translate up 2px, shadow grows), counts in Departure Mono, empty state dithered.
- **Editor:** canvas cursor becomes a pixel crosshair; run chip uses the loader sprite; run console rows in Departure Mono; palette hex in Departure Mono; zoom readout and coordinates in Departure Mono.
- **Dialogs / sheets / toasts / menus everywhere:** inherit Phase 2 frames.
- **No scanlines** on body content; the canvas well may take an optional 1px dither edge only.

### Acceptance

- Page-by-page screenshot review (auth, home, editor, dialog, sheet, toast) attached to the phase commit message summary; no layout regressions (panel sizes, canvas fit, composer position unchanged).

## Phase 5 — Audit, accessibility & documentation

- Contrast audit on Sweetie 16 pairs used in the new frames and shadows; fix any pair below 4.5:1 for text.
- Zoom 200%, `prefers-reduced-motion`, keyboard focus visibility, and screen-reader names re-checked on the changed components.
- Legibility sign-off: side-by-side of Silkscreen 16px vs Pixelify 12px for micro-labels; the winner is applied repo-wide.
- Remove IBM Plex imports and stale utilities; update `DESIGN.md` (typography, components, motion, iconography) and `AGENTS.md` where it mentions fonts.
- Delete any orphaned CSS; run the full gate.

---

# Part II — Agent Capabilities

## Phase 6 — Observation & foundation

**Goal:** the agent can see everything the editor shows before it paints.

| Tool                        | Contract                                                                                                                                                 | Notes                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_project` (fix)        | `{ assetId, name, width, height, palette: [{index, hex}], style, frames: [{id, name, index}], currentFrame: {id, name}, layers: [{id, name, visible}] }` | Today it claims to return frame names and does not; fix that.                                                                                      |
| `read_frame` (fix + extend) | `{ frameId?, layerId?, view?: "composite" \| "layer" }` → `{ frameId, view, width, height, rows: string[], colors: [{index, hex, count}] }`              | RLE rows (`"0x5 3x10 0x17"`) fix the ambiguous `join("")` for palettes ≥10 colors and cut tokens. Default view is the composite of visible layers. |
| `read_region`               | `{ frameId?, x, y, width, height, view? }` → RLE rows + colors                                                                                           | Zoomed inspection without paying for the whole frame.                                                                                              |
| `preview_frame`             | `{ frameId?, mode?: "frame" \| "strip", scale?: 1..10 }` → `ToolOutput.content([text, image])`                                                           | Renders through `packages/export`; `strip` is a contact sheet of every frame. Registered only for models with image input.                         |

**Spike: vision capability.** Verify with a real request whether `muse-spark-1.3-contributor` and `deepseek-v4.1-flash` accept image input through OpenCode Go; record the result; encode as `models.vision` (migration 0004, default false). If no catalog model is vision-capable, Phase 6 ships without registering `preview_frame`; the filmstrip stays available as data until a vision model is added.

**Tests & acceptance:** RLE round-trip; composite vs layer read on a two-layer frame; region bounds; live: the agent reads the project, a frame, a region, and — if vision is verified — previews a frame and describes it.

## Phase 7 — Multi-frame work & animation continuity

**Goal:** the agent can create, duplicate, reorder, rename, and delete frames, paint across them, and check that the animation reads as connected.

| Tool              | Contract                                                                                                                               | Notes                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `use_frame`       | `{ frameId }`                                                                                                                          | Sets the run's default frame; drawing tools also take optional `frameId`.     |
| `add_frame`       | `{ name?, duplicateOfFrameId? }`                                                                                                       | Blank or duplicate, matching editor rules.                                    |
| `rename_frame`    | `{ frameId, name }`                                                                                                                    |                                                                               |
| `move_frame`      | `{ frameId, index }`                                                                                                                   | Reuses the dense-renumber transaction.                                        |
| `delete_frame`    | `{ frameId }`                                                                                                                          | Last-frame rule: replace with a fresh blank frame. Approval-gated in Phase 8. |
| `check_animation` | `{ frameIds? }` → per pair: changed pixels, diff bbox, opaque-centroid shift, silhouette drift; loop check last→first; per-frame stats | Deterministic, unit-tested; thresholds documented as constants.               |

**Run model:** `RunBinding` becomes multi-frame (`{ assetId, originFrameId, currentFrameId, frames: Map<id, {name, buffer}>, palette, width, height, style, approvedScope? }`); `onStroke` persists the frame actually edited; while a run is active the editor locks **all** frames of the asset, and the API's 409 guard extends to every frame mutation.

**Tests & acceptance:** unit: frame CRUD handlers, dense renumber, continuity metrics on crafted pairs; live: a four-frame hop cycle generated in one run with `check_animation` clean.

## Phase 8 — Plan-first & rich human clarification

**Goal:** the agent plans visibly; when it needs the user it asks with a rich card — single choice, multi-select, always a free-text field, previews, approve-with-edits — and the run parks durably until the answer arrives.

| Tool                            | Contract                                                                            | Recovery   |
| ------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| `plan`                          | `{ steps: string[] }`                                                               | safe       |
| `present_plan`                  | `{ summary, frames: [{ frameId?, name, description }] }`, `requiresApproval: true`  | safe       |
| `ask_user`                      | Anvia `createQuestionTool()` (≤4 questions, choices + `allowCustom`)                | safe       |
| drawing tools                   | dynamic approval when `frameId` is outside `approvedScope` and not the origin frame | idempotent |
| `delete_frame`, `resize_canvas` | `requiresApproval: true`                                                            | idempotent |

A proposed frame with a `frameId` targets an existing frame and joins `approvedScope` when approved; a frame without one will be created — `add_frame` adds newly created frames to `approvedScope` automatically, so painting a frame the run just created never re-asks. Editing the plan in the card produces a **staged override** persisted on `generation_runs.override jsonb` (migration 0005), keyed by the interaction's `internalCallId`, validated, and consumed by `present_plan`'s execute. Rejection returns `{approved: false, reason}`.

**Interaction UX (editor, built on Part I primitives):** an interaction card in the run console: title, questions/plan, radio or checkbox choices, **free-text field always visible**, frame previews when the interaction carries frame ids (approval `input`; for `ask_user` the UI joins `toolCallId` → the `tool_started` stream event's input). Multi-select convention: question ids ending in `_multi` render checkboxes; the answer serializes as a JSON array string, validated server-side with a bounded fallback to custom text.

**Durable wiring:** worker `follow()` detects `snapshot.run.status === "waiting"`, reads `snapshot.run.outcome.interaction`, publishes a new `interaction` stream event, and persists `generation_runs.status = "waiting"` plus the sanitized interaction in `events` (deduplicated by `interactionId`). New internal endpoint `POST /internal/runs/:id/respond` → `run.respond(interactionId, response)`; the API adds ownership-checked `POST /api/runs/:id/respond`. `active-run` returns waiting runs with their interaction; the console restores the pending card after refresh; answering resumes the stream; stop still cancels. Restart-safe: the durable store holds the continuation and the worker re-publishes the pending interaction idempotently.

**Tests & acceptance:** unit: interaction mapping, multi-select serialization, staged override, dynamic approval predicate; contract test for `assertAgentInteractionResponse` with custom answers; live: "make a 4-frame hop cycle" → plan → `present_plan` card → user edits scope → run edits exactly the confirmed frames → painting an unapproved frame triggers a second card.

## Phase 9 — Versioning (per frame, per asset)

**Goal:** every change is recoverable with context.

**Data model (migration 0006):** `versions` (`id`, `assetId`, `frameId` nullable, `scope: "frame" | "asset"`, `kind`, `author: "user" | "agent"`, `runId` nullable, `label` nullable, `snapshot` jsonb, `createdAt`).

**Creation & retention:** a version is written whenever a change is persisted (run terminal per touched frame; user flush; frame add/delete/move/rename; resize; palette; restore). Consecutive changes by the same author and kind on the same frame within 120 s coalesce. Keep the newest 200 per asset; unlabeled prune first. Restore writes the old snapshot as the new current state and records `kind: "restore"` (never destructive); blocked while a run is active (409).

**API & UI:** `GET /api/assets/:id/versions?scope=&frameId=&limit=&cursor=`; `PATCH …/:versionId` (label); `POST …/:versionId/restore`. UI: **History** panel in the right rail (sheet on narrow) built on Part I primitives — frame timeline with thumbnail, author badge (`You` / `Agent · muse-spark · xhigh`), relative time, label edit, restore with confirmation; asset tab aggregates frame entries by run plus asset-level kinds; selecting a version previews it with an onion diff overlay against the current frame. Thumbnails render client-side from the snapshot.

**Tests & acceptance:** store unit tests (coalescing, prune order, restore-as-new, run grouping); API paging; live: draw, run the agent, restore a pre-run version, confirm a new `restore` entry and the run link.

## Phase 10 — Drawing primitives & quality

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

**Critique expansion:** stray pixels; outline placement (internal outline, silhouette gaps); margins (art touching the canvas edge, empty border rows). Deterministic, each with unit tests; instructions keep "finish only when issues is empty".

**Tests & acceptance:** unit for each command and critique case; live: a 3-shade rock with `apply_outline` + `dither_rect`, critique clean.

## Phase 11 — Layers, workflow & infra

| Tool                | Contract                  | Command                            |
| ------------------- | ------------------------- | ---------------------------------- |
| `add_layer`         | `{ name? }` (≤4)          | existing `addLayer`                |
| `rename_layer`      | `{ layerId, name }`       | existing `renameLayer`             |
| `set_layer_visible` | `{ layerId, visible }`    | existing `setLayerVisible`         |
| `remove_layer`      | `{ layerId }` (≥1)        | existing `removeLayer`             |
| `think`             | Anvia `createThinkTool()` | scratchpad; console row `thinking` |

- **Run history in context:** the worker prompt gains the last 3 finished runs for the asset (prompt + answer, truncated to 200 chars) so follow-ups like "make it bigger" have context.
- **maxTurns:** raised from 24 to 40.
- **Evals:** deterministic cases for layer tools and `think`; judge copy updated for plan-first.

**Acceptance:** live: a two-layer build with visibility toggles; a follow-up edit resolves against the previous run's context.

## Phase 12 — Workspace agent & home composer

**Goal:** a composer on the home screen; the agent knows the user's projects and assets and can propose or create the right home for new work.

**Run scope:** `generation_threads` (migration 0007) gains nullable `projectId` and nullable `assetId` with a one-of constraint; `POST /api/runs` accepts `{ scope: "workspace", projectId?, prompt, modelId, reasoningEffort }`. The worker binds a workspace run with no asset; drawing tools fail with "Choose or create an asset first." until `use_asset` binds one.

| Tool            | Contract                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `list_projects` | → `[{ id, name, updatedAt, assetCount }]`                                |
| `list_assets`   | `{ projectId }` → `[{ id, name, width, height, frameCount, updatedAt }]` |
| `create_asset`  | `{ projectId, name, width, height, palette? }` → asset + bound           |
| `use_asset`     | `{ assetId }` → binds the run                                            |

Plan/question/approval tools work unchanged; `present_plan` covers "put this in project X, asset Y, 4 frames" proposals.

**UI:** home composer (same component, built on Part I primitives), runs stream into a console below it; on completion the console links to the touched asset; home shows recent runs. The interaction card works here too; previews appear once an asset is bound.

**Tests & acceptance:** API workspace run creation, thread constraint, ownership checks; live: from the home composer, "buat slime hijau 32px dengan 4 frame hop, taruh di project Pixelaition" → list projects → `present_plan` card → confirm → asset created, frames drawn, `check_animation` clean, console links to the new asset.

---

## Open questions & spikes

1. **Vision capability** (Phase 6 spike) — whether Muse Spark / DeepSeek accept images via OpenCode Go; result seeds `models.vision`.
2. **`assertAgentInteractionResponse` strictness** — behavior when a custom answer is sent for a question without `allowCustom`; the UI always sends valid values, but the contract test records the truth.
3. **Staged override persistence** — lives on `generation_runs.override` so a worker restart mid-waiting can still consume it; validated again at execute time.
4. **Filmstrip limits** — cap preview scale and total bytes (≤ 1 MB per image).
5. **Retention defaults** (Phase 9) — 200 versions/asset, 120 s coalescing; revisit in use.
6. **Micro-label face** (Phase 5) — Silkscreen 16px vs Pixelify 12px; decided with a side-by-side screenshot review.
7. **Departure Mono vendoring** — license file checked in; confirm the woff2 subset covers digits, punctuation, and the latin strings the console prints.

## References

- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://sketch-agent.csail.mit.edu
- https://ljvmiranda921.github.io/notebook/2025/07/20/draw-me-a-swordsman
- https://github.com/willibrandon/pixel-mcp
- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://docs.ag-ui.com/concepts/interrupts
- https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
- https://departuremono.com · https://fonts.google.com/specimen/Pixelify+Sans · https://github.com/nostalgic-css/NES.css · https://jdan.github.io/98.css · https://github.com/matt-auckland/retro-css · https://help.play.date/developer/designing-for-playdate · https://pixelarticons.com
- Anvia v1 declarations in-repo: `@anvia/core` `createQuestionTool` / `requiresApproval` / `AgentInteractionRequest`; `@anvia/durable` `DurableRun.respond` / `snapshot.run.outcome.interaction` / status `waiting`.

# Agents

Pixelaition is a pnpm workspace. Pixel mutations go through `applyCommand` in `@pixelaition/pixel`. The web app, API, worker, and MCP server do not invent a second pixel format.

## Commands

```powershell
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
pnpm db:migrate
```

`pnpm dev` expects the root `.env`. Do not add a `.env` inside a package.

## Boundaries

- Provider keys, Better Auth secrets, and the worker token stay on the server. Nothing secret uses a `VITE_` prefix.
- Two providers, two env groups: `AGENT_BASE_URL` + `AGENT_API_KEY` serve the agentic models (OpenRouter, whose model slugs carry the org prefix; pointed at OpenCode Go instead, the worker sends that service's stable `x-opencode-session` header, and no other endpoint gets extra headers), and `DECISION_MODEL_BASE_URL` + `DECISION_MODEL_API_KEY` + `DECISION_MODEL` serve Jev. Env keys name the role, never the provider, so either side can move with a `.env` change.
- Anvia agents are constructed with `new Agent`. Do not use the v0 builder API.
- The drawing agent may change a canvas only through its tools. Tool handlers reject colors and coordinates the document refuses. Layer tools take a layer id or its name, so the model can paint on the names it reads.
- Every drawing run is one durable `asset-draw` task: Jev sets the shape (workers 1-4, whether a review round is worth it), a supervisor child plans and the plan card is approved, up to four worker children paint their own frames in parallel behind an `allSettled` join, and a review child (continuing the plan's conversation) reads every frame, answers with a typed verdict — `{ done, summary, fixes[] }` — and decides when the work is finished: there is no round cap in code, and a review's fixes may name the layers to touch (a fix writes only those) and a reference frame to copy from. Ask runs stay single read-only runs.
- One agent per model, effort and role (supervisor: plan/review/fix, whose children continue each other's conversation; painter: workers; ask) — `continueFrom` never crosses agents, so roles that continue each other share one. The role gate in the tool layer stays as a second wall and names its cause. Workers and fix children paint, then stop; they do not move or redraw finished pixels to chase a critique, and a fix writes only on the layers its review order named.
- Workers write only their owned frames; the plan's palette additions happen before the parallel phase, and the supervisor's search references ride into each worker's `view_image` allow-list.
- Every editing role carries the whole editor catalog; ownership and the approved plan—not a missing tool—decide what a role should call. A role gate still names the cause when a write targets a frame outside its assignment. Frames of every asset in the same project are readable through `list_project_frames` / `read_frame(assetId)` / `read_palette`; pixels move with `copy_region`, `paste_region`, `mirror_region`, `repeat_region` and `copy_layers`, which carry RGBA colours unchanged and never guess a colour. `check_animation` measures the unchanged body against a reference frame, not just consecutive frames, so a frame that redrew a shared part is flagged and a turning flame is not.
- Long sessions (many review rounds) are bounded by Anvia's durable compaction against the model's declared window, not by cutting prompts or fields: no prose field carries a length cap.
- One task per asset thread: a second drawing request answers `RUN_IN_PROGRESS` (guarded in the API and again in the worker before submission).
- The editor shows per-frame task state (colour, shape, and label; whole-pixel `steps()` animation that `prefers-reduced-motion` turns off), streams the task tree into the console, feeds each frame's canvas from its own worker's stream, and anchors a message to the frame in view through the composer's frame-context toggle.
- Steering while workers run is routed by Jev (target worker and frame, with a confidence threshold); below it the user picks the frame and the answer re-sends the message anchored. A worker's `ask_user` surfaces as a per-frame badge, a waiting counter, and the question card when its frame is open.
- Every agentic case is read back from its Langfuse trace (`tools/trace-check.mjs`; use `--run <durableRunId>` for a single compose/ask run); a case without a readable trace is not a passed case.
- The drawing agent decides the artwork's own structure: a request that describes the subject acting means key frames, named parts (a sword, a glow, a shadow, wings, leaves) mean layers, and a real species or character means a web_search reference to look at before painting. The user never has to name frames, layers, or searches.
- Destructive frame tools (`replace_color`, `delete_frame`, `resize_canvas`) pass a Jev request check before they run: a call that cannot touch a painted pixel runs without a request, a clearly supported or unclear one proceeds to the editor tool, and only a clearly unsupported one is refused to the model; editor-tool calls never pause for a human card. The check reads the run's recorded user request; a missing key or an unreachable provider fails with a named cause.
- Every prompt passes the Jev guardrail before a run exists, and every closing message is screened before it is stored: one request per message with hazard Nouls plus a severity Score, and the pass/review/block thresholds in code. A blocked or unscreenable message is withheld, and the reason names the hazard.
- Jev picks the run's mode from the whole context, never a user-facing toggle: the decision reads the thread's recent exchanges plus the project, asset, frames, current frame, and attached references, and chooses between a drawing run and an asking-only run. An ask runs the same model with read-only tools and answers in the console; a vague or conversational prompt is a turn, never a 422.
- Entity summaries are generated by the worker (`frames` from a rendered PNG by the vision model, `assets`/`projects` from the cheap chat model), stored on the rows, and read-only. They ride every decision and run prompt: `Project:`/`Asset:`/`Frame summary:` lines, `read_project`/`read_frame` outputs, and `list_projects`/`list_assets` rows. A missing or failed summary is an absent line, never a guess, and never blocks a run.
- Home runs are proposal-first: `POST /api/home/runs` spends the guardrail and Jev once, stores a `run_proposals` row, and starts nothing; a second call with the proposal id and an explicit confirm starts the run and seeds the stored Jev spend into its usage. The confirmation card always appears, even at high confidence, and can defer the asset to the agent ("Let the agent choose").
- The agent asks for a missing target with `ask_user` (the Anvia question tool): question ids `project`, `asset`, `project_name`, `asset_name` render as live dropdowns and text fields fed by the app's own entities — the model's choice values are never trusted for target ids. A project always exists before a workspace thread (the thread constraint), so `projectId: "new"` needs its name at confirm time. More than 50 projects fails the home decision with `PROJECT_LIMIT_FOR_DECISION` and the card falls back to "Let the agent choose".
- Web search is Tavily behind `TAVILY_API_KEY`; without the key the agent has no search tools. `view_image` may only fetch https URLs a `web_search` in this run returned (or a reference the plan already allowed), private hosts and redirects to them are refused. A vision model receives the bytes as a file part. A model that cannot see receives a description from the summary-vision model. A missing vision model fails with that cause. The agent never claims to have seen an image the tool did not return. `list_projects` and `list_assets` work on asset runs and workspace runs; both query by the run owner's id.
- User reference images ride with the message as base64 media parts: the browser downscales each to 512px and the API caps them (4 images, ~1.5 MB each), the durable runtime persists them for restart and retry, and the run prompt counts them so the model looks. The Jev text guardrail screens the message text; attached pixels are the user's own references.
- A live run accepts steering: `POST /api/runs/:id/steer` takes a batch of follow-ups and delivers them **one message per turn, FIFO** (the worker serializes delivery: the next message is submitted only after the previous is applied), and the console shows queued and applied rows. The composer queues instead of blocking while a run is live — empty input shows Stop, typed text shows Add to queue, the dock reorders with drag and drop, Send now steers the whole queue, and when a run finishes the next queued prompt starts itself, one run at a time.
- Every run accounts for its own usage: model token counts and the provider's raw cost plus Jev tokens and cost stream to the console as `usage` events and persist on the run row. Each model's `context_window` feeds Anvia's `contextLimits`, so every response carries `contextUsage` (used/remaining tokens and percent against the window) and the newest one rides the usage payload. The console header is two fixed lines — the state with the whole asset conversation's total elapsed and cost, then the rectangular context bar with its percent and used/window numbers (no "context" label: the numbers are the dotted underline and the whole bar group is the token popover's trigger) and the composer's selected model beneath the time and cost — never a one-liner that wraps unpredictably, and its live contribution holds until the session aggregate has folded a finished turn in, so the totals never dip. The bar is scaled to the selected model's catalog window (the same used-token count rescaled when the composer switches models), its ten hard cells fill left to right and dither from `accent` toward `erase` as the window fills, so a nearly full window reads as danger before it overflows; no off-palette tint, ever. The asset conversation's settled spend (`GET /api/assets/:id/session`, also on `active-run`) sums every finished task and parentless run, and names the newest generation's model with its catalog window as the fallback when no model is selected. Phase progress (`reviewing 2/4`) shows only while a run is live, "AGENT" is not a label, and the line never guesses a percentage: before the first snapshot it reads `0% · 0 / 1M`, and a model without a declared window stays `0 / —`.
- Each turn's meta sits under the user's message: send time, the model's `display_name` with its effort, the turn's cost, and its total tokens — cached input never prints on the line. Hovering or focusing the total opens the exact input/cached/output breakdown in a pixel popover, and the header's context row opens the same detail for the whole conversation; hovering the header's model name opens a popover with its full display name, never the provider slug. The raw usage log row is not printed at all, and the agent's reply is its own bordered card apart from tool rows and thinking notes with no usage line of its own; a streamed answer that equals the run's closing message shows once, never twice. Those totals are additive; the context bar is not, because one generation's window snapshot already contains the whole conversation it read.
- The console behaves like a chat transcript: its first expand lands on the newest line, and a later expand returns to the bottom when the reader was following the stream or to the position they left when they had scrolled up.
- `@anvia/durable` runs in `apps/worker` only, against one SQLite file.
- The approved frame scope is persisted on the run row and restored on recovery, and approving a call approves its frame: a restart never re-asks for scope the user already granted. Boot binds recovered runs before `runtime.resume()` pumps them, so a resumed tool call always finds its binding.
- A Durable submission carries no model controls. Models, their reasoning efforts, and their output budget live in the `models` table, seeded by migrations, and the worker sends that budget as `max_output_tokens` (the provider charges a request's declared budget against its output-token limit, so an unset cap means the model maximum and a quick 429). Reasoning effort is set by registering one agent per model and effort and choosing the `agentId`, never by writing the effort into the prompt.
- When the app cannot do something for real — a missing key, an unknown model or effort, an unreachable provider — it fails with an error naming the cause. Deterministic fallbacks and silent substitutions are forbidden; a bounded retry of the same request (429/5xx with SDK backoff) is not a substitution.
- Langfuse is optional. When it is configured, run traces travel over the OTLP endpoint with user, session, tags, and metadata attached; trace payloads are size-capped and provider keys never travel through telemetry. Jev calls (decision, request check, guardrail) land on the same traces as generations with their USD cost in `cost_details`.
- Canvas drawing lives in `apps/web/src/components/pixel-canvas.tsx`. The frame is drawn as a scaled bitmap; do not go back to one `fillRect` per cell. The transparency checker is baked into that bitmap in whole document pixels, never drawn in screen space.
- While a run is active for an asset, the editor never writes the frame back; strokes come from the agent's tool calls as they happen. The canvas is a live feed, not a replay.
- The home and the editor move between each other with typed View Transitions (`viewTransition: { types: ["editor"] }`): the dock, console, and target card carry `data-flight` names that morph into the editor's canvas (`asset-flight`), console (`console-flight`), and composer (`composer-flight`). The bar is one element across both screens (`bar-flight`), and its pieces travel separately so the move reads as a morph rather than a swap: the account chip (`bar-account`) leaves to the right, the editor's breadcrumb (`bar-context`) and action cluster (`bar-actions`) arrive after it, and the wordmark (`brand-flight`, named only at ≥640px so the editor's hidden label is never squashed) glides between the two bar positions while the bar's surface cross-fades from the home's floating paper to the editor's `panel`. Opening a library card is the `editor-card` type instead: the card itself is the flying element and its chrome waits behind it. Going back is the `editor-back` type and the artwork itself shrinks into its thumbnail in the home's grid: a transparent copy of the painted pixels (`lib/sprite-flight.ts`) is laid over the canvas and named `asset-flight`, the frame's own name is switched off for that move, and the returning card's thumbnail canvas carries the same name **during render** on the new side — an effect that runs after the paint would leave the new snapshot without a counterpart and the sprite would simply vanish. No panel, checker, or border travels with it. The home brings that card into view in a layout effect (so the snapshot already has it on screen, and the back navigation passes `resetScroll: false`), is at full strength from the first frame, and dissolves the editor's chrome over the flight; the name is dropped after the flight so the next card click cannot leave two elements with one name. Signing in is the `auth-in` type and signing out is `auth-out`: the signed-out brand is the same shared element as the home's (`brand-flight`), so it scales and travels from the auth slide into the bar — and back out on sign-out — while the bar (`bar-flight`) and the library (`library-flight`) rise as whole blocks from their own rendered size. The named box is what the browser scales, so the auth wordmark sits in a `self-start` wrapper: a column flex item stretches to the column's width by default, and that stretched box would drag the glyphs sideways through the morph. `prefers-reduced-motion` drops the name in CSS, so the brand dissolves with its page instead of scaling. Sign-out is an in-app move now, not a reload — the session ends, the home flies out, and the query cache is cleared afterwards. `prefers-reduced-motion` disables the morphs and turns the move into one dissolve; a browser without the API navigates plainly (the door still rides the history state), and the home's docked composer is the same component the editor renders.
- Interface colours come from the Atelier ramp through the tokens in `DESIGN.md`. Do not introduce a colour outside that table, and never use `faint` for copy.
- Interface type comes from the pixel scale in `apps/web/src/styles.css` (`text-pixel-hero/display/title/label/body/mono`, each face on its design grid); pixel craft comes from the utilities there (`pixel-corners`, `pixel-window`, `bevel`, `shadow-pixel-*`, `pixel-grid`, `dither-*`). Components use both instead of hand-rolling sizes, radii, or soft shadows.
- Commit messages follow Conventional Commits.

- One asset is one image document. Every frame shares the editor's rail, canvas
  shell, view controls, composer and export; the internal `frames.kind` values
  `sprite` and `social` are storage details, never product language. A
  pixel-backed frame holds true-RGBA layers at the asset canvas; an
  output-size frame holds a scene graph of packed RGBA colours at its size
  preset and shares the asset swatches and copy deck. A pixel colour is never an index into that swatch
  list, so changing or dropping a swatch never rewrites pixels.
- `packages/artboard` is shared by the web, API, worker and MCP; do not fork the
  renderer or the preset registry. An output-size frame's dimensions, safe
  zones, crops, exclusions, minimum text size and byte budget come from
  `packages/artboard/src/presets.ts`. A check error is a real geometry failure,
  never a warning to wave through.
- Jev chooses the mode from the prompt: an edit on an output-size frame becomes
  a compose run, and a question stays an ask run with the artboard read tools
  (`list_formats`, `read_set`, `read_artboard`, `check_artboard`,
  `list_project_sprites`) bound to the asset.
- The layout agent is one compose run per asset, bound to the asset's
  output-size frames and the project's pixel frames; it plans through
  `present_artboard_plan`, writes only after approval, saves each frame with
  optimistic versioning, and leaves a version snapshot. Boot recovery re-binds
  the asset and artboard tools from `generation_runs.mode`.
- An output-size frame is created with `POST /api/assets/:id/frames`
  (`kind: social` internally), edited through its scene route, and exported at
  native size. `GET /api/projects/:id/resources` is the project-wide read:
  assets, pixel frames, output-size frames, palettes and dimensions. Cross-asset
  reuse is explicit: image elements name `assetId/frameId`; frame import carries
  RGBA colours unchanged; palette import updates swatches and remaps artboard
  scenes only; background import copies one frame's backdrop.
- Output-size frames are not extra pixel canvases: their `layers` are `[]`, and
  every pixel-only helper (`frameToBuffer`, version preview, pixel PUT) must
  filter `kind !== "social"` or refuse it with a named cause.
- The migration from `artboard_sets`/`artboards` is one-way and idempotent:
  `0027_mixed_asset_frames` moves rows into `frames` and copies the latest copy
  deck onto the asset. Legacy tables stay read-only for old URLs until removal.

## Packages

| Path                | Role                                        |
| ------------------- | ------------------------------------------- |
| `packages/pixel`    | Document, commands, camera, critique        |
| `packages/artboard` | Native-size scene renderer, presets, checks |
| `packages/export`   | `.pxl`, PNG, JPG, SVG, ZIP                  |
| `packages/agent`    | Tools, decisions, instructions, evals       |
| `packages/db`       | Drizzle schema                              |
| `apps/web`          | Editor                                      |
| `apps/api`          | Auth, CRUD, export, run proxy               |
| `apps/worker`       | Durable runtime                             |
| `apps/mcp`          | Stdio MCP                                   |

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

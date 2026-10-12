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
- Anvia agents are constructed with `new Agent`. Do not use the v0 builder API.
- The drawing agent may change a canvas only through its tools. Tool handlers reject colors and coordinates the document refuses.
- Destructive frame tools (`clear_region`, `replace_color`, `set_palette`, `remove_layer`, `delete_frame`, `resize_canvas`) pass a Jev request check before they run: a call that cannot touch a painted pixel runs without a request, a clearly supported one proceeds, a clearly unsupported one is refused to the model, and an unclear one pauses through the normal durable approval. The check reads the run's recorded user request; a missing key or an unreachable provider fails with a named cause.
- Every prompt passes the Jev guardrail before a run exists, and every closing message is screened before it is stored: one request per message with hazard Nouls plus a severity Score, and the pass/review/block thresholds in code. A blocked or unscreenable message is withheld, and the reason names the hazard.
- `@anvia/durable` runs in `apps/worker` only, against one SQLite file.
- The approved frame scope is persisted on the run row and restored on recovery, and approving a call approves its frame: a restart never re-asks for scope the user already granted. Boot binds recovered runs before `runtime.resume()` pumps them, so a resumed tool call always finds its binding.
- A Durable submission carries no model controls. Models and their reasoning efforts live in the `models` table, seeded by migrations. Reasoning effort is set by registering one agent per model and effort and choosing the `agentId`, never by writing the effort into the prompt.
- When the app cannot do something for real — a missing key, an unknown model or effort, an unreachable provider — it fails with an error naming the cause. Deterministic fallbacks and silent substitutions are forbidden; a bounded retry of the same request (429/5xx with SDK backoff) is not a substitution.
- Langfuse is optional. When it is configured, run traces travel over the OTLP endpoint with user, session, tags, and metadata attached; trace payloads are size-capped and provider keys never travel through telemetry. Jev calls (decision, request check, guardrail) land on the same traces as generations with their USD cost in `cost_details`.
- Canvas drawing lives in `apps/web/src/components/pixel-canvas.tsx`. The frame is drawn as a scaled bitmap; do not go back to one `fillRect` per cell. The transparency checker is baked into that bitmap in whole document pixels, never drawn in screen space.
- While a run is active for an asset, the editor never writes the frame back; strokes come from the agent's tool calls as they happen. The canvas is a live feed, not a replay.
- Interface colours come from Sweetie 16 through the tokens in `DESIGN.md`. Do not introduce a colour outside that table, and never use `faint` for copy.
- Interface type comes from the pixel scale in `apps/web/src/styles.css` (`text-pixel-hero/display/title/label/body/mono`, each face on its design grid); pixel craft comes from the utilities there (`pixel-corners`, `pixel-window`, `bevel`, `shadow-pixel-*`, `pixel-grid`, `dither-*`). Components use both instead of hand-rolling sizes, radii, or soft shadows.
- Commit messages follow Conventional Commits.

## Packages

| Path              | Role                                  |
| ----------------- | ------------------------------------- |
| `packages/pixel`  | Document, commands, camera, critique  |
| `packages/export` | `.pxl`, PNG, JPG, SVG, ZIP            |
| `packages/agent`  | Tools, decisions, instructions, evals |
| `packages/db`     | Drizzle schema                        |
| `apps/web`        | Editor                                |
| `apps/api`        | Auth, CRUD, export, run proxy         |
| `apps/worker`     | Durable runtime                       |
| `apps/mcp`        | Stdio MCP                             |

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

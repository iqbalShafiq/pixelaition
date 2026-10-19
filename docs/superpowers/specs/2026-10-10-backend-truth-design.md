# Backend Truth — Design

**Status:** Approved for planning
**Date:** 2026-10-10
**Scope:** Sub-project A of the OpenCode Go / realtime drawing effort. Sub-project B (editor UX) has its own spec.

## Goal

Make the database the single source of truth for the drawing models and their reasoning efforts, remove every deterministic fallback that guesses on the user's behalf, and make Langfuse tracing correct enough to debug real runs.

## Non-goals

- No admin UI for editing models. The catalog changes only through versioned migrations.
- No per-user or per-project model catalogs.
- No prompt management migration to Langfuse.
- The OpenCode Go session-header fix and `maxTurns: 24` already landed and stay as-is.

## 1. Models live in Postgres

### Schema — `models`

| Column       | Type                                | Notes                                                      |
| ------------ | ----------------------------------- | ---------------------------------------------------------- |
| `id`         | text, primary key                   | The provider model id, e.g. `muse-spark-1.3-contributor`   |
| `api`        | text, not null                      | `chat` or `responses` — which endpoint family serves it    |
| `efforts`    | jsonb, not null                     | Ordered array of effort names, e.g. `["low","high","max"]` |
| `position`   | integer, not null                   | Composer order                                             |
| `enabled`    | boolean, not null default true      | Hides a model without deleting its history                 |
| `created_at` | timestamptz, not null default now() |                                                            |
| `updated_at` | timestamptz, not null default now() |                                                            |

### Seed

Seeded by a Drizzle migration (SQL, versioned in `packages/db/drizzle/`). Seed rows:

| id                           | api         | efforts                                     | position |
| ---------------------------- | ----------- | ------------------------------------------- | -------- |
| `deepseek-v4.1-flash`        | `chat`      | `["low","high","max"]`                      | 0        |
| `muse-spark-1.3-contributor` | `responses` | `["minimal","low","medium","high","xhigh"]` | 1        |

These effort sets come from the OpenCode model catalog, verified against the provider's published metadata.

### Worker

- Reads enabled models from the database at boot, ordered by `position`.
- Registers one Durable agent per model × effort, id `pixel-draw:<modelId>:<effort>` — the existing pattern, now driven by the table.
- `/internal/runs` selects the agent by exact `(modelId, effort)` match. Unknown pairs return **422** with the message naming the unknown value. No remapping to the first model.
- Empty table = zero agents; `/internal/agents` reports an empty catalog; generate returns the existing 503.
- `OPENAI_MODELS` env parsing (`parseModelSpecs`), the generic-effort fallback (`effortsFor`), the api-family heuristic (`defaultApiFor`), and `selectRunTarget`'s remap are deleted. `openCodeGoHeaders` stays.

### API

- `GET /api/models` reads the database (`id`, `efforts`, ordered, enabled only). It never fetches the provider's `/models` list and never invents a fallback row. `reasoningEfforts` stays gone.
- `POST /api/runs` validates `modelId` + `reasoningEffort` against the table; unknown pairs return **422** with a specific message. The run row stores what was validated, not what was requested.

### Env

- `OPENAI_MODELS` and `OPENAI_MODEL` are removed from all code, docs, and the local `.env` (targeted line deletion, no file dump).
- `DECISION_MODEL` (or `TYPESAFE_API_KEY`) is required for generating. `EVAL_MODEL` is required for `pnpm eval:judge`; the `EVAL_MODEL || OPENAI_MODEL || "gpt-4.1-mini"` chain is removed.

## 2. No deterministic fallbacks

The rule: when the system cannot do something for real, it says so. It never silently substitutes a guess.

Removals, exactly:

| Where                               | Removed behavior                                                                                                                              | Replacement                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/src/decide.ts`      | regex `decideFromPrompt`, vague-prompt heuristics, early returns, catch-and-accept                                                            | Decision always comes from a real model (Jev or `DECISION_MODEL`). No decision model configured → API returns 503 naming the missing config. Provider failure → **502** with the provider error; the run is not started. |
| `packages/agent/src/models.ts`      | `parseModelSpecs`, `effortsFor` generic fallback, `defaultApiFor` heuristic, `selectRunTarget` remap                                          | Deleted with their tests; replaced by DB-backed catalog mapping with exact-match selection.                                                                                                                              |
| `apps/api`                          | provider `/models` fetch + `OPENAI_MODEL` fallback row; worker-catalog fallback chain                                                         | DB only. Worker unreachable → the catalog comes from the DB read; no guessing.                                                                                                                                           |
| `apps/worker`                       | `OPENAI_MODEL` fallback spec; `specs = parsedSpecs.length > 0 ? parsedSpecs : [{id: fallbackModelId}]`                                        | DB only.                                                                                                                                                                                                                 |
| `apps/web` composer                 | generic effort list `["none","low","medium","high"]` when the model declares none; model-reset-to-first when the stored preference is unknown | No invented options: empty effort list disables Generate. Stored preference unknown → clear selection; the composer shows an explicit "pick a model" state.                                                              |
| `packages/agent/src/evals/judge.ts` | `EVAL_MODEL \|\| OPENAI_MODEL \|\| "gpt-4.1-mini"`                                                                                            | `EVAL_MODEL` required; missing → clear error before any provider call.                                                                                                                                                   |

`decide.ts` keeps exactly one behavior: call the configured decision model, return its classification, propagate failures as errors.

## 3. Langfuse tracing (per the official Langfuse skill)

Current state: the worker has an optional `@anvia/langfuse` observer with `redactInputs: true`, attached to every agent. Baseline audit against the Langfuse best-practices page, then fill the gaps:

- **Run attribution:** each drawing trace carries `name` (`pixel-draw:<modelId>:<effort>`), `user_id` (the Pixelaition user), `session_id` (the asset thread id), `tags` (`pixelaition`, `draw`), and metadata (`assetId`, `frameId`, `modelId`, `effort`). The exact wiring path (agent run settings vs durable submission options) is resolved by reading the installed `@anvia/core` / `@anvia/durable` types during planning; nothing is smuggled through the prompt.
- **Decision traces:** the prompt decision call is traced too, tagged `pixelaition`, `decide`, with the same user/session attribution.
- **Baseline requirements** verified on the real trace: model name, token usage, descriptive names, span hierarchy, observation types, redaction, trace input/output limited to the user prompt — not raw tool args.
- **Flush per run** on completion/failure so traces are not lost on worker restarts.
- **Verification loop (required):** run a real Muse draw, fetch the trace with `langfuse-cli` (credentials injected via `dotenv -e .env`, never printed), audit it against the freshly fetched best-practices doc, fix gaps, repeat until clean. Report the final trace id.

## 4. Testing

- TDD for the new pure units: DB-row → catalog mapping (`packages/agent`), run-target validation exact-match, decision contract (no-fallback cases: missing model, provider error → error, never silent success).
- The deleted fallback tests are deleted, not adapted.
- Integration probes: worker `/internal/agents` with the seeded DB reports exactly 2 models and 8 agent ids; `POST /api/runs` with an unknown pair returns 422; a real Muse run completes and persists pixels; trace fetched and audited.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## 5. Review focus

- Migration applies cleanly on a database that already has runs referencing old model ids (no FK breakage; `generation_runs.model_id` stays free text).
- Empty/disabled-everything catalog: UI and API stay coherent and loud.
- `DECISION_MODEL=muse-spark-1.3-contributor` works through the decision client's api family (responses). If the decision client cannot speak responses, the API must fail loudly and the fix belongs in the decision client wiring — not in a fallback.
- No secret ever reaches logs, traces, or error messages.

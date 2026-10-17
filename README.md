# Pixelaition

Pixelaition is a pixel-asset studio. You draw on a canvas, or describe a sprite and watch the pixels appear while the agent works. A project keeps one palette and one style guide so the assets inside it stay related. A finished asset can grow new states, such as another facing or another action, from a frame that already exists.

## Stack

TypeScript, React, Vite, TanStack Router, TanStack Query, Tailwind CSS 4, Motion, Express, Drizzle, PostgreSQL, Better Auth, and Anvia. Generation runs in a separate worker on `@anvia/durable`, so closing the tab does not stop a drawing. `@anvia/langfuse` records reasoning, tool calls, and messages when its keys are set. `@anvia/core/evals` scores the agent.

## Run it

Node.js 22.16 or newer, pnpm 10, and Docker.

```powershell
copy .env.example .env
docker compose up --build
```

Open `http://localhost:3000`, create an account, and start a project.

For day-to-day development, keep Postgres in Docker and run the apps on the host:

```powershell
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev
```

The web app is on port 3000 and proxies `/api` to port 3001. The worker listens on port 4002. One `.env` at the repository root feeds every package through `dotenv-cli`.

Set `AGENT_BASE_URL` to an OpenAI-compatible endpoint that serves the drawing models (OpenRouter is `https://openrouter.ai/api/v1`) and `AGENT_API_KEY` to its key. The drawing models and their reasoning-effort options live in the `models` table, seeded by migrations, and the composer reads them from there; the seed is also the catalog, so a model that leaves the seed is deleted by the next migration. Jev, the decision model, is configured by `DECISION_MODEL`, `DECISION_MODEL_BASE_URL`, and `DECISION_MODEL_API_KEY`; it is required before a run will start, decides between drawing and answering-only, and is a real model call, never a local heuristic. Manual editing works without any of them, and `pnpm eval:judge` requires `EVAL_MODEL`.

The home screen is a workspace: it generates a short summary for every project, asset, and frame in the background, Jev picks a target from those summaries, and a confirmation card appears before any run exists — confirm to start (the run then assembles into the editor with a view transition), or let the running agent ask instead. The same composer component docks at the bottom of both screens.

`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` turn tracing on. Leave them empty to run without telemetry. For a local Langfuse, use its official Compose file and point `LANGFUSE_BASE_URL` at that UI.

## Editor

Three columns on a wide screen. The left column holds frames and layers, the middle is the canvas, and the right holds the palette and the canvas size. Below 1100px the side columns hide and the canvas plus the composer stay.

The toolbar holds the tools, the brush size, the zoom controls, and the grid, checker, and onion-skin switches.

| Key | Tool      | Key | Tool       |
| --- | --------- | --- | ---------- |
| `V` | Select    | `G` | Fill       |
| `B` | Pencil    | `I` | Eyedropper |
| `E` | Eraser    | `L` | Line       |
| `R` | Rectangle | `H` | Pan        |

Pan with `H`, the space bar, or the middle button of a drag. `[` and `]` change the brush size. `Escape` drops the selection. Ctrl or Cmd+Z undoes, Ctrl or Cmd+Shift+Z redoes, Ctrl or Cmd+0 fits, and Ctrl or Cmd+1 shows the sprite at one to one. The wheel zooms toward the cursor.

Frames get added, duplicated, renamed, and deleted from the left column, and the play button steps through them. Onion skin draws the neighbouring frames underneath the one you are editing, at display opacity only. A frame keeps up to four layers.

Drawing is saved 500ms after you stop. Generate streams activity as the worker thinks and paints. Refreshing the page reloads the pixels already stored and can reconnect to the event stream.

## Export

The Export dialog picks a scope of one frame, one asset, or the whole project, then PNG, JPG, SVG, ZIP, or `.pxl`. `.pxl` covers a whole project. More than one file is zipped. Scale runs 1, 2, 4, 8, or 10.

The same work is available over HTTP as `POST /api/export`:

```json
{
  "scope": "asset",
  "projectId": "…",
  "assetId": "…",
  "format": "png",
  "scale": 4
}
```

`.pxl` is JSON:

```json
{ "format": "pixelaition", "version": 1 }
```

Sizes run from 8 to 128. Index 0 in the palette is transparent `#00000000`.

## MCP

`apps/mcp` speaks stdio and calls the API with a personal access token. Create one with `POST /api/api-keys` while signed in. The token is shown once.

```json
{
  "mcpServers": {
    "pixelaition": {
      "command": "pnpm",
      "args": ["--filter", "@pixelaition/mcp", "start"],
      "env": {
        "PIXELAITION_API_URL": "http://localhost:3001",
        "PIXELAITION_API_TOKEN": "pxl_..."
      }
    }
  }
}
```

Tools: `list_projects`, `create_project`, `get_project`, `list_assets`, `get_asset`, `create_asset`, `get_frame`, `paint_pixels`, `set_palette`, `create_frame`, `duplicate_frame`, `export_asset`, `export_project`.

`get_frame` returns the frame as rows of palette indexes, with `0` meaning transparent. `paint_pixels` takes palette indexes rather than hex and returns what the server actually committed. Writes go through the same `applyCommand` the editor uses, so a bad coordinate or an index outside the palette is refused instead of stored. `export_asset` returns image content, and zips the result when the asset has more than one frame.

## Checks

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
```

`pnpm eval:judge` calls the model-judged metrics (`faithfulness`, `answerRelevancy`, `promptAlignment`, `abstention`, `llmScore`) and needs `AGENT_API_KEY`: the judge runs on the agent provider.

## Layout

`packages/pixel` is the document and the edit commands. `packages/export` writes files. `packages/agent` holds tools, the pixel skill, and evals. `packages/db` is Drizzle. `apps/web`, `apps/api`, `apps/worker`, and `apps/mcp` are the processes.

Inside `apps/web`, `src/components/ui.tsx` holds the shared controls, `src/components/pixel-canvas.tsx` owns all canvas drawing, and the panels, composer, and export dialog live beside them. Screens do not restyle controls themselves.

The worker is the only owner of the Durable SQLite file. Do not run more than one worker replica. It registers one agent per model and reasoning effort from the `models` table, because a Durable submission carries no model controls.

## License

MIT

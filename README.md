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

Set `OPENAI_BASE_URL` to an OpenAI-compatible endpoint. The sample points at OpenRouter. `OPENAI_API_KEY` and `OPENAI_MODEL` are required before Generate will draw. Manual editing works without them. `TYPESAFE_API_KEY` turns semantic routing over to Jev. Without it, a local prompt check asks for a subject when the request is too vague.

`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` turn tracing on. Leave them empty to run without telemetry. For a local Langfuse, use its official Compose file and point `LANGFUSE_BASE_URL` at that UI.

## Editor

The canvas uses integer zoom steps and pans with `H`, the space bar, or the middle path of a drag while Pan is selected. `B` draws, `E` erases, `G` fills. Ctrl or Cmd+Z undoes. Ctrl or Cmd+0 fits the sprite. The model and reasoning effort you pick are saved on your account.

Generate streams activity as the worker thinks and paints. Refreshing the page reloads the pixels already stored and can reconnect to the event stream.

## Export

`POST /api/export` writes `.pxl`, PNG, JPG, or SVG. More than one file is zipped. `.pxl` is JSON:

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

Tools include `list_projects`, `create_project`, `create_asset`, `get_asset`, and `export_project`.

## Checks

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm eval
```

`pnpm eval:judge` calls the model-judged metrics (`faithfulness`, `answerRelevancy`, `promptAlignment`, `abstention`, `llmScore`) and needs `OPENAI_API_KEY`.

## Layout

`packages/pixel` is the document and the edit commands. `packages/export` writes files. `packages/agent` holds tools, the pixel skill, and evals. `packages/db` is Drizzle. `apps/web`, `apps/api`, `apps/worker`, and `apps/mcp` are the processes.

The worker is the only owner of the Durable SQLite file. Do not run more than one worker replica.

## License

MIT

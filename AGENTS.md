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
- `@anvia/durable` runs in `apps/worker` only, against one SQLite file.
- Langfuse is optional. When it is configured, capture reasoning, tool arguments, and messages, and redact secrets.
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

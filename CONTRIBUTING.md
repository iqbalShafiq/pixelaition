# Contributing

Use Node.js 22.16 or newer and pnpm 10.

1. Copy `.env.example` to `.env`.
2. `docker compose up -d db`
3. `pnpm install`
4. `pnpm db:migrate`
5. `pnpm dev`

Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before opening a pull request. Commit messages use [Conventional Commits](https://www.conventionalcommits.org/).

Pixel behavior belongs in `packages/pixel` with a Vitest check. Do not duplicate coordinate or palette rules in the React editor.

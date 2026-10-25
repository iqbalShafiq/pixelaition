import { defineConfig } from "@playwright/test";

/**
 * E2E runs against the real web, API, and worker. The database must already be
 * migrated (`pnpm db:migrate`); each spec creates its own user and project.
 * Agent cases use Muse Spark explicitly and never fall back to another model.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @pixelaition/api dev",
      url: "http://127.0.0.1:3001/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @pixelaition/worker dev",
      url: "http://127.0.0.1:4002/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DURABLE_DATABASE_PATH: "./data/e2e-runs.sqlite",
      },
    },
    {
      command: "pnpm --filter @pixelaition/web dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

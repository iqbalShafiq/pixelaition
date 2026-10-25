import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("imports an Aseprite file through the frame panel", async ({ page }) => {
  const email = `ase-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Aseprite E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", { data: { name: "ase e2e" } });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "ase" },
  });
  const assetBody = (await asset.json()) as {
    id: string;
    frames: Array<{ id: string }>;
  };
  const file = readFileSync(new URL("./fixtures/two-frame.ase", import.meta.url));

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.locator('input[type="file"][accept*=".ase"]').setInputFiles({
    name: "sprite.ase",
    mimeType: "image/x-aseprite",
    buffer: file,
  });
  await expect(page.getByRole("heading", { name: "Aseprite imported" })).toBeVisible();
  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ id: string; width?: number }>;
  };
  const before = new Set(assetBody.frames.map((frame) => frame.id));
  const imported = body.frames.filter((frame) => !before.has(frame.id));
  expect(imported.length).toBeGreaterThan(0);
  expect(imported.every((frame) => frame.width === 8)).toBe(true);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

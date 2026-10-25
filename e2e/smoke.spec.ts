import { expect, test } from "@playwright/test";

/**
 * The first end-to-end path: a real account, a real project and asset through
 * the API, then the editor rendered by the real web app. Agent cases live in
 * their own spec so this smoke test never spends a model call.
 */
test("registers, creates an asset, and opens the editor", async ({ page }) => {
  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  const password = "pixel-e2e-password";

  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E Artist");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: `E2E ${Date.now()}` },
  });
  expect(project.ok()).toBeTruthy();
  const projectBody = (await project.json()) as { id: string };

  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "e2e-sprite" },
  });
  expect(asset.ok()).toBeTruthy();
  const assetBody = (await asset.json()) as { id: string };

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await expect(page.getByRole("img", { name: /pixel canvas/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pencil" })).toBeVisible();

  // Cleanup is best-effort; a failed delete must not mask a product failure.
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

import { expect, test } from "@playwright/test";

test("opens a library card in the editor without a long freeze", async ({ page }) => {
  const email = `nav-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Nav E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "navigation e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "navigable" },
  });
  const assetBody = (await asset.json()) as { id: string };
  await page.goto("/projects");
  const card = page.getByRole("link", { name: /navigable/ }).first();
  await expect(card).toBeVisible();
  await expect(page.locator('img[src*="/thumbnail"]').first()).toBeVisible();
  const start = Date.now();
  await card.click();
  await expect(page.getByRole("img", { name: /Pixel canvas/ })).toBeVisible({
    timeout: 15_000,
  });
  expect(Date.now() - start).toBeLessThan(10_000);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

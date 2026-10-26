import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/hero.png", import.meta.url)),
);

test("imports an image into new frames and locks the palette", async ({ page }) => {
  const email = `editor-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  const password = "pixel-e2e-password";
  await page.goto("/register");
  await page.getByLabel("Name").fill("Editor E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "import e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "hero" },
  });
  const assetBody = (await asset.json()) as { id: string; frames: Array<{ id: string }> };

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.getByRole("button", { name: "Import image" }).click();
  await page.setInputFiles("#import-image-input", {
    name: "hero.png",
    mimeType: "image/png",
    buffer: fixture,
  });
  await expect(page.getByText("16×16 px")).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("2 frames")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("hero", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Lock palette", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unlock palette", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Lock style guide", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unlock style guide", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // A metadata-only update must not leave the lazy canvas blank.
  await expect(page.getByText("0 layers", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Unlock style guide", exact: true }).click();

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

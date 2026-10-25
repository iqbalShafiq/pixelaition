import { expect, test } from "@playwright/test";

type AssetBody = {
  frames: Array<{
    id: string;
    layers: Array<{ pixels: string }>;
    undoHistory?: { past: unknown[]; future: unknown[] } | null;
  }>;
};

test("keeps undo and redo across a reload", async ({ page }) => {
  const email = `history-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("History E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "history e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "history" },
  });
  const assetBody = (await asset.json()) as { id: string };
  const readAsset = async () =>
    (await (await page.request.get(`/api/assets/${assetBody.id}`)).json()) as AssetBody;

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Pencil", exact: true }).click();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);

  const history = async () => (await readAsset()).frames[0]?.undoHistory;
  await expect
    .poll(async () => (await history())?.past.length ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await history())?.future.length ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.reload();
  await expect(canvas).toBeVisible();
  const redo = page.getByRole("button", { name: "Redo" });
  await expect(redo).toBeEnabled();
  await redo.click();

  await expect
    .poll(async () => (await history())?.future.length ?? 0, { timeout: 15_000 })
    .toBe(0);
  const pixels = Buffer.from(
    (await readAsset()).frames[0]?.layers[0]?.pixels ?? "",
    "base64",
  );
  expect(pixels.some((value) => value !== 0)).toBe(true);

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

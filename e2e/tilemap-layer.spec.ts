import { expect, test } from "@playwright/test";

test("creates a persistent tile-index layer", async ({ page }) => {
  const email = `tilemap-layer-${Date.now()}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Tilemap Layer");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "tilemap layer" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "layer" },
  });
  const assetBody = (await asset.json()) as { id: string };
  await page.request.put(`/api/assets/${assetBody.id}/slices`, {
    data: {
      slices: [{ id: "s", name: "grass", x: 0, y: 0, width: 16, height: 16 }],
    },
  });

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.getByRole("button", { name: "Add tilemap layer" }).click();
  await expect(page.getByText("TILEMAP", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stamp tile" }).click();
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.65);
  await page.waitForTimeout(900);
  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{
      layers: Array<{
        name: string;
        tilemap?: { tileWidth: number; tileHeight: number; data: number[] };
      }>;
    }>;
  };
  const tilemap = body.frames[0]?.layers.find((layer) => layer.tilemap);
  expect(tilemap?.name).toBe("tilemap");
  expect(tilemap?.tilemap).toMatchObject({
    tileWidth: 16,
    tileHeight: 16,
  });
  expect(tilemap?.tilemap.data[0]).toBe(-1);
  expect(tilemap?.tilemap.data).toContain(0);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

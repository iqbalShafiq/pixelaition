import { expect, test } from "@playwright/test";

test("applies a tilemap JSON onto the open frame", async ({ page }) => {
  const email = `tilemap-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Tilemap E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "tilemap e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "tilemap" },
  });
  const assetBody = (await asset.json()) as {
    id: string;
    frames: Array<{
      id: string;
      layers: Array<{ id: string; name: string; pixels: string }>;
    }>;
  };
  const layer = assetBody.frames[0]?.layers[0];
  if (!layer) throw new Error("asset has no layer");
  const scripted = await page.request.post(`/api/assets/${assetBody.id}/script`, {
    data: {
      frameId: assetBody.frames[0]?.id,
      layerId: layer.id,
      commands: [{ type: "fill", x: 0, y: 0, color: 1 }],
    },
  });
  expect(scripted.ok()).toBe(true);

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: "map.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        width: 2,
        height: 2,
        tileWidth: 16,
        tileHeight: 16,
        tileset: [{ index: 0, name: "tile", x: 0, y: 0, width: 16, height: 16 }],
        layers: [{ name: "pixels", data: [0, 0, 0, 0] }],
      }),
    ),
  });
  await expect(page.getByText("Tilemap applied")).toBeVisible();
  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const savedPixels = Buffer.from(body.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect([...savedPixels.subarray(0, 4)]).toEqual([11, 9, 6, 255]);
  expect([...savedPixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)]).toEqual([
    11, 9, 6, 255,
  ]);
  expect([...savedPixels.subarray((31 * 32 + 31) * 4, (31 * 32 + 31) * 4 + 4)]).toEqual([
    11, 9, 6, 255,
  ]);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

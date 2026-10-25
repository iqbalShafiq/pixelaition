import { expect, test } from "@playwright/test";

test("removes a flat background from a layer", async ({ page }) => {
  const email = `bg-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Background E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", { data: { name: "bg e2e" } });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "background" },
  });
  const assetBody = (await asset.json()) as {
    id: string;
    frames: Array<{
      id: string;
      layers: Array<{ id: string; name: string; visible: boolean }>;
    }>;
  };
  const frame = assetBody.frames[0];
  const layer = frame?.layers[0];
  if (!frame || !layer) throw new Error("missing frame fixture");
  const filledBytes = Buffer.alloc(32 * 32 * 4);
  for (let cell = 0; cell < 32 * 32; cell += 1) {
    filledBytes[cell * 4] = 255;
    filledBytes[cell * 4 + 3] = 255;
  }
  const filled = filledBytes.toString("base64");
  const put = await page.request.put(`/api/assets/${assetBody.id}/frames/${frame.id}`, {
    data: {
      layers: [
        {
          id: layer.id,
          name: layer.name,
          visible: true,
          pixels: filled,
        },
      ],
      groups: [],
    },
  });
  expect(put.ok()).toBe(true);
  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");

  await page.waitForTimeout(500);

  const settings = page.getByRole("button", { name: "Settings for pixels" }).first();
  await settings.click();
  await page.getByRole("button", { name: "Remove background" }).click();
  await page.waitForTimeout(800);

  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const savedBody = (await saved.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const pixels = Buffer.from(savedBody.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect(pixels.length).toBeGreaterThan(0);
  expect([...pixels].every((value) => value === 0)).toBe(true);

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

import { expect, test } from "@playwright/test";

test("magic wand selects a flat region and clears it", async ({ page }) => {
  const email = `sel-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Selection E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", { data: { name: "sel e2e" } });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "selection" },
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
  if (!frame || !layer) throw new Error("missing fixture");
  const filledBytes = Buffer.alloc(32 * 32 * 4);
  for (let cell = 0; cell < 32 * 32; cell += 1) {
    filledBytes[cell * 4] = 255;
    filledBytes[cell * 4 + 3] = 255;
  }
  const filled = filledBytes.toString("base64");
  await page.request.put(`/api/assets/${assetBody.id}/frames/${frame.id}`, {
    data: {
      layers: [{ id: layer.id, name: layer.name, visible: true, pixels: filled }],
      groups: [],
    },
  });

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");

  await page.getByRole("button", { name: "Magic wand" }).click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.waitForTimeout(800);

  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const pixels = Buffer.from(body.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect(pixels.length).toBeGreaterThan(0);
  expect([...pixels].every((value) => value === 0)).toBe(true);

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

test("lasso selects a polygon and clears only inside it", async ({ page }) => {
  const email = `lasso-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Lasso E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "lasso e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "lasso" },
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
  if (!frame || !layer) throw new Error("missing fixture");
  await page.request.put(`/api/assets/${assetBody.id}/frames/${frame.id}`, {
    data: {
      layers: [
        {
          id: layer.id,
          name: layer.name,
          visible: true,
          pixels: Buffer.alloc(32 * 32 * 4, 255).toString("base64"),
        },
      ],
      groups: [],
    },
  });
  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");
  await page.getByRole("button", { name: "Lasso" }).click();
  const at = (px: number, py: number) => ({
    x: box.x + box.width * px,
    y: box.y + box.height * py,
  });
  const start = at(0.2, 0.2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [px, py] of [
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
    [0.2, 0.2],
  ] as const) {
    const point = at(px, py);
    await page.mouse.move(point.x, point.y, { steps: 3 });
  }
  await page.mouse.up();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.waitForTimeout(800);
  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const pixels = Buffer.from(body.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect(pixels.includes(0)).toBe(true);
  expect(pixels.includes(255)).toBe(true);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

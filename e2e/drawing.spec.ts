import { expect, test } from "@playwright/test";

async function openEditor(page: import("@playwright/test").Page) {
  const email = `draw-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Draw E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);
  const project = await page.request.post("/api/projects", {
    data: { name: "draw e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "draw" },
  });
  const assetBody = (await asset.json()) as { id: string };
  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await expect(page.getByRole("img", { name: /Pixel canvas/ })).toBeVisible();
  return { projectId: projectBody.id, assetId: assetBody.id };
}

test("draws an ellipse and copies a rectangular selection", async ({ page }) => {
  const { projectId, assetId } = await openEditor(page);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");

  await page.getByRole("button", { name: "Ellipse" }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
    steps: 6,
  });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const painted = await page.request.get(`/api/assets/${assetId}`);
  const paintedBody = (await painted.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const pixels = Buffer.from(paintedBody.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect([...pixels].filter((value) => value !== 0).length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, {
    steps: 4,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  const paste = page.getByRole("button", { name: "Paste", exact: true });
  await expect(paste).toBeEnabled();
  await paste.click();
  await page.waitForTimeout(700);
  await expect(page.getByRole("img", { name: /Pixel canvas/ })).toBeVisible();

  await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
});

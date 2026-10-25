import { expect, test } from "@playwright/test";

test("a linked layer follows edits into the other frame", async ({ page }) => {
  const email = `link-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Linked E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "linked e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "linked" },
  });
  const assetBody = (await asset.json()) as { id: string };
  await page.request.post(`/api/assets/${assetBody.id}/frames`, {
    data: { name: "second" },
  });

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  const canvas = page.getByRole("img", { name: /Pixel canvas/ });
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no box");

  const settings = page.getByRole("button", { name: "Settings for pixels" }).first();
  await settings.click();
  await page.getByRole("button", { name: "Link across frames" }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Pencil", exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
    steps: 5,
  });
  await page.mouse.up();
  await page.waitForTimeout(900);

  await page.getByRole("button", { name: /Select second/ }).click();
  await page.waitForTimeout(400);

  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ name: string; layers: Array<{ linkId?: string; pixels: string }> }>;
  };
  const first = body.frames.find((frame) => frame.name !== "second");
  const second = body.frames.find((frame) => frame.name === "second");
  expect(first?.layers[0]?.linkId).toBeTruthy();
  expect(second?.layers[0]?.linkId).toBe(first?.layers[0]?.linkId);
  expect(second?.layers[0]?.pixels).toBe(first?.layers[0]?.pixels);
  expect(
    [...Buffer.from(second?.layers[0]?.pixels ?? "", "base64")].some(
      (value) => value !== 0,
    ),
  ).toBe(true);

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

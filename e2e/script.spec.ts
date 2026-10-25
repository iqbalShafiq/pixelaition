import { expect, test } from "@playwright/test";

test("runs a command script from the editor", async ({ page }) => {
  const email = `script-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Script E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "script e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "scripted" },
  });
  const assetBody = (await asset.json()) as { id: string };
  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page
    .getByLabel("Commands (JSON)")
    .fill('[{"type":"fill","x":0,"y":0,"color":1}]');
  await page.getByRole("button", { name: "Run script" }).click();
  await expect(page.getByText("Script committed.", { exact: true })).toBeVisible();
  const saved = await page.request.get(`/api/assets/${assetBody.id}`);
  const body = (await saved.json()) as {
    frames: Array<{ layers: Array<{ pixels: string }> }>;
  };
  const pixels = Buffer.from(body.frames[0]?.layers[0]?.pixels ?? "", "base64");
  expect(pixels.length).toBeGreaterThan(0);
  for (let cell = 0; cell < pixels.length; cell += 4) {
    expect([...pixels.subarray(cell, cell + 4)]).toEqual([11, 9, 6, 255]);
  }
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

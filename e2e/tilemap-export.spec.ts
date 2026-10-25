import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("exports a tilemap JSON from the export dialog", async ({ page }) => {
  const email = `tilemap-export-${Date.now()}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Tilemap Export");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "tilemap export" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "map" },
  });
  const assetBody = (await asset.json()) as {
    id: string;
    frames: Array<{ id: string; layers: Array<{ id: string; name: string }> }>;
  };
  const frame = assetBody.frames[0];
  const layer = frame?.layers[0];
  if (!frame || !layer) throw new Error("missing frame fixture");
  const scripted = await page.request.post(`/api/assets/${assetBody.id}/script`, {
    data: {
      frameId: frame.id,
      layerId: layer.id,
      commands: [{ type: "fill", x: 0, y: 0, color: 1 }],
    },
  });
  expect(scripted.ok()).toBe(true);
  const sliced = await page.request.put(`/api/assets/${assetBody.id}/slices`, {
    data: {
      slices: [{ id: "s", name: "grass", x: 0, y: 0, width: 16, height: 16 }],
    },
  });
  expect(sliced.ok()).toBe(true);

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.locator("#export-format").click();
  await page.getByRole("option", { name: "tilemap-json" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("download has no path");
  const map = JSON.parse(readFileSync(path, "utf8")) as {
    width: number;
    tileWidth: number;
    layers: Array<{ data: number[] }>;
  };
  expect(map.tileWidth).toBe(16);
  expect(map.width).toBe(2);
  expect(map.layers[0]?.data).toHaveLength(4);
  expect(map.layers[0]?.data.every((value) => value === 0)).toBe(true);
  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

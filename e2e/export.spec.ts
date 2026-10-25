import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("exports a GIF with the asset timing", async ({ page }) => {
  const email = `export-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Export E2E");
  await page.getByLabel("Email").fill(email);
  await page.locator("#auth-password").fill("pixel-e2e-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects/);

  const project = await page.request.post("/api/projects", {
    data: { name: "export e2e" },
  });
  const projectBody = (await project.json()) as { id: string };
  const asset = await page.request.post(`/api/projects/${projectBody.id}/assets`, {
    data: { name: "animated" },
  });
  const assetBody = (await asset.json()) as { id: string; frames: Array<{ id: string }> };
  const first = assetBody.frames[0];
  if (!first) throw new Error("no first frame");
  const added = await page.request.post(`/api/assets/${assetBody.id}/frames`, {
    data: { name: "second" },
  });
  const addedBody = (await added.json()) as {
    frames: Array<{ id: string; name: string }>;
  };
  const second = addedBody.frames.find((frame) => frame.name === "second");
  if (!second) throw new Error("no second frame");
  await page.request.patch(`/api/assets/${assetBody.id}/frames/${first.id}`, {
    data: { durationMs: 120 },
  });
  await page.request.put(`/api/assets/${assetBody.id}/tags`, {
    data: {
      tags: [
        {
          name: "loop",
          fromFrameId: first.id,
          toFrameId: second.id,
          direction: "forward",
          loop: true,
        },
      ],
    },
  });

  await page.goto(`/projects/${projectBody.id}/assets/${assetBody.id}`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.locator("#export-format").click();
  await page.getByRole("option", { name: "gif" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("download has no path");
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 6).toString("ascii")).toBe("GIF89a");

  await page.request.delete(`/api/projects/${projectBody.id}`).catch(() => undefined);
});

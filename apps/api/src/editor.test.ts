import { randomUUID } from "node:crypto";
import { createDatabase, projects, user, type Database } from "@pixelaition/db";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuffer } from "@pixelaition/pixel";
import { framesToAse } from "@pixelaition/export";
import { createApiKey } from "./store.js";

async function probe(url: string | undefined): Promise<Database | undefined> {
  if (!url) return undefined;
  const candidate = createDatabase(url);
  try {
    await Promise.race([
      candidate.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    return candidate;
  } catch {
    await candidate.$client.end({ timeout: 1 }).catch(() => undefined);
    return undefined;
  }
}

const db = await probe(process.env.DATABASE_URL);
process.env.BETTER_AUTH_SECRET ??= "editor-test-secret";
const appModule = db ? await import("./app.js") : undefined;

const base64 = (values: number[]) =>
  Buffer.from(Uint8Array.from(values)).toString("base64");

describe.skipIf(!db)("editor import and palette routes", () => {
  const userId = randomUUID();
  let live: Database;
  let app: Express;
  let token: string;

  beforeAll(async () => {
    if (!db || !appModule) throw new Error("database probe did not resolve");
    live = db;
    app = appModule.createApp();
    await live.insert(user).values({
      id: userId,
      name: "Editor Test",
      email: `editor-${userId}@test.local`,
    });
    token = (await createApiKey(live, userId, "editor-test")).token;
  });

  afterAll(async () => {
    if (!live) return;
    await live.delete(user).where(eq(user.id, userId));
    const { db: appDb } = await import("./auth.js");
    await appDb.$client.end({ timeout: 5 });
    await live.$client.end({ timeout: 5 });
  });

  async function createAsset(name: string) {
    const project = await request(app)
      .post("/api/projects")
      .set("authorization", `Bearer ${token}`)
      .send({ name: `${name} project` });
    expect(project.status).toBe(201);
    const asset = await request(app)
      .post(`/api/projects/${project.body.id}/assets`)
      .set("authorization", `Bearer ${token}`)
      .send({ name });
    expect(asset.status).toBe(201);
    return {
      projectId: project.body.id as string,
      asset: asset.body as {
        id: string;
        width: number;
        height: number;
        palette: string[];
        frames: Array<{ id: string; layers: Array<{ id: string; pixels: string }> }>;
      },
    };
  }

  it("locks the palette, refuses additions, and unlocks", async () => {
    const { projectId, asset } = await createAsset("lock");
    try {
      const locked = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({ action: "lock", locked: true });
      expect(locked.status).toBe(200);
      expect(locked.body.paletteLocked).toBe(true);

      const refused = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({ action: "add", color: "#ff0000" });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("PALETTE_LOCKED");

      const unlocked = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({ action: "lock", locked: false });
      expect(unlocked.status).toBe(200);
      expect(unlocked.body.paletteLocked).toBe(false);
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("remaps pixels and social scenes when a colour is removed", async () => {
    const { projectId, asset } = await createAsset("remap");
    try {
      const replaced = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({
          action: "replace",
          palette: ["#00000000", "#ff0000", "#0000ff"],
        });
      expect(replaced.status).toBe(200);

      const frame = replaced.body.frames[0];
      const pixels = new Array(asset.width * asset.height).fill(1);
      pixels[0] = 2;
      const painted = await request(app)
        .put(`/api/assets/${asset.id}/frames/${frame.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({
          layers: [
            {
              id: frame.layers[0].id,
              name: frame.layers[0].name,
              visible: true,
              pixels: base64(pixels),
            },
          ],
        });
      if (painted.status !== 200) console.log("painted", painted.body);
      expect(painted.status).toBe(200);

      const removed = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({ action: "remove", index: 1, remapTo: 2 });
      expect(removed.status).toBe(200);
      expect(removed.body.palette).toEqual(["#00000000", "#0000ff"]);
      const stored = removed.body.frames[0].layers[0].pixels as string;
      expect(stored).toBe(base64(new Array(asset.width * asset.height).fill(1)));
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("sets frame timing and a tag, then exports GIF, APNG, and a sheet", async () => {
    const { projectId, asset } = await createAsset("timing");
    try {
      const frames = asset.frames;
      const added = await request(app)
        .post(`/api/assets/${asset.id}/frames`)
        .set("authorization", `Bearer ${token}`)
        .send({ name: "second" });
      expect(added.status).toBe(201);
      const second = added.body.frames.find(
        (frame: { name: string }) => frame.name === "second",
      );
      const first = frames[0];
      if (!first || !second) throw new Error("missing timing fixture frames");
      const variant = await request(app)
        .post(`/api/assets/${asset.id}/frames/${first.id}/variant`)
        .set("authorization", `Bearer ${token}`)
        .send({ name: "mirror", mirror: "horizontal" });
      expect(variant.status).toBe(201);
      expect(
        variant.body.frames.some((frame: { name: string }) => frame.name === "mirror"),
      ).toBe(true);

      const source = createBuffer({ width: 8, height: 8 });
      source.layers[0]?.pixels.fill(1);
      const aseImport = await request(app)
        .post(`/api/assets/${asset.id}/import/ase`)
        .set("authorization", `Bearer ${token}`)
        .send({
          data: Buffer.from(framesToAse([{ buffer: source, durationMs: 100 }])).toString(
            "base64",
          ),
        });
      expect(aseImport.status).toBe(201);
      expect(aseImport.body.frames.length).toBeGreaterThan(asset.frames.length);

      const firstLayer = first.layers[0];
      if (!firstLayer) throw new Error("missing layer fixture");
      const scripted = await request(app)
        .post(`/api/assets/${asset.id}/script`)
        .set("authorization", `Bearer ${token}`)
        .send({
          frameId: first.id,
          commands: [
            {
              type: "fill",
              layerId: firstLayer.id,
              x: 0,
              y: 0,
              color: 1,
            },
          ],
        });
      expect(scripted.status).toBe(200);
      const scriptedPixels = Buffer.from(
        scripted.body.frames.find((frame: { id: string }) => frame.id === first.id)
          .layers[0].pixels,
        "base64",
      );
      expect(scriptedPixels[0]).toBe(1);

      const timing = await request(app)
        .patch(`/api/assets/${asset.id}/frames/${first.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ durationMs: 120 });
      expect(timing.status).toBe(200);
      expect(
        timing.body.frames.find((frame: { id: string }) => frame.id === first.id)
          .durationMs,
      ).toBe(120);

      const tagged = await request(app)
        .put(`/api/assets/${asset.id}/tags`)
        .set("authorization", `Bearer ${token}`)
        .send({
          tags: [
            {
              name: "idle",
              fromFrameId: first.id,
              toFrameId: second.id,
              direction: "pingpong",
              loop: true,
            },
          ],
        });
      expect(tagged.status).toBe(200);
      expect(tagged.body.tags).toHaveLength(1);

      const sliced = await request(app)
        .put(`/api/assets/${asset.id}/slices`)
        .set("authorization", `Bearer ${token}`)
        .send({
          slices: [
            {
              id: "slice-1",
              name: "button",
              x: 0,
              y: 0,
              width: 16,
              height: 16,
              nineSlice: { left: 4, right: 4, top: 4, bottom: 6 },
              pivot: { x: 8, y: 12 },
            },
          ],
        });
      expect(sliced.status).toBe(200);
      expect(sliced.body.slices[0]).toMatchObject({
        name: "button",
        pivot: { x: 8, y: 12 },
      });

      const lockedStyle = await request(app)
        .patch(`/api/assets/${asset.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ styleLocked: true });
      expect(lockedStyle.status, JSON.stringify(lockedStyle.body)).toBe(200);
      expect(lockedStyle.body.styleLocked).toBe(true);

      const grayscale = await request(app)
        .put(`/api/assets/${asset.id}/color-mode`)
        .set("authorization", `Bearer ${token}`)
        .send({ mode: "grayscale" });
      expect(grayscale.status).toBe(200);
      expect(grayscale.body.colorMode).toBe("grayscale");
      for (const color of grayscale.body.palette.slice(1)) {
        const [r, g, b] = [1, 3, 5].map((offset) =>
          Number.parseInt(String(color).slice(offset, offset + 2), 16),
        );
        expect(r).toBe(g);
        expect(g).toBe(b);
      }

      const gif = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "gif" });
      expect(gif.status).toBe(200);
      expect(gif.headers["content-type"]).toBe("image/gif");
      expect((gif.body as Buffer).subarray(0, 6).toString("ascii")).toBe("GIF89a");

      const apng = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "apng" });
      expect(apng.status).toBe(200);
      expect(apng.headers["content-type"]).toBe("image/apng");

      const ase = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "ase" });
      expect(ase.status).toBe(200);
      expect(ase.headers["content-type"]).toBe("image/x-aseprite");
      if (Buffer.isBuffer(ase.body)) {
        expect(ase.body.readUInt16LE(4)).toBe(0xa5e0);
      }

      const webp = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "webp" });
      expect(webp.status).toBe(200);
      expect(webp.headers["content-type"]).toBe("image/webp");
      expect((webp.body as Buffer).subarray(0, 4).toString("ascii")).toBe("RIFF");

      const sequence = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "png-sequence" });
      expect(sequence.status).toBe(200);
      expect(sequence.headers["content-type"]).toBe("application/zip");

      const sheet = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "asset", projectId, assetId: asset.id, format: "sheet" });
      expect(sheet.status).toBe(200);
      expect(sheet.headers["content-type"]).toBe("application/zip");
      expect(sheet.headers["content-disposition"]).toContain(".zip");
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("imports two indexed frames into the asset palette", async () => {
    const { projectId, asset } = await createAsset("import");
    try {
      const sourcePalette = ["#00000000", "#ff0000", "#0000ff"];
      const replaced = await request(app)
        .patch(`/api/assets/${asset.id}/palette`)
        .set("authorization", `Bearer ${token}`)
        .send({ action: "replace", palette: sourcePalette });
      expect(replaced.status).toBe(200);

      const framePixels = new Array(64).fill(1);
      framePixels[0] = 2;
      const imported = await request(app)
        .post(`/api/assets/${asset.id}/import`)
        .set("authorization", `Bearer ${token}`)
        .send({
          palette: sourcePalette,
          mode: "frames",
          frames: [
            {
              name: "hero",
              width: 8,
              height: 8,
              layers: [{ name: "body", pixels: base64(framePixels) }],
            },
            {
              name: "hero-copy",
              width: 8,
              height: 8,
              layers: [{ name: "body", pixels: base64(framePixels) }],
            },
          ],
        });
      if (imported.status !== 201) console.log("imported", imported.body);
      expect(imported.status).toBe(201);
      expect(imported.body.frames).toHaveLength(3);
      expect(
        imported.body.frames.some((frame: { name: string }) => frame.name === "hero"),
      ).toBe(true);
      const hero = imported.body.frames.find(
        (frame: { name: string }) => frame.name === "hero",
      );
      expect(hero.layers[0].pixels).toBe(base64(framePixels));
      expect(imported.body.palette).toEqual(sourcePalette);
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });
});

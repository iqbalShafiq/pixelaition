import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  apiKeys,
  assets,
  frames,
  generationRuns,
  generationThreads,
  projects,
  userPreferences,
  type Database,
} from "@pixelaition/db";
import {
  addFrame,
  applyCommand,
  assetFrameBuffer,
  createAsset,
  defaultStyle,
  duplicateFrame,
  writeFrame,
  type Asset,
  type Frame,
  type StyleGuide,
} from "@pixelaition/pixel";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listProjects(db: Database, userId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
}

export async function createProjectRecord(
  db: Database,
  userId: string,
  name: string,
  description = "",
) {
  const id = randomUUID();
  const style: StyleGuide = defaultStyle;
  await db.insert(projects).values({ id, userId, name, description, style });
  return { id, userId, name, description, style };
}

export async function getProjectRecord(db: Database, userId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) return undefined;
  const assetRows = await db.select().from(assets).where(eq(assets.projectId, projectId));
  return { ...project, assets: assetRows };
}

export async function createAssetRecord(
  db: Database,
  userId: string,
  projectId: string,
  name: string,
): Promise<Asset | undefined> {
  const project = await getProjectRecord(db, userId, projectId);
  if (!project) return undefined;
  const style = project.style as StyleGuide;
  const asset = createAsset({
    name,
    width: style.defaultWidth,
    height: style.defaultHeight,
  });
  await db.insert(assets).values({
    id: asset.id,
    projectId,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    palette: asset.palette,
  });
  for (const frame of asset.frames) {
    await db.insert(frames).values({
      id: frame.id,
      assetId: asset.id,
      name: frame.name,
      index: frame.index,
      layers: frame.layers,
    });
  }
  return asset;
}

export async function getAssetRecord(db: Database, userId: string, assetId: string) {
  const [row] = await db
    .select({
      asset: assets,
      projectUserId: projects.userId,
      style: projects.style,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(assets)
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(and(eq(assets.id, assetId), eq(projects.userId, userId)));
  if (!row) return undefined;
  const frameRows = await db
    .select()
    .from(frames)
    .where(eq(frames.assetId, assetId))
    .orderBy(frames.index);
  return {
    ...row.asset,
    style: row.style as StyleGuide,
    projectId: row.projectId,
    projectName: row.projectName,
    frames: frameRows as Array<Frame & { assetId: string }>,
  };
}

export async function saveFrame(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  layers: Frame["layers"],
) {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) return undefined;
  await db
    .update(frames)
    .set({ layers, updatedAt: new Date() })
    .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return getAssetRecord(db, userId, assetId);
}

type AssetRecord = NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>;

export type StoreFailure = { code: string; message: string };

function asPixelAsset(record: AssetRecord): Asset {
  return {
    id: record.id,
    name: record.name,
    width: record.width,
    height: record.height,
    palette: record.palette as string[],
    frames: record.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      index: frame.index,
      layers: frame.layers,
    })),
  };
}

async function persistAsset(
  db: Database,
  userId: string,
  assetId: string,
  asset: Asset,
): Promise<AssetRecord | undefined> {
  await db
    .update(assets)
    .set({
      name: asset.name,
      width: asset.width,
      height: asset.height,
      palette: asset.palette,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, assetId));
  for (const frame of asset.frames) {
    await db
      .update(frames)
      .set({ layers: frame.layers, updatedAt: new Date() })
      .where(and(eq(frames.id, frame.id), eq(frames.assetId, assetId)));
  }
  return getAssetRecord(db, userId, assetId);
}

export async function addFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  name: string,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  const next = addFrame(asPixelAsset(record), name);
  const added = next.frames.at(-1);
  if (!added) return { asset: undefined };
  await db.insert(frames).values({
    id: added.id,
    assetId,
    name: added.name,
    index: added.index,
    layers: added.layers,
  });
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { asset: await getAssetRecord(db, userId, assetId) };
}

export async function duplicateFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  name?: string,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  const next = duplicateFrame(asPixelAsset(record), frameId, name ?? "");
  if (!next)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is gone." },
    };
  const added = next.frames.at(-1);
  if (!added) return { asset: undefined };
  await db.insert(frames).values({
    id: added.id,
    assetId,
    name: added.name,
    index: added.index,
    layers: added.layers,
  });
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { asset: await getAssetRecord(db, userId, assetId) };
}

export async function renameFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  name: string,
): Promise<AssetRecord | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset?.frames.some((frame) => frame.id === frameId)) return undefined;
  await db
    .update(frames)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return getAssetRecord(db, userId, assetId);
}

export async function deleteFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
): Promise<{ ok: boolean; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { ok: false };
  if (record.frames.length <= 1) {
    return {
      ok: false,
      failure: { code: "FRAME_REQUIRED", message: "An asset keeps at least one frame." },
    };
  }
  if (!record.frames.some((frame) => frame.id === frameId)) return { ok: false };
  await db.delete(frames).where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { ok: true };
}

export async function updateAssetRecord(
  db: Database,
  userId: string,
  assetId: string,
  input: { name?: string; width?: number; height?: number; palette?: string[] },
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  let asset = asPixelAsset(record);
  const trimmed = input.name?.trim();
  if (trimmed) asset = { ...asset, name: trimmed };
  if (!asset.frames[0]) return { asset: await persistAsset(db, userId, assetId, asset) };

  // Every frame gates the change so a palette cannot shrink past a color another
  // frame still uses. Each frame is checked on its own buffer.
  for (const frame of asset.frames) {
    const buffer = assetFrameBuffer(asset, frame.id);
    if (!buffer) continue;
    if (input.palette) {
      const result = applyCommand(buffer, { type: "setPalette", palette: input.palette });
      if (!result.ok) return { asset: undefined, failure: result };
    }
    if (input.width !== undefined || input.height !== undefined) {
      const result = applyCommand(buffer, {
        type: "resize",
        width: input.width ?? buffer.width,
        height: input.height ?? buffer.height,
      });
      if (!result.ok) return { asset: undefined, failure: result };
    }
  }

  const first = assetFrameBuffer(asset, asset.frames[0].id);
  if (first) {
    let next = first;
    if (input.palette) {
      const result = applyCommand(next, { type: "setPalette", palette: input.palette });
      if (result.ok) next = result.buffer;
    }
    if (input.width !== undefined || input.height !== undefined) {
      const result = applyCommand(next, {
        type: "resize",
        width: input.width ?? next.width,
        height: input.height ?? next.height,
      });
      if (result.ok) next = result.buffer;
    }
    for (const frame of asset.frames) asset = writeFrame(asset, frame.id, next);
  }
  return { asset: await persistAsset(db, userId, assetId, asset) };
}

export async function listFrameRecords(db: Database, userId: string, assetId: string) {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) return undefined;
  return db
    .select()
    .from(frames)
    .where(eq(frames.assetId, assetId))
    .orderBy(asc(frames.index));
}

export async function getPreferences(db: Database, userId: string) {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row ?? { userId, lastModelId: null, lastReasoningEffort: null };
}

export async function savePreferences(
  db: Database,
  userId: string,
  input: { lastModelId?: string | null; lastReasoningEffort?: string | null },
) {
  await db
    .insert(userPreferences)
    .values({
      userId,
      lastModelId: input.lastModelId ?? null,
      lastReasoningEffort: input.lastReasoningEffort ?? null,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        ...(input.lastModelId !== undefined ? { lastModelId: input.lastModelId } : {}),
        ...(input.lastReasoningEffort !== undefined
          ? { lastReasoningEffort: input.lastReasoningEffort }
          : {}),
      },
    });
  return getPreferences(db, userId);
}

export async function createApiKey(db: Database, userId: string, name: string) {
  const token = `pxl_${randomBytes(24).toString("hex")}`;
  const id = randomUUID();
  await db.insert(apiKeys).values({ id, userId, name, tokenHash: hashToken(token) });
  return { id, name, token };
}

export async function userIdForToken(db: Database, token: string) {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)));
  if (!row) return undefined;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return row.userId;
}

export async function revokeApiKey(db: Database, userId: string, id: string) {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
}

export async function ensureThread(db: Database, userId: string, assetId: string) {
  const [existing] = await db
    .select()
    .from(generationThreads)
    .where(
      and(eq(generationThreads.assetId, assetId), eq(generationThreads.userId, userId)),
    );
  if (existing) return existing;
  const id = randomUUID();
  await db.insert(generationThreads).values({ id, assetId, userId });
  return { id, assetId, userId };
}

export async function insertRun(
  db: Database,
  input: {
    threadId: string;
    requestId: string;
    modelId: string;
    reasoningEffort: string;
    durableRunId?: string;
    status: string;
  },
) {
  const id = randomUUID();
  await db.insert(generationRuns).values({ id, ...input });
  return id;
}

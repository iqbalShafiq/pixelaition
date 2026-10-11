import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  apiKeys,
  assets,
  createVersion,
  frames,
  generationRuns,
  generationThreads,
  projects,
  userPreferences,
  versions,
  RETENTION_LIMIT,
  type Database,
  type VersionScope,
} from "@pixelaition/db";
import {
  addFrame,
  applyCommand,
  assetFrameBuffer,
  createAsset,
  decodePixels,
  defaultStyle,
  duplicateFrame,
  moveFrame,
  writeFrame,
  type Asset,
  type Frame,
  type StyleGuide,
} from "@pixelaition/pixel";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

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

type AssetRecord = NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>;

export type StoreFailure = { code: string; message: string };

/** Frame-scoped snapshot shape: the name and layers a restore replays. */
function frameSnapshot(name: string, layers: Frame["layers"]) {
  return { name, layers };
}

/** Asset-scoped snapshot shape: the metadata plus the frames that existed. */
function assetSnapshot(asset: {
  name: string;
  width: number;
  height: number;
  palette: unknown;
  frames: Array<{ id: string }>;
}) {
  return {
    name: asset.name,
    width: asset.width,
    height: asset.height,
    palette: asset.palette,
    frameIds: asset.frames.map((frame) => frame.id),
  };
}

async function recordFrameVersion(
  db: Database,
  assetId: string,
  frameId: string,
  kind: string,
  name: string,
  layers: Frame["layers"],
) {
  await createVersion(db, {
    assetId,
    frameId,
    scope: "frame",
    kind,
    author: "user",
    snapshot: frameSnapshot(name, layers),
  });
}

async function recordAssetVersion(
  db: Database,
  assetId: string,
  kind: string,
  asset: {
    name: string;
    width: number;
    height: number;
    palette: unknown;
    frames: Array<{ id: string }>;
  },
) {
  await createVersion(db, {
    assetId,
    scope: "asset",
    kind,
    author: "user",
    snapshot: assetSnapshot(asset),
  });
}

export async function saveFrame(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  layers: Frame["layers"],
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) return { asset: undefined };
  const frame = asset.frames.find((item) => item.id === frameId);
  if (!frame)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is not available." },
    };
  // A buffer sized for another canvas would make every later read of this asset
  // throw, so it is refused here instead of stored.
  const expected = asset.width * asset.height;
  try {
    for (const layer of layers) decodePixels(layer.pixels, expected);
  } catch {
    return {
      asset: undefined,
      failure: {
        code: "FRAME_SIZE_MISMATCH",
        message: `Those pixels are not ${asset.width} by ${asset.height}. Reload the asset and try again.`,
      },
    };
  }
  await db
    .update(frames)
    .set({ layers, updatedAt: new Date() })
    .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  await recordFrameVersion(db, assetId, frameId, "edit", frame.name, layers);
  return { asset: await getAssetRecord(db, userId, assetId) };
}

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
  before: Asset,
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
  // Only the frame rows that actually changed are written, so a rename cannot
  // clobber a concurrent autosave or a worker stroke on another frame.
  for (const frame of asset.frames) {
    const previous = before.frames.find((item) => item.id === frame.id);
    if (previous && JSON.stringify(previous.layers) === JSON.stringify(frame.layers))
      continue;
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
  await recordFrameVersion(db, assetId, added.id, "frame-add", added.name, added.layers);
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
  await recordFrameVersion(db, assetId, added.id, "frame-add", added.name, added.layers);
  return { asset: await getAssetRecord(db, userId, assetId) };
}

export async function moveFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  toIndex: number,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  const before = asPixelAsset(record);
  const next = moveFrame(before, frameId, toIndex);
  if (!next)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is gone." },
    };
  await db.transaction(async (tx) => {
    // A unique index guards (asset, index), so a direct renumber might collide
    // with a row that has not moved yet. Park every frame far above the final
    // range first, then write the dense 0..n-1 order.
    await tx
      .update(frames)
      .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
      .where(eq(frames.assetId, assetId));
    for (const frame of next.frames) {
      await tx
        .update(frames)
        .set({ index: frame.index, updatedAt: new Date() })
        .where(and(eq(frames.id, frame.id), eq(frames.assetId, assetId)));
    }
    await tx.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  });
  await recordAssetVersion(db, assetId, "frame-move", next);
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
  const frame = asset?.frames.find((item) => item.id === frameId);
  if (!asset || !frame) return undefined;
  await db
    .update(frames)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  await recordFrameVersion(db, assetId, frameId, "rename", trimmed, frame.layers);
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
  if (!record.frames.some((frame) => frame.id === frameId)) return { ok: false };
  await db.delete(frames).where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
  // An asset keeps at least one frame: removing the last one replaces it with a
  // fresh blank frame instead of refusing, so delete always means delete.
  if (record.frames.length <= 1) {
    const previous = asPixelAsset(record);
    const next = addFrame(
      { ...previous, frames: previous.frames.filter((frame) => frame.id !== frameId) },
      "",
    );
    const added = next.frames.at(-1);
    if (added) {
      await db.insert(frames).values({
        id: added.id,
        assetId,
        name: added.name,
        index: added.index,
        layers: added.layers,
      });
    }
  }
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  const after = await getAssetRecord(db, userId, assetId);
  if (after) await recordAssetVersion(db, assetId, "frame-delete", after);
  return { ok: true };
}

/** Applies name, resize, and palette changes without recording a version. */
async function applyAssetUpdate(
  db: Database,
  userId: string,
  assetId: string,
  input: { name?: string; width?: number; height?: number; palette?: string[] },
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  const before = asPixelAsset(record);
  let asset = before;
  const trimmed = input.name?.trim();
  if (trimmed) asset = { ...asset, name: trimmed };
  const firstId = asset.frames[0]?.id;
  if (!firstId) return { asset: await persistAsset(db, userId, assetId, asset, before) };

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

  // One write, not one per frame: writeFrame reshapes every other frame while
  // keeping its own pixels. Writing each frame would stamp frame zero over all.
  const first = assetFrameBuffer(asset, firstId);
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
    asset = writeFrame(asset, firstId, next);
  }
  return { asset: await persistAsset(db, userId, assetId, asset, before) };
}

export async function updateAssetRecord(
  db: Database,
  userId: string,
  assetId: string,
  input: { name?: string; width?: number; height?: number; palette?: string[] },
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const result = await applyAssetUpdate(db, userId, assetId, input);
  if (!result.asset) return result;
  const kind =
    input.width !== undefined || input.height !== undefined
      ? "resize"
      : input.palette !== undefined
        ? "palette"
        : input.name !== undefined
          ? "rename"
          : undefined;
  if (kind) await recordAssetVersion(db, assetId, kind, result.asset);
  return result;
}

/** The active-run guard shared by the store's restore and the API's routes. */
export async function assetHasActiveRun(db: Database, assetId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: generationRuns.id })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
    .where(
      and(
        eq(generationThreads.assetId, assetId),
        inArray(generationRuns.status, ["queued", "running", "waiting"]),
      ),
    )
    .limit(1);
  return run !== undefined;
}

function frameSnapshotFrom(
  snapshot: unknown,
): { name: string; layers: Frame["layers"] } | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const item = snapshot as { name?: unknown; layers?: unknown };
  if (typeof item.name !== "string") return undefined;
  const name = item.name.trim();
  if (!name || name.length > 80) return undefined;
  const layers = item.layers;
  if (!Array.isArray(layers) || layers.length === 0) return undefined;
  for (const layer of layers) {
    if (typeof layer !== "object" || layer === null) return undefined;
    const entry = layer as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.visible !== "boolean" ||
      typeof entry.pixels !== "string"
    )
      return undefined;
  }
  return { name, layers: layers as Frame["layers"] };
}

function assetSnapshotFrom(snapshot: unknown):
  | {
      name: string;
      width: number;
      height: number;
      palette: string[];
      frameIds: string[];
    }
  | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const item = snapshot as Record<string, unknown>;
  if (typeof item.name !== "string" || item.name.trim() === "") return undefined;
  if (typeof item.width !== "number" || typeof item.height !== "number") return undefined;
  if (!Array.isArray(item.palette)) return undefined;
  if (item.palette.some((color) => typeof color !== "string")) return undefined;
  if (!Array.isArray(item.frameIds)) return undefined;
  if (item.frameIds.some((id) => typeof id !== "string")) return undefined;
  return {
    name: item.name,
    width: item.width,
    height: item.height,
    palette: item.palette as string[],
    frameIds: item.frameIds as string[],
  };
}

/** Parks every frame above the range, then writes the dense 0..n-1 order. */
async function reorderFrames(db: Database, assetId: string, frameIds: string[]) {
  await db.transaction(async (tx) => {
    // A unique index guards (asset, index), so a direct renumber might collide
    // with a row that has not moved yet. Park first, then write the order.
    await tx
      .update(frames)
      .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
      .where(eq(frames.assetId, assetId));
    for (const [index, id] of frameIds.entries()) {
      await tx
        .update(frames)
        .set({ index, updatedAt: new Date() })
        .where(and(eq(frames.id, id), eq(frames.assetId, assetId)));
    }
  });
}

/**
 * Replays a snapshot as the new current state and records the replay as a new
 * `restore` version. Never destructive, and never while a run owns the asset.
 */
export async function restoreVersion(
  db: Database,
  userId: string,
  assetId: string,
  versionId: string,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  if (await assetHasActiveRun(db, assetId)) {
    return {
      asset: undefined,
      failure: {
        code: "RUN_IN_PROGRESS",
        message: "The agent is drawing on this asset right now.",
      },
    };
  }
  const [version] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.assetId, assetId)));
  if (!version)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That version is not available." },
    };

  let restored: unknown;
  if (version.scope === "frame") {
    const frameId = version.frameId;
    if (!frameId)
      return {
        asset: undefined,
        failure: { code: "NOT_FOUND", message: "That version's frame is gone." },
      };
    const frame = record.frames.find((item) => item.id === frameId);
    if (!frame)
      return {
        asset: undefined,
        failure: { code: "NOT_FOUND", message: "That version's frame is gone." },
      };
    const snapshot = frameSnapshotFrom(version.snapshot);
    if (!snapshot)
      return {
        asset: undefined,
        failure: {
          code: "INVALID_VERSION",
          message: "That version's snapshot is malformed.",
        },
      };
    try {
      for (const layer of snapshot.layers)
        decodePixels(layer.pixels, record.width * record.height);
    } catch {
      return {
        asset: undefined,
        failure: {
          code: "INVALID_VERSION",
          message: "That version does not fit this asset's canvas.",
        },
      };
    }
    await db
      .update(frames)
      .set({ name: snapshot.name, layers: snapshot.layers, updatedAt: new Date() })
      .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
    await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
    restored = frameSnapshot(snapshot.name, snapshot.layers);
  } else {
    const snapshot = assetSnapshotFrom(version.snapshot);
    if (!snapshot)
      return {
        asset: undefined,
        failure: {
          code: "INVALID_VERSION",
          message: "That version's snapshot is malformed.",
        },
      };
    // The recorded order only replays when it still names exactly this asset's
    // frames: a version from another frame set cannot be replayed safely.
    const currentIds = new Set(record.frames.map((item) => item.id));
    const recordedIds = new Set(snapshot.frameIds);
    if (
      recordedIds.size !== snapshot.frameIds.length ||
      recordedIds.size !== currentIds.size ||
      snapshot.frameIds.some((id) => !currentIds.has(id))
    )
      return {
        asset: undefined,
        failure: {
          code: "INVALID_VERSION",
          message: "That version's frames do not match this asset.",
        },
      };
    const applied = await applyAssetUpdate(db, userId, assetId, {
      name: snapshot.name,
      width: snapshot.width,
      height: snapshot.height,
      palette: snapshot.palette,
    });
    if (!applied.asset)
      return {
        asset: undefined,
        failure: applied.failure ?? {
          code: "NOT_FOUND",
          message: "That asset is not available.",
        },
      };
    const currentOrder = record.frames.map((item) => item.id).join("|");
    if (currentOrder !== snapshot.frameIds.join("|"))
      await reorderFrames(db, assetId, snapshot.frameIds);
    restored = assetSnapshot(applied.asset);
  }

  const after = await getAssetRecord(db, userId, assetId);
  if (!after)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That asset is not available." },
    };
  if (version.scope === "asset") restored = assetSnapshot(after);

  await createVersion(db, {
    assetId,
    frameId: version.frameId,
    scope: version.scope,
    kind: "restore",
    author: "user",
    label: `Restore of ${version.author} ${version.kind} · ${version.id}`,
    snapshot: restored,
  });
  return { asset: after };
}

export async function updateVersionLabel(
  db: Database,
  userId: string,
  assetId: string,
  versionId: string,
  label: string | null,
) {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) return undefined;
  const [updated] = await db
    .update(versions)
    .set({ label })
    .where(and(eq(versions.id, versionId), eq(versions.assetId, assetId)))
    .returning();
  return updated;
}

/** A run id alone must never be enough to read or cancel somebody else's run. */
export async function runBelongsTo(
  db: Database,
  runId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: generationThreads.userId })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
    .where(eq(generationRuns.id, runId));
  return row?.userId === userId;
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

/** A thread's home: the asset an editor run draws on, or a workspace project. */
export type ThreadScope = { assetId: string } | { projectId: string };

/**
 * The one thread per user and scope. An asset thread and a workspace thread
 * are separate conversations even when the workspace later picks that asset.
 */
export async function ensureThread(db: Database, userId: string, scope: ThreadScope) {
  const where =
    "assetId" in scope
      ? and(
          eq(generationThreads.assetId, scope.assetId),
          eq(generationThreads.userId, userId),
        )
      : and(
          eq(generationThreads.projectId, scope.projectId),
          eq(generationThreads.userId, userId),
        );
  const [existing] = await db.select().from(generationThreads).where(where);
  if (existing) return existing;
  const id = randomUUID();
  const [created] = await db
    .insert(generationThreads)
    .values(
      "assetId" in scope
        ? { id, assetId: scope.assetId, userId }
        : { id, projectId: scope.projectId, userId },
    )
    .returning();
  if (!created) throw new Error("The thread row could not be created.");
  return created;
}

export async function insertRun(
  db: Database,
  input: {
    threadId: string;
    requestId: string;
    modelId: string;
    reasoningEffort: string;
    frameId?: string;
    prompt?: string;
    durableRunId?: string;
    status: string;
  },
) {
  const id = randomUUID();
  await db.insert(generationRuns).values({ id, ...input });
  return id;
}

export type VersionCursor = { createdAt: Date; id: string };

/** Newest first, paged by `(createdAt, id)` so equal timestamps stay ordered. */
export async function listVersions(
  db: Database,
  assetId: string,
  options: {
    scope?: VersionScope;
    frameId?: string;
    limit?: number;
    cursor?: VersionCursor;
  },
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), RETENTION_LIMIT);
  const conditions = [eq(versions.assetId, assetId)];
  if (options.scope) conditions.push(eq(versions.scope, options.scope));
  if (options.frameId) conditions.push(eq(versions.frameId, options.frameId));
  if (options.cursor) {
    const { createdAt, id } = options.cursor;
    conditions.push(
      or(
        lt(versions.createdAt, createdAt),
        and(eq(versions.createdAt, createdAt), lt(versions.id, id)),
      )!,
    );
  }
  return db
    .select()
    .from(versions)
    .where(and(...conditions))
    .orderBy(desc(versions.createdAt), desc(versions.id))
    .limit(limit);
}

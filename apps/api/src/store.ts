import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  apiKeys,
  assets,
  createVersion,
  frames,
  generationRuns,
  generationThreads,
  models,
  projects,
  runProposals,
  runTasks,
  userPreferences,
  versions,
  RETENTION_LIMIT,
  type Database,
  type VersionScope,
} from "@pixelaition/db";
import {
  applyCommand,
  assetFrameBuffer,
  bufferToFrame,
  createAsset,
  createBuffer,
  decodePixels,
  defaultStyle,
  emptyPixels,
  encodePixels,
  frameToBuffer,
  paletteIndexMap,
  writeFrame,
  type Asset,
  type Frame,
  type StyleGuide,
} from "@pixelaition/pixel";
import {
  buildTemplateScene,
  getPreset,
  mapSceneIndices,
  renderScene,
  sceneSchema,
  type ArtboardScene,
  type CopyDeck,
  type PaletteImage,
  type SpriteSource,
  syncCopyScene,
} from "@pixelaition/artboard";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listProjects(db: Database, userId: string) {
  const rows = await db
    .select({ project: projects, assetCount: count(assets.id) })
    .from(projects)
    .leftJoin(assets, eq(assets.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .groupBy(projects.id)
    .orderBy(desc(projects.updatedAt));
  return rows.map((row) => ({ ...row.project, assetCount: row.assetCount }));
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
      kind: "sprite",
      width: asset.width,
      height: asset.height,
    });
  }
  return asset;
}

type StoredFrame = typeof frames.$inferSelect & {
  layers: Frame["layers"];
  groups: NonNullable<Frame["groups"]>;
};

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
    frames: frameRows as StoredFrame[],
  };
}

type AssetRecord = NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>;

export type StoreFailure = { code: string; message: string };

/** Frame-scoped snapshot shape: the name and layers a restore replays. */
function frameSnapshot(name: string, layers: Frame["layers"]) {
  return { name, layers };
}

function socialSnapshot(frame: {
  name: string;
  presetId: string | null;
  width: number | null;
  height: number | null;
  scene: unknown;
  copyOverride: unknown;
  status: string;
}) {
  return {
    name: frame.name,
    layers: [],
    social: {
      presetId: frame.presetId,
      width: frame.width,
      height: frame.height,
      scene: frame.scene,
      copyOverride: frame.copyOverride,
      status: frame.status,
    },
  };
}

async function recordSocialVersion(
  db: Database,
  assetId: string,
  frameId: string,
  kind: string,
  frame: Parameters<typeof socialSnapshot>[0],
) {
  await createVersion(db, {
    assetId,
    frameId,
    scope: "frame",
    kind,
    author: "user",
    snapshot: socialSnapshot(frame),
  });
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

export async function recordFrameVersion(
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

export async function recordAssetVersion(
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
  groups?: Frame["groups"],
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) return { asset: undefined };
  const frame = asset.frames.find((item) => item.id === frameId);
  if (!frame)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is not available." },
    };
  if (frame.kind === "social") {
    return {
      asset: undefined,
      failure: {
        code: "NOT_A_SPRITE_FRAME",
        message: "This frame is edited through its scene, not through pixels.",
      },
    };
  }
  // A buffer sized for another canvas would make every later read of this asset
  // throw, so it is refused here instead of stored.
  const frameWidth = frame.width ?? asset.width;
  const frameHeight = frame.height ?? asset.height;
  const expected = frameWidth * frameHeight;
  try {
    for (const layer of layers) decodePixels(layer.pixels, expected);
  } catch {
    return {
      asset: undefined,
      failure: {
        code: "FRAME_SIZE_MISMATCH",
        message: `Those pixels are not ${frameWidth} by ${frameHeight}. Reload the asset and try again.`,
      },
    };
  }
  await db
    .update(frames)
    .set({ layers, ...(groups !== undefined ? { groups } : {}), updatedAt: new Date() })
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
    frames: record.frames
      .filter((frame) => frame.kind !== "social")
      .map((frame) => ({
        id: frame.id,
        name: frame.name,
        index: frame.index,
        layers: frame.layers,
        groups: (frame.groups ?? []) as Frame["groups"],
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
    if (
      previous &&
      JSON.stringify(previous.layers) === JSON.stringify(frame.layers) &&
      JSON.stringify(previous.groups ?? []) === JSON.stringify(frame.groups ?? [])
    )
      continue;
    await db
      .update(frames)
      .set({
        layers: frame.layers,
        ...(frame.groups !== undefined ? { groups: frame.groups } : {}),
        updatedAt: new Date(),
      })
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
  const index =
    record.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
  const blank = createBuffer({
    width: record.width,
    height: record.height,
    palette: record.palette as string[],
    layerName: "pixels",
  });
  const added = bufferToFrame(blank, {
    id: randomUUID(),
    name: name.trim() || `frame-${index + 1}`,
    index,
  });
  await db.insert(frames).values({
    id: added.id,
    assetId,
    name: added.name,
    index: added.index,
    layers: added.layers,
    kind: "sprite",
    width: record.width,
    height: record.height,
  });
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  await recordFrameVersion(db, assetId, added.id, "frame-add", added.name, added.layers);
  return { asset: await getAssetRecord(db, userId, assetId) };
}

function spriteSources(record: AssetRecord): Map<string, SpriteSource> {
  const sprites = new Map<string, SpriteSource>();
  for (const frame of record.frames) {
    if (frame.kind === "social") continue;
    const width = frame.width ?? record.width;
    const height = frame.height ?? record.height;
    sprites.set(`${record.id}:${frame.id}`, {
      assetId: record.id,
      assetName: record.name,
      frameId: frame.id,
      frameName: frame.name,
      buffer: frameToBuffer(frame, width, height, record.palette as string[]),
    });
  }
  return sprites;
}

export async function addSocialFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  input: {
    presetId?: string;
    width?: number;
    height?: number;
    name?: string;
    template?: string;
    copy?: CopyDeck;
  },
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return { asset: undefined };
  if (input.width !== undefined && input.height !== undefined) {
    const width = Math.round(input.width);
    const height = Math.round(input.height);
    if (width < 8 || height < 8 || width > 4096 || height > 4096) {
      return {
        asset: undefined,
        failure: {
          code: "INVALID_SIZE",
          message: "A custom frame must be between 8 and 4096 pixels on each side.",
        },
      };
    }
    const index =
      record.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
    const blank = emptyPixels(width, height);
    await db.insert(frames).values({
      id: randomUUID(),
      assetId,
      name: input.name?.trim() || `Custom ${width}×${height}`,
      index,
      layers: [
        {
          id: "background",
          name: "Background",
          visible: true,
          pixels: encodePixels(blank),
        },
        {
          id: "artwork",
          name: "Artwork",
          visible: true,
          pixels: encodePixels(blank),
        },
      ],
      kind: "sprite",
      width,
      height,
      presetId: null,
      scene: null,
      copyOverride: {},
      status: "draft",
      version: 1,
    });
    await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
    return { asset: await getAssetRecord(db, userId, assetId) };
  }
  if (!input.presetId) {
    return {
      asset: undefined,
      failure: { code: "UNKNOWN_FORMAT", message: "A canvas size is required." },
    };
  }
  let preset;
  try {
    preset = getPreset(input.presetId);
  } catch (reason) {
    return {
      asset: undefined,
      failure: {
        code: "UNKNOWN_FORMAT",
        message: reason instanceof Error ? reason.message : "Unknown format.",
      },
    };
  }
  const sprites = spriteSources(record);
  const source = [...sprites.values()][0];
  const copy = input.copy ?? (record.copy as CopyDeck);
  const template = (input.template ??
    preset.defaultTemplate) as typeof preset.defaultTemplate;
  const scene = buildTemplateScene({
    preset,
    template,
    copy,
    palette: record.palette as string[],
    ...(source ? { sprite: source } : {}),
  });
  const index =
    record.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
  // A native frame is still a pixel document: background is the first layer,
  // the template artwork is the second. Nothing is stored as a scene.
  const background = renderScene({
    scene: { ...scene, elements: [] },
    preset,
    palette: record.palette as string[],
    sprites,
  }).image;
  const artwork = renderScene({
    scene: { ...scene, background: { kind: "transparent" } },
    preset,
    palette: record.palette as string[],
    sprites,
  }).image;
  const layers = [
    {
      id: "background",
      name: "Background",
      visible: true,
      pixels: encodePixels(background.indices),
    },
    {
      id: "artwork",
      name: "Artwork",
      visible: true,
      pixels: encodePixels(artwork.indices),
    },
  ];
  await db.insert(frames).values({
    id: randomUUID(),
    assetId,
    name: input.name?.trim() || preset.label,
    index,
    layers,
    kind: "sprite",
    width: preset.width,
    height: preset.height,
    presetId: preset.id,
    scene: null,
    copyOverride: {},
    status: "draft",
    version: 1,
  });
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { asset: await getAssetRecord(db, userId, assetId) };
}

export async function saveSocialFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
  input: {
    version: number;
    scene?: unknown;
    copyOverride?: Record<string, string>;
    status?: "draft" | "ready" | "needs-fix";
    name?: string;
  },
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const [row] = await db
    .select({ frame: frames })
    .from(frames)
    .innerJoin(assets, eq(frames.assetId, assets.id))
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(
      and(
        eq(frames.id, frameId),
        eq(frames.assetId, assetId),
        eq(projects.userId, userId),
      ),
    );
  if (!row) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is not available." },
    };
  }
  if (row.frame.version !== input.version) {
    return {
      asset: undefined,
      failure: {
        code: "VERSION_CONFLICT",
        message: `This frame changed (expected version ${input.version}, current ${row.frame.version}). Reload it.`,
      },
    };
  }
  const scene =
    input.scene === undefined ? row.frame.scene : sceneSchema.parse(input.scene);
  const [updated] = await db
    .update(frames)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 80) } : {}),
      ...(input.copyOverride !== undefined ? { copyOverride: input.copyOverride } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      scene,
      version: row.frame.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(frames.id, frameId), eq(frames.version, input.version)))
    .returning({ id: frames.id });
  if (!updated) {
    return {
      asset: undefined,
      failure: {
        code: "VERSION_CONFLICT",
        message: "This frame changed while it was being saved. Reload it.",
      },
    };
  }
  // Pixel-backed frames can carry a scene overlay too; only native-size
  // frames use the scene version timeline for now.
  if (row.frame.kind === "social") {
    await recordSocialVersion(db, assetId, frameId, "edit", {
      name: input.name?.trim().slice(0, 80) ?? row.frame.name,
      presetId: row.frame.presetId,
      width: row.frame.width,
      height: row.frame.height,
      scene,
      copyOverride: input.copyOverride ?? row.frame.copyOverride,
      status: input.status ?? row.frame.status,
    });
  }
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  return { asset: await getAssetRecord(db, userId, assetId) };
}

export async function updateAssetCopyRecord(
  db: Database,
  userId: string,
  assetId: string,
  copy: CopyDeck,
): Promise<AssetRecord | undefined> {
  const record = await getAssetRecord(db, userId, assetId);
  if (!record) return undefined;
  await db
    .update(assets)
    .set({ copy, updatedAt: new Date() })
    .where(eq(assets.id, assetId));
  for (const frame of record.frames) {
    if (frame.kind !== "social") continue;
    const scene = sceneSchema.parse(frame.scene);
    const next = syncCopyScene(scene, copy, frame.copyOverride as Record<string, string>);
    if (JSON.stringify(next) === JSON.stringify(scene)) continue;
    await db
      .update(frames)
      .set({ scene: next, version: frame.version + 1, updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
  }
  return getAssetRecord(db, userId, assetId);
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
  const source = record.frames.find((frame) => frame.id === frameId);
  if (!source)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is gone." },
    };
  const index =
    record.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
  if (source.kind === "social") {
    await db.insert(frames).values({
      id: randomUUID(),
      assetId,
      name: name?.trim() || `${source.name} copy`,
      index,
      layers: [],
      kind: "social",
      width: source.width,
      height: source.height,
      presetId: source.presetId,
      scene: source.scene,
      copyOverride: source.copyOverride,
      status: "draft",
      version: 1,
    });
  } else {
    const buffer = frameToBuffer(
      source,
      source.width ?? record.width,
      source.height ?? record.height,
      record.palette as string[],
    );
    const copy = bufferToFrame(buffer, {
      id: randomUUID(),
      name: name?.trim() || `${source.name} copy`,
      index,
    });
    copy.layers = copy.layers.map((layer) => ({ ...layer, id: randomUUID() }));
    await db.insert(frames).values({
      id: copy.id,
      assetId,
      name: copy.name,
      index: copy.index,
      layers: copy.layers,
      kind: "sprite",
      width: source.width ?? record.width,
      height: source.height ?? record.height,
    });
  }
  await db.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
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
  const ordered = [...record.frames].sort((a, b) => a.index - b.index);
  const from = ordered.findIndex((frame) => frame.id === frameId);
  if (from === -1)
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is gone." },
    };
  const target = Math.max(0, Math.min(ordered.length - 1, toIndex));
  const [moving] = ordered.splice(from, 1);
  if (moving) ordered.splice(target, 0, moving);
  await db.transaction(async (tx) => {
    // A unique index guards (asset, index), so park the whole list above the
    // final range before writing the dense order.
    await tx
      .update(frames)
      .set({ index: sql`${frames.index} + 1000`, updatedAt: new Date() })
      .where(eq(frames.assetId, assetId));
    for (const [index, frame] of ordered.entries()) {
      await tx
        .update(frames)
        .set({ index, updatedAt: new Date() })
        .where(and(eq(frames.id, frame.id), eq(frames.assetId, assetId)));
    }
    await tx.update(assets).set({ updatedAt: new Date() }).where(eq(assets.id, assetId));
  });
  await recordAssetVersion(db, assetId, "frame-move", {
    ...record,
    frames: ordered,
  });
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
    const blank = createBuffer({
      width: record.width,
      height: record.height,
      palette: record.palette as string[],
      layerName: "pixels",
    });
    const added = bufferToFrame(blank, {
      id: randomUUID(),
      name: `frame-1`,
      index: 0,
    });
    await db.insert(frames).values({
      id: added.id,
      assetId,
      name: added.name,
      index: added.index,
      layers: added.layers,
      kind: "sprite",
      width: record.width,
      height: record.height,
    });
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

/**
 * The active-run guard shared by the store's restore and the API's routes.
 * A live run owns an asset through its thread (editor runs) or through its
 * frame_id (a workspace run that bound an asset mid-run keeps a project-scoped
 * thread, so only the frame pointer identifies the asset it is drawing on).
 */
export async function assetHasActiveRun(db: Database, assetId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: generationRuns.id })
    .from(generationRuns)
    .innerJoin(generationThreads, eq(generationRuns.threadId, generationThreads.id))
    .leftJoin(frames, eq(frames.id, generationRuns.frameId))
    .where(
      and(
        inArray(generationRuns.status, ["queued", "running", "waiting"]),
        or(eq(generationThreads.assetId, assetId), eq(frames.assetId, assetId)),
      ),
    )
    .limit(1);
  if (run !== undefined) return true;
  // A task is active from the moment it is submitted; its child runs may not
  // exist yet, so the task row is checked too (live finding: two tasks for one
  // asset slipped through in the 100 ms before the plan child bound).
  const [task] = await db
    .select({ id: runTasks.id })
    .from(runTasks)
    .where(
      and(
        inArray(runTasks.status, ["queued", "running", "waiting"]),
        or(
          eq(runTasks.assetId, assetId),
          inArray(
            runTasks.threadId,
            db
              .select({ id: generationThreads.id })
              .from(generationThreads)
              .where(eq(generationThreads.assetId, assetId)),
          ),
        ),
      ),
    )
    .limit(1);
  return task !== undefined;
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
  if (!Array.isArray(layers)) return undefined;
  if (layers.length === 0) {
    // Social snapshots carry a scene instead of pixel layers.
    return typeof item === "object" && "social" in item
      ? { name, layers: [] }
      : undefined;
  }
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
function socialSnapshotFrom(snapshot: unknown):
  | {
      scene: ArtboardScene;
      copyOverride: Record<string, string>;
      status: "draft" | "ready" | "needs-fix";
    }
  | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const social = (snapshot as { social?: unknown }).social;
  if (typeof social !== "object" || social === null) return undefined;
  const item = social as {
    scene?: unknown;
    copyOverride?: unknown;
    status?: unknown;
  };
  try {
    const scene = sceneSchema.parse(item.scene);
    const copyOverride =
      typeof item.copyOverride === "object" && item.copyOverride !== null
        ? (item.copyOverride as Record<string, string>)
        : {};
    const status =
      item.status === "ready" || item.status === "needs-fix" ? item.status : "draft";
    return { scene, copyOverride, status };
  } catch {
    return undefined;
  }
}

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
    if (frame.kind === "social") {
      const social = socialSnapshotFrom(version.snapshot);
      if (!social) {
        return {
          asset: undefined,
          failure: {
            code: "INVALID_VERSION",
            message: "That frame version's scene is malformed.",
          },
        };
      }
      await db
        .update(frames)
        .set({
          name: frame.name,
          scene: social.scene,
          copyOverride: social.copyOverride,
          status: social.status,
          version: frame.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(frames.id, frameId), eq(frames.assetId, assetId)));
      await db
        .update(assets)
        .set({ updatedAt: new Date() })
        .where(eq(assets.id, assetId));
      return { asset: await getAssetRecord(db, userId, assetId) };
    }
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
    setId?: string;
    prompt?: string;
    durableRunId?: string;
    status: string;
    mode?: "draw" | "ask" | "compose";
  },
) {
  const id = randomUUID();
  await db.insert(generationRuns).values({ id, ...input });
  return id;
}

/**
 * The task row for one drawing request. The API owns the public id (the same
 * id the web streams), and the worker records the durable task id on it.
 */
export async function insertTaskRecord(
  db: Database,
  input: {
    id: string;
    threadId: string;
    assetId?: string;
    shape: {
      workers: number;
      review: boolean;
      source?: string;
      followUp?: {
        prompt: string;
        modelId: string;
        reasoningEffort: string;
        userId: string;
        threadId: string;
        started?: boolean;
      };
    };
  },
) {
  await db.insert(runTasks).values({
    id: input.id,
    threadId: input.threadId,
    ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
    status: "queued",
    phase: "plan",
    shape: input.shape,
  });
  return input.id;
}

export async function setTaskDurableId(
  db: Database,
  id: string,
  durableTaskId: string,
): Promise<void> {
  await db
    .update(runTasks)
    .set({ durableTaskId, status: "running" })
    .where(eq(runTasks.id, id));
}

export async function failTask(db: Database, id: string, reason: string): Promise<void> {
  await db
    .update(runTasks)
    .set({ status: "failed", finishedAt: new Date() })
    .where(eq(runTasks.id, id));
  void reason;
}

export async function taskBelongsTo(
  db: Database,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runTasks.id })
    .from(runTasks)
    .innerJoin(generationThreads, eq(runTasks.threadId, generationThreads.id))
    .where(and(eq(runTasks.id, taskId), eq(generationThreads.userId, userId)));
  return row !== undefined;
}

/** The task row plus every child run, for the editor's snapshot endpoint. */
export async function taskSnapshot(db: Database, assetId: string) {
  const [task] = await db
    .select()
    .from(runTasks)
    .where(
      // Every terminal state counts too: the editor shows the asset's latest
      // task whatever happened to it, never a stale earlier one.
      and(
        eq(runTasks.assetId, assetId),
        inArray(runTasks.status, [
          "queued",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
        ]),
      ),
    )
    .orderBy(desc(runTasks.createdAt))
    .limit(1);
  if (task === undefined) return undefined;
  const children = await db
    .select({
      id: generationRuns.id,
      status: generationRuns.status,
      role: generationRuns.role,
      workerKey: generationRuns.workerKey,
      frameIds: generationRuns.frameIds,
      durableRunId: generationRuns.durableRunId,
      modelId: generationRuns.modelId,
      reasoningEffort: generationRuns.reasoningEffort,
    })
    .from(generationRuns)
    .where(eq(generationRuns.taskId, task.id))
    .orderBy(generationRuns.createdAt);
  const frameRows = await db
    .select({ id: frames.id, name: frames.name })
    .from(frames)
    .where(eq(frames.assetId, assetId));
  return { task, children, frameRows };
}

/** The newest generation's context window state, as the worker persisted it. */
export type SessionContext = {
  model: { modelId: string; context: { contextWindow: number } };
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
};

export type SessionUsage = {
  input: number;
  cached: number;
  output: number;
  total: number;
  cost: number;
  /** Agent wall time across every settled turn, in milliseconds. */
  elapsedMs: number;
  /** The latest generation's context state; null when none is known. */
  context: SessionContext | null;
  /** The model the newest generation used; null before the first model call. */
  modelId: string | null;
  /**
   * That model's catalog window, when the catalog declares one. The console's
   * empty context line prints `0 / 1M` from it before the first snapshot.
   */
  contextWindow: number | null;
};

type UsagePart = {
  input?: unknown;
  cached?: unknown;
  output?: unknown;
  total?: unknown;
  cost?: unknown;
  context?: unknown;
};

function sumNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reads the context state off a persisted usage blob. The worker writes it in
 * Anvia's `ContextUsage` shape; a malformed one reads as "no context", never
 * as a guess.
 */
function contextFromUsage(usage: UsagePart): SessionContext | null {
  const candidate = usage.context as
    | {
        model?: { modelId?: unknown; context?: { contextWindow?: unknown } };
        usedTokens?: unknown;
        remainingTokens?: unknown;
        usedPercent?: unknown;
        remainingPercent?: unknown;
      }
    | null
    | undefined;
  const modelId = candidate?.model?.modelId;
  const contextWindow = candidate?.model?.context?.contextWindow;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  if (!isFiniteNumber(contextWindow) || contextWindow <= 0) return null;
  if (
    !isFiniteNumber(candidate?.usedTokens) ||
    !isFiniteNumber(candidate?.remainingTokens) ||
    !isFiniteNumber(candidate?.usedPercent) ||
    !isFiniteNumber(candidate?.remainingPercent)
  ) {
    return null;
  }
  return {
    model: { modelId, context: { contextWindow } },
    usedTokens: candidate.usedTokens,
    remainingTokens: candidate.remainingTokens,
    usedPercent: candidate.usedPercent,
    remainingPercent: candidate.remainingPercent,
  };
}

/**
 * The whole asset conversation's settled spend: every finished task (its usage
 * already rolled up its children) plus every finished parentless run, the
 * summed agent wall time, and the newest context window state. Live rows stay
 * out — the console composes those from the run's own stream.
 */
export async function sessionUsageForThread(
  db: Database,
  threadId: string,
): Promise<SessionUsage> {
  const taskRows = await db
    .select({
      usage: runTasks.usage,
      createdAt: runTasks.createdAt,
      finishedAt: runTasks.finishedAt,
    })
    .from(runTasks)
    .where(and(eq(runTasks.threadId, threadId), isNotNull(runTasks.finishedAt)));
  const runRows = await db
    .select({
      usage: generationRuns.usage,
      createdAt: generationRuns.createdAt,
      finishedAt: generationRuns.finishedAt,
    })
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.threadId, threadId),
        // A task's children are already inside the task's rollup.
        isNull(generationRuns.taskId),
        isNotNull(generationRuns.finishedAt),
      ),
    );
  // The newest generation names the model the conversation last used. Its
  // catalog window lets the header print `0 / 1M` before a snapshot exists.
  const [newestRun] = await db
    .select({
      modelId: generationRuns.modelId,
      contextWindow: models.contextWindow,
    })
    .from(generationRuns)
    .leftJoin(models, eq(models.id, generationRuns.modelId))
    .where(eq(generationRuns.threadId, threadId))
    .orderBy(desc(generationRuns.createdAt))
    .limit(1);
  const totals: SessionUsage = {
    input: 0,
    cached: 0,
    output: 0,
    total: 0,
    cost: 0,
    elapsedMs: 0,
    context: null,
    modelId: newestRun?.modelId ?? null,
    contextWindow: newestRun?.contextWindow ?? null,
  };
  // Settled rows in finish order: the last context state is the newest one.
  const settled = [...taskRows, ...runRows].sort(
    (left, right) =>
      (left.finishedAt?.getTime() ?? 0) - (right.finishedAt?.getTime() ?? 0),
  );
  for (const row of settled) {
    const usage = (row.usage ?? {}) as UsagePart;
    totals.input += sumNumber(usage.input);
    totals.cached += sumNumber(usage.cached);
    totals.output += sumNumber(usage.output);
    totals.total += sumNumber(usage.total);
    totals.cost += sumNumber(usage.cost);
    if (row.finishedAt && row.createdAt) {
      totals.elapsedMs += Math.max(0, row.finishedAt.getTime() - row.createdAt.getTime());
    }
    const context = contextFromUsage(usage);
    if (context !== null) totals.context = context;
  }
  return totals;
}

export type ProposalRow = typeof runProposals.$inferSelect;

export type ProposalInput = {
  userId: string;
  prompt: string;
  intent: string;
  project: { id: string | "new"; confidence: number };
  asset?: { id: string | "new"; confidence: number };
  guardrail: unknown;
  decision: unknown;
  expiresAt: Date;
};

/** Hold a home decision between the proposal response and the confirm. */
export async function insertProposal(
  db: Database,
  input: ProposalInput,
): Promise<ProposalRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(runProposals)
    .values({
      id,
      userId: input.userId,
      prompt: input.prompt,
      intent: input.intent,
      projectId: input.project.id,
      assetId: input.asset?.id ?? null,
      projectConfidence: input.project.confidence,
      assetConfidence: input.asset?.confidence ?? null,
      guardrail: input.guardrail as never,
      decision: input.decision as never,
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error("The proposal could not be stored.");
  return row;
}

/** One-shot: an expired, consumed, or foreign proposal fails with its cause. */
export async function consumeProposal(
  db: Database,
  userId: string,
  id: string,
): Promise<{ proposal: ProposalRow } | { failure: StoreFailure }> {
  // Atomic: only an unconsumed row can be claimed, so two parallel confirms
  // cannot both start a run.
  const [claimed] = await db
    .update(runProposals)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(runProposals.id, id),
        eq(runProposals.userId, userId),
        isNull(runProposals.consumedAt),
      ),
    )
    .returning();
  if (claimed) {
    if (claimed.expiresAt.getTime() <= Date.now()) {
      return {
        failure: {
          code: "PROPOSAL_EXPIRED",
          message: "That proposal expired; send the prompt again.",
        },
      };
    }
    return { proposal: claimed };
  }
  // The claim failed: name why from the current row.
  const [row] = await db
    .select()
    .from(runProposals)
    .where(and(eq(runProposals.id, id), eq(runProposals.userId, userId)));
  if (!row) {
    return { failure: { code: "NOT_FOUND", message: "That proposal is not available." } };
  }
  if (row.consumedAt !== null) {
    return {
      failure: { code: "PROPOSAL_CONSUMED", message: "That proposal was already used." },
    };
  }
  return {
    failure: {
      code: "PROPOSAL_EXPIRED",
      message: "That proposal expired; send the prompt again.",
    },
  };
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

function mapScenePalette(
  scene: ArtboardScene,
  source: string[],
  target: string[],
): ArtboardScene {
  return mapSceneIndices(scene, paletteIndexMap(source, target));
}
export async function importFrameRecord(
  db: Database,
  userId: string,
  targetAssetId: string,
  sourceAssetId: string,
  sourceFrameId: string,
  name?: string,
): Promise<{ asset: AssetRecord | undefined; frameId?: string; failure?: StoreFailure }> {
  const target = await getAssetRecord(db, userId, targetAssetId);
  const source = await getAssetRecord(db, userId, sourceAssetId);
  if (!target || !source) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That asset is not available." },
    };
  }
  const sourceFrame = source.frames.find((frame) => frame.id === sourceFrameId);
  if (!sourceFrame) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That source frame is not available." },
    };
  }
  const index =
    target.frames.reduce((highest, frame) => Math.max(highest, frame.index), -1) + 1;
  const id = randomUUID();
  if (sourceFrame.kind === "social") {
    if (!sourceFrame.scene || !sourceFrame.presetId) {
      return {
        asset: undefined,
        failure: { code: "INVALID_FRAME", message: "That frame has no scene." },
      };
    }
    const scene = mapScenePalette(
      sceneSchema.parse(sourceFrame.scene),
      source.palette as string[],
      target.palette as string[],
    );
    const preset = getPreset(sourceFrame.presetId);
    await db.insert(frames).values({
      id,
      assetId: targetAssetId,
      name: name?.trim() || `${sourceFrame.name} (${source.name})`,
      index,
      layers: [],
      kind: "social",
      width: sourceFrame.width ?? preset.width,
      height: sourceFrame.height ?? preset.height,
      presetId: preset.id,
      scene,
      copyOverride: sourceFrame.copyOverride,
      status: "draft",
      version: 1,
    });
    await recordSocialVersion(db, targetAssetId, id, "import", {
      name: name?.trim() || `${sourceFrame.name} (${source.name})`,
      presetId: preset.id,
      width: sourceFrame.width ?? preset.width,
      height: sourceFrame.height ?? preset.height,
      scene,
      copyOverride: sourceFrame.copyOverride,
      status: "draft",
    });
    if (
      Object.keys(target.copy as CopyDeck).length === 0 &&
      Object.keys(source.copy as CopyDeck).length > 0
    ) {
      await db
        .update(assets)
        .set({ copy: source.copy, updatedAt: new Date() })
        .where(eq(assets.id, targetAssetId));
    }
  } else {
    const width = sourceFrame.width ?? source.width;
    const height = sourceFrame.height ?? source.height;
    if (width !== target.width || height !== target.height) {
      return {
        asset: undefined,
        failure: {
          code: "FRAME_SIZE_MISMATCH",
          message: `That frame is ${width}×${height}; this asset's canvas is ${target.width}×${target.height}.`,
        },
      };
    }
    const buffer = frameToBuffer(sourceFrame, width, height, source.palette as string[]);
    const mapping = paletteIndexMap(
      source.palette as string[],
      target.palette as string[],
    );
    const mapped = {
      ...buffer,
      palette: [...(target.palette as string[])],
      layers: buffer.layers.map((layer) => ({
        ...layer,
        id: randomUUID(),
        pixels: layer.pixels.map((value) => mapping[value] ?? 0),
      })),
    };
    const copy = bufferToFrame(mapped, {
      id,
      name: name?.trim() || `${sourceFrame.name} (${source.name})`,
      index,
    });
    await db.insert(frames).values({
      id: copy.id,
      assetId: targetAssetId,
      name: copy.name,
      index: copy.index,
      layers: copy.layers,
      kind: "sprite",
      width,
      height,
    });
  }
  await db
    .update(assets)
    .set({ updatedAt: new Date() })
    .where(eq(assets.id, targetAssetId));
  return { asset: await getAssetRecord(db, userId, targetAssetId), frameId: id };
}

export async function importPaletteRecord(
  db: Database,
  userId: string,
  targetAssetId: string,
  sourceAssetId: string,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const target = await getAssetRecord(db, userId, targetAssetId);
  const source = await getAssetRecord(db, userId, sourceAssetId);
  if (!target || !source) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That asset is not available." },
    };
  }
  if (target.paletteLocked) {
    return {
      asset: undefined,
      failure: {
        code: "PALETTE_LOCKED",
        message: "The palette is locked for this asset.",
      },
    };
  }
  const nextPalette = source.palette as string[];
  if (nextPalette.length < 2) {
    return {
      asset: undefined,
      failure: { code: "INVALID_PALETTE", message: "The source palette is empty." },
    };
  }
  const mapping = paletteIndexMap(target.palette as string[], nextPalette);
  for (const frame of target.frames) {
    if (frame.kind === "social") {
      if (!frame.scene) continue;
      const scene = mapScenePalette(
        sceneSchema.parse(frame.scene),
        target.palette as string[],
        nextPalette,
      );
      await db
        .update(frames)
        .set({ scene, version: frame.version + 1, updatedAt: new Date() })
        .where(eq(frames.id, frame.id));
      continue;
    }
    const width = frame.width ?? target.width;
    const height = frame.height ?? target.height;
    const buffer = frameToBuffer(frame, width, height, target.palette as string[]);
    const mapped = {
      ...buffer,
      palette: [...nextPalette],
      layers: buffer.layers.map((layer) => ({
        ...layer,
        pixels: layer.pixels.map((value) => mapping[value] ?? 0),
      })),
    };
    const copy = bufferToFrame(mapped, {
      id: frame.id,
      name: frame.name,
      index: frame.index,
    });
    await db
      .update(frames)
      .set({ layers: copy.layers, updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
  }
  await db
    .update(assets)
    .set({ palette: nextPalette, updatedAt: new Date() })
    .where(eq(assets.id, targetAssetId));
  return { asset: await getAssetRecord(db, userId, targetAssetId) };
}

async function projectSpriteSources(
  db: Database,
  userId: string,
  projectId: string,
): Promise<Map<string, SpriteSource>> {
  const project = await getProjectRecord(db, userId, projectId);
  if (!project) return new Map();
  const sprites = new Map<string, SpriteSource>();
  for (const summary of project.assets) {
    const asset = await getAssetRecord(db, userId, summary.id);
    if (!asset) continue;
    for (const frame of asset.frames) {
      if (frame.kind === "social") continue;
      const width = frame.width ?? asset.width;
      const height = frame.height ?? asset.height;
      sprites.set(`${asset.id}:${frame.id}`, {
        assetId: asset.id,
        assetName: asset.name,
        frameId: frame.id,
        frameName: frame.name,
        buffer: frameToBuffer(frame, width, height, asset.palette as string[]),
      });
    }
  }
  return sprites;
}

export async function renderSocialFrameRecord(
  db: Database,
  userId: string,
  assetId: string,
  frameId: string,
): Promise<
  | { image: PaletteImage; name: string; width: number; height: number; failure?: never }
  | { failure: StoreFailure }
> {
  const asset = await getAssetRecord(db, userId, assetId);
  if (!asset) {
    return { failure: { code: "NOT_FOUND", message: "That asset is not available." } };
  }
  const frame = asset.frames.find((item) => item.id === frameId);
  if (!frame || frame.kind !== "social" || !frame.presetId || !frame.scene) {
    return {
      failure: { code: "NOT_FOUND", message: "That frame is not available." },
    };
  }
  const preset = getPreset(frame.presetId);
  const sprites = await projectSpriteSources(db, userId, asset.projectId);
  try {
    const rendered = renderScene({
      scene: sceneSchema.parse(frame.scene),
      preset,
      palette: asset.palette as string[],
      sprites,
    });
    return {
      image: rendered.image,
      name: frame.name,
      width: preset.width,
      height: preset.height,
    };
  } catch (reason) {
    return {
      failure: {
        code: "RENDER_FAILED",
        message: reason instanceof Error ? reason.message : "The frame could not render.",
      },
    };
  }
}

export async function copySocialBackgroundRecord(
  db: Database,
  userId: string,
  targetAssetId: string,
  targetFrameId: string,
  sourceAssetId: string,
  sourceFrameId: string,
): Promise<{ asset: AssetRecord | undefined; failure?: StoreFailure }> {
  const target = await getAssetRecord(db, userId, targetAssetId);
  const source = await getAssetRecord(db, userId, sourceAssetId);
  if (!target || !source) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That asset is not available." },
    };
  }
  const frame = target.frames.find(
    (item) => item.id === targetFrameId && item.kind === "social",
  );
  const sourceFrame = source.frames.find(
    (item) => item.id === sourceFrameId && item.kind === "social",
  );
  if (!frame || !sourceFrame?.scene) {
    return {
      asset: undefined,
      failure: { code: "NOT_FOUND", message: "That frame is not available." },
    };
  }
  const sourceScene = sceneSchema.parse(sourceFrame.scene);
  const targetScene = sceneSchema.parse(frame.scene);
  const mapping = paletteIndexMap(source.palette as string[], target.palette as string[]);
  const mapColor = (value: number) => mapping[value] ?? 0;
  const background: typeof targetScene.background =
    sourceScene.background.kind === "solid"
      ? { ...sourceScene.background, color: mapColor(sourceScene.background.color) }
      : sourceScene.background.kind === "pattern"
        ? {
            ...sourceScene.background,
            colorA: mapColor(sourceScene.background.colorA),
            colorB: mapColor(sourceScene.background.colorB),
          }
        : sourceScene.background;
  const [updated] = await db
    .update(frames)
    .set({
      scene: { ...targetScene, background },
      version: frame.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(frames.id, frame.id))
    .returning();
  if (updated) {
    await recordSocialVersion(db, targetAssetId, frame.id, "edit", updated);
  }
  await db
    .update(assets)
    .set({ updatedAt: new Date() })
    .where(eq(assets.id, targetAssetId));
  return { asset: await getAssetRecord(db, userId, targetAssetId) };
}

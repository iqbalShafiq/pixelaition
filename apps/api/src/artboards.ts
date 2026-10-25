import { randomUUID } from "node:crypto";
import {
  artboardSets,
  artboardVersions,
  artboards,
  assets,
  projects,
  type Database,
} from "@pixelaition/db";
import {
  buildTemplateScene,
  checkScene,
  getPreset,
  renderScene,
  sceneSchema,
  syncCopyScene,
  upgradeScene,
  type Artboard,
  type ArtboardCheck,
  type ArtboardScene,
  type ArtboardSet,
  type CopyDeck,
  type CopyOverride,
  type FormatPreset,
  type PaletteImage,
  type SetWithArtboards,
  type SpriteSource,
  type TemplateId,
} from "@pixelaition/artboard";
import { encodeArtboard } from "@pixelaition/export";
import { frameToBuffer, type Frame, type FrameBuffer } from "@pixelaition/pixel";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { getAssetRecord } from "./store.js";

/** A new kit starts with the formats that prove the idea in one look. */
export const DEFAULT_SET_PRESETS = [
  "linkedin-profile",
  "linkedin-cover",
  "instagram-post",
  "instagram-reel",
  "youtube-thumbnail",
] as const;

export type ArtboardSetDto = Omit<ArtboardSet, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
  artboardCount?: number;
};

export type ArtboardDto = Omit<Artboard, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export function toSetDto(
  row: typeof artboardSets.$inferSelect,
  artboardCount?: number,
): ArtboardSetDto {
  return {
    id: row.id,
    projectId: row.projectId,
    assetId: row.assetId,
    name: row.name,
    copy: row.copy as CopyDeck,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(artboardCount !== undefined ? { artboardCount } : {}),
  };
}

export function toArtboardDto(
  row: typeof artboards.$inferSelect,
  palette?: string[],
): ArtboardDto {
  const parsed = sceneSchema.parse(row.scene);
  return {
    id: row.id,
    setId: row.setId,
    presetId: row.presetId,
    name: row.name,
    width: row.width,
    height: row.height,
    pixelUnit: row.pixelUnit,
    scene: palette ? upgradeScene(parsed, palette) : parsed,
    copyOverride: row.copyOverride as CopyOverride,
    status: row.status as Artboard["status"],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listArtboardSets(db: Database, userId: string, projectId?: string) {
  const rows = await db
    .select({
      set: artboardSets,
      artboardCount: count(artboards.id),
    })
    .from(artboardSets)
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .leftJoin(artboards, eq(artboards.setId, artboardSets.id))
    .where(
      projectId === undefined
        ? eq(projects.userId, userId)
        : and(eq(projects.userId, userId), eq(artboardSets.projectId, projectId)),
    )
    .groupBy(artboardSets.id)
    .orderBy(desc(artboardSets.updatedAt));
  return rows.map((row) => toSetDto(row.set, row.artboardCount));
}

export async function getArtboardSet(
  db: Database,
  userId: string,
  setId: string,
): Promise<SetWithArtboards | undefined> {
  const [row] = await db
    .select({ set: artboardSets, palette: assets.palette })
    .from(artboardSets)
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .innerJoin(assets, eq(assets.id, artboardSets.assetId))
    .where(and(eq(artboardSets.id, setId), eq(projects.userId, userId)));
  if (!row) return undefined;
  const rows = await db
    .select()
    .from(artboards)
    .where(eq(artboards.setId, setId))
    .orderBy(asc(artboards.createdAt), asc(artboards.id));
  return {
    ...toSetDto(row.set),
    artboards: rows.map((item) => toArtboardDto(item, row.palette as string[])),
  };
}

export async function createArtboardSet(
  db: Database,
  userId: string,
  input: {
    projectId: string;
    assetId: string;
    name?: string;
    presetIds?: string[];
    copy?: CopyDeck;
  },
): Promise<{ set?: SetWithArtboards; failure?: { code: string; message: string } }> {
  const asset = await getAssetRecord(db, userId, input.assetId);
  if (!asset || asset.projectId !== input.projectId) {
    return {
      failure: { code: "NOT_FOUND", message: "That asset is not in this project." },
    };
  }
  const presetIds =
    input.presetIds && input.presetIds.length > 0
      ? input.presetIds
      : [...DEFAULT_SET_PRESETS];
  const presets: FormatPreset[] = [];
  for (const presetId of presetIds) {
    try {
      presets.push(getPreset(presetId));
    } catch (reason) {
      return {
        failure: {
          code: "UNKNOWN_FORMAT",
          message: reason instanceof Error ? reason.message : "Unknown format.",
        },
      };
    }
  }
  const source = primarySprite(asset, asset.frames[0]?.id);
  const copy = input.copy ?? defaultCopy(asset.name, asset.projectName);
  const id = randomUUID();
  await db.insert(artboardSets).values({
    id,
    projectId: input.projectId,
    assetId: input.assetId,
    name: input.name?.trim() || `${asset.name} social kit`,
    copy,
  });
  for (const preset of presets) {
    const scene = buildTemplateScene({
      preset,
      template: preset.defaultTemplate,
      copy,
      palette: asset.palette as string[],
      ...(source ? { sprite: source } : {}),
    });
    await db.insert(artboards).values({
      id: randomUUID(),
      setId: id,
      presetId: preset.id,
      name: preset.label,
      width: preset.width,
      height: preset.height,
      pixelUnit: preset.pixelUnit,
      scene,
      copyOverride: {},
      status: "draft",
      version: 1,
    });
  }
  const created = await getArtboardSet(db, userId, id);
  return created
    ? { set: created }
    : { failure: { code: "NOT_FOUND", message: "The set was not saved." } };
}

export async function updateArtboardSet(
  db: Database,
  userId: string,
  setId: string,
  input: { name?: string; copy?: CopyDeck },
): Promise<
  | { set: SetWithArtboards; changed: number }
  | { failure: { code: string; message: string } }
> {
  const existing = await getArtboardSet(db, userId, setId);
  if (!existing)
    return { failure: { code: "NOT_FOUND", message: "That set is not available." } };
  const nextCopy = input.copy ?? existing.copy;
  await db
    .update(artboardSets)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.copy !== undefined ? { copy: nextCopy } : {}),
      updatedAt: new Date(),
    })
    .where(eq(artboardSets.id, setId));
  let changed = 0;
  if (input.copy !== undefined) {
    for (const artboard of existing.artboards) {
      const scene = syncCopyScene(artboard.scene, nextCopy, artboard.copyOverride);
      if (JSON.stringify(scene) === JSON.stringify(artboard.scene)) continue;
      await db.insert(artboardVersions).values({
        id: randomUUID(),
        setId,
        artboardId: artboard.id,
        scope: "artboard",
        kind: "copy-sync",
        author: "user",
        runId: null,
        snapshot: { scene: artboard.scene, name: artboard.name },
      });
      await db
        .update(artboards)
        .set({ scene, version: artboard.version + 1, updatedAt: new Date() })
        .where(eq(artboards.id, artboard.id));
      changed += 1;
    }
  }
  const updated = await getArtboardSet(db, userId, setId);
  if (!updated)
    return { failure: { code: "NOT_FOUND", message: "That set is not available." } };
  return { set: updated, changed };
}

export async function createArtboard(
  db: Database,
  userId: string,
  setId: string,
  input: { presetId: string; name?: string; template?: TemplateId; copy?: CopyDeck },
): Promise<
  | { artboard: ArtboardDto; set: SetWithArtboards }
  | { failure: { code: string; message: string } }
> {
  const set = await getArtboardSet(db, userId, setId);
  if (!set)
    return { failure: { code: "NOT_FOUND", message: "That set is not available." } };
  const asset = await getAssetRecord(db, userId, set.assetId);
  if (!asset)
    return { failure: { code: "NOT_FOUND", message: "The set's asset is missing." } };
  let preset: FormatPreset;
  try {
    preset = getPreset(input.presetId);
  } catch (reason) {
    return {
      failure: {
        code: "UNKNOWN_FORMAT",
        message: reason instanceof Error ? reason.message : "Unknown format.",
      },
    };
  }
  const copy = input.copy ?? set.copy;
  const source = primarySprite(asset, asset.frames[0]?.id);
  const scene = buildTemplateScene({
    preset,
    template: input.template ?? preset.defaultTemplate,
    copy,
    palette: asset.palette as string[],
    ...(source ? { sprite: source } : {}),
  });
  const id = randomUUID();
  await db.insert(artboards).values({
    id,
    setId,
    presetId: preset.id,
    name: input.name?.trim() || preset.label,
    width: preset.width,
    height: preset.height,
    pixelUnit: preset.pixelUnit,
    scene,
    copyOverride: {},
    status: "draft",
    version: 1,
  });
  const updated = await getArtboardSet(db, userId, setId);
  const artboard = updated?.artboards.find((item) => item.id === id);
  if (!updated || !artboard) {
    return { failure: { code: "NOT_FOUND", message: "The artboard was not saved." } };
  }
  return { artboard, set: updated };
}

export async function updateArtboard(
  db: Database,
  userId: string,
  artboardId: string,
  input: {
    name?: string;
    scene?: ArtboardScene;
    copyOverride?: CopyOverride;
    status?: Artboard["status"];
    version: number;
    author?: "user" | "agent";
    runId?: string;
  },
): Promise<
  | { artboard: ArtboardDto; set: SetWithArtboards }
  | { failure: { code: string; message: string } }
> {
  const [row] = await db
    .select({ artboard: artboards, set: artboardSets, palette: assets.palette })
    .from(artboards)
    .innerJoin(artboardSets, eq(artboardSets.id, artboards.setId))
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .innerJoin(assets, eq(assets.id, artboardSets.assetId))
    .where(and(eq(artboards.id, artboardId), eq(projects.userId, userId)));
  if (!row)
    return { failure: { code: "NOT_FOUND", message: "That artboard is not available." } };
  if (row.artboard.version !== input.version) {
    return {
      failure: {
        code: "VERSION_CONFLICT",
        message: `This artboard changed (expected version ${input.version}, current ${row.artboard.version}). Reload it.`,
      },
    };
  }
  const nextScene = input.scene ?? (row.artboard.scene as ArtboardScene);
  const scene = upgradeScene(sceneSchema.parse(nextScene), row.palette as string[]);
  const [written] = await db
    .update(artboards)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.copyOverride !== undefined ? { copyOverride: input.copyOverride } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      scene,
      version: row.artboard.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(artboards.id, artboardId), eq(artboards.version, input.version)))
    .returning({ id: artboards.id });
  if (!written) {
    return {
      failure: {
        code: "VERSION_CONFLICT",
        message: "This artboard changed while it was being saved. Reload it.",
      },
    };
  }
  await db.insert(artboardVersions).values({
    id: randomUUID(),
    setId: row.set.id,
    artboardId,
    scope: "artboard",
    kind: "update",
    author: input.author ?? "user",
    runId: input.runId ?? null,
    snapshot: { scene: row.artboard.scene, name: row.artboard.name },
  });
  await db
    .update(artboardSets)
    .set({ updatedAt: new Date() })
    .where(eq(artboardSets.id, row.set.id));
  const set = await getArtboardSet(db, userId, row.set.id);
  const artboard = set?.artboards.find((item) => item.id === artboardId);
  if (!set || !artboard) {
    return { failure: { code: "NOT_FOUND", message: "That artboard is not available." } };
  }
  return { artboard, set };
}

export async function deleteArtboard(
  db: Database,
  userId: string,
  artboardId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: artboards.id, setId: artboards.setId })
    .from(artboards)
    .innerJoin(artboardSets, eq(artboardSets.id, artboards.setId))
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .where(and(eq(artboards.id, artboardId), eq(projects.userId, userId)));
  if (!row) return false;
  await db.delete(artboards).where(eq(artboards.id, artboardId));
  await db
    .update(artboardSets)
    .set({ updatedAt: new Date() })
    .where(eq(artboardSets.id, row.setId));
  return true;
}

export async function deleteArtboardSet(
  db: Database,
  userId: string,
  setId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: artboardSets.id })
    .from(artboardSets)
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .where(and(eq(artboardSets.id, setId), eq(projects.userId, userId)));
  if (!row) return false;
  await db.delete(artboardSets).where(eq(artboardSets.id, setId));
  return true;
}

export type RenderedArtboard = {
  artboard: ArtboardDto;
  preset: FormatPreset;
  image: PaletteImage;
  checks: ArtboardCheck[];
  bytes: number;
  format: "png" | "jpg";
};

/** Load the set's sprite frames once, keyed for the renderer. */
export async function spritesForSet(
  db: Database,
  userId: string,
  set: SetWithArtboards,
): Promise<
  | {
      assetId: string;
      assetName: string;
      palette: string[];
      sprites: Map<string, SpriteSource>;
      missing: string[];
    }
  | undefined
> {
  const asset = await getAssetRecord(db, userId, set.assetId);
  if (!asset) return undefined;
  const sprites = new Map<string, SpriteSource>();
  for (const frame of asset.frames) {
    const buffer = frameToBuffer(
      frame as Frame,
      asset.width,
      asset.height,
      asset.palette as string[],
    );
    sprites.set(`${asset.id}:${frame.id}`, {
      assetId: asset.id,
      assetName: asset.name,
      frameId: frame.id,
      frameName: frame.name,
      buffer,
    });
  }
  return {
    assetId: asset.id,
    assetName: asset.name,
    palette: asset.palette as string[],
    sprites,
    missing: [],
  };
}

export async function renderArtboardRecord(
  db: Database,
  userId: string,
  artboardId: string,
  preferredFormat: "png" | "jpg" = "png",
): Promise<
  | { rendered: RenderedArtboard; set: SetWithArtboards }
  | { failure: { code: string; message: string } }
> {
  const [row] = await db
    .select({ artboard: artboards, set: artboardSets })
    .from(artboards)
    .innerJoin(artboardSets, eq(artboardSets.id, artboards.setId))
    .innerJoin(projects, eq(projects.id, artboardSets.projectId))
    .where(and(eq(artboards.id, artboardId), eq(projects.userId, userId)));
  if (!row)
    return { failure: { code: "NOT_FOUND", message: "That artboard is not available." } };
  const set = await getArtboardSet(db, userId, row.set.id);
  if (!set)
    return { failure: { code: "NOT_FOUND", message: "That set is not available." } };
  const context = await spritesForSet(db, userId, set);
  if (!context)
    return { failure: { code: "NOT_FOUND", message: "The set's asset is missing." } };
  const artboard = toArtboardDto(row.artboard);
  const preset = getPreset(artboard.presetId);
  if (preset.width !== artboard.width || preset.height !== artboard.height) {
    return {
      failure: {
        code: "PRESET_CHANGED",
        message: `This artboard was built for ${artboard.width}×${artboard.height}, but the ${preset.label} preset is now ${preset.width}×${preset.height}.`,
      },
    };
  }
  let image: PaletteImage;
  try {
    image = renderScene({
      scene: artboard.scene,
      preset,
      palette: context.palette,
      sprites: context.sprites,
    }).image;
  } catch (reason) {
    return {
      failure: {
        code: "RENDER_FAILED",
        message:
          reason instanceof Error
            ? reason.message
            : "The artboard could not be rendered.",
      },
    };
  }
  let format = preferredFormat;
  let bytes = encodeArtboard(image, format).length;
  if (preset.maxBytes !== null && bytes > preset.maxBytes && format === "png") {
    format = "jpg";
    bytes = encodeArtboard(image, format).length;
  }
  const checks = checkScene({
    scene: artboard.scene,
    preset,
    palette: context.palette,
    sprites: context.sprites,
    bytes,
  });
  return { rendered: { artboard, preset, image, checks, bytes, format }, set };
}

export async function renderSet(
  db: Database,
  userId: string,
  setId: string,
): Promise<
  | {
      set: SetWithArtboards;
      rendered: RenderedArtboard[];
      copy: CopyDeck;
      summary: { errors: number; warnings: number; ok: boolean };
    }
  | { failure: { code: string; message: string } }
> {
  const set = await getArtboardSet(db, userId, setId);
  if (!set)
    return { failure: { code: "NOT_FOUND", message: "That set is not available." } };
  const rendered: RenderedArtboard[] = [];
  for (const artboard of set.artboards) {
    const result = await renderArtboardRecord(db, userId, artboard.id);
    if ("failure" in result) return result;
    rendered.push(result.rendered);
  }
  const errors = rendered.reduce(
    (sum, item) => sum + item.checks.filter((check) => check.severity === "error").length,
    0,
  );
  const warnings = rendered.reduce(
    (sum, item) =>
      sum + item.checks.filter((check) => check.severity === "warning").length,
    0,
  );
  return {
    set,
    rendered,
    copy: set.copy,
    summary: { errors, warnings, ok: errors === 0 },
  };
}

export function defaultCopy(assetName: string, projectName: string): CopyDeck {
  return {
    eyebrow: projectName.toUpperCase().slice(0, 32),
    headline: assetName,
    subhead: "One mark, every feed.",
    cta: "Make yours",
    handle: `@${slug(projectName)}`,
  };
}

export function primarySprite(
  asset: NonNullable<Awaited<ReturnType<typeof getAssetRecord>>>,
  frameId: string | undefined,
): SpriteSource | undefined {
  const frame =
    asset.frames.find((item) => item.id === frameId && item.kind !== "social") ??
    asset.frames.find((item) => item.kind !== "social");
  if (!frame) return undefined;
  const buffer: FrameBuffer = frameToBuffer(
    frame as Frame,
    asset.width,
    asset.height,
    asset.palette as string[],
  );
  return {
    assetId: asset.id,
    assetName: asset.name,
    frameId: frame.id,
    frameName: frame.name,
    buffer,
  };
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "social"
  );
}

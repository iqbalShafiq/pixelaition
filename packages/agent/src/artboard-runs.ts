import type {
  Artboard,
  ArtboardSet,
  CopyDeck,
  SpriteSource,
} from "@pixelaition/artboard";

/**
 * The artboard task's live state. It mirrors the drawing run binding: tools
 * mutate this map, `save_artboard` is the only write, and the worker's DB
 * callbacks are injected so the agent package stays storage-free.
 */
export type ArtboardRunBinding = {
  setId: string;
  setName: string;
  projectId: string;
  assetId: string;
  assetName: string;
  palette: string[];
  copy: CopyDeck;
  artboards: Map<string, Artboard>;
  sprites: Map<string, SpriteSource>;
  currentArtboardId?: string;
  /** Worker/fix children only write the boards they were given. */
  ownedArtboardIds?: ReadonlySet<string>;
  role?: "art-director" | "layout";
  planApproved?: boolean;
  onSave?: (artboard: Artboard) => Promise<Artboard>;
  onCreate?: (input: {
    presetId: string;
    name?: string;
    template?: string;
    copy?: CopyDeck;
  }) => Promise<Artboard>;
  onDelete?: (artboardId: string) => Promise<void>;
  onSetCopy?: (copy: CopyDeck) => Promise<{ set: ArtboardSet; artboards: Artboard[] }>;
  onLoadSprite?: (assetId: string, frameId?: string) => Promise<SpriteSource | undefined>;
  /** A model that cannot see tool-result images gets the vision model's words. */
  onDescribeImage?: (image: { data: string; mediaType: string }) => Promise<string>;
};

const runs = new Map<string, ArtboardRunBinding>();

export function bindArtboardRun(runId: string, binding: ArtboardRunBinding): void {
  runs.set(runId, {
    ...binding,
    copy: { ...binding.copy },
    artboards: new Map(
      [...binding.artboards].map(([id, artboard]) => [
        id,
        {
          ...artboard,
          scene: {
            ...artboard.scene,
            elements: artboard.scene.elements.map((element) => ({ ...element })),
          },
        },
      ]),
    ),
    sprites: new Map(binding.sprites),
  });
}

export function releaseArtboardRun(runId: string): void {
  runs.delete(runId);
}

export function getArtboardRun(runId: string): ArtboardRunBinding | undefined {
  return runs.get(runId);
}

export function artboardRunIdFromOperation(operationId: string | undefined): string {
  if (!operationId) throw new Error("The social tools need a durable operation id.");
  const slash = operationId.indexOf("/");
  return slash === -1 ? operationId : operationId.slice(0, slash);
}

export function requireArtboardRun(operationId: string | undefined): ArtboardRunBinding {
  const run = getArtboardRun(artboardRunIdFromOperation(operationId));
  if (!run) throw new Error("This artboard run is no longer active.");
  return run;
}

export function resolveArtboard(run: ArtboardRunBinding, id?: string): Artboard {
  const wanted = id ?? run.currentArtboardId ?? [...run.artboards.keys()][0];
  if (!wanted) throw new Error("This set has no artboards yet.");
  const artboard =
    run.artboards.get(wanted) ??
    [...run.artboards.values()].find(
      (candidate) => candidate.name.trim().toLowerCase() === wanted.trim().toLowerCase(),
    );
  if (!artboard) {
    throw new Error(
      `No artboard named or identified by "${wanted}". Artboards: ${[...run.artboards.values()].map((item) => item.name).join(", ")}.`,
    );
  }
  return artboard;
}

export function assertOwnedArtboard(run: ArtboardRunBinding, artboardId: string): void {
  if (run.ownedArtboardIds !== undefined && !run.ownedArtboardIds.has(artboardId)) {
    throw new Error("That artboard belongs to another worker.");
  }
}

export function writeArtboard(run: ArtboardRunBinding, artboard: Artboard): void {
  run.artboards.set(artboard.id, artboard);
  run.currentArtboardId = artboard.id;
}

export function spriteFor(
  run: ArtboardRunBinding,
  assetId: string | undefined,
  frameId: string | undefined,
): SpriteSource | undefined {
  const wantedAsset = assetId ?? run.assetId;
  if (wantedAsset === run.assetId) {
    if (frameId) return run.sprites.get(`${run.assetId}:${frameId}`);
    return [...run.sprites.values()].find((source) => source.assetId === run.assetId);
  }
  if (frameId) return run.sprites.get(`${wantedAsset}:${frameId}`);
  return [...run.sprites.values()].find((source) => source.assetId === wantedAsset);
}

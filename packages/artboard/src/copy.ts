import type { CopyDeck, CopyOverride } from "./types.js";

/** The copy an artboard renders: the set's deck with only its explicit overrides. */
export function resolveCopy(copy: CopyDeck, override?: CopyOverride): CopyDeck {
  if (!override) return { ...copy };
  const merged: CopyDeck = { ...copy };
  for (const [key, value] of Object.entries(override) as Array<
    [keyof CopyDeck, string | undefined]
  >) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** The fields that carry a visible message; the caption is a post field. */
export function hasImageCopy(copy: CopyDeck): boolean {
  return Boolean(
    copy.eyebrow?.trim() ||
    copy.headline?.trim() ||
    copy.subhead?.trim() ||
    copy.cta?.trim() ||
    copy.handle?.trim(),
  );
}

export function copyLines(copy: CopyDeck): string[] {
  return [copy.eyebrow, copy.headline, copy.subhead, copy.cta, copy.handle, copy.legal]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

const COPY_KEYS: Array<keyof CopyDeck> = [
  "eyebrow",
  "headline",
  "subhead",
  "cta",
  "handle",
  "legal",
];

/**
 * Rewrite the text elements that are wired to the shared copy deck. A field
 * an artboard overrides is left alone; the caller owns that decision.
 */
export function syncCopyScene(
  scene: import("./types.js").ArtboardScene,
  copy: CopyDeck,
  override: CopyOverride = {},
): import("./types.js").ArtboardScene {
  const elements: import("./types.js").Element[] = [];
  for (const element of scene.elements) {
    if (element.kind !== "text") {
      elements.push(element);
      continue;
    }
    const key = element.id as keyof CopyDeck;
    if (
      !(element.id in copy) ||
      !COPY_KEYS.includes(key) ||
      override[key] !== undefined
    ) {
      elements.push(element);
      continue;
    }
    const value = copy[key]?.trim();
    if (value) elements.push({ ...element, text: value });
  }
  return { ...scene, elements };
}

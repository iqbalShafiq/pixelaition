import { availableSizes } from "./font.js";
import { layoutText } from "./text.js";
import type { CopyDeck, CopyOverride, TextElement } from "./types.js";

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
    if (value) elements.push(fitTextToSlot({ ...element, text: value }));
  }
  return { ...scene, elements };
}

/**
 * Refit a text element inside the slot the template reserved. A longer copy
 * steps down the atlas instead of growing into the next element; the box,
 * alignment and position stay the author's.
 */
export function fitTextToSlot(element: TextElement): TextElement {
  const sizes = availableSizes(element.face, element.weight)
    .filter((size) => size <= element.size)
    .sort((a, b) => b - a);
  const slotHeight =
    element.height ?? (element.maxLines ?? 3) * (element.lineHeight ?? element.size);
  let chosen = element;
  for (const size of sizes.length > 0 ? sizes : [element.size]) {
    const candidate = { ...element, size };
    const layout = layoutText(candidate);
    chosen = candidate;
    if (
      layout.height <= slotHeight &&
      (element.maxLines === undefined || layout.lines.length <= element.maxLines)
    ) {
      return candidate;
    }
  }
  return chosen;
}

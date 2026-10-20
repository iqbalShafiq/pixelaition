import { availableSizes } from "./font.js";
import { layoutText } from "./text.js";
import type {
  ArtboardScene,
  CopyDeck,
  CopyOverride,
  Element,
  TextElement,
} from "./types.js";

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
  scene: ArtboardScene,
  copy: CopyDeck,
  override: CopyOverride = {},
): ArtboardScene {
  const elements: Element[] = [];
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
    const value = copy[key]?.trim() ?? "";
    const nextTextY = scene.elements
      .filter(
        (candidate) =>
          candidate.kind === "text" &&
          candidate.id !== element.id &&
          candidate.y > element.y &&
          candidate.x < element.x + element.width &&
          candidate.x + candidate.width > element.x,
      )
      .sort((a, b) => a.y - b.y)[0]?.y;
    const slotHeight =
      element.height ??
      (nextTextY !== undefined ? Math.max(8, nextTextY - element.y - 2) : undefined);
    elements.push(fitTextToSlot({ ...element, text: value }, slotHeight));
  }
  return { ...scene, elements };
}

/**
 * Refit a text element inside the slot the template reserved. A longer copy
 * steps down the atlas instead of growing into the next element; the box,
 * alignment and position stay the author's.
 */
export function fitTextToSlot(element: TextElement, limit?: number): TextElement {
  const slotHeight =
    limit ??
    element.height ??
    (element.maxLines ?? 3) * (element.lineHeight ?? element.size);
  const effective = element.size * (element.scale ?? 1);
  // A board an agent composed may have a one-line slot even though the copy
  // slot can hold two or three lines. Let a shared-copy edit use the room it
  // actually has, but never turn a label into a paragraph.
  const cap = element.id === "headline" || element.id === "subhead" ? 3 : 2;
  const maxSize = Math.min(effective, Math.min(128, Math.floor(slotHeight / 1.1)));
  const sizes = availableSizes(element.face, element.weight)
    .filter((size) => size <= maxSize)
    .sort((a, b) => b - a);
  let chosen = element;
  let smallest = element;
  for (const size of sizes.length > 0 ? sizes : [element.size]) {
    const ratio =
      element.lineHeight !== undefined && element.size > 0
        ? element.lineHeight / element.size
        : 1.22;
    const lineHeight = Math.max(1, Math.round(size * ratio));
    const room = Math.max(1, Math.floor(slotHeight / Math.max(1, lineHeight)));
    const allowed = Math.min(cap, Math.max(element.maxLines ?? 1, room));
    const candidate = {
      ...element,
      size,
      scale: 1,
      lineHeight,
      maxLines: allowed,
    };
    const layout = layoutText(candidate);
    if (!smallest || size < smallest.size * (smallest.scale ?? 1)) {
      smallest = candidate;
    }
    chosen = candidate;
    if (layout.height <= slotHeight && layout.lines.length <= allowed) {
      return candidate;
    }
  }
  return sizes.length > 0 ? chosen : smallest;
}

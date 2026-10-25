import { availableSizes, missingGlyphs, resolveFont } from "./font.js";
import { elementBounds, hexToRgba } from "./render.js";
import { layoutText, textBounds } from "./text.js";
import type {
  ArtboardCheck,
  ArtboardScene,
  Element,
  FormatPreset,
  Rect,
  SpriteSource,
} from "./types.js";
import { frameKey } from "./types.js";

export type CheckInput = {
  scene: ArtboardScene;
  preset: FormatPreset;
  palette: string[];
  sprites?: Map<string, SpriteSource>;
  /** Encoded bytes, when the caller already rendered the image. */
  bytes?: number;
};

/**
 * The deterministic half of review. The model judges hierarchy and taste;
 * geometry, safe areas, palette membership, contrast and file size are decided
 * here so a reviewer never has to eyeball a number.
 */
export function checkScene(input: CheckInput): ArtboardCheck[] {
  const { scene, preset, palette, sprites, bytes } = input;
  const checks: ArtboardCheck[] = [];
  if (scene.version !== 1) {
    checks.push({
      code: "VERSION",
      severity: "error",
      message: `Unknown scene version ${String(scene.version)}.`,
    });
  }
  if (preset.width <= 0 || preset.height <= 0) {
    checks.push({
      code: "DIMENSION",
      severity: "error",
      message: "The format has no valid dimensions.",
    });
  }
  if (scene.elements.length === 0) {
    checks.push({
      code: "EMPTY",
      severity: "error",
      message: "The artboard has no elements.",
    });
  }
  if (scene.background.kind === "solid") {
    assertPalette(scene.background.color, palette.length, "background", checks);
  }
  if (scene.background.kind === "pattern") {
    assertPalette(scene.background.colorA, palette.length, "background colour A", checks);
    assertPalette(scene.background.colorB, palette.length, "background colour B", checks);
  }
  for (const element of scene.elements) {
    validateElement(element, scene, preset, palette, sprites, checks);
  }
  if (bytes !== undefined && preset.maxBytes !== null && bytes > preset.maxBytes) {
    checks.push({
      code: "FILE_SIZE",
      severity: "error",
      message: `The encoded file is ${formatBytes(bytes)}; this format allows ${formatBytes(
        preset.maxBytes,
      )}.`,
    });
  }
  return checks;
}

function validateElement(
  element: Element,
  scene: ArtboardScene,
  preset: FormatPreset,
  palette: string[],
  sprites: Map<string, SpriteSource> | undefined,
  checks: ArtboardCheck[],
): void {
  if (element.kind === "rect" || element.kind === "frame") {
    assertPalette(element.color, palette.length, element.kind, checks, element.id);
  }
  if (element.kind === "pattern") {
    assertPalette(element.colorA, palette.length, "pattern colour A", checks, element.id);
    assertPalette(element.colorB, palette.length, "pattern colour B", checks, element.id);
  }
  if (element.kind === "text") {
    validateText(element, scene, preset, palette, checks);
  }
  if (element.kind === "sprite") {
    const source =
      sprites?.get(frameKey(element.assetId, element.frameId ?? "")) ??
      findSprite(sprites, element.assetId, element.frameId);
    if (!source) {
      checks.push({
        code: "SPRITE_MISSING",
        severity: "error",
        message: `Sprite ${element.assetId}${element.frameId ? ` / ${element.frameId}` : ""} is not available.`,
        elementId: element.id,
      });
    } else if (!Number.isInteger(element.scale) || element.scale < 1) {
      checks.push({
        code: "SPRITE_SCALE",
        severity: "error",
        message: `Sprite scale ${element.scale} is not a whole number.`,
        elementId: element.id,
      });
    }
  }
  if (element.safe === false) return;
  const bounds = elementBounds(element, sprites);
  if (bounds.width <= 0 || bounds.height <= 0) {
    checks.push({
      code: "EMPTY",
      severity: "error",
      message: "An element has no visible bounds.",
      elementId: element.id,
    });
    return;
  }
  if (preset.safeZones.length > 0) {
    const inside = preset.safeZones.some((zone) => contains(zone, bounds));
    const circleSafe =
      preset.shape !== "circle" ||
      insideCircle(bounds, {
        x: 0,
        y: 0,
        width: preset.width,
        height: preset.height,
      });
    if (!inside || !circleSafe) {
      checks.push({
        code: "SAFE_ZONE",
        severity: "error",
        message: `${labelOf(element)} crosses the safe area of ${preset.label}.`,
        elementId: element.id,
      });
    }
  }
  for (const crop of preset.crops) {
    if (!contains(crop, bounds)) {
      checks.push({
        code: "CROP",
        severity: "warning",
        message: `${labelOf(element)} is outside the ${crop.label}.`,
        elementId: element.id,
      });
    }
  }
  for (const zone of preset.exclusions) {
    if (intersects(zone, bounds)) {
      checks.push({
        code: "EXCLUSION",
        severity: "error",
        message: `${labelOf(element)} overlaps ${zone.label}.`,
        elementId: element.id,
      });
    }
  }
}

function validateText(
  element: Extract<Element, { kind: "text" }>,
  scene: ArtboardScene,
  preset: FormatPreset,
  palette: string[],
  checks: ArtboardCheck[],
): void {
  assertPalette(element.color, palette.length, "text", checks, element.id);
  let font;
  try {
    font = resolveFont(element.face, element.weight, element.size);
  } catch {
    checks.push({
      code: "TEXT_SIZE",
      severity: "error",
      message: `${element.face} ${element.weight} has no ${element.size}px atlas. Choose ${availableSizes(
        element.face,
        element.weight,
      ).join(", ")}.`,
      elementId: element.id,
    });
    return;
  }
  const missing = missingGlyphs(font, element.text);
  if (missing.length > 0) {
    checks.push({
      code: "TEXT_GLYPH",
      severity: "error",
      message: `${element.face} cannot render ${missing.map((char) => `"${char}"`).join(", ")}.`,
      elementId: element.id,
    });
  }
  const layout = layoutText(element);
  if (element.maxLines !== undefined && layout.lines.length > element.maxLines) {
    checks.push({
      code: "TEXT_OVERFLOW",
      severity: "error",
      message: `${labelOf(element)} wraps to ${layout.lines.length} lines; the box allows ${element.maxLines}.`,
      elementId: element.id,
    });
  }
  if (element.height !== undefined && layout.height > element.height) {
    checks.push({
      code: "TEXT_OVERFLOW",
      severity: "error",
      message: `${labelOf(element)} is ${layout.height}px tall; its copy slot is ${element.height}px.`,
      elementId: element.id,
    });
  }
  if (preset.minTextSize > 0 && !["eyebrow", "handle", "legal"].includes(element.id)) {
    const effective = element.size * (element.scale ?? 1);
    if (effective < preset.minTextSize) {
      checks.push({
        code: "TEXT_TOO_SMALL",
        severity: "warning",
        message: `${labelOf(element)} is ${effective}px; ${preset.label} needs at least ${preset.minTextSize}px to read at thumbnail size.`,
        elementId: element.id,
      });
    }
  }
  const bounds = textBounds(element);
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > preset.width ||
    bounds.y + bounds.height > preset.height
  ) {
    checks.push({
      code: "CROP",
      severity: "error",
      message: `${labelOf(element)} runs outside the ${preset.label} canvas.`,
      elementId: element.id,
    });
  }
  if (scene.background.kind === "solid" && element.color < palette.length) {
    const ratio = contrastRatio(palette[element.color] ?? "#000000", [
      palette[scene.background.color] ?? "#000000",
    ]);
    if (ratio !== null && ratio < 4.5) {
      checks.push({
        code: "CONTRAST",
        severity: "warning",
        message: `${labelOf(element)} has ${ratio.toFixed(2)}:1 contrast against the background.`,
        elementId: element.id,
      });
    }
  }
}

function assertPalette(
  color: number,
  size: number,
  label: string,
  checks: ArtboardCheck[],
  elementId?: string,
): void {
  if (!Number.isInteger(color) || color < 0 || color >= size) {
    checks.push({
      code: "PALETTE",
      severity: "error",
      message: `The ${label} uses palette index ${color}, outside the ${size}-colour palette.`,
      ...(elementId ? { elementId } : {}),
    });
  }
}

function findSprite(
  sprites: Map<string, SpriteSource> | undefined,
  assetId: string,
  frameId: string | undefined,
): SpriteSource | undefined {
  if (!sprites) return undefined;
  for (const source of sprites.values()) {
    if (source.assetId !== assetId) continue;
    if (frameId === undefined || source.frameId === frameId) return source;
  }
  return undefined;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function intersects(left: Rect, right: Rect): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

export function insideCircle(bounds: Rect, canvas: Rect): boolean {
  const centerX = canvas.x + canvas.width / 2;
  const centerY = canvas.y + canvas.height / 2;
  const radius = Math.min(canvas.width, canvas.height) / 2;
  const corners = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height],
  ];
  return corners.every(([x, y]) => {
    if (x === undefined || y === undefined) return false;
    const dx = x - centerX;
    const dy = y - centerY;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  });
}

export function contrastRatio(foreground: string, backgrounds: string[]): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  if (foregroundLuminance === null || backgrounds.length === 0) return null;
  let worst = Number.POSITIVE_INFINITY;
  for (const background of backgrounds) {
    const luminance = relativeLuminance(background);
    if (luminance === null) continue;
    const lighter = Math.max(foregroundLuminance, luminance);
    const darker = Math.min(foregroundLuminance, luminance);
    worst = Math.min(worst, (lighter + 0.05) / (darker + 0.05));
  }
  return Number.isFinite(worst) ? worst : null;
}

function relativeLuminance(hex: string): number | null {
  let rgba: [number, number, number, number];
  try {
    rgba = hexToRgba(hex);
  } catch {
    return null;
  }
  const [r, g, b, a] = rgba;
  if (a < 255) return null;
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function labelOf(element: Element): string {
  if (element.kind === "text") {
    const text = element.text.trim().replace(/\s+/g, " ");
    return text.length > 0 ? `“${text.slice(0, 28)}”` : "Text";
  }
  return element.kind === "sprite" ? "Sprite" : element.kind;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** The error/warning summary a UI badge and an agent review both read. */
export function summarizeChecks(checks: ArtboardCheck[]): {
  errors: number;
  warnings: number;
  ok: boolean;
} {
  const errors = checks.filter((check) => check.severity === "error").length;
  const warnings = checks.filter((check) => check.severity === "warning").length;
  return { errors, warnings, ok: errors === 0 };
}

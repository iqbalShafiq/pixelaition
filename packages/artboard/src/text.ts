import {
  availableSizes,
  glyphBits,
  glyphFor,
  resolveFont,
  type ResolvedFont,
} from "./font.js";
import { readCell, writeCell } from "@pixelaition/pixel";
import type { Rect, TextElement } from "./types.js";

export type TextLine = {
  text: string;
  width: number;
};

export type TextLayout = {
  font: ResolvedFont;
  lines: TextLine[];
  lineHeight: number;
  ascent: number;
  descent: number;
  height: number;
  width: number;
};

export function textScale(element: TextElement): number {
  return element.scale ?? 1;
}

export function fontSize(element: TextElement): number {
  return element.size * textScale(element);
}

export function resolveElementFont(
  element: Pick<TextElement, "face" | "weight" | "size">,
): ResolvedFont {
  // The atlas starts at 16px. A small sprite needs 4–12px labels, so render
  // the 16px glyph grid through a fractional nearest-neighbour scale instead
  // of refusing the size or hiding the overflow.
  const sizes = availableSizes(element.face, element.weight);
  const atlasSize = sizes.find((size) => size >= element.size) ?? sizes.at(-1);
  if (atlasSize === undefined) {
    throw new Error(`Text face ${element.face} ${element.weight} has no atlas.`);
  }
  const font = resolveFont(element.face, element.weight, atlasSize);
  return {
    ...font,
    scale: element.size / atlasSize,
  };
}

export function measureLine(
  font: ResolvedFont,
  text: string,
  letterSpacing = 0,
  scale = 1,
): number {
  let width = 0;
  for (const char of text) {
    const glyph = glyphFor(font, char);
    width += (glyph?.advance ?? Math.round(font.size * 0.5)) + letterSpacing;
  }
  return Math.max(0, width * scale);
}

/**
 * Greedy word wrapping with an explicit newline. A word wider than the box is
 * broken by character, never silently clipped; the check reports the overflow.
 */
export function wrapText(
  font: ResolvedFont,
  text: string,
  width: number,
  letterSpacing = 0,
  scale = 1,
): TextLine[] {
  const lines: TextLine[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push({ text: "", width: 0 });
      continue;
    }
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    let current = "";
    const flush = () => {
      if (current.length > 0) {
        lines.push({
          text: current,
          width: measureLine(font, current, letterSpacing, scale),
        });
        current = "";
      }
    };
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (measureLine(font, candidate, letterSpacing, scale) <= width) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        flush();
        if (measureLine(font, word, letterSpacing, scale) <= width) {
          current = word;
          continue;
        }
      }
      let chunk = "";
      for (const char of word) {
        const next = `${chunk}${char}`;
        if (measureLine(font, next, letterSpacing, scale) > width && chunk.length > 0) {
          lines.push({
            text: chunk,
            width: measureLine(font, chunk, letterSpacing, scale),
          });
          chunk = char;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }
    flush();
  }
  return lines.length > 0 ? lines : [{ text: "", width: 0 }];
}

export function layoutText(element: TextElement): TextLayout {
  const font = resolveElementFont(element);
  const scale = font.scale * textScale(element);
  const lines = wrapText(
    font,
    element.text,
    element.width,
    element.letterSpacing ?? 0,
    scale,
  );
  const lineHeight = (element.lineHeight ?? Math.round(font.size * 1.25)) * scale;
  const ascent = font.ascent * scale;
  const descent = font.descent * scale;
  const width = lines.reduce((max, line) => Math.max(max, line.width), 0);
  return {
    font,
    lines,
    lineHeight,
    ascent,
    descent,
    height: lines.length * lineHeight,
    width,
  };
}

/** The upright painted bounds, before the element's rotation is applied. */
function uprightTextBounds(element: TextElement): Rect {
  const layout = layoutText(element);
  const x =
    element.align === "left"
      ? element.x
      : element.align === "center"
        ? Math.round(element.x + (element.width - layout.width) / 2)
        : element.x + element.width - layout.width;
  return {
    x,
    y: element.y,
    width: Math.max(1, layout.width),
    height: Math.max(1, layout.height),
  };
}

/** The painted bounds of a text element, honouring its rotation and alignment. */
export function textBounds(element: TextElement): Rect {
  const bounds = uprightTextBounds(element);
  if (!element.rotation) return bounds;
  const radians = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const points = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height],
  ].map(([x, y]) => {
    const dx = (x ?? 0) - cx;
    const dy = (y ?? 0) - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
  const xs = points.map(([x]) => x ?? 0);
  const ys = points.map(([, y]) => y ?? 0);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.ceil(Math.max(...xs)) - minX),
    height: Math.max(1, Math.ceil(Math.max(...ys)) - minY),
  };
}

export function lineStart(element: TextElement, line: TextLine): number {
  if (element.align === "left") return element.x;
  if (element.align === "center") {
    return Math.round(element.x + (element.width - line.width) / 2);
  }
  return element.x + element.width - line.width;
}

/**
 * Paint `text` into an index buffer. Every covered pixel receives the element's
 * palette index; there is no blending, so the result stays inside the palette.
 */
function drawTextUpright(
  target: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  element: TextElement,
  paletteSize: number,
  rgba = false,
): void {
  if (!rgba && (element.color <= 0 || element.color >= paletteSize)) return;
  if (rgba && element.color <= 0) return;
  const layout = layoutText(element);
  const scale = layout.font.scale * textScale(element);
  const spacing = element.letterSpacing ?? 0;
  for (let index = 0; index < layout.lines.length; index += 1) {
    const line = layout.lines[index];
    if (!line || line.text.length === 0) continue;
    const baseline = element.y + layout.ascent + index * layout.lineHeight;
    let penX = lineStart(element, line);
    for (const char of line.text) {
      const glyph = glyphFor(layout.font, char);
      if (!glyph) {
        penX += Math.round(layout.font.size * 0.5) * scale;
        continue;
      }
      const bits = glyphBits(glyph);
      if (scale !== 1) {
        // Sample the source glyph once per target pixel. This is nearest-
        // neighbour downscaling, so every output pixel still comes from the
        // atlas and the palette never gains an anti-aliased colour.
        const width = Math.max(1, Math.round(glyph.width * scale));
        const height = Math.max(1, Math.round(glyph.height * scale));
        const glyphX = Math.round(penX + glyph.left * scale);
        const glyphY = Math.round(baseline + glyph.top * scale);
        for (let y = 0; y < height; y += 1) {
          const sourceY = Math.min(
            glyph.height - 1,
            Math.max(0, Math.floor((y + 0.5) / scale)),
          );
          for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(
              glyph.width - 1,
              Math.max(0, Math.floor((x + 0.5) / scale)),
            );
            if (bits[sourceY * glyph.width + sourceX] !== 1) continue;
            const px = glyphX + x;
            const py = glyphY + y;
            if (px < 0 || py < 0 || px >= canvasWidth || py >= canvasHeight) continue;
            if (rgba) writeCell(target, py * canvasWidth + px, element.color);
            else target[py * canvasWidth + px] = element.color;
          }
        }
      } else {
        const glyphX = penX + glyph.left * scale;
        const glyphY = baseline + glyph.top * scale;
        for (let y = 0; y < glyph.height; y += 1) {
          for (let x = 0; x < glyph.width; x += 1) {
            if (bits[y * glyph.width + x] !== 1) continue;
            for (let dy = 0; dy < scale; dy += 1) {
              for (let dx = 0; dx < scale; dx += 1) {
                const px = glyphX + x * scale + dx;
                const py = glyphY + y * scale + dy;
                if (px < 0 || py < 0 || px >= canvasWidth || py >= canvasHeight) continue;
                if (rgba) writeCell(target, py * canvasWidth + px, element.color);
                else target[py * canvasWidth + px] = element.color;
              }
            }
          }
        }
      }
      penX += (glyph.advance + spacing) * scale;
    }
  }
}

/**
 * Paint text with its rotation applied. The upright glyphs are rendered into a
 * temporary layer, then every target pixel samples that layer through the
 * inverse rotation. Sampling is nearest-neighbour, so the result contains only
 * palette indices and stays a pixel asset.
 */
export function drawText(
  target: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  element: TextElement,
  paletteSize: number,
): void {
  if (!element.rotation) {
    drawTextUpright(target, canvasWidth, canvasHeight, element, paletteSize);
    return;
  }
  const upright = new Uint8Array(canvasWidth * canvasHeight);
  drawTextUpright(
    upright,
    canvasWidth,
    canvasHeight,
    { ...element, rotation: 0 },
    paletteSize,
  );
  const bounds = uprightTextBounds({ ...element, rotation: 0 });
  const radians = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rotated = textBounds(element);
  const left = Math.max(0, rotated.x);
  const top = Math.max(0, rotated.y);
  const right = Math.min(canvasWidth, rotated.x + rotated.width + 1);
  const bottom = Math.min(canvasHeight, rotated.y + rotated.height + 1);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sourceX = Math.round(cx + dx * cos + dy * sin);
      const sourceY = Math.round(cy - dx * sin + dy * cos);
      if (sourceX < 0 || sourceY < 0 || sourceX >= canvasWidth || sourceY >= canvasHeight)
        continue;
      const value = upright[sourceY * canvasWidth + sourceX] ?? 0;
      if (value !== 0) target[y * canvasWidth + x] = value;
    }
  }
}

/** Paint text into a straight-RGBA layer without quantising its colour. */
export function drawTextRgba(
  target: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  element: TextElement,
): void {
  if (!element.rotation) {
    drawTextUpright(target, canvasWidth, canvasHeight, element, 0, true);
    return;
  }
  const upright = new Uint8Array(canvasWidth * canvasHeight * 4);
  drawTextUpright(
    upright,
    canvasWidth,
    canvasHeight,
    { ...element, rotation: 0 },
    0,
    true,
  );
  const bounds = uprightTextBounds({ ...element, rotation: 0 });
  const radians = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rotated = textBounds(element);
  const left = Math.max(0, rotated.x);
  const top = Math.max(0, rotated.y);
  const right = Math.min(canvasWidth, rotated.x + rotated.width + 1);
  const bottom = Math.min(canvasHeight, rotated.y + rotated.height + 1);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sourceX = Math.round(cx + dx * cos + dy * sin);
      const sourceY = Math.round(cy - dx * sin + dy * cos);
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= canvasWidth ||
        sourceY >= canvasHeight
      ) {
        continue;
      }
      const value = readCell(upright, sourceY * canvasWidth + sourceX);
      if (value !== 0) writeCell(target, y * canvasWidth + x, value);
    }
  }
}

import { glyphBits, glyphFor, resolveFont, type ResolvedFont } from "./font.js";
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
  return resolveFont(element.face, element.weight, element.size);
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
  const scale = textScale(element);
  const lines = wrapText(
    font,
    element.text,
    element.width,
    element.letterSpacing ?? 0,
    scale,
  );
  const lineHeight = (element.lineHeight ?? Math.round(element.size * 1.25)) * scale;
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

/** The painted bounds of a text element, honouring its alignment. */
export function textBounds(element: TextElement): Rect {
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
export function drawText(
  target: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  element: TextElement,
  paletteSize: number,
): void {
  if (element.color <= 0 || element.color >= paletteSize) return;
  const layout = layoutText(element);
  const scale = textScale(element);
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
              target[py * canvasWidth + px] = element.color;
            }
          }
        }
      }
      penX += (glyph.advance + spacing) * scale;
    }
  }
}

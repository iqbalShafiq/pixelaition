import { cloneBuffer, composite, layerById, replaceLayer } from "./buffer.js";
import {
  clonePixels,
  inBounds,
  indexOf,
  isSizeAllowed,
  normalizeHex,
  readCell,
} from "./pixels.js";
import {
  MAX_COLORS,
  type Command,
  type CommandResult,
  type DitherPattern,
  type FrameBuffer,
  type Point,
} from "./types.js";

function fail(code: string, message: string): CommandResult {
  return { ok: false, code, message };
}

function requireLayer(buffer: FrameBuffer, layerId: string): CommandResult | FrameBuffer {
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  return buffer;
}

function paintPoints(
  buffer: FrameBuffer,
  layerId: string,
  points: Array<Point & { color?: number }>,
  colorFor: (point: Point & { color?: number }) => number,
): CommandResult {
  const gate = requireLayer(buffer, layerId);
  if ("ok" in gate) return gate;
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  const next = clonePixels(layer.pixels);
  for (const point of points) {
    if (!inBounds(buffer.width, buffer.height, point.x, point.y)) {
      return fail("OUT_OF_BOUNDS", "A pixel sits outside the canvas.");
    }
    const color = colorFor(point);
    if (!Number.isInteger(color) || color < 0 || color >= buffer.palette.length) {
      return fail("PALETTE_INDEX", "A pixel uses a color that is not in the palette.");
    }
    next[indexOf(buffer.width, point.x, point.y)] = color;
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

/** Bresenham. Exported so a clipped shape can be previewed and applied the same way. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  for (;;) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

function withinRegion(
  buffer: FrameBuffer,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (width < 1 || height < 1) return false;
  return x >= 0 && y >= 0 && x + width <= buffer.width && y + height <= buffer.height;
}

function flood(
  buffer: FrameBuffer,
  layerId: string,
  x: number,
  y: number,
  color: number,
  region?: { width: number; height: number },
): CommandResult {
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  if (!inBounds(buffer.width, buffer.height, x, y)) {
    return fail("OUT_OF_BOUNDS", "The fill starts outside the canvas.");
  }
  if (!Number.isInteger(color) || color < 0 || color >= buffer.palette.length) {
    return fail("PALETTE_INDEX", "The fill color is not in the palette.");
  }
  const limit = region
    ? {
        left: x,
        top: y,
        right: x + region.width - 1,
        bottom: y + region.height - 1,
      }
    : undefined;
  const inside = (point: Point) =>
    !limit ||
    (point.x >= limit.left &&
      point.x <= limit.right &&
      point.y >= limit.top &&
      point.y <= limit.bottom);
  const target = readCell(layer.pixels, indexOf(buffer.width, x, y));
  if (target === color) return { ok: true, buffer };
  const next = clonePixels(layer.pixels);
  const stack: Point[] = [{ x, y }];
  while (stack.length > 0) {
    const point = stack.pop();
    if (!point || !inBounds(buffer.width, buffer.height, point.x, point.y)) continue;
    if (!inside(point)) continue;
    const index = indexOf(buffer.width, point.x, point.y);
    if (readCell(next, index) !== target) continue;
    next[index] = color;
    stack.push(
      { x: point.x + 1, y: point.y },
      { x: point.x - 1, y: point.y },
      { x: point.x, y: point.y + 1 },
      { x: point.x, y: point.y - 1 },
    );
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

function paletteIndexOk(buffer: FrameBuffer, color: number): boolean {
  return Number.isInteger(color) && color >= 0 && color < buffer.palette.length;
}

function replaceColor(
  buffer: FrameBuffer,
  layerId: string | undefined,
  from: number,
  to: number,
): CommandResult {
  if (!paletteIndexOk(buffer, from) || !paletteIndexOk(buffer, to)) {
    return fail("PALETTE_INDEX", "The swap uses a color that is not in the palette.");
  }
  if (layerId !== undefined) {
    const gate = requireLayer(buffer, layerId);
    if ("ok" in gate) return gate;
  }
  const swap = (pixels: Uint8Array): Uint8Array => {
    const next = clonePixels(pixels);
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] === from) next[index] = to;
    }
    return next;
  };
  return {
    ok: true,
    buffer: {
      ...buffer,
      layers: buffer.layers.map((layer) =>
        layerId === undefined || layer.id === layerId
          ? { ...layer, pixels: swap(layer.pixels) }
          : layer,
      ),
    },
  };
}

function outline(buffer: FrameBuffer, layerId: string, color: number): CommandResult {
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  if (!paletteIndexOk(buffer, color)) {
    return fail("PALETTE_INDEX", "The outline color is not in the palette.");
  }
  const view = composite(buffer);
  const next = clonePixels(layer.pixels);
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if (readCell(view, indexOf(buffer.width, x, y)) !== 0) continue;
      const touchesOpaque = [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
      ].some(
        (point) =>
          inBounds(buffer.width, buffer.height, point.x, point.y) &&
          readCell(view, indexOf(buffer.width, point.x, point.y)) !== 0,
      );
      if (touchesOpaque) next[indexOf(buffer.width, x, y)] = color;
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

function dither(
  buffer: FrameBuffer,
  layerId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  colorA: number,
  colorB: number,
  pattern: DitherPattern,
): CommandResult {
  const gate = requireLayer(buffer, layerId);
  if ("ok" in gate) return gate;
  if (width < 1 || height < 1) {
    return fail("SIZE", "A dither region needs a positive width and height.");
  }
  if (!withinRegion(buffer, x, y, width, height)) {
    return fail("OUT_OF_BOUNDS", "The dither region reaches outside the canvas.");
  }
  if (!paletteIndexOk(buffer, colorA) || !paletteIndexOk(buffer, colorB)) {
    return fail("PALETTE_INDEX", "A dither color is not in the palette.");
  }
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  const next = clonePixels(layer.pixels);
  for (let cellY = y; cellY < y + height; cellY += 1) {
    for (let cellX = x; cellX < x + width; cellX += 1) {
      const useA = pattern === "checker" ? (cellX + cellY) % 2 === 0 : cellX % 2 === 0;
      next[indexOf(buffer.width, cellX, cellY)] = useA ? colorA : colorB;
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

export function applyCommand(source: FrameBuffer, command: Command): CommandResult {
  const buffer = cloneBuffer(source);
  switch (command.type) {
    case "paint":
      return paintPoints(
        buffer,
        command.layerId,
        command.points,
        (point) => point.color ?? 0,
      );
    case "erase":
      return paintPoints(buffer, command.layerId, command.points, () => 0);
    case "fill":
      return flood(buffer, command.layerId, command.x, command.y, command.color);
    case "line":
      return paintPoints(
        buffer,
        command.layerId,
        linePoints(command.x0, command.y0, command.x1, command.y1).map((point) => ({
          ...point,
          color: command.color,
        })),
        (point) => point.color ?? 0,
      );
    case "rect": {
      if (command.width < 1 || command.height < 1) {
        return fail("SIZE", "A rectangle needs a positive width and height.");
      }
      const points: Array<Point & { color: number }> = [];
      const x1 = command.x + command.width - 1;
      const y1 = command.y + command.height - 1;
      for (let y = command.y; y <= y1; y += 1) {
        for (let x = command.x; x <= x1; x += 1) {
          const edge = x === command.x || y === command.y || x === x1 || y === y1;
          if (command.filled || edge) points.push({ x, y, color: command.color });
        }
      }
      return paintPoints(buffer, command.layerId, points, (point) => point.color ?? 0);
    }
    case "region": {
      if (command.width < 1 || command.height < 1) {
        return fail("SIZE", "A selection needs a positive width and height.");
      }
      if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
        return fail("OUT_OF_BOUNDS", "The selection reaches outside the canvas.");
      }
      if (command.mode === "flood") {
        return flood(buffer, command.layerId, command.x, command.y, command.color, {
          width: command.width,
          height: command.height,
        });
      }
      const color = command.mode === "clear" ? 0 : command.color;
      const points: Array<Point & { color: number }> = [];
      for (let y = command.y; y < command.y + command.height; y += 1) {
        for (let x = command.x; x < command.x + command.width; x += 1) {
          points.push({ x, y, color });
        }
      }
      return paintPoints(buffer, command.layerId, points, (point) => point.color ?? 0);
    }
    case "setPalette": {
      if (command.palette.length < 2 || command.palette.length > MAX_COLORS + 1) {
        return fail(
          "PALETTE_SIZE",
          "A palette needs a transparent color and at most 255 others.",
        );
      }
      const palette: string[] = [];
      for (const color of command.palette) {
        const hex = normalizeHex(color);
        if (!hex)
          return fail(
            "PALETTE_COLOR",
            "Index 0 must be #00000000 and every entry must be hex.",
          );
        palette.push(hex);
      }
      if (palette[0] !== "#00000000") {
        return fail(
          "PALETTE_COLOR",
          "Index 0 must be #00000000 and every entry must be hex.",
        );
      }
      const highest = highestIndex(buffer);
      if (highest >= palette.length) {
        return fail(
          "PALETTE_IN_USE",
          "The canvas still uses a color this palette would remove.",
        );
      }
      return { ok: true, buffer: { ...buffer, palette } };
    }
    case "reindexPalette": {
      if (command.palette.length < 2 || command.palette.length > MAX_COLORS + 1) {
        return fail(
          "PALETTE_SIZE",
          "A palette needs a transparent color and at most 255 others.",
        );
      }
      const palette: string[] = [];
      for (const color of command.palette) {
        const hex = normalizeHex(color);
        if (!hex) {
          return fail(
            "PALETTE_COLOR",
            "Index 0 must be #00000000 and every entry must be hex.",
          );
        }
        palette.push(hex);
      }
      if (palette[0] !== "#00000000") {
        return fail(
          "PALETTE_COLOR",
          "Index 0 must be #00000000 and every entry must be hex.",
        );
      }
      const mapping = new Map<number, number>();
      for (const [from, to] of Object.entries(command.mapping)) {
        const source = Number(from);
        if (
          !Number.isInteger(source) ||
          source < 0 ||
          source >= buffer.palette.length ||
          !Number.isInteger(to) ||
          to < 0 ||
          to >= palette.length
        ) {
          return fail(
            "PALETTE_INDEX",
            `The mapping from ${from} to ${to} is not an index in both palettes.`,
          );
        }
        mapping.set(source, to);
      }
      for (const layer of buffer.layers) {
        for (const value of layer.pixels) {
          if (value !== 0 && !mapping.has(value)) {
            return fail(
              "PALETTE_IN_USE",
              `The canvas uses colour ${value}, and this palette replaces it without saying what it becomes.`,
            );
          }
        }
      }
      const layers = buffer.layers.map((layer) => {
        const pixels = clonePixels(layer.pixels);
        for (let index = 0; index < pixels.length; index += 1) {
          const mapped = mapping.get(pixels[index] ?? 0);
          if (mapped !== undefined) pixels[index] = mapped;
        }
        return { ...layer, pixels };
      });
      return { ok: true, buffer: { ...buffer, palette, layers } };
    }
    case "resize": {
      if (!isSizeAllowed(command.width) || !isSizeAllowed(command.height)) {
        return fail("SIZE", "Canvas size must be an integer from 8 to 128.");
      }
      const layers = buffer.layers.map((layer) => {
        const pixels = new Uint8Array(command.width * command.height);
        const copyWidth = Math.min(buffer.width, command.width);
        const copyHeight = Math.min(buffer.height, command.height);
        for (let y = 0; y < copyHeight; y += 1) {
          for (let x = 0; x < copyWidth; x += 1) {
            pixels[indexOf(command.width, x, y)] = readCell(
              layer.pixels,
              indexOf(buffer.width, x, y),
            );
          }
        }
        return { ...layer, pixels };
      });
      return {
        ok: true,
        buffer: { ...buffer, width: command.width, height: command.height, layers },
      };
    }
    case "addLayer": {
      const name = command.name.trim();
      if (!name) return fail("LAYER_NAME", "A layer needs a name.");
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: [
            ...buffer.layers,
            {
              id: command.id,
              name,
              visible: true,
              pixels: new Uint8Array(buffer.width * buffer.height),
            },
          ],
        },
      };
    }
    case "renameLayer": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      const name = command.name.trim();
      if (!name) return fail("LAYER_NAME", "A layer needs a name.");
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId ? { ...layer, name } : layer,
          ),
        },
      };
    }
    case "setLayerVisible": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId ? { ...layer, visible: command.visible } : layer,
          ),
        },
      };
    }
    case "removeLayer": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (buffer.layers.length <= 1) {
        return fail("LAYER_REQUIRED", "A frame keeps at least one layer.");
      }
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.filter((layer) => layer.id !== command.layerId),
        },
      };
    }
    case "mirror": {
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) => ({
            ...layer,
            pixels: mirrorPixels(layer.pixels, buffer.width, buffer.height),
          })),
        },
      };
    }
    case "replaceColor":
      return replaceColor(buffer, command.layerId, command.from, command.to);
    case "stamp":
      return stamp(buffer, command);
    case "mirrorRegion":
      return mirrorRegion(buffer, command);
    case "outline":
      return outline(buffer, command.layerId, command.color);
    case "dither":
      return dither(
        buffer,
        command.layerId,
        command.x,
        command.y,
        command.width,
        command.height,
        command.colorA,
        command.colorB,
        command.pattern,
      );
    default: {
      const unexpected: never = command;
      return fail("UNKNOWN_COMMAND", `Unsupported edit: ${JSON.stringify(unexpected)}`);
    }
  }
}

function highestIndex(buffer: FrameBuffer): number {
  let highest = 0;
  for (const layer of buffer.layers) {
    for (const color of layer.pixels) highest = Math.max(highest, color);
  }
  return highest;
}

function mirrorPixels(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const next = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      next[indexOf(width, width - 1 - x, y)] = readCell(pixels, indexOf(width, x, y));
    }
  }
  return next;
}

/** Write a resolved block of indices into one layer; every index must be a colour. */
function stamp(
  buffer: FrameBuffer,
  command: Extract<Command, { type: "stamp" }>,
): CommandResult {
  const gate = requireLayer(buffer, command.layerId);
  if ("ok" in gate) return gate;
  if (command.width < 1 || command.height < 1) {
    return fail("SIZE", "A copied region needs a positive width and height.");
  }
  if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
    return fail("OUT_OF_BOUNDS", "The copied region reaches outside the canvas.");
  }
  if (command.pixels.length !== command.width * command.height) {
    return fail(
      "SHAPE",
      `The copied region holds ${command.pixels.length} pixels but ${command.width}×${command.height} needs ${command.width * command.height}.`,
    );
  }
  const layer = layerById(buffer, command.layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  const next = clonePixels(layer.pixels);
  for (let row = 0; row < command.height; row += 1) {
    for (let column = 0; column < command.width; column += 1) {
      const color = command.pixels[row * command.width + column];
      if (color === undefined || !paletteIndexOk(buffer, color)) {
        const target =
          color === undefined
            ? `row ${row + command.y}, column ${column + command.x}`
            : `row ${row + command.y}, column ${column + command.x} uses index ${color}`;
        return fail(
          "PALETTE_INDEX",
          `${target} is not a colour in this asset's palette. Map the source colours to this palette first.`,
        );
      }
      next[indexOf(buffer.width, command.x + column, command.y + row)] = color;
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
}

/** Flip one rectangle inside its own bounds; pixels outside it are untouched. */
function mirrorRegion(
  buffer: FrameBuffer,
  command: Extract<Command, { type: "mirrorRegion" }>,
): CommandResult {
  const gate = requireLayer(buffer, command.layerId);
  if ("ok" in gate) return gate;
  if (command.width < 1 || command.height < 1) {
    return fail("SIZE", "A mirrored region needs a positive width and height.");
  }
  if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
    return fail("OUT_OF_BOUNDS", "The mirrored region reaches outside the canvas.");
  }
  const layer = layerById(buffer, command.layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  const next = clonePixels(layer.pixels);
  for (let row = 0; row < command.height; row += 1) {
    for (let column = 0; column < command.width; column += 1) {
      const fromX =
        command.axis === "horizontal"
          ? command.x + command.width - 1 - column
          : command.x + column;
      const fromY =
        command.axis === "vertical"
          ? command.y + command.height - 1 - row
          : command.y + row;
      next[indexOf(buffer.width, command.x + column, command.y + row)] = readCell(
        layer.pixels,
        indexOf(buffer.width, fromX, fromY),
      );
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
}

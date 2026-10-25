import { cloneBuffer, composite, layerById, replaceLayer } from "./buffer.js";
import { colorDistance, hexToColor } from "./color.js";
import {
  clonePixels,
  emptyPixels,
  inBounds,
  indexOf,
  normalizeHex,
  readCell,
  writeCell,
} from "./pixels.js";
import {
  MAX_COLORS,
  type Command,
  type CommandResult,
  type DitherPattern,
  type FrameBuffer,
  type Layer,
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
    const color = resolveColor(buffer, colorFor(point));
    if (!colorOk(color)) {
      return fail("COLOR", "A pixel uses an invalid RGBA colour.");
    }
    writeCell(next, indexOf(buffer.width, point.x, point.y), color);
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

/**
 * A grid ellipse inside a bounding box. Rows are symmetric and every point is
 * inside the box; an outline records the extreme cell of each row, a filled
 * ellipse records the whole run.
 */
export function ellipsePoints(
  x: number,
  y: number,
  width: number,
  height: number,
  filled = false,
): Point[] {
  if (width < 1 || height < 1) return [];
  const rx = (width - 1) / 2;
  const ry = (height - 1) / 2;
  const cx = x + rx;
  const points = new Map<string, Point>();
  const add = (px: number, py: number) => {
    const point = { x: Math.round(px), y: Math.round(py) };
    points.set(`${point.x}:${point.y}`, point);
  };
  for (let row = 0; row < height; row += 1) {
    const normalized = ry === 0 ? 0 : (row - ry) / ry;
    const extent = rx * Math.sqrt(Math.max(0, 1 - normalized * normalized));
    const left = Math.ceil(cx - extent);
    const right = Math.floor(cx + extent);
    if (filled) {
      for (let column = left; column <= right; column += 1) add(column, y + row);
    } else {
      add(left, y + row);
      add(right, y + row);
    }
  }
  return [...points.values()];
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
  if (!colorOk(color)) {
    return fail("COLOR", "The fill colour is invalid.");
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
  const resolved = resolveColor(buffer, color);
  const target = readCell(layer.pixels, indexOf(buffer.width, x, y));
  if (target === resolved) return { ok: true, buffer };
  const next = clonePixels(layer.pixels);
  const stack: Point[] = [{ x, y }];
  while (stack.length > 0) {
    const point = stack.pop();
    if (!point || !inBounds(buffer.width, buffer.height, point.x, point.y)) continue;
    if (!inside(point)) continue;
    const index = indexOf(buffer.width, point.x, point.y);
    if (readCell(next, index) !== target) continue;
    writeCell(next, index, resolved);
    stack.push(
      { x: point.x + 1, y: point.y },
      { x: point.x - 1, y: point.y },
      { x: point.x, y: point.y + 1 },
      { x: point.x, y: point.y - 1 },
    );
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

function colorOk(color: number): boolean {
  return Number.isInteger(color) && color >= 0 && color <= 0xffffffff;
}

/**
 * Transitional palette-index support: small values are legacy indices, while
 * packed RGBA colours are always above the transparent-black range. New tools
 * pass packed colours (or hex, converted at the boundary).
 */
function resolveColor(buffer: FrameBuffer, color: number): number {
  if (color >= 0 && color < buffer.palette.length && color < 16) {
    return hexToColor(buffer.palette[color] ?? "#00000000") ?? 0;
  }
  return color;
}

function replaceColor(
  buffer: FrameBuffer,
  layerId: string | undefined,
  from: number,
  to: number,
): CommandResult {
  const source = resolveColor(buffer, from);
  const target = resolveColor(buffer, to);
  if (!colorOk(source) || !colorOk(target)) {
    return fail("COLOR", "The replacement colours are invalid.");
  }
  if (layerId !== undefined) {
    const gate = requireLayer(buffer, layerId);
    if ("ok" in gate) return gate;
  }
  const swap = (pixels: Uint8Array): Uint8Array => {
    const next = clonePixels(pixels);
    const cells = buffer.width * buffer.height;
    for (let index = 0; index < cells; index += 1) {
      if (readCell(next, index) === source) writeCell(next, index, target);
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
  if (!colorOk(color)) {
    return fail("COLOR", "The outline colour is invalid.");
  }
  const resolved = resolveColor(buffer, color);
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
      if (touchesOpaque) writeCell(next, indexOf(buffer.width, x, y), resolved);
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
  if (!colorOk(colorA) || !colorOk(colorB)) {
    return fail("COLOR", "A dither colour is invalid.");
  }
  const layer = layerById(buffer, layerId);
  if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
  const useColorA = resolveColor(buffer, colorA);
  const useColorB = resolveColor(buffer, colorB);
  const next = clonePixels(layer.pixels);
  for (let cellY = y; cellY < y + height; cellY += 1) {
    for (let cellX = x; cellX < x + width; cellX += 1) {
      const useA = pattern === "checker" ? (cellX + cellY) % 2 === 0 : cellX % 2 === 0;
      writeCell(next, indexOf(buffer.width, cellX, cellY), useA ? useColorA : useColorB);
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, layerId, next) };
}

/** Which layer, if any, a pixel mutation would write while locked. */
function lockedLayerFor(buffer: FrameBuffer, command: Command): Layer | undefined {
  const readOnly = new Set([
    "setPalette",
    "reindexPalette",
    "resize",
    "addLayer",
    "replaceLayer",
    "renameLayer",
    "setLayerVisible",
    "setLayerOpacity",
    "setLayerBlend",
    "setLayerLocked",
    "setLayerLink",
    "setTilemap",
    "duplicateLayer",
    "addLayerGroup",
    "renameLayerGroup",
    "setLayerGroupVisible",
    "setLayerGroupOpacity",
    "removeLayerGroup",
    "moveLayerToGroup",
    "removeLayer",
  ]);
  if (readOnly.has(command.type)) return undefined;
  const layerId = (command as { layerId?: string }).layerId;
  if (layerId !== undefined) {
    const layer = buffer.layers.find((item) => item.id === layerId);
    return layer?.locked ? layer : undefined;
  }
  if (command.type === "mirror") {
    return buffer.layers.find((layer) => layer.locked);
  }
  return undefined;
}

export function applyCommand(source: FrameBuffer, command: Command): CommandResult {
  const buffer = cloneBuffer(source);
  const locked = lockedLayerFor(buffer, command);
  if (locked) {
    return fail("LAYER_LOCKED", `The layer "${locked.name}" is locked.`);
  }
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
      if (command.palette.length < 1 || command.palette.length > MAX_COLORS + 1) {
        return fail("PALETTE_SIZE", "A palette holds at most 256 swatches.");
      }
      const palette: string[] = [];
      for (const color of command.palette) {
        const hex = normalizeHex(color);
        if (!hex) {
          return fail("PALETTE_COLOR", "Every swatch must be a hex colour.");
        }
        palette.push(hex);
      }
      return { ok: true, buffer: { ...buffer, palette } };
    }
    case "reindexPalette": {
      // Swatches no longer own pixel colours; reindexing only refreshes the
      // library and leaves every RGBA pixel untouched.
      const palette: string[] = [];
      for (const color of command.palette) {
        const hex = normalizeHex(color);
        if (!hex) return fail("PALETTE_COLOR", "Every swatch must be a hex colour.");
        palette.push(hex);
      }
      return { ok: true, buffer: { ...buffer, palette } };
    }
    case "resize": {
      if (
        !Number.isInteger(command.width) ||
        !Number.isInteger(command.height) ||
        command.width < 1 ||
        command.height < 1
      ) {
        return fail("SIZE", "Canvas size must be a positive integer.");
      }
      const layers = buffer.layers.map((layer) => {
        const pixels = emptyPixels(command.width, command.height);
        const copyWidth = Math.min(buffer.width, command.width);
        const copyHeight = Math.min(buffer.height, command.height);
        for (let y = 0; y < copyHeight; y += 1) {
          for (let x = 0; x < copyWidth; x += 1) {
            writeCell(
              pixels,
              indexOf(command.width, x, y),
              readCell(layer.pixels, indexOf(buffer.width, x, y)),
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
              pixels: emptyPixels(buffer.width, buffer.height),
            },
          ],
        },
      };
    }
    case "replaceLayer": {
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      if (command.pixels.length !== buffer.width * buffer.height * 4)
        return fail("PIXEL_COUNT", "The layer pixels do not match the canvas.");
      const next: Layer = {
        ...layer,
        pixels: clonePixels(command.pixels),
      };
      if ("text" in command) {
        if (command.text === null) delete next.text;
        else if (command.text) next.text = { ...command.text };
      }
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((item) =>
            item.id === command.layerId ? next : item,
          ),
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
    case "setLayerOpacity": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      const opacity = Number.isFinite(command.opacity)
        ? Math.max(0, Math.min(1, command.opacity))
        : 1;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId ? { ...layer, opacity } : layer,
          ),
        },
      };
    }
    case "setLayerBlend": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId ? { ...layer, blend: command.blend } : layer,
          ),
        },
      };
    }
    case "setLayerLocked": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId ? { ...layer, locked: command.locked } : layer,
          ),
        },
      };
    }
    case "setTilemap": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId
              ? {
                  ...layer,
                  ...(command.tilemap
                    ? { tilemap: { ...command.tilemap, data: [...command.tilemap.data] } }
                    : { tilemap: undefined }),
                }
              : layer,
          ),
        },
      };
    }
    case "setLayerLink": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId
              ? {
                  ...layer,
                  ...(command.linkId
                    ? { linkId: command.linkId }
                    : { linkId: undefined }),
                }
              : layer,
          ),
        },
      };
    }
    case "duplicateLayer": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (buffer.layers.some((layer) => layer.id === command.id)) {
        return fail("LAYER_EXISTS", "That layer id is already on this frame.");
      }
      const source = buffer.layers.find((layer) => layer.id === command.layerId);
      if (!source) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const name = command.name.trim();
      if (!name) return fail("LAYER_NAME", "A layer needs a name.");
      const index = buffer.layers.findIndex((layer) => layer.id === source.id);
      const copy = {
        ...source,
        id: command.id,
        name,
        pixels: clonePixels(source.pixels),
        ...(source.text ? { text: { ...source.text } } : {}),
      };
      const layers = [...buffer.layers];
      layers.splice(index + 1, 0, copy);
      return { ok: true, buffer: { ...buffer, layers } };
    }
    case "addLayerGroup": {
      const groups = buffer.groups ?? [];
      if (groups.some((group) => group.id === command.id)) {
        return fail("GROUP_EXISTS", "That layer group id is already on this frame.");
      }
      if (
        command.parentGroupId &&
        !groups.some((group) => group.id === command.parentGroupId)
      ) {
        return fail("GROUP_NOT_FOUND", "That parent layer group is not on this frame.");
      }
      const name = command.name.trim();
      if (!name) return fail("GROUP_NAME", "A layer group needs a name.");
      return {
        ok: true,
        buffer: {
          ...buffer,
          groups: [
            ...groups,
            {
              id: command.id,
              name,
              visible: true,
              ...(command.parentGroupId ? { parentGroupId: command.parentGroupId } : {}),
            },
          ],
        },
      };
    }
    case "renameLayerGroup": {
      const groups = buffer.groups ?? [];
      if (!groups.some((group) => group.id === command.groupId)) {
        return fail("GROUP_NOT_FOUND", "That layer group is not on this frame.");
      }
      const name = command.name.trim();
      if (!name) return fail("GROUP_NAME", "A layer group needs a name.");
      return {
        ok: true,
        buffer: {
          ...buffer,
          groups: groups.map((group) =>
            group.id === command.groupId ? { ...group, name } : group,
          ),
        },
      };
    }
    case "setLayerGroupVisible": {
      const groups = buffer.groups ?? [];
      if (!groups.some((group) => group.id === command.groupId)) {
        return fail("GROUP_NOT_FOUND", "That layer group is not on this frame.");
      }
      return {
        ok: true,
        buffer: {
          ...buffer,
          groups: groups.map((group) =>
            group.id === command.groupId ? { ...group, visible: command.visible } : group,
          ),
        },
      };
    }
    case "setLayerGroupOpacity": {
      const groups = buffer.groups ?? [];
      if (!groups.some((group) => group.id === command.groupId)) {
        return fail("GROUP_NOT_FOUND", "That layer group is not on this frame.");
      }
      const opacity = Math.max(0, Math.min(1, command.opacity));
      return {
        ok: true,
        buffer: {
          ...buffer,
          groups: groups.map((group) =>
            group.id === command.groupId ? { ...group, opacity } : group,
          ),
        },
      };
    }
    case "removeLayerGroup": {
      const groups = buffer.groups ?? [];
      const removed = groups.find((group) => group.id === command.groupId);
      if (!removed)
        return fail("GROUP_NOT_FOUND", "That layer group is not on this frame.");
      const parent = removed.parentGroupId;
      return {
        ok: true,
        buffer: {
          ...buffer,
          groups: groups
            .filter((group) => group.id !== command.groupId)
            .map((group) =>
              group.parentGroupId === command.groupId
                ? {
                    ...group,
                    ...(parent
                      ? { parentGroupId: parent }
                      : { parentGroupId: undefined }),
                  }
                : group,
            ),
          layers: buffer.layers.map((layer) =>
            layer.parentGroupId === command.groupId
              ? {
                  ...layer,
                  ...(parent ? { parentGroupId: parent } : { parentGroupId: undefined }),
                }
              : layer,
          ),
        },
      };
    }
    case "moveLayerToGroup": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (
        command.groupId &&
        !(buffer.groups ?? []).some((group) => group.id === command.groupId)
      ) {
        return fail("GROUP_NOT_FOUND", "That layer group is not on this frame.");
      }
      return {
        ok: true,
        buffer: {
          ...buffer,
          layers: buffer.layers.map((layer) =>
            layer.id === command.layerId
              ? {
                  ...layer,
                  ...(command.groupId
                    ? { parentGroupId: command.groupId }
                    : { parentGroupId: undefined }),
                }
              : layer,
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
    case "tileFill": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (
        command.tileWidth < 1 ||
        command.tileHeight < 1 ||
        !withinRegion(
          buffer,
          command.tileX,
          command.tileY,
          command.tileWidth,
          command.tileHeight,
        ) ||
        !withinRegion(buffer, command.x, command.y, command.width, command.height)
      ) {
        return fail("SHAPE", "The tile or destination reaches outside the canvas.");
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const tile: number[] = [];
      for (let row = 0; row < command.tileHeight; row += 1) {
        for (let column = 0; column < command.tileWidth; column += 1) {
          tile.push(
            readCell(
              layer.pixels,
              indexOf(buffer.width, command.tileX + column, command.tileY + row),
            ),
          );
        }
      }
      const next = clonePixels(layer.pixels);
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          writeCell(
            next,
            indexOf(buffer.width, command.x + column, command.y + row),
            tile[
              (row % command.tileHeight) * command.tileWidth +
                (column % command.tileWidth)
            ] ?? 0,
          );
        }
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "moveMask": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (
        !withinRegion(buffer, command.x, command.y, command.width, command.height) ||
        command.mask.length !== command.width * command.height ||
        !withinRegion(
          buffer,
          command.x + command.dx,
          command.y + command.dy,
          command.width,
          command.height,
        )
      ) {
        return fail(
          "SHAPE",
          "The masked move has the wrong region, mask, or destination.",
        );
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const source: number[] = [];
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          const local = row * command.width + column;
          if (command.mask[local] !== 1) continue;
          source[local] = readCell(
            layer.pixels,
            indexOf(buffer.width, command.x + column, command.y + row),
          );
        }
      }
      const next = clonePixels(layer.pixels);
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          if (command.mask[row * command.width + column] !== 1) continue;
          writeCell(next, indexOf(buffer.width, command.x + column, command.y + row), 0);
        }
      }
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          const local = row * command.width + column;
          if (command.mask[local] !== 1) continue;
          writeCell(
            next,
            indexOf(
              buffer.width,
              command.x + command.dx + column,
              command.y + command.dy + row,
            ),
            source[local] ?? 0,
          );
        }
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "transformMask": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (
        !withinRegion(buffer, command.x, command.y, command.width, command.height) ||
        command.mask.length !== command.width * command.height
      ) {
        return fail("SHAPE", "The masked transform has the wrong region or mask size.");
      }
      if (
        (command.transform === "rotateCW" || command.transform === "rotateCCW") &&
        command.width !== command.height
      ) {
        return fail("SQUARE_REQUIRED", "A masked quarter-turn needs a square selection.");
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const source: number[] = [];
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          const local = row * command.width + column;
          if (command.mask[local] !== 1) continue;
          source[local] = readCell(
            layer.pixels,
            indexOf(buffer.width, command.x + column, command.y + row),
          );
        }
      }
      const next = clonePixels(layer.pixels);
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          if (command.mask[row * command.width + column] !== 1) continue;
          writeCell(next, indexOf(buffer.width, command.x + column, command.y + row), 0);
        }
      }
      const size = command.width;
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          let sourceColumn = column;
          let sourceRow = row;
          if (command.transform === "flipHorizontal") {
            sourceColumn = command.width - 1 - column;
          }
          if (command.transform === "flipVertical") {
            sourceRow = command.height - 1 - row;
          }
          if (command.transform === "rotateCW") {
            sourceColumn = row;
            sourceRow = size - 1 - column;
          }
          if (command.transform === "rotateCCW") {
            sourceColumn = size - 1 - row;
            sourceRow = column;
          }
          const local = sourceRow * size + sourceColumn;
          if (command.mask[local] !== 1) continue;
          writeCell(
            next,
            indexOf(buffer.width, command.x + column, command.y + row),
            source[local] ?? 0,
          );
        }
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "fillMask": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (
        !withinRegion(buffer, command.x, command.y, command.width, command.height) ||
        command.mask.length !== command.width * command.height
      ) {
        return fail("SHAPE", "The masked fill has the wrong region or mask size.");
      }
      const fillColor = resolveColor(buffer, command.color);
      if (!colorOk(fillColor)) {
        return fail("COLOR", "The fill colour is invalid.");
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const inside = (x: number, y: number) => {
        const localX = x - command.x;
        const localY = y - command.y;
        return (
          localX >= 0 &&
          localY >= 0 &&
          localX < command.width &&
          localY < command.height &&
          command.mask[localY * command.width + localX] === 1
        );
      };
      const startX = command.x + Math.floor(command.width / 2);
      const startY = command.y + Math.floor(command.height / 2);
      let seed: Point | undefined;
      for (let y = command.y; y < command.y + command.height && !seed; y += 1) {
        for (let x = command.x; x < command.x + command.width; x += 1) {
          if (
            inside(x, y) &&
            readCell(layer.pixels, indexOf(buffer.width, x, y)) !== command.color
          ) {
            seed = { x, y };
            break;
          }
        }
      }
      if (!seed) seed = { x: startX, y: startY };
      if (!inside(seed.x, seed.y)) return { ok: true, buffer };
      const target = readCell(layer.pixels, indexOf(buffer.width, seed.x, seed.y));
      if (target === command.color) return { ok: true, buffer };
      const next = clonePixels(layer.pixels);
      const stack: Point[] = [seed];
      const seen = new Set<number>();
      while (stack.length > 0) {
        const point = stack.pop();
        if (!point || !inside(point.x, point.y)) continue;
        const index = indexOf(buffer.width, point.x, point.y);
        if (seen.has(index)) continue;
        seen.add(index);
        if (readCell(next, index) !== target) continue;
        writeCell(next, index, fillColor);
        stack.push(
          { x: point.x + 1, y: point.y },
          { x: point.x - 1, y: point.y },
          { x: point.x, y: point.y + 1 },
          { x: point.x, y: point.y - 1 },
        );
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "ellipse": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (command.width < 1 || command.height < 1) {
        return fail("SIZE", "An ellipse needs a positive width and height.");
      }
      if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
        return fail("OUT_OF_BOUNDS", "The ellipse reaches outside the canvas.");
      }
      if (!colorOk(command.color)) {
        return fail("COLOR", "The ellipse colour is invalid.");
      }
      return paintPoints(
        buffer,
        command.layerId,
        ellipsePoints(
          command.x,
          command.y,
          command.width,
          command.height,
          command.filled,
        ).map((point) => ({ ...point, color: command.color })),
        (point) => point.color ?? 0,
      );
    }
    case "rotateRegion": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (command.width !== command.height) {
        return fail("SQUARE_REQUIRED", "A quarter-turn needs a square selection.");
      }
      if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
        return fail("OUT_OF_BOUNDS", "The selected region reaches outside the canvas.");
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const next = clonePixels(layer.pixels);
      const size = command.width;
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          const sourceX = command.turns === 1 ? size - 1 - row : column;
          const sourceY = command.turns === 1 ? column : size - 1 - column;
          writeCell(
            next,
            indexOf(buffer.width, command.x + column, command.y + row),
            readCell(
              layer.pixels,
              indexOf(buffer.width, command.x + sourceX, command.y + sourceY),
            ),
          );
        }
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "moveRegion": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      if (!withinRegion(buffer, command.x, command.y, command.width, command.height)) {
        return fail("OUT_OF_BOUNDS", "The selected region reaches outside the canvas.");
      }
      if (
        !withinRegion(
          buffer,
          command.x + command.dx,
          command.y + command.dy,
          command.width,
          command.height,
        )
      ) {
        return fail("OUT_OF_BOUNDS", "The moved region would leave the canvas.");
      }
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const source: number[] = [];
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          source[row * command.width + column] = readCell(
            layer.pixels,
            indexOf(buffer.width, command.x + column, command.y + row),
          );
        }
      }
      const next = clonePixels(layer.pixels);
      if (command.eraseSource) {
        for (let row = 0; row < command.height; row += 1) {
          for (let column = 0; column < command.width; column += 1) {
            writeCell(
              next,
              indexOf(buffer.width, command.x + column, command.y + row),
              0,
            );
          }
        }
      }
      for (let row = 0; row < command.height; row += 1) {
        for (let column = 0; column < command.width; column += 1) {
          writeCell(
            next,
            indexOf(
              buffer.width,
              command.x + command.dx + column,
              command.y + command.dy + row,
            ),
            source[row * command.width + column] ?? 0,
          );
        }
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
    case "removeBackground": {
      const gate = requireLayer(buffer, command.layerId);
      if ("ok" in gate) return gate;
      const layer = layerById(buffer, command.layerId);
      if (!layer) return fail("LAYER_NOT_FOUND", "That layer is not on this frame.");
      const sample = resolveColor(
        buffer,
        command.color ?? readCell(layer.pixels, indexOf(buffer.width, 0, 0)),
      );
      if (!colorOk(sample)) {
        return fail("COLOR", "The background colour is invalid.");
      }
      const tolerance = Math.max(0, Math.min(255, command.tolerance ?? 0));
      const sampleRgb = [
        (sample >>> 24) & 0xff,
        (sample >>> 16) & 0xff,
        (sample >>> 8) & 0xff,
      ] as const;
      const matches = (color: number) => {
        if ((color & 0xff) === 0) return false;
        return (
          colorDistance(
            [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff],
            sampleRgb,
          ) <= tolerance
        );
      };
      const edgesOnly = command.edgesOnly ?? true;
      const cells = buffer.width * buffer.height;
      if (!edgesOnly) {
        const next = clonePixels(layer.pixels);
        for (let index = 0; index < cells; index += 1) {
          const color = readCell(next, index);
          if (matches(color)) writeCell(next, index, 0);
        }
        return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
      }
      const next = clonePixels(layer.pixels);
      const queue: Point[] = [];
      for (let x = 0; x < buffer.width; x += 1) {
        queue.push({ x, y: 0 }, { x, y: buffer.height - 1 });
      }
      for (let y = 0; y < buffer.height; y += 1) {
        queue.push({ x: 0, y }, { x: buffer.width - 1, y });
      }
      const seen = new Set<number>();
      while (queue.length > 0) {
        const point = queue.pop();
        if (!point) continue;
        if (!inBounds(buffer.width, buffer.height, point.x, point.y)) continue;
        const index = indexOf(buffer.width, point.x, point.y);
        if (seen.has(index)) continue;
        seen.add(index);
        if (!matches(readCell(next, index))) continue;
        writeCell(next, index, 0);
        queue.push(
          { x: point.x + 1, y: point.y },
          { x: point.x - 1, y: point.y },
          { x: point.x, y: point.y + 1 },
          { x: point.x, y: point.y - 1 },
        );
      }
      return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
    }
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

function mirrorPixels(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const next = clonePixels(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      writeCell(
        next,
        indexOf(width, width - 1 - x, y),
        readCell(pixels, indexOf(width, x, y)),
      );
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
      const color =
        command.pixels[row * command.width + column] === undefined
          ? undefined
          : resolveColor(buffer, command.pixels[row * command.width + column] ?? 0);
      if (color === undefined || !colorOk(color)) {
        return fail(
          "COLOR",
          `Row ${row + command.y}, column ${column + command.x} is not a valid RGBA colour.`,
        );
      }
      writeCell(next, indexOf(buffer.width, command.x + column, command.y + row), color);
    }
  }
  const replaced = replaceLayer(buffer, command.layerId, next);
  if (!command.tilemapData) return { ok: true, buffer: replaced };
  return {
    ok: true,
    buffer: {
      ...replaced,
      layers: replaced.layers.map((item) =>
        item.id === command.layerId && item.tilemap
          ? {
              ...item,
              tilemap: { ...item.tilemap, data: [...command.tilemapData!] },
            }
          : item,
      ),
    },
  };
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
      writeCell(
        next,
        indexOf(buffer.width, command.x + column, command.y + row),
        readCell(layer.pixels, indexOf(buffer.width, fromX, fromY)),
      );
    }
  }
  return { ok: true, buffer: replaceLayer(buffer, command.layerId, next) };
}

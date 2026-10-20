import { createThinkTool, createTool } from "@anvia/core";
import { ToolOutput } from "@anvia/core/tool";
import {
  availableSizes,
  availableWeights,
  buildTemplateScene,
  checkScene,
  elementBounds,
  formatBytes,
  formatPresets,
  getPreset,
  layoutText,
  missingGlyphs,
  resolveFont,
  snapTextSize,
  summarizeChecks,
  type Artboard,
  type ArtboardCheck,
  type CopyDeck,
  type Element,
  type PaletteImage,
  type TextElement,
  renderScene,
} from "@pixelaition/artboard";
import { artboardToJpg, artboardToPng } from "@pixelaition/export";
import { z } from "zod";
import {
  assertOwnedArtboard,
  assertPlanApproved,
  requireArtboardRun,
  resolveArtboard,
  spriteFor,
  writeArtboard,
  type ArtboardRunBinding,
} from "./artboard-runs.js";

const MAX_PREVIEW_BYTES = 1024 * 1024;

const anchor = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

const face = z.enum(["silkscreen", "pixelify", "mono"]);
const weight = z.union([z.literal(400), z.literal(600), z.literal(700)]);
const align = z.enum(["left", "center", "right"]);

const artboardId = z
  .string()
  .min(1)
  .optional()
  .describe("The artboard id or name. Omit for the artboard this worker owns.");

const copySchema = z.object({
  eyebrow: z.string().max(200).optional(),
  headline: z.string().max(400).optional(),
  subhead: z.string().max(600).optional(),
  cta: z.string().max(120).optional(),
  handle: z.string().max(120).optional(),
  caption: z.string().max(4000).optional(),
  legal: z.string().max(600).optional(),
});

function checksFor(
  run: ArtboardRunBinding,
  artboard: Artboard,
  bytes?: number,
): ArtboardCheck[] {
  const preset = getPreset(artboard.presetId);
  return checkScene({
    scene: artboard.scene,
    preset,
    palette: run.palette,
    sprites: run.sprites,
    ...(bytes !== undefined ? { bytes } : {}),
  });
}

function encoded(
  run: ArtboardRunBinding,
  artboard: Artboard,
): { png: Uint8Array; bytes: number } {
  const png = artboardToPng(renderFor(run, artboard));
  return { png, bytes: png.length };
}

function renderFor(run: ArtboardRunBinding, artboard: Artboard): PaletteImage {
  const preset = getPreset(artboard.presetId);
  return renderScene({
    scene: artboard.scene,
    preset,
    palette: run.palette,
    sprites: run.sprites,
  }).image;
}

function downsample(image: PaletteImage, factor: number): PaletteImage {
  if (factor <= 1) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const counts = new Map<number, number>();
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= image.width || sy >= image.height) continue;
          const color = image.indices[sy * image.width + sx] ?? 0;
          counts.set(color, (counts.get(color) ?? 0) + 1);
        }
      }
      let best = 0;
      let bestCount = -1;
      for (const [color, count] of counts) {
        if (count > bestCount) {
          best = color;
          bestCount = count;
        }
      }
      indices[y * width + x] = best;
    }
  }
  return { ...image, width, height, indices };
}

function checksJson(checks: ArtboardCheck[]): {
  summary: ReturnType<typeof summarizeChecks>;
  checks: ArtboardCheck[];
} {
  return { summary: summarizeChecks(checks), checks };
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function copyFrom(input: z.infer<typeof copySchema>): CopyDeck {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ) as CopyDeck;
}

/** The complete social tool catalogue. Roles filter it; the task owns the scope. */
export function createArtboardTools(options: { vision?: boolean } = {}) {
  const listFormats = createTool({
    name: "list_formats",
    description:
      "List every social format with its exact output size, safe areas, crops, exclusions, byte limit and notes. Read this before choosing a layout; never invent a dimension.",
    inputSchema: z.object({
      group: z
        .enum(["profile", "cover", "post", "vertical", "video", "banner"])
        .optional(),
    }),
    execute: (input) => {
      const presets = formatPresets
        .filter((preset) => input.group === undefined || preset.group === input.group)
        .map((preset) => ({
          id: preset.id,
          platform: preset.platform,
          group: preset.group,
          label: preset.label,
          width: preset.width,
          height: preset.height,
          minTextSize: preset.minTextSize,
          maxBytes: preset.maxBytes,
          shape: preset.shape,
          defaultTemplate: preset.defaultTemplate,
          safeZones: preset.safeZones,
          crops: preset.crops,
          exclusions: preset.exclusions,
          notes: preset.notes,
          official: preset.official,
          source: preset.source,
          verifiedAt: preset.verifiedAt,
        }));
      return {
        presets,
        fonts: {
          silkscreen: {
            400: availableSizes("silkscreen", 400),
            700: availableSizes("silkscreen", 700),
          },
          pixelify: {
            400: availableSizes("pixelify", 400),
            600: availableSizes("pixelify", 600),
          },
          mono: { 400: availableSizes("mono", 400) },
        },
        note: "`size` is the final pixel height. The tool snaps it to the smallest atlas size at or above the request, or grows the largest by whole pixels; the result reports size/scale/effectiveSize.",
      };
    },
  });

  const readSet = createTool({
    name: "read_set",
    description:
      "Read the set: its name, shared copy, mark, palette and every artboard's scene and status. This is the composition before any edit.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireArtboardRun(context.operationId);
      return {
        setId: run.setId,
        name: run.setName,
        assetId: run.assetId,
        assetName: run.assetName,
        palette: run.palette,
        copy: run.copy,
        artboards: [...run.artboards.values()].map((artboard) => ({
          id: artboard.id,
          name: artboard.name,
          presetId: artboard.presetId,
          width: artboard.width,
          height: artboard.height,
          status: artboard.status,
          version: artboard.version,
          scene: artboard.scene,
          copyOverride: artboard.copyOverride,
        })),
      };
    },
  });

  const listProjectSprites = createTool({
    name: "list_project_sprites",
    description:
      "List every sprite frame available in the project with its asset and dimensions. Use these ids in place_sprite to reuse another asset's artwork.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireArtboardRun(context.operationId);
      return {
        sprites: [...run.sprites.values()].map((sprite) => ({
          assetId: sprite.assetId,
          assetName: sprite.assetName,
          frameId: sprite.frameId,
          frameName: sprite.frameName,
          width: sprite.buffer.width,
          height: sprite.buffer.height,
          palette: sprite.buffer.palette,
        })),
      };
    },
  });

  const readArtboard = createTool({
    name: "read_artboard",
    description:
      "Read one artboard's scene, resolved copy and deterministic checks. Use it before changing a board or to see what a reviewer saw.",
    inputSchema: z.object({ artboardId }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      const checks = checksFor(run, artboard);
      return {
        artboard,
        checks: checksJson(checks),
      };
    },
  });

  const checkArtboard = createTool({
    name: "check_artboard",
    description:
      "Run the deterministic checks on one artboard: exact size, safe areas, crops, exclusions, text overflow, contrast, palette and byte budget. Fix every error before claiming the board is ready.",
    inputSchema: z.object({ artboardId }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      const encodedResult = encoded(run, artboard);
      return {
        artboardId: artboard.id,
        bytes: encodedResult.bytes,
        ...checksJson(checksFor(run, artboard, encodedResult.bytes)),
      };
    },
  });

  const previewArtboard = createTool({
    name: "preview_artboard",
    description:
      "Render one artboard as a PNG you can see. Use it to judge hierarchy and legibility, and to compare a board with the rest of the family. `scale` downsamples by a whole number for a thumbnail check.",
    inputSchema: z.object({
      artboardId,
      scale: z.number().int().min(1).max(8).default(1),
      format: z.enum(["png", "jpg"]).default("png"),
    }),
    execute: async (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      const preset = getPreset(artboard.presetId);
      const image = downsample(renderFor(run, artboard), input.scale);
      const png =
        input.format === "png" ? artboardToPng(image) : artboardToJpg(image, "#0a0a09");
      if (png.length > MAX_PREVIEW_BYTES) {
        throw new Error(
          `The preview is ${formatBytes(png.length)}, over the ${formatBytes(MAX_PREVIEW_BYTES)} image limit. Lower \`scale\`.`,
        );
      }
      const checks = checksFor(run, artboard);
      const summary = summarizeChecks(checks);
      const label = `${artboard.name} · ${preset.label} · ${preset.width}×${preset.height}${input.scale > 1 ? ` shown at 1/${input.scale}` : ""} · ${summary.errors} error${summary.errors === 1 ? "" : "s"}, ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"} · ${formatBytes(png.length)}`;
      if (options.vision === false) {
        if (!run.onDescribeImage) {
          return `${label}\nThe selected model cannot see images; read check_artboard for the geometry and use the copy/positions as evidence.`;
        }
        const description = await run.onDescribeImage({
          data: Buffer.from(png).toString("base64"),
          mediaType: input.format === "png" ? "image/png" : "image/jpeg",
        });
        return `${label}\nSeen by the vision model: ${description}`;
      }
      return ToolOutput.content([
        { type: "text", text: label },
        {
          type: "file",
          data: { type: "data", data: Buffer.from(png).toString("base64") },
          mediaType: input.format === "png" ? "image/png" : "image/jpeg",
          filename: `${uniqueId("preview")}.${input.format}`,
        },
      ]);
    },
  });

  const applyTemplate = createTool({
    name: "apply_template",
    description:
      "Reset an artboard to a slot layout: centered-mark, centered-copy, split-copy, stack-copy, thumbnail, banner-copy, profile-mark, or blank. The template places the mark and the copy inside the safe area; adjust from there.",
    inputSchema: z.object({
      artboardId,
      template: z.enum([
        "blank",
        "centered-mark",
        "centered-copy",
        "split-copy",
        "stack-copy",
        "thumbnail",
        "banner-copy",
        "profile-mark",
      ]),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const preset = getPreset(artboard.presetId);
      const source = spriteFor(run, run.assetId, undefined);
      const scene = buildTemplateScene({
        preset,
        template: input.template,
        copy: run.copy,
        palette: run.palette,
        ...(source ? { sprite: source } : {}),
      });
      const next = { ...artboard, scene };
      writeArtboard(run, next);
      return {
        artboardId: next.id,
        template: input.template,
        elements: next.scene.elements.map((element) => element.id),
        checks: checksJson(checksFor(run, next)),
      };
    },
  });

  const setBackground = createTool({
    name: "set_background",
    description:
      "Set the artboard background: transparent, a solid palette index, or a two-colour checker/dither pattern. Colours are palette indices, never hex.",
    inputSchema: z.object({
      artboardId,
      kind: z.enum(["transparent", "solid", "pattern"]),
      color: z.number().int().nonnegative().optional(),
      colorA: z.number().int().nonnegative().optional(),
      colorB: z.number().int().nonnegative().optional(),
      unit: z.number().int().min(1).max(64).optional(),
      mode: z.enum(["checker", "50"]).optional(),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const background =
        input.kind === "transparent"
          ? { kind: "transparent" as const }
          : input.kind === "solid"
            ? {
                kind: "solid" as const,
                color: requireColor(input.color, run, "background"),
              }
            : {
                kind: "pattern" as const,
                colorA: requireColor(input.colorA, run, "pattern colour A"),
                colorB: requireColor(input.colorB, run, "pattern colour B"),
                unit: input.unit ?? 4,
                mode: input.mode ?? "checker",
              };
      const next = { ...artboard, scene: { ...artboard.scene, background } };
      writeArtboard(run, next);
      return { artboardId: next.id, background };
    },
  });

  const placeSprite = createTool({
    name: "place_sprite",
    description:
      "Place or move the mark on an artboard. The scale is a whole number; the anchor says which part of the mark sits at x,y. A fractional scale is refused rather than blurred.",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1).max(80).default("mark"),
      assetId: z.string().optional(),
      frameId: z.string().optional(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      scale: z.number().int().min(1).max(64),
      anchor: anchor.default("center"),
      replace: z.boolean().default(true),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const source = spriteFor(run, input.assetId, input.frameId);
      if (!source) {
        throw new Error(
          `No sprite frame ${input.frameId ?? "(first)"} for asset ${input.assetId ?? run.assetId}.`,
        );
      }
      const element: Element = {
        id: input.elementId,
        kind: "sprite",
        assetId: source.assetId,
        ...(source.frameId ? { frameId: source.frameId } : {}),
        x: input.x,
        y: input.y,
        scale: input.scale,
        anchor: input.anchor,
      };
      const elements = input.replace
        ? [...artboard.scene.elements.filter((item) => item.id !== element.id), element]
        : [...artboard.scene.elements, element];
      const next = { ...artboard, scene: { ...artboard.scene, elements } };
      writeArtboard(run, next);
      return {
        artboardId: next.id,
        element,
        bounds: elementBounds(element, run.sprites),
        checks: checksJson(checksFor(run, next)),
      };
    },
  });

  const setText = createTool({
    name: "set_text",
    description:
      "Create or update a text element. `size` is the requested final pixel height; it snaps to an atlas size plus whole-pixel scale. Text is wrapped inside `width`; `height` reserves a copy slot (copy edits refit inside it), and `maxLines` plus the deterministic checks report overflow instead of clipping silently.",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1).max(80).default("headline"),
      text: z.string().max(2000),
      face: face.default("silkscreen"),
      weight: weight.optional(),
      size: z.number().int().min(8).max(192),
      scale: z.number().int().min(1).max(8).default(1),
      color: z.number().int().nonnegative(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1).optional(),
      align: align.default("left"),
      lineHeight: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(20).default(3),
      letterSpacing: z.number().int().min(0).max(64).optional(),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      if (input.text.trim().length === 0) {
        const elements = artboard.scene.elements.filter(
          (item) => item.id !== input.elementId,
        );
        const next = { ...artboard, scene: { ...artboard.scene, elements } };
        writeArtboard(run, next);
        return { removed: input.elementId, checks: checksJson(checksFor(run, next)) };
      }
      const resolvedWeight = input.weight ?? (input.face === "silkscreen" ? 700 : 400);
      requireColor(input.color, run, "text");
      const snapped = snapTextSize(input.face, resolvedWeight, input.size);
      const scale = Math.max(1, Math.min(8, input.scale * snapped.scale));
      const font = resolveFont(input.face, resolvedWeight, snapped.size);
      const missing = missingGlyphs(font, input.text);
      if (missing.length > 0) {
        throw new Error(
          `${input.face} cannot render ${missing.map((char) => `"${char}"`).join(", ")}. Rewrite the copy with supported characters.`,
        );
      }
      const existing = artboard.scene.elements.find(
        (item) => item.id === input.elementId,
      );
      const existingHeight = existing?.kind === "text" ? existing.height : undefined;
      const element: TextElement = {
        id: input.elementId,
        kind: "text",
        text: input.text,
        face: input.face,
        weight: resolvedWeight,
        size: snapped.size,
        ...(scale > 1 ? { scale } : {}),
        color: input.color,
        x: input.x,
        y: input.y,
        width: input.width,
        ...(input.height !== undefined
          ? { height: input.height }
          : existingHeight !== undefined
            ? { height: existingHeight }
            : {}),
        align: input.align,
        ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
        maxLines: input.maxLines,
        ...(input.letterSpacing !== undefined
          ? { letterSpacing: input.letterSpacing }
          : {}),
      };
      const elements = [
        ...artboard.scene.elements.filter((item) => item.id !== element.id),
        element,
      ];
      const next = { ...artboard, scene: { ...artboard.scene, elements } };
      writeArtboard(run, next);
      const layout = layoutText(element);
      return {
        artboardId: next.id,
        element,
        lines: layout.lines.length,
        width: layout.width,
        height: layout.height,
        size: snapped.size,
        scale,
        effectiveSize: snapped.size * scale,
        checks: checksJson(checksFor(run, next)),
      };
    },
  });

  const addRect = createTool({
    name: "add_rect",
    description: "Add a solid palette block (a band, a rule, a backdrop).",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1).max(80).optional(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      color: z.number().int().nonnegative(),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      requireColor(input.color, run, "rect");
      const element: Element = {
        id: input.elementId ?? uniqueId("rect"),
        kind: "rect",
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        color: input.color,
      };
      const next = addElement(artboard, element);
      writeArtboard(run, next);
      return { artboardId: next.id, element };
    },
  });

  const addPattern = createTool({
    name: "add_pattern",
    description: "Add a checker or dither texture block in two palette colours.",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1).max(80).optional(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      colorA: z.number().int().nonnegative(),
      colorB: z.number().int().nonnegative(),
      unit: z.number().int().min(1).max(64).default(4),
      mode: z.enum(["checker", "50"]).default("checker"),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      requireColor(input.colorA, run, "pattern colour A");
      requireColor(input.colorB, run, "pattern colour B");
      const element: Element = {
        id: input.elementId ?? uniqueId("pattern"),
        kind: "pattern",
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        colorA: input.colorA,
        colorB: input.colorB,
        unit: input.unit,
        mode: input.mode,
      };
      const next = addElement(artboard, element);
      writeArtboard(run, next);
      return { artboardId: next.id, element };
    },
  });

  const addFrame = createTool({
    name: "add_frame",
    description: "Add a rectangular border in a palette colour.",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1).max(80).optional(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      thickness: z.number().int().min(1).max(64),
      color: z.number().int().nonnegative(),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      requireColor(input.color, run, "frame");
      const element: Element = {
        id: input.elementId ?? uniqueId("frame"),
        kind: "frame",
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        thickness: input.thickness,
        color: input.color,
        safe: false,
      };
      const next = addElement(artboard, element);
      writeArtboard(run, next);
      return { artboardId: next.id, element };
    },
  });

  const removeElement = createTool({
    name: "remove_element",
    description: "Remove one element from an artboard by id.",
    inputSchema: z.object({ artboardId, elementId: z.string().min(1) }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const elements = artboard.scene.elements.filter(
        (element) => element.id !== input.elementId,
      );
      if (elements.length === artboard.scene.elements.length) {
        throw new Error(`No element with id "${input.elementId}".`);
      }
      const next = { ...artboard, scene: { ...artboard.scene, elements } };
      writeArtboard(run, next);
      return { artboardId: next.id, removed: input.elementId };
    },
  });

  const moveElement = createTool({
    name: "move_element",
    description:
      "Move an element to a new top-left position, or nudge it by dx/dy. Positions are whole output pixels.",
    inputSchema: z.object({
      artboardId,
      elementId: z.string().min(1),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      dx: z.number().int().optional(),
      dy: z.number().int().optional(),
    }),
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const element = artboard.scene.elements.find((item) => item.id === input.elementId);
      if (!element) throw new Error(`No element with id "${input.elementId}".`);
      const x = Math.max(0, Math.round(input.x ?? element.x + (input.dx ?? 0)));
      const y = Math.max(0, Math.round(input.y ?? element.y + (input.dy ?? 0)));
      const elements = artboard.scene.elements.map((item) =>
        item.id === input.elementId ? { ...item, x, y } : item,
      );
      const next = { ...artboard, scene: { ...artboard.scene, elements } };
      writeArtboard(run, next);
      return { artboardId: next.id, elementId: input.elementId, x, y };
    },
  });

  const saveArtboard = createTool({
    name: "save_artboard",
    description:
      "Persist the artboard you own. Save only after the deterministic checks are clean; the result is the version the set and the exporter read.",
    inputSchema: z.object({ artboardId }),
    execute: async (input, context) => {
      const run = requireArtboardRun(context.operationId);
      assertPlanApproved(run);
      const artboard = resolveArtboard(run, input.artboardId);
      assertOwnedArtboard(run, artboard.id);
      const encodedResult = encoded(run, artboard);
      const checks = checksFor(run, artboard, encodedResult.bytes);
      const saved = run.onSave
        ? await run.onSave({
            ...artboard,
            status: summarizeChecks(checks).ok ? "ready" : "needs-fix",
          })
        : artboard;
      writeArtboard(run, saved);
      return {
        artboardId: saved.id,
        version: saved.version,
        status: saved.status,
        bytes: encodedResult.bytes,
        ...checksJson(checks),
      };
    },
  });

  const createArtboard = createTool({
    name: "create_artboard",
    description:
      "Add a format to the set after the plan is approved. The preset owns its exact size and safe areas.",
    inputSchema: z.object({
      presetId: z.string().min(1),
      name: z.string().min(1).max(80).optional(),
      template: z
        .enum([
          "blank",
          "centered-mark",
          "centered-copy",
          "split-copy",
          "stack-copy",
          "thumbnail",
          "banner-copy",
          "profile-mark",
        ])
        .optional(),
      copy: copySchema.optional(),
    }),
    execute: async (input, context) => {
      const run = requireArtboardRun(context.operationId);
      if (run.planApproved !== true) {
        throw new Error(
          "The plan is not approved yet. Call present_artboard_plan first.",
        );
      }
      if (!run.onCreate) throw new Error("This run cannot create artboards.");
      const artboard = await run.onCreate({
        presetId: input.presetId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.copy !== undefined ? { copy: copyFrom(input.copy) } : {}),
      });
      writeArtboard(run, artboard);
      return { artboard, checks: checksJson(checksFor(run, artboard)) };
    },
  });

  const deleteArtboard = createTool({
    name: "delete_artboard",
    description: "Remove an artboard from the set. The director's structural call.",
    inputSchema: z.object({ artboardId: z.string().min(1) }),
    execute: async (input, context) => {
      const run = requireArtboardRun(context.operationId);
      assertPlanApproved(run);
      if (!run.onDelete) throw new Error("This run cannot delete artboards.");
      const artboard = resolveArtboard(run, input.artboardId);
      await run.onDelete(artboard.id);
      run.artboards.delete(artboard.id);
      return { deleted: artboard.id };
    },
  });

  const setCopy = createTool({
    name: "set_copy",
    description:
      "Replace the shared copy deck and propagate it to every board that has not overridden a field. Keep on-image copy short; the caption is a post field.",
    inputSchema: copySchema,
    execute: async (input, context) => {
      const run = requireArtboardRun(context.operationId);
      assertPlanApproved(run);
      if (!run.onSetCopy) throw new Error("This run cannot change the set copy.");
      const copy = copyFrom(input);
      const result = await run.onSetCopy(copy);
      run.copy = copy;
      run.artboards = new Map(
        result.artboards.map((artboard) => [artboard.id, artboard]),
      );
      return { copy, changed: result.artboards.length };
    },
  });

  const presentPlan = createTool({
    name: "present_artboard_plan",
    description:
      "Ask the user to approve the set plan. Use it once, after writing the plan JSON in your reply and before creating or editing any artboard.",
    inputSchema: z.object({
      summary: z.string().min(1).max(400),
      formats: z.array(z.string().min(1)).max(40).default([]),
    }),
    requiresApproval: true,
    execute: (input, context) => {
      const run = requireArtboardRun(context.operationId);
      run.planApproved = true;
      return {
        approved: true,
        summary: input.summary,
        formats: input.formats,
        next: "Create the planned boards with create_artboard, then compose each one.",
      };
    },
  });

  const plan = createTool({
    name: "plan",
    description:
      "Record the steps you will take in the run console. Revise it by calling plan again.",
    inputSchema: z.object({
      steps: z.array(z.string().min(1).max(200)).min(1).max(20),
    }),
    execute: (input) => ({ steps: input.steps }),
  });

  return [
    listFormats,
    readSet,
    listProjectSprites,
    readArtboard,
    checkArtboard,
    previewArtboard,
    applyTemplate,
    setBackground,
    placeSprite,
    setText,
    addRect,
    addPattern,
    addFrame,
    removeElement,
    moveElement,
    saveArtboard,
    createArtboard,
    deleteArtboard,
    setCopy,
    presentPlan,
    plan,
    createThinkTool(),
  ];
}

function addElement(artboard: Artboard, element: Element): Artboard {
  return {
    ...artboard,
    scene: {
      ...artboard.scene,
      elements: [
        ...artboard.scene.elements.filter((item) => item.id !== element.id),
        element,
      ],
    },
  };
}

function requireColor(
  color: number | undefined,
  run: ArtboardRunBinding,
  label: string,
): number {
  if (color === undefined) throw new Error(`The ${label} needs a palette colour index.`);
  if (!Number.isInteger(color) || color < 0 || color >= run.palette.length) {
    throw new Error(
      `Palette index ${color} is outside the ${run.palette.length}-colour palette.`,
    );
  }
  return color;
}

/** The sizes a face can render, for a tool error or an inspector picker. */
export function textSizes(
  face: "silkscreen" | "pixelify" | "mono",
  weight?: 400 | 600 | 700,
): number[] {
  const resolved = weight ?? (face === "silkscreen" ? 700 : 400);
  return availableSizes(face, resolved);
}

export function textWeights(face: "silkscreen" | "pixelify" | "mono") {
  return availableWeights(face);
}

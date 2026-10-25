import { z } from "zod";
import {
  MAX_SIZE,
  MIN_SIZE,
  blendModes,
  shadowDirections,
  tagDirections,
} from "./types.js";

const hex = z.string().regex(/^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/);

export const styleGuideSchema = z.object({
  defaultWidth: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  defaultHeight: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  outline: hex,
  shadowDirection: z.enum(shadowDirections),
  notes: z.string().max(2000),
});

export const textLayerSchema = z.object({
  text: z.string().max(2000),
  face: z.enum(["silkscreen", "pixelify", "mono"]),
  weight: z.union([z.literal(400), z.literal(700)]),
  size: z.number().int().min(1).max(4096),
  color: z.number().int().nonnegative(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  align: z.enum(["left", "center", "right"]),
  lineHeight: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  letterSpacing: z.number().int().optional(),
  scale: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
});

export const layerGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  opacity: z.number().min(0).max(1).optional(),
  parentGroupId: z.string().min(1).optional(),
});

export const layerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  pixels: z.string(),
  text: textLayerSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: z.enum(blendModes).optional(),
  locked: z.boolean().optional(),
  parentGroupId: z.string().min(1).optional(),
});

export const frameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  index: z.number().int().nonnegative(),
  layers: z.array(layerSchema).min(1),
  groups: z.array(layerGroupSchema).optional(),
  durationMs: z.number().int().min(10).max(60_000).optional(),
});

export const sliceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  nineSlice: z
    .object({
      left: z.number().int().min(0),
      right: z.number().int().min(0),
      top: z.number().int().min(0),
      bottom: z.number().int().min(0),
    })
    .optional(),
  pivot: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  width: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  height: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  palette: z.array(hex).min(2).max(256),
  frames: z.array(frameSchema).min(1),
  slices: z.array(sliceSchema).optional(),
  tags: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(40),
        fromFrameId: z.string().min(1),
        toFrameId: z.string().min(1),
        direction: z.enum(tagDirections),
        loop: z.boolean(),
        color: hex.optional(),
      }),
    )
    .optional(),
});

export const pixelProjectSchema = z.object({
  format: z.literal("pixelaition"),
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(2000),
    style: styleGuideSchema,
  }),
  assets: z.array(assetSchema),
});

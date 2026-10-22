import { z } from "zod";
import { MAX_SIZE, MIN_SIZE, shadowDirections } from "./types.js";

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
  size: z.number().int().min(4).max(120),
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

export const layerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  pixels: z.string(),
  text: textLayerSchema.optional(),
});

export const frameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  index: z.number().int().nonnegative(),
  layers: z.array(layerSchema).min(1),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  width: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  height: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  palette: z.array(hex).min(2).max(256),
  frames: z.array(frameSchema).min(1),
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

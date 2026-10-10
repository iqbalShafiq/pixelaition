import { z } from "zod";
import { MAX_SIZE, MIN_SIZE, shadowDirections } from "./types.js";

const hex = z.string().regex(/^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/);

export const styleGuideSchema = z.object({
  defaultWidth: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  defaultHeight: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  maxColors: z.number().int().min(1).max(32),
  outline: hex,
  shadowDirection: z.enum(shadowDirections),
  notes: z.string().max(2000),
});

export const layerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  visible: z.boolean(),
  pixels: z.string(),
});

export const frameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  index: z.number().int().nonnegative(),
  layers: z.array(layerSchema).min(1).max(4),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  width: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  height: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  palette: z.array(hex).min(2).max(33),
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

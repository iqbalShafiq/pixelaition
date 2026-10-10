import { createTool } from "@anvia/core";
import { applyCommand, type FrameBuffer } from "@pixelaition/pixel";
import { z } from "zod";
import { paintStroke, refreshCritique, requireRun } from "./runs.js";

const point = z.object({
  x: z.number().int(),
  y: z.number().int(),
  color: z.number().int().nonnegative(),
});

export function createPixelTools() {
  const readProject = createTool({
    name: "read_project",
    description: "Read the style guide and frame names for the asset being drawn.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      return {
        assetId: run.assetId,
        frameId: run.frameId,
        width: run.buffer.width,
        height: run.buffer.height,
        palette: run.buffer.palette,
        layers: run.buffer.layers.map((layer) => layer.name),
        style: run.style,
      };
    },
  });

  const readFrame = createTool({
    name: "read_frame",
    description:
      "Read the current frame as rows of palette indexes. Zero is transparent.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      const layer =
        run.buffer.layers.find((item) => item.visible) ?? run.buffer.layers[0];
      const rows: string[] = [];
      if (!layer) return { rows };
      for (let y = 0; y < run.buffer.height; y += 1) {
        const row: number[] = [];
        for (let x = 0; x < run.buffer.width; x += 1) {
          row.push(layer.pixels[y * run.buffer.width + x] ?? 0);
        }
        rows.push(row.join(""));
      }
      return { layerId: layer.id, rows };
    },
  });

  const paint = createTool({
    name: "paint_stroke",
    description:
      "Paint up to 48 pixels on a layer. Colors are palette indexes. The server stores only the pixels it accepts.",
    inputSchema: z.object({
      layerId: z.string(),
      label: z.string().min(1).max(40),
      points: z.array(point).min(1).max(48),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const stroke = paintStroke(run, input.layerId, input.label, input.points);
      return { committed: stroke.points.length, label: stroke.label };
    },
  });

  const fillRect = createTool({
    name: "fill_rect",
    description: "Fill a rectangle on a layer with one palette index.",
    inputSchema: z.object({
      layerId: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color: z.number().int().nonnegative(),
    }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const result = applyCommand(run.buffer, { type: "rect", ...input, filled: true });
      if (!result.ok) throw new Error(result.message);
      run.buffer = result.buffer;
      run.onStroke?.(
        {
          label: "fill",
          points: [],
        },
        run.buffer,
      );
      return { committed: true };
    },
  });

  const setPalette = createTool({
    name: "set_palette",
    description: "Replace the palette. Index 0 must stay #00000000.",
    inputSchema: z.object({ palette: z.array(z.string()).min(2).max(33) }),
    execute: (input, context) => {
      const run = requireRun(context.operationId);
      const result = applyCommand(run.buffer, {
        type: "setPalette",
        palette: input.palette,
      });
      if (!result.ok) throw new Error(result.message);
      run.buffer = result.buffer;
      return { palette: run.buffer.palette };
    },
  });

  const critique = createTool({
    name: "critique_frame",
    description:
      "Run the deterministic pixel critique. Finish only when issues is empty.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      return { issues: refreshCritique(run) };
    },
  });

  const mirror = createTool({
    name: "mirror_frame",
    description:
      "Flip every layer horizontally. Use this for a left/right variant before painting differences.",
    inputSchema: z.object({}),
    execute: (_input, context) => {
      const run = requireRun(context.operationId);
      const result = applyCommand(run.buffer, { type: "mirror" });
      if (!result.ok) throw new Error(result.message);
      run.buffer = result.buffer;
      return { committed: true };
    },
  });

  return [readProject, readFrame, paint, fillRect, setPalette, critique, mirror];
}

export function activeLayerId(buffer: FrameBuffer): string {
  return buffer.layers.find((layer) => layer.visible)?.id ?? buffer.layers[0]?.id ?? "";
}

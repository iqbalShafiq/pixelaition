import { readFile, writeFile } from "node:fs/promises";
import {
  applyCommand,
  bufferToFrame,
  createBuffer,
  createProject,
  frameToBuffer,
  paletteFromImage,
  pixelProjectSchema,
  quantizeToPalette,
  type Asset,
  type Command,
  type Frame,
  type FrameBuffer,
  type Slice,
} from "@pixelaition/pixel";
import {
  atlasForEngine,
  type AtlasPreset,
  frameToJpg,
  frameToPng,
  frameToTileset,
  framesToApng,
  framesToGif,
  framesToSheet,
  sheetToAsepriteJson,
  zipFiles,
} from "@pixelaition/export";
import { PNG } from "pngjs";

/**
 * A small file-mode companion to the editor. It reads and writes the same .pxl
 * document and calls the same renderers, so a CI job cannot drift from the app.
 */
export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "export") {
    await exportProject(rest);
    return;
  }
  if (command === "import") {
    await importImage(rest);
    return;
  }
  if (command === "import-aseprite") {
    await importAsepriteJson(rest);
    return;
  }
  if (command === "inspect") {
    await inspectProject(rest);
    return;
  }
  if (command === "apply-script") {
    await applyScript(rest);
    return;
  }
  throw new Error(`Unknown command "${command}". Try --help.`);
}

function printHelp(): void {
  console.log(`pixelaition

  pixelaition inspect <project.pxl>
  pixelaition export <project.pxl> --out <path> [--format png|jpg|gif|apng|sheet|png-sequence] [--asset name] [--scale n]
  pixelaition import <image.png> --out <project.pxl> [--name name] [--colors 32]
  pixelaition import-aseprite <sheet.png> <atlas.json> --out <project.pxl> [--name name] [--colors 32]
  pixelaition apply-script <project.pxl> <script.json> --out <project.pxl>

Formats use the editor's palette, renderer, and atlas contract.`);
}

async function readProject(path: string) {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return pixelProjectSchema.parse(raw);
}

async function inspectProject(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) throw new Error("inspect needs a .pxl path.");
  const project = await readProject(path);
  console.log(
    JSON.stringify(
      {
        project: project.project.name,
        assets: project.assets.map((asset) => ({
          name: asset.name,
          width: asset.width,
          height: asset.height,
          frames: asset.frames.length,
          tags: asset.tags?.length ?? 0,
          slices: asset.slices?.length ?? 0,
        })),
      },
      null,
      2,
    ),
  );
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function selectedAsset(project: Awaited<ReturnType<typeof readProject>>, name?: string) {
  const asset = name
    ? project.assets.find((item) => item.name === name || item.id === name)
    : project.assets[0];
  if (!asset) throw new Error(`No asset named "${name ?? "the first asset"}".`);
  return asset;
}

function frameBuffer(asset: Asset, frame: Frame): FrameBuffer {
  return frameToBuffer(
    frame,
    frame.width ?? asset.width,
    frame.height ?? asset.height,
    asset.palette,
  );
}

async function exportProject(args: string[]): Promise<void> {
  const input = args[0];
  const out = option(args, "out");
  if (!input || !out) throw new Error("export needs an input and --out.");
  const project = await readProject(input);
  const asset = selectedAsset(project, option(args, "asset"));
  const format = (option(args, "format") ?? "png").toLowerCase();
  const scale = Number(option(args, "scale") ?? "1");
  const frames = asset.frames.map((frame) => ({
    frame,
    buffer: frameBuffer(asset, frame),
    durationMs: frame.durationMs ?? 100,
  }));
  if (format === "png" || format === "jpg") {
    const first = frames[0];
    if (!first) throw new Error("That asset has no frames.");
    const bytes =
      format === "png"
        ? frameToPng(first.buffer, scale)
        : frameToJpg(first.buffer, scale);
    await writeFile(out, bytes);
    return;
  }
  if (format === "gif") {
    await writeFile(out, framesToGif(frames, asset.palette, { scale }));
    return;
  }
  if (format === "apng") {
    await writeFile(out, framesToApng(frames, { scale }));
    return;
  }
  if (format === "tileset") {
    const first = frames[0];
    if (!first) throw new Error("That asset has no frames.");
    const tileset = frameToTileset(
      first.buffer,
      Number(option(args, "tile-width") ?? "16"),
      Number(option(args, "tile-height") ?? "16"),
      slug(asset.name),
    );
    await writeFile(
      out,
      zipFiles({
        ...tileset.tiles,
        [`${slug(asset.name)}-tileset.json`]: `${JSON.stringify(tileset.meta, null, 2)}\n`,
      }),
    );
    return;
  }
  if (format === "sheet" || format === "png-sequence" || format === "aseprite-json") {
    if (format === "png-sequence") {
      const files: Record<string, Uint8Array> = {};
      frames.forEach((entry, index) => {
        files[`${slug(asset.name)}-${String(index + 1).padStart(3, "0")}.png`] =
          frameToPng(entry.buffer, scale);
      });
      await writeFile(out, zipFiles(files));
      return;
    }
    if (format === "aseprite-json") {
      const sheet = framesToSheet(
        frames.map((entry) => ({
          name: entry.frame.name,
          buffer: entry.buffer,
          durationMs: entry.durationMs,
        })),
        (asset.tags ?? []) as never,
        {
          scale,
          imageName: `${slug(asset.name)}.png`,
          slices: (asset.slices ?? []) as Slice[],
        },
      );
      const tags = (asset.tags ?? []).flatMap((tag) => {
        const from = frames.findIndex((entry) => entry.frame.id === tag.fromFrameId);
        const to = frames.findIndex((entry) => entry.frame.id === tag.toFrameId);
        if (from < 0 || to < 0) return [];
        return [
          {
            name: tag.name,
            from: Math.min(from, to),
            to: Math.max(from, to),
            direction: tag.direction,
          },
        ];
      });
      await writeFile(
        out,
        zipFiles({
          [`${slug(asset.name)}.png`]: sheet.png,
          [`${slug(asset.name)}.json`]: `${JSON.stringify(
            sheetToAsepriteJson(sheet, tags, `${slug(asset.name)}.png`),
            null,
            2,
          )}\n`,
        }),
      );
      return;
    }
    const sheet = framesToSheet(
      frames.map((entry) => ({
        name: entry.frame.name,
        buffer: entry.buffer,
        durationMs: entry.durationMs,
      })),
      (asset.tags ?? []) as never,
      {
        scale,
        imageName: `${slug(asset.name)}.png`,
        slices: (asset.slices ?? []) as Slice[],
        packed: args.includes("--packed"),
      },
    );
    await writeFile(
      out,
      zipFiles({
        [`${slug(asset.name)}.png`]: sheet.png,
        [`${slug(asset.name)}-atlas.json`]: `${JSON.stringify(
          atlasForEngine(
            sheet,
            (option(args, "atlas-preset") as AtlasPreset | undefined) ?? "native",
          ),
          null,
          2,
        )}\n`,
      }),
    );
    return;
  }
  throw new Error(`Unsupported format "${format}".`);
}

async function importImage(args: string[]): Promise<void> {
  const input = args[0];
  const out = option(args, "out");
  if (!input || !out) throw new Error("import needs an image and --out.");
  const image = PNG.sync.read(await readFile(input));
  const rgba = new Uint8Array(image.data);
  const palette = paletteFromImage(
    { data: rgba, width: image.width, height: image.height },
    Number(option(args, "colors") ?? "32"),
  );
  if (!palette[0] || palette[0].slice(-2).toLowerCase() !== "00") {
    palette.unshift("#00000000");
  }
  if (palette.length < 2) palette.push("#000000");
  const buffer = createBuffer({
    width: image.width,
    height: image.height,
    palette: palette.slice(0, 255),
  });
  buffer.layers[0]?.pixels.set(
    quantizeToPalette({ data: rgba, width: image.width, height: image.height }, palette),
  );
  const frame = bufferToFrame(buffer, {
    id: crypto.randomUUID(),
    name: "imported",
    index: 0,
  });
  const asset: Asset = {
    id: crypto.randomUUID(),
    name: option(args, "name") ?? "imported",
    width: image.width,
    height: image.height,
    palette: [...buffer.palette],
    frames: [frame],
  };
  const project = createProject(asset.name);
  project.assets.push(asset);
  await writeFile(out, `${JSON.stringify(project, null, 2)}\n`);
}

type AsepriteAtlas = {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated?: boolean;
      trimmed?: boolean;
      duration?: number;
    }
  >;
  meta?: {
    frameTags?: Array<{
      name: string;
      from: number;
      to: number;
      direction?: string;
    }>;
  };
};

/** Import Aseprite's JSON spritesheet export (not the binary .ase format). */
async function importAsepriteJson(args: string[]): Promise<void> {
  const imagePath = args[0];
  const jsonPath = args[1];
  const out = option(args, "out");
  if (!imagePath || !jsonPath || !out) {
    throw new Error("import-aseprite needs a PNG, an atlas JSON, and --out.");
  }
  const image = PNG.sync.read(await readFile(imagePath));
  const rgba = new Uint8Array(image.data);
  const atlas = JSON.parse(await readFile(jsonPath, "utf8")) as AsepriteAtlas;
  const entries = Object.entries(atlas.frames ?? {});
  if (entries.length === 0) throw new Error("The atlas has no frames.");
  for (const [name, entry] of entries) {
    if (entry.rotated || entry.trimmed) {
      throw new Error(
        `Aseprite frame "${name}" is rotated or trimmed; re-export it untrimmed.`,
      );
    }
  }
  const palette = paletteFromImage(
    { data: rgba, width: image.width, height: image.height },
    Number(option(args, "colors") ?? "32"),
  );
  if (!palette[0] || palette[0].slice(-2).toLowerCase() !== "00") {
    palette.unshift("#00000000");
  }
  if (palette.length < 2) palette.push("#000000");
  const frames: Frame[] = entries.map(([, entry], index) => {
    const width = entry.frame.w;
    const height = entry.frame.h;
    const slice = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = ((entry.frame.y + y) * image.width + entry.frame.x + x) * 4;
        const target = (y * width + x) * 4;
        slice[target] = rgba[source] ?? 0;
        slice[target + 1] = rgba[source + 1] ?? 0;
        slice[target + 2] = rgba[source + 2] ?? 0;
        slice[target + 3] = rgba[source + 3] ?? 0;
      }
    }
    const buffer = createBuffer({ width, height, palette: palette.slice(0, 255) });
    buffer.layers[0]?.pixels.set(
      quantizeToPalette({ data: slice, width, height }, palette),
    );
    return bufferToFrame(buffer, {
      id: crypto.randomUUID(),
      name: `frame-${index + 1}`,
      index,
      durationMs: Math.max(10, Math.round(entry.duration ?? 100)),
    });
  });
  const first = frames[0];
  if (!first) throw new Error("The atlas has no frames.");
  const asset: Asset = {
    id: crypto.randomUUID(),
    name: option(args, "name") ?? "aseprite",
    width: first.width ?? image.width,
    height: first.height ?? image.height,
    palette: [...(frames[0] ? palette.slice(0, 255) : palette)],
    frames,
    tags: (atlas.meta?.frameTags ?? []).flatMap((tag) => {
      const from = frames[tag.from];
      const to = frames[tag.to];
      if (!from || !to) return [];
      return [
        {
          id: crypto.randomUUID(),
          name: tag.name,
          fromFrameId: from.id,
          toFrameId: to.id,
          direction:
            tag.direction === "reverse" || tag.direction === "pingpong"
              ? tag.direction
              : "forward",
          loop: true,
        },
      ];
    }),
  };
  const project = createProject(asset.name);
  project.assets.push(asset);
  await writeFile(out, `${JSON.stringify(project, null, 2)}\n`);
}

type CommandScript = {
  asset?: string;
  frame?: string;
  commands: Command[];
};

/** Apply a JSON command script; every command still goes through applyCommand. */
async function applyScript(args: string[]): Promise<void> {
  const input = args[0];
  const scriptPath = args[1];
  const out = option(args, "out");
  if (!input || !scriptPath || !out) {
    throw new Error("apply-script needs a project, a script, and --out.");
  }
  const project = await readProject(input);
  const script = JSON.parse(await readFile(scriptPath, "utf8")) as CommandScript;
  const asset = selectedAsset(project, script.asset);
  const frame = script.frame
    ? asset.frames.find((item) => item.name === script.frame || item.id === script.frame)
    : asset.frames[0];
  if (!frame) throw new Error(`No frame named "${script.frame ?? "the first frame"}".`);
  let buffer = frameToBuffer(frame, asset.width, asset.height, asset.palette);
  const layerIds = new Map(buffer.layers.map((layer) => [layer.name, layer.id]));
  for (const [index, raw] of script.commands.entries()) {
    const command =
      "layerId" in raw && typeof raw.layerId === "string"
        ? ({ ...raw, layerId: layerIds.get(raw.layerId) ?? raw.layerId } as Command)
        : raw;
    const result = applyCommand(buffer, command);
    if (!result.ok) {
      throw new Error(`Command ${index + 1} (${raw.type}): ${result.message}`);
    }
    buffer = result.buffer;
  }
  const nextFrame: Frame = {
    ...bufferToFrame(buffer, {
      id: frame.id,
      name: frame.name,
      index: frame.index,
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
    }),
  };
  const nextAsset: Asset = {
    ...asset,
    palette: [...buffer.palette],
    frames: asset.frames.map((item) => (item.id === frame.id ? nextFrame : item)),
  };
  await writeFile(
    out,
    `${JSON.stringify(
      {
        ...project,
        assets: project.assets.map((item) => (item.id === asset.id ? nextAsset : item)),
      },
      null,
      2,
    )}\n`,
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sprite"
  );
}

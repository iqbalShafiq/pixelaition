import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { applyCommand, bufferToFrame, frameToBuffer } from "@pixelaition/pixel";
import { z } from "zod";

const api = process.env.PIXELAITION_API_URL ?? "http://localhost:3001";
const token = process.env.PIXELAITION_API_TOKEN ?? "";

async function call(path: string, init?: RequestInit) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `API ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

const server = new McpServer({ name: "pixelaition", version: "0.1.0" });

type AssetFrame = {
  id: string;
  name: string;
  index: number;
  kind?: "sprite" | "social";
  width?: number | null;
  height?: number | null;
  presetId?: string | null;
  scene?: unknown;
  layers: Array<{ id: string; name: string; visible: boolean; pixels: string }>;
};
type AssetRecord = {
  id: string;
  projectId: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: AssetFrame[];
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function loadAsset(assetId: string): Promise<AssetRecord> {
  return (await call(`/api/assets/${assetId}`)) as AssetRecord;
}

function frameOf(asset: AssetRecord, frameId: string): AssetFrame {
  const frame = asset.frames.find((item) => item.id === frameId);
  if (!frame) throw new Error(`Frame ${frameId} is not on asset ${asset.id}.`);
  return frame;
}

async function writeFrame(
  asset: AssetRecord,
  frameId: string,
  layers: AssetFrame["layers"],
) {
  return call(`/api/assets/${asset.id}/frames/${frameId}`, {
    method: "PUT",
    body: JSON.stringify({ layers }),
  });
}

server.registerTool(
  "list_projects",
  { description: "List Pixelaition projects for the token owner.", inputSchema: {} },
  async () => text(await call("/api/projects")),
);

server.registerTool(
  "create_project",
  {
    description: "Create a project.",
    inputSchema: { name: z.string(), description: z.string().optional() },
  },
  async ({ name, description }) =>
    text(
      await call("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      }),
    ),
);

server.registerTool(
  "get_project",
  {
    description: "Read one project with its asset list and style guide.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => text(await call(`/api/projects/${projectId}`)),
);

server.registerTool(
  "list_assets",
  {
    description: "List the assets in a project.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => {
    const project = (await call(`/api/projects/${projectId}`)) as {
      assets: Array<{ id: string; name: string }>;
    };
    return text(project.assets);
  },
);

server.registerTool(
  "get_asset",
  {
    description: "Read one asset, including frames and palette indexes.",
    inputSchema: { assetId: z.string() },
  },
  async ({ assetId }) => text(await loadAsset(assetId)),
);

server.registerTool(
  "create_asset",
  {
    description: "Create an asset in a project.",
    inputSchema: { projectId: z.string(), name: z.string() },
  },
  async ({ projectId, name }) =>
    text(
      await call(`/api/projects/${projectId}/assets`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    ),
);

server.registerTool(
  "get_frame",
  {
    description:
      "Read one frame as rows of palette indexes. Zero is transparent. Pass rows=false to get the encoded layers instead.",
    inputSchema: {
      assetId: z.string(),
      frameId: z.string(),
      rows: z.boolean().default(true),
    },
  },
  async ({ assetId, frameId, rows }) => {
    const asset = await loadAsset(assetId);
    const frame = frameOf(asset, frameId);
    if (!rows) return text(frame);
    const buffer = frameToBuffer(frame, asset.width, asset.height, asset.palette);
    const layer = buffer.layers.find((item) => item.visible) ?? buffer.layers[0];
    if (!layer) return text({ layerId: null, rows: [] });
    const grid: string[] = [];
    for (let y = 0; y < buffer.height; y += 1) {
      const line: number[] = [];
      for (let x = 0; x < buffer.width; x += 1) {
        line.push(layer.pixels[y * buffer.width + x] ?? 0);
      }
      grid.push(line.join(""));
    }
    return text({ layerId: layer.id, name: layer.name, rows: grid });
  },
);

server.registerTool(
  "paint_pixels",
  {
    description:
      "Paint or erase pixels on a frame. Colors are palette indexes, not hex. The server stores only the pixels it accepts.",
    inputSchema: {
      assetId: z.string(),
      frameId: z.string(),
      layerId: z.string().optional(),
      mode: z.enum(["paint", "erase"]).default("paint"),
      points: z
        .array(z.object({ x: z.number().int(), y: z.number().int() }))
        .min(1)
        .max(256),
      color: z.number().int().nonnegative().default(1),
    },
  },
  async ({ assetId, frameId, layerId, mode, points, color }) => {
    const asset = await loadAsset(assetId);
    const frame = frameOf(asset, frameId);
    let buffer = frameToBuffer(frame, asset.width, asset.height, asset.palette);
    const target = layerId ?? buffer.layers[0]?.id;
    if (!target) throw new Error("That frame has no layer to paint on.");
    const result = applyCommand(
      buffer,
      mode === "erase"
        ? { type: "erase", layerId: target, points }
        : {
            type: "paint",
            layerId: target,
            points: points.map((point) => ({ ...point, color })),
          },
    );
    if (!result.ok) throw new Error(result.message);
    buffer = result.buffer;
    await writeFrame(asset, frameId, bufferToFrame(buffer, frame).layers);
    return text({ committed: points.length, mode });
  },
);

server.registerTool(
  "set_palette",
  {
    description:
      "Replace an asset palette. Index 0 must stay #00000000. Refused if a frame still uses a color the new palette would remove.",
    inputSchema: { assetId: z.string(), palette: z.array(z.string()).min(2).max(256) },
  },
  async ({ assetId, palette }) =>
    text(
      await call(`/api/assets/${assetId}`, {
        method: "PATCH",
        body: JSON.stringify({ palette }),
      }),
    ),
);

server.registerTool(
  "create_frame",
  {
    description: "Add an empty frame to an asset.",
    inputSchema: { assetId: z.string(), name: z.string().default("") },
  },
  async ({ assetId, name }) =>
    text(
      await call(`/api/assets/${assetId}/frames`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    ),
);

server.registerTool(
  "duplicate_frame",
  {
    description: "Copy a frame, which is how a new state or facing starts.",
    inputSchema: {
      assetId: z.string(),
      frameId: z.string(),
      name: z.string().optional(),
    },
  },
  async ({ assetId, frameId, name }) =>
    text(
      await call(`/api/assets/${assetId}/frames/${frameId}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    ),
);

async function exportImage(body: Record<string, unknown>) {
  const response = await fetch(`${api}/api/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  const type = response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    content: [
      {
        type: "image" as const,
        data: Buffer.from(bytes).toString("base64"),
        mimeType: type,
      },
      { type: "text" as const, text: `Exported ${body.format ?? "png"}.` },
    ],
  };
}

server.registerTool(
  "export_asset",
  {
    description:
      "Render one asset as an image and return it as image content. scope is asset for every frame, or frame for a single frameId. An asset with more than one frame comes back as a zip.",
    inputSchema: {
      assetId: z.string(),
      frameId: z.string().optional(),
      format: z.enum(["png", "jpg", "svg"]).default("png"),
      scale: z
        .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(10)])
        .default(1),
      background: z.string().optional(),
    },
  },
  async ({ assetId, frameId, format, scale, background }) => {
    const asset = await loadAsset(assetId);
    return exportImage({
      scope: frameId ? "frame" : "asset",
      projectId: asset.projectId,
      assetId,
      frameId,
      format,
      scale,
      background,
    });
  },
);

server.registerTool(
  "export_project",
  {
    description: "Export a whole project as a .pxl document.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => {
    const response = await fetch(`${api}/api/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId, format: "pxl", scale: 1 }),
    });
    return { content: [{ type: "text" as const, text: await response.text() }] };
  },
);

const transport = new StdioServerTransport();
server.registerTool(
  "list_project_resources",
  {
    description:
      "List every asset and frame in a project, including native-size frames, palettes and dimensions. Use it before reusing another asset's frame or palette.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => text(await call(`/api/projects/${projectId}/resources`)),
);

server.registerTool(
  "import_frame",
  {
    description:
      "Copy a frame from another asset in the same project. Pixel colours map through the target palette; a native-size frame keeps its output size.",
    inputSchema: {
      assetId: z.string(),
      sourceAssetId: z.string(),
      sourceFrameId: z.string(),
      name: z.string().optional(),
    },
  },
  async ({ assetId, sourceAssetId, sourceFrameId, name }) =>
    text(
      await call(`/api/assets/${assetId}/frames/import`, {
        method: "POST",
        body: JSON.stringify({
          sourceAssetId,
          sourceFrameId,
          ...(name !== undefined ? { name } : {}),
        }),
      }),
    ),
);

server.registerTool(
  "create_social_frame",
  {
    description:
      "Add a native-size frame to an existing asset. The asset can also hold pixel frames.",
    inputSchema: {
      assetId: z.string(),
      presetId: z.string(),
      name: z.string().optional(),
    },
  },
  async ({ assetId, presetId, name }) =>
    text(
      await call(`/api/assets/${assetId}/frames`, {
        method: "POST",
        body: JSON.stringify({
          kind: "social",
          presetId,
          ...(name !== undefined ? { name } : {}),
        }),
      }),
    ),
);

await server.connect(transport);

// ---- Social artboards -------------------------------------------------------

server.registerTool(
  "list_social_sets",
  {
    description:
      "List the social kits in a project, with artboard counts and shared copy.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) =>
    text(await call(`/api/sets?projectId=${encodeURIComponent(projectId)}`)),
);

server.registerTool(
  "get_social_set",
  {
    description:
      "Read a social kit with every artboard scene, shared copy, and format preset.",
    inputSchema: { setId: z.string() },
  },
  async ({ setId }) => text(await call(`/api/sets/${setId}`)),
);

server.registerTool(
  "create_social_set",
  {
    description:
      "Create a social kit from one asset. Presets are exact native formats; omit presetIds for the starter six.",
    inputSchema: {
      projectId: z.string(),
      assetId: z.string(),
      presetIds: z.array(z.string()).optional(),
    },
  },
  async ({ projectId, assetId, presetIds }) =>
    text(
      await call(`/api/projects/${projectId}/sets`, {
        method: "POST",
        body: JSON.stringify({ assetId, ...(presetIds ? { presetIds } : {}) }),
      }),
    ),
);

server.registerTool(
  "add_social_format",
  {
    description:
      "Add one format (profile, cover, post, story, reel, thumbnail, banner) to a kit.",
    inputSchema: { setId: z.string(), presetId: z.string() },
  },
  async ({ setId, presetId }) =>
    text(
      await call(`/api/sets/${setId}/artboards`, {
        method: "POST",
        body: JSON.stringify({ presetId }),
      }),
    ),
);

server.registerTool(
  "update_social_artboard",
  {
    description:
      "Replace an artboard scene with optimistic versioning. Read it first with get_social_set.",
    inputSchema: {
      artboardId: z.string(),
      version: z.number().int().positive(),
      name: z.string().optional(),
      scene: z.unknown().optional(),
      copyOverride: z.record(z.string(), z.string()).optional(),
      status: z.enum(["draft", "ready"]).optional(),
    },
  },
  async ({ artboardId, ...patch }) =>
    text(
      await call(`/api/artboards/${artboardId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    ),
);

server.registerTool(
  "check_social_set",
  {
    description:
      "Run the deterministic size, safe-zone, crop, text, contrast, and byte checks for a kit.",
    inputSchema: { setId: z.string() },
  },
  async ({ setId }) => text(await call(`/api/sets/${setId}/state`)),
);

server.registerTool(
  "render_social_artboard",
  {
    description: "Render one artboard to PNG and return the image.",
    inputSchema: { artboardId: z.string() },
  },
  async ({ artboardId }) => {
    const response = await fetch(`${api}/api/artboards/${artboardId}/preview`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error((await response.text()) || `API ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      content: [
        { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" },
      ],
    };
  },
);

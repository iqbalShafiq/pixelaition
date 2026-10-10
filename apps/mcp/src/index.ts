import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

server.registerTool(
  "list_projects",
  { description: "List Pixelaition projects for the token owner.", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await call("/api/projects")) }],
  }),
);

server.registerTool(
  "create_project",
  {
    description: "Create a project.",
    inputSchema: { name: z.string(), description: z.string().optional() },
  },
  async ({ name, description }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await call("/api/projects", {
            method: "POST",
            body: JSON.stringify({ name, description }),
          }),
        ),
      },
    ],
  }),
);

server.registerTool(
  "get_asset",
  {
    description: "Read one asset, including frames and palette indexes.",
    inputSchema: { assetId: z.string() },
  },
  async ({ assetId }) => ({
    content: [
      { type: "text", text: JSON.stringify(await call(`/api/assets/${assetId}`)) },
    ],
  }),
);

server.registerTool(
  "create_asset",
  {
    description: "Create an asset in a project.",
    inputSchema: { projectId: z.string(), name: z.string() },
  },
  async ({ projectId, name }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await call(`/api/projects/${projectId}/assets`, {
            method: "POST",
            body: JSON.stringify({ name }),
          }),
        ),
      },
    ],
  }),
);

server.registerTool(
  "export_project",
  {
    description: "Export a project as a .pxl document.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => {
    const response = await fetch(`${api}/api/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId, format: "pxl", scale: 1 }),
    });
    return { content: [{ type: "text", text: await response.text() }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

import { describe, expect, it } from "vitest";
import {
  ALL_TOOL_NAMES,
  FIX_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  REVIEW_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  toolsForRole,
} from "./roles.js";

const tools = [
  "paint_stroke",
  "fill_rect",
  "add_layer",
  "rename_layer",
  "copy_region",
  "paste_region",
  "mirror_region",
  "repeat_region",
  "copy_layers",
  "read_frame",
  "read_region",
  "read_palette",
  "list_project_frames",
  "preview_frame",
  "compare_frames",
  "critique_frame",
  "check_animation",
  "web_search",
  "view_image",
  "ask_user",
  "add_frame",
  "delete_frame",
  "move_frame",
  "rename_frame",
  "mirror_frame",
  "set_palette",
  "resize_canvas",
  "resize_frame",
  "use_asset",
  "create_asset",
  "list_projects",
  "list_assets",
  "plan",
  "present_plan",
  "use_frame",
  "write_frame",
  "save_frame",
].map((name) => ({ name }));

const names = (role: Parameters<typeof toolsForRole>[0]) =>
  toolsForRole(role, tools).map((tool) => tool.name);

describe("role tool catalogs", () => {
  it("gives every editing role the whole catalogue", () => {
    for (const role of ["plan", "worker", "fix", "review"] as const) {
      expect(toolsForRole(role, tools)).toHaveLength(tools.length);
    }
  });

  it("keeps the exported sets identical and complete", () => {
    expect(WORKER_TOOL_NAMES).toBe(ALL_TOOL_NAMES);
    expect(FIX_TOOL_NAMES).toBe(ALL_TOOL_NAMES);
    expect(REVIEW_TOOL_NAMES).toBe(ALL_TOOL_NAMES);
    expect(PLAN_TOOL_NAMES).toBe(ALL_TOOL_NAMES);
    for (const tool of tools) {
      expect(ALL_TOOL_NAMES.has(tool.name)).toBe(true);
    }
  });

  it("still exposes save and write only where the editor defines them", () => {
    expect(names("worker")).toContain("save_frame");
    expect(names("fix")).toContain("write_frame");
  });
});

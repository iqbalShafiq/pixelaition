import { describe, expect, it } from "vitest";
import {
  FIX_TOOL_NAMES,
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
  it("gives a worker the full painting kit, transfer tools and project reads", () => {
    const kept = names("worker");
    for (const tool of [
      "paint_stroke",
      "fill_rect",
      "add_layer",
      "rename_layer",
      "mirror_frame",
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
      "web_search",
      "view_image",
      "ask_user",
      "save_frame",
    ]) {
      expect(kept).toContain(tool);
    }
  });

  it("offers every painting role the palette, and nobody the structure", () => {
    for (const role of ["worker", "fix"] as const) {
      expect(names(role)).toContain("set_palette");
    }
    expect(names("worker")).toContain("use_frame");
    expect(names("worker")).not.toContain("add_frame");
  });

  it("never offers a worker a structural or target tool", () => {
    const kept = names("worker");
    for (const tool of [
      "add_frame",
      "delete_frame",
      "move_frame",
      "rename_frame",
      "resize_canvas",
      "resize_frame",
      "use_asset",
      "create_asset",
      "list_projects",
      "list_assets",
      "plan",
      "present_plan",
      "write_frame",
      "critique_frame",
      "check_animation",
    ]) {
      expect(kept).not.toContain(tool);
    }
  });

  it("gives the review reads and judgement, and no painting", () => {
    const kept = names("review");
    expect(kept).toEqual(
      expect.arrayContaining([
        "read_frame",
        "read_region",
        "list_project_frames",
        "preview_frame",
        "compare_frames",
        "critique_frame",
        "check_animation",
        "web_search",
        "view_image",
      ]),
    );
    for (const tool of ["paint_stroke", "paste_region", "ask_user", "add_frame"]) {
      expect(kept).not.toContain(tool);
    }
  });

  it("lets a fix paint, transfer, compare and save, but never judge", () => {
    const kept = names("fix");
    for (const tool of [
      "paint_stroke",
      "paste_region",
      "copy_region",
      "copy_layers",
      "preview_frame",
      "compare_frames",
      "check_animation",
      "write_frame",
      "save_frame",
    ]) {
      expect(kept).toContain(tool);
    }
    for (const tool of ["critique_frame", "add_frame", "resize_frame"]) {
      expect(kept).not.toContain(tool);
    }
  });

  it("gives the plan the whole catalogue", () => {
    expect(toolsForRole("plan", tools)).toHaveLength(tools.length);
  });

  it("keeps the sets exported so the worker can register one agent per role", () => {
    expect(WORKER_TOOL_NAMES.has("paint_stroke")).toBe(true);
    expect(WORKER_TOOL_NAMES.has("set_palette")).toBe(true);
    expect(REVIEW_TOOL_NAMES.has("paint_stroke")).toBe(false);
    expect(FIX_TOOL_NAMES.has("save_frame")).toBe(true);
    expect(FIX_TOOL_NAMES.has("paste_region")).toBe(true);
  });
});

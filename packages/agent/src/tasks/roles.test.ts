import { describe, expect, it } from "vitest";
import { REVIEW_TOOL_NAMES, WORKER_TOOL_NAMES, toolsForRole } from "./roles.js";

const tools = [
  "paint_stroke",
  "fill_rect",
  "add_layer",
  "rename_layer",
  "read_frame",
  "critique_frame",
  "check_animation",
  "web_search",
  "view_image",
  "ask_user",
  "add_frame",
  "delete_frame",
  "move_frame",
  "mirror_frame",
  "set_palette",
  "resize_canvas",
  "use_asset",
  "create_asset",
  "list_projects",
  "list_assets",
  "plan",
  "present_plan",
  "use_frame",
].map((name) => ({ name }));

describe("role tool sets", () => {
  it("gives a worker every painting and layer tool but no structural or target tool", () => {
    const names = toolsForRole("worker", tools).map((tool) => tool.name);
    for (const keep of [
      "paint_stroke",
      "fill_rect",
      "add_layer",
      "rename_layer",
      "read_frame",
      "web_search",
      "view_image",
      "list_projects",
      "list_assets",
      "ask_user",
      "use_frame",
    ]) {
      expect(names).toContain(keep);
    }
    for (const drop of [
      "add_frame",
      "delete_frame",
      "move_frame",
      "mirror_frame",
      "set_palette",
      "resize_canvas",
      "use_asset",
      "create_asset",
      "plan",
      "present_plan",
      "critique_frame",
      "check_animation",
    ]) {
      expect(names).not.toContain(drop);
    }
  });
  it("gives the review only reading and judgement tools", () => {
    const names = toolsForRole("review", tools).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_frame",
        "critique_frame",
        "check_animation",
        "web_search",
        "view_image",
        "list_projects",
        "critique_frame",
        "check_animation",
      ]),
    );
    expect(names).not.toContain("paint_stroke");
    expect(names).not.toContain("ask_user");
  });
  it("gives the plan the whole catalogue and the fix the worker set", () => {
    expect(toolsForRole("plan", tools)).toHaveLength(tools.length);
    expect(toolsForRole("fix", tools).map((tool) => tool.name)).toEqual(
      toolsForRole("worker", tools).map((tool) => tool.name),
    );
  });
  it("keeps the sets exported for the worker's registration", () => {
    expect(WORKER_TOOL_NAMES.has("paint_stroke")).toBe(true);
    expect(WORKER_TOOL_NAMES.has("set_palette")).toBe(false);
    expect(REVIEW_TOOL_NAMES.has("paint_stroke")).toBe(false);
  });
});

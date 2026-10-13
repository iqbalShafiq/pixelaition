/**
 * Roles inside one drawing task. An Anvia agent carries a fixed tool list, so
 * each role registers its own agent (Task 7) built from these sets: the plan
 * agent gets everything, a worker gets the complete painting and layer tools
 * for its own frames plus asking, and the review only reads and judges.
 */
export type AgentRole = "plan" | "worker" | "review" | "fix";

export const WORKER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "paint_stroke",
  "fill_rect",
  "erase_stroke",
  "draw_line",
  "flood_fill",
  "fill_region",
  "clear_region",
  "replace_color",
  "apply_outline",
  "dither_rect",
  "add_layer",
  "rename_layer",
  "set_layer_visible",
  "remove_layer",
  "read_project",
  "read_frame",
  "read_region",
  "preview_frame",
  "critique_frame",
  "check_animation",
  "use_frame",
  "web_search",
  "view_image",
  "ask_user",
]);

export const REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_project",
  "read_frame",
  "read_region",
  "preview_frame",
  "critique_frame",
  "check_animation",
  "web_search",
  "view_image",
]);

export function toolsForRole<T extends { name: string }>(
  role: AgentRole,
  tools: readonly T[],
): T[] {
  if (role === "plan") return [...tools];
  const names = role === "review" ? REVIEW_TOOL_NAMES : WORKER_TOOL_NAMES;
  return tools.filter((tool) => names.has(tool.name));
}

export const planInstructions = [
  "You plan pixel-art work; you do not paint in this phase.",
  "Read the project, the asset, its frames, and its summaries; search for references when the subject is a real species, character, or place.",
  "Decide the frames (names and intents), the layers each frame needs, the palette additions (within the style guide's colour maximum), the references (https only, with a short note), and the worker split (at most four workers; each frame in exactly one worker).",
  "Create the planned frames with add_frame and set the palette additions with set_palette before you finish.",
  "Pass the worker split, the palette additions, and the references in present_plan so the approval card shows them.",
  "Finish by answering with one JSON object matching the plan schema and nothing else.",
].join("\n");

export const workerInstructions = [
  "You are one worker in a supervised team; you paint only the frames you were given.",
  "Follow the plan's intents and layer names exactly; keep outlines, palette, and proportions consistent with the read-only frames you can see.",
  "The palette is final; never call set_palette. Frame structure (adding, deleting, moving frames) is not yours; report anything you need instead of doing it.",
  "When a colour or shape is genuinely unclear, ask the user with ask_user instead of guessing.",
  "Call critique_frame before you finish and fix what it reports; end with a one-sentence summary of what you painted.",
].join("\n");

export const reviewInstructions = [
  "You are the supervisor's review pass; you never paint.",
  "Read every frame the workers produced, compare them with the plan and with each other: continuity, palette, outline colour, proportions, and the frames' intents.",
  "Finish by answering with one JSON object: { ok: true } when every frame passes, or { ok: false, fixes: [{ frame, note }] } with at most two fixes.",
].join("\n");

export const fixInstructions = [
  "You are a fix worker; you paint only the frames named in your task.",
  "Apply exactly the fix the review asked for, keep the palette and outlines of the neighbouring frames, and call critique_frame before you finish.",
  "End with a one-sentence summary of what changed.",
].join("\n");

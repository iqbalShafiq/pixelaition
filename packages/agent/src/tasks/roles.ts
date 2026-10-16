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
  "use_frame",
  "web_search",
  "view_image",
  "list_projects",
  "list_assets",
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
  "list_projects",
  "list_assets",
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
  "Decide the frames (names and intents), the layers each frame needs, the palette additions (within the palette's remaining capacity), the references (https only, with a short note), and the worker split (at most four workers; each frame in exactly one worker).",
  "Plan painting, not erasing: a frame is drawn by laying colours down (paint_stroke, fill_rect, draw_line, flood_fill, apply_outline, dither_rect). clear_region may clear a rectangle without asking. replace_color still stops for the user's approval, so name it only when existing pixels must change colour.",
  "A request that describes the subject acting — a flap, a jump, a walk, a pose change — means key frames: plan three to six separate frames, one per key pose, never a single frame. One frame is only right for a still pose.",
  "Write the full plan as ONE JSON object in your reply, exactly the schema below: frames (each with name, intent, layers), workers, palette, and references. The runtime reads that reply and the approval card shows it.",
  "Then call present_plan with a one-line summary only. Its arguments stay small on purpose: the card is the user's approval of the plan you wrote, not a second copy of it.",
  "Create the frames with add_frame, set the palette additions with set_palette, and resize the canvas with resize_canvas when the plan changes its size — only after the user approves the plan.",
  "Finish by answering with one JSON object matching the plan schema and nothing else.",
].join("\n");

export const workerInstructions = [
  "You are one worker in a supervised team; you paint only the frames you were given.",
  "Follow the plan's intents and layer names exactly; keep outlines, palette, and proportions consistent with the read-only frames you can see.",
  "The palette and the canvas size are final; never call set_palette or resize_canvas. Frame structure (adding, deleting, moving frames) is not yours; report anything you need instead of doing it.",
  "Draw additively: paint_stroke, fill_rect, draw_line, flood_fill, apply_outline, and dither_rect. clear_region clears a rectangle to transparency and does not ask. replace_color pauses for the user's approval, so use it only when the plan or the review asks for a recolour.",
  "When a colour or shape is genuinely unclear, ask the user with ask_user instead of guessing.",
  "Do not call critique_frame or check_animation, and do not move, clear, or redraw a finished sprite to chase a margin or a critique. The reviewer owns that pass.",
  "After the last paint, answer with one sentence naming what you painted, then stop.",
].join("\n");

export const reviewInstructions = [
  "You are the supervisor's review pass; you never paint.",
  "Read every frame the workers produced, compare them with the plan and with each other: continuity, palette, outline colour, proportions, and the frames' intents.",
  "Call critique_frame on each frame, and check_animation when the asset has more than one frame. That judgement is yours; the workers do not critique.",
  "Finish by answering with one JSON object: { ok: true } when every frame passes, or { ok: false, fixes: [{ frame, note }] } with at most two fixes.",
].join("\n");

export const fixInstructions = [
  "You are a fix worker; you paint only the frames named in your task.",
  "Apply exactly the fix the review asked for, keep the palette and outlines of the neighbouring frames. Do not call critique_frame or check_animation; the reviewer judges the result.",
  "Fix additively, like a worker: paint the corrected pixels over what is there. clear_region does not ask. replace_color pauses for approval, so use it only when the review's note asks for a recolour.",
  "Do not shift or redraw pixels the review did not ask you to change.",
  "End with a one-sentence summary of what changed, then stop.",
].join("\n");

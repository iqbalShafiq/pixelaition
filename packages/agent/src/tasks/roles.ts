/**
 * Roles inside one drawing task. The role a child plays is the one thing that
 * decides what it can call, and it decides it here — by carrying a different
 * tool list — instead of offering a tool and refusing it later; the assert in
 * `runs.ts` stays as a second wall for a stale binding.
 */
export type AgentRole = "plan" | "worker" | "review" | "fix";

/**
 * Tools for looking and measuring. Every role that reads frames gets the whole
 * set: a worker must be able to look at the frames it was told are read-only,
 * at frames in sibling assets of the same project, and at its own result.
 */
const READ_TOOLS: readonly string[] = [
  "read_project",
  "list_project_frames",
  "read_frame",
  "read_timeline",
  "read_region",
  "read_palette",
  "preview_frame",
  "compare_frames",
  "web_search",
  "view_image",
  "think",
  "ask_user",
];

/** Tools that change pixels on a frame the role owns. */
const PAINT_TOOLS: readonly string[] = [
  "mirror_frame",
  "paint_stroke",
  "fill_rect",
  "erase_stroke",
  "draw_line",
  "draw_ellipse",
  "move_region",
  "rotate_region",
  "flood_fill",
  "fill_region",
  "clear_region",
  "replace_color",
  "apply_outline",
  "dither_rect",
  "add_layer",
  "add_text",
  "edit_text",
  "rename_layer",
  "set_layer_visible",
  "set_layer_opacity",
  "set_layer_blend",
  "set_layer_locked",
  "duplicate_layer",
  "remove_layer",
  // Choosing colours is part of painting: any role that paints may add one,
  // and the pixels follow their colours when the palette changes.
  "set_palette",
];

/**
 * Moving pixels between frames without redrawing them: read a region from any
 * frame of the project, stamp it into one of your own, flip it, repeat a stamp.
 * They are the answer to "make this part look like that one" and are safe for
 * every painting role because the target frame still passes ownership.
 */
const TRANSFER_TOOLS: readonly string[] = [
  "copy_region",
  "paste_region",
  "mirror_region",
  "repeat_region",
  "copy_layers",
];

/** Frame structure and asset-wide state belong to the supervisor alone. */
const SUPERVISOR_TOOLS: readonly string[] = [
  "present_plan",
  "plan",
  "use_asset",
  "create_asset",
  "add_frame",
  "rename_frame",
  "move_frame",
  "delete_frame",
  "edit_palette_color",
  "remove_palette_color",
  "reorder_palette",
  "resize_canvas",
  "resize_frame",
  "set_frame_duration",
  "set_tags",
  "add_tag",
  "delete_tag",
  "list_projects",
  "list_assets",
];

/** Judging is the review pass's alone, including its two measuring tools. */
const REVIEW_TOOLS: readonly string[] = [
  "critique_frame",
  "check_animation",
  "check_timeline",
];

/** Frame switching is limited to the frames a writer owns. */
const USE_FRAME = "use_frame";

function catalog(
  ...groups: Array<readonly string[] | ReadonlySet<string>>
): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => [...group]));
}

/** A writer saves the frame it finished; the write cursor is its fixed home. */
const WRITER_TOOLS: readonly string[] = ["save_frame"];

export const WORKER_TOOL_NAMES: ReadonlySet<string> = catalog(
  READ_TOOLS,
  PAINT_TOOLS,
  TRANSFER_TOOLS,
  WRITER_TOOLS,
  // A worker can own more than one frame (for example a profile and its wide
  // cover). It may move between those frames, but `use_frame` still rejects a
  // frame outside its assignment. It may also correct its own frame's canvas
  // to the planned size; the tool still checks ownership.
  [USE_FRAME, "resize_frame"],
);

export const REVIEW_TOOL_NAMES: ReadonlySet<string> = catalog(
  READ_TOOLS.filter((tool) => tool !== "ask_user"),
  REVIEW_TOOLS,
);

/** A fix child paints, saves pixels and compares, but never judges or resizes. */
export const FIX_TOOL_NAMES: ReadonlySet<string> = catalog(
  WORKER_TOOL_NAMES,
  // A fix moves between the frames its order names and may watch the numbers
  // it is asked to move; it never switches to an unrelated frame and never
  // delivers a verdict.
  ["check_animation", "write_frame"],
);

/** The supervisor owns the plan, the structure, the palette and the verdict. */
export const PLAN_TOOL_NAMES: ReadonlySet<string> = catalog(
  READ_TOOLS,
  PAINT_TOOLS,
  TRANSFER_TOOLS,
  REVIEW_TOOLS,
  SUPERVISOR_TOOLS,
  [USE_FRAME],
);

export function toolNamesForRole(role: AgentRole): ReadonlySet<string> {
  if (role === "plan") return PLAN_TOOL_NAMES;
  if (role === "review") return REVIEW_TOOL_NAMES;
  if (role === "fix") return FIX_TOOL_NAMES;
  return WORKER_TOOL_NAMES;
}

export function toolsForRole<T extends { name: string }>(
  role: AgentRole,
  tools: readonly T[],
): T[] {
  if (role === "plan") return [...tools];
  const names = toolNamesForRole(role);
  return tools.filter((tool) => names.has(tool.name));
}

/**
 * What each role is told. Instructions are written at the level of intent —
 * what the role is for and how it fails — so the model applies judgement
 * instead of following brittle per-call rules. Language follows the user's
 * request; the plan, review and fix notes travel in that language too.
 */
export const planInstructions = [
  "You plan pixel-art work; you do not paint in this phase.",
  "Read the project, every asset in it, its frames and their summaries. A project's assets share one style: what the other assets do with outlines, shading and proportions is evidence for this one.",
  "Search for references when the subject is a real species, character, or place, and look at at least one result before writing the plan. A local edit to an existing frame (recolour, outline, a small prop) does not need a search or new reference frames.",
  "Decide the frames (names, intents, and each frame's width and height when the request names a real output size), the layers each frame needs, the palette additions (within the palette's remaining capacity), the references (https only, with a short note), and the worker split (at most four workers; each frame in exactly one worker).",
  "Every frame is one pixel canvas at its own width and height. A native-size frame is just a larger pixel canvas: plan it with the same layers, palette and workers as any other frame. Never split the request into a separate artboard or compose phase, and never treat a marketing dimension as a different kind of document.",
  "Read the asset's existing frames before writing the plan. If the request creates a new set and an existing frame is not useful (the blank default `idle` is the usual case), either reuse/resize it as one of the planned frames or list its name in removeFrames and delete it after creating the replacements. Never leave an unplanned blank frame behind.",
  "If the request edits one existing frame, plan only that frame and the layers it actually changes. Do not list unchanged frames, do not add frames, and use one worker unless the edit genuinely spans multiple frames.",
  "Parts that must line up across frames — a stand, a body, feet, a shadow — deserve their own layer on every key frame. When a later frame keeps a part unchanged, the fix can copy it from the reference frame instead of redrawing it, so build frames that share a body rather than redrawing it each time.",
  "Write the full plan as ONE JSON object in your reply, exactly the schema below: frames (each with name, intent, width, height, and layers), workers, palette, and references. The runtime reads that reply and the approval card shows it. Width and height are real pixel canvases, not display hints: an X profile request is 400×400, an X cover 1500×500, a LinkedIn cover 1584×396.",
  "Then call present_plan with a one-line summary only. Its arguments stay small on purpose: the card is the user's approval of the plan you wrote, not a second copy of it.",
  "After approval, create each frame with add_frame using that frame's width and height, and set the palette additions with set_palette. Then delete every frame named in removeFrames with delete_frame. If the request resizes one existing frame, call resize_frame with its width and height; use resize_canvas only when the request changes the whole asset's canvas.",
  "Answer in the language of the user's request, and write each frame's intent in that language.",
  "Finish by answering with one JSON object matching the plan schema and nothing else.",
].join("\n");

export const workerInstructions = [
  "You are one worker in a supervised team; you paint only the frames you were given, and only the layers named for each.",
  "Follow the plan's intents and layer names exactly; keep outlines, palette, and proportions consistent with the frames you can see. They are read-only for you but yours to look at, and you can look at every frame of every asset in this project for style.",
  "Do not add frames, move frames, set the palette or resize the whole canvas. You may switch between the frames you were assigned with use_frame, and you may call resize_frame on one of your own frames when its planned width or height differs from its current canvas; never switch to or resize a frame outside your assignment. Do not call critique_frame or check_animation: the reviewer judges. Do not draw the same part twice when a copy region would do.",
  "Work additively: paint_stroke, fill_rect, draw_line, flood_fill, apply_outline, and dither_rect. clear_region clears a rectangle to transparency and does not ask. replace_color pauses for the user's approval, so use it only when the plan or a review asks for a recolour.",
  "For words, use add_text once and then edit_text to change content, size, colour, rotation or position. A text layer stays editable and is still rasterized into palette pixels; never redraw the glyphs by hand and never bake text with fill or paint tools.",
  "When a part has to match another frame exactly — a stand, a face, a prop — read it with read_region and place it with paste_region (or copy_region) rather than redrawing it by eye. Copy a whole part before adding the difference for this frame.",
  "Look at your result with preview_frame (and preview_frame paired with a reference frame) before you stop. For a frame larger than a megapixel, preview at scale 0.5 or lower. When a colour or shape is genuinely unclear, ask the user with ask_user instead of guessing.",
  "Paint the frames you own, then save_frame and stop. After the last paint, answer with one sentence naming what you painted.",
].join("\n");

export const reviewInstructions = [
  "You are the supervisor's review pass; you never paint. You decide when the work is done.",
  "Look at the result first: preview_frame on the frames — the strip shows them together — and compare each frame with the plan and with each other: continuity, palette, outline colour, proportions, and the frames' intents. For a frame larger than a megapixel, set preview scale to 0.5 or lower; the scale accepts fractions so the PNG stays under the image limit.",
  "Read frame metadata before judging: read_project, list_project_frames and read_frame return every frame's id, name, index, width, height, summary and layers, for the current frame and for every other frame. A missing layer is a plan or painting fact, not a guess.\n  Measure next: critique_frame on each frame, check_animation with the frame that carries the body as referenceFrame, and compare_frames between a frame and its reference when a part should match.",
  "Judge what matters for this request. A finding the artist cannot fix by construction — a layer the plan does not have, a colour the palette does not hold, a part the request never asked for — is not a fix order; say so in `summary` and stop. A finding the drawing broke is a fix order. A painting role that needed a missing colour can add it itself with set_palette, so a finding about a colour is about the design, not about permission.",
  "Each review is a fresh look, and the work log tells you what earlier rounds tried. A finding that survived an attempt is not evidence for another identical attempt: order a different act (a named tool and region — copy_region, paste_region, copy_layers from the reference frame) or take the frame as it is. When the same finding has come back three times, it is yours to resolve: either the design does not allow it (say so in summary and finish) or it is small enough to accept (finish and name it). The work log is how you know it has come back — a task that keeps re-asking is stuck, and finishing is your judgement to make.",
  "Use `done` once every frame meets what the request asked for, even when small issues remain — say what remains in `summary` instead. Use `fix` only when a new attempt can plausibly land, and give each fix the frame, the layers to touch, the tool or region that fixes it, and the reference frame when one matched better.",
  "A fix paints pixels; it cannot add, delete, rename, or resize frames. Do not turn a structural finding (a duplicate frame, a wrong frame size, a missing frame) into a fix order: name it in `summary` and finish. The supervisor owns structure.",
  "Finish by answering with one JSON object: { done: true, summary } or { done: false, summary, fixes: [{ frame, layers?, note, referenceFrame? }] }. Write the summary and notes in the language of the user's request.",
].join("\n");

export const fixInstructions = [
  "You are a fix worker; you paint only the frames named in your task, and only the layers the review named.",
  "Fix exactly what the review asked for, and only on the layers it named. When the review points at a reference frame, look at it and copy the matching region or layer instead of redrawing it by eye; when the part must stay identical, copy, paste or mirror it.",
  "Fix additively, like a worker: paint the corrected pixels over what is there. clear_region does not ask. replace_color pauses for approval, so use it only when the review's note asks for a recolour. You may switch among the frames named in your task and resize one of those frames with resize_frame when the review names a size.",
  "Compare before and after (preview_frame, compare_frames) and change nothing the review did not ask you to change.",
  "Save with save_frame, end with a one-sentence summary of what changed in the user's language, then stop.",
].join("\n");

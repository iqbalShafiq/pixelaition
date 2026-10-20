/**
 * Roles inside one artboard-compose task. A director plans the set and judges
 * renders; a layout child composes the formats it owns. The role carries its
 * tool list, so a layout child is never offered set-wide structure.
 */
export type ArtboardRole = "art-director" | "layout";

const READ = [
  "list_formats",
  "read_set",
  "read_artboard",
  "preview_artboard",
  "check_artboard",
  "think",
  "plan",
] as const;

const EDIT = [
  "apply_template",
  "set_background",
  "place_sprite",
  "set_text",
  "add_rect",
  "add_pattern",
  "add_frame",
  "remove_element",
  "move_element",
  "save_artboard",
] as const;

const STRUCTURE = [
  "create_artboard",
  "delete_artboard",
  "set_copy",
  "present_artboard_plan",
] as const;

export const ARTBOARD_DIRECTOR_TOOLS: ReadonlySet<string> = new Set([
  ...READ,
  ...EDIT,
  ...STRUCTURE,
]);

export const ARTBOARD_LAYOUT_TOOLS: ReadonlySet<string> = new Set([...READ, ...EDIT]);

export function artboardToolNamesForRole(role: ArtboardRole): ReadonlySet<string> {
  return role === "art-director" ? ARTBOARD_DIRECTOR_TOOLS : ARTBOARD_LAYOUT_TOOLS;
}

export function artboardToolsForRole<T extends { name: string }>(
  role: ArtboardRole,
  tools: readonly T[],
): T[] {
  const names = artboardToolNamesForRole(role);
  return tools.filter((tool) => names.has(tool.name));
}

export const artboardDirectorInstructions = [
  "You direct a social kit: one sprite and one copy deck rendered at the native size of several platforms. The deliverable is the set of artboards, not a sprite.",
  "Read before deciding: list_formats for the exact dimensions, safe areas, crops, byte limits and format notes; read_set for the mark, the copy and the current boards.",
  "Plan the family. Choose the formats the request asks for (profile, cover, post, story, vertical video, thumbnail, banner), one template per board, and the copy that survives every crop. Keep the same headline, mark and palette across the family; adapt the layout, not the identity.",
  "A request that names a platform means its format. A request that says 'all socials' means profile + cover + feed post + vertical + thumbnail, not every preset in the registry.",
  "Keep essential copy inside the safe area, out of the profile overlap, the Reels/TikTok rails and the YouTube duration badge. The validator is the authority on geometry; never claim a fit you did not check.",
  "The copy deck is shared. Change it with set_copy; an artboard that genuinely needs different words gets a copy override, not a silent fork.",
  "When the plan is ready, write it as one JSON object in your reply with {setName, concept, copy, artboards:[{format, template, role}], workers:[{key, formats}], review}. Then call present_artboard_plan with a one-line summary. Do not create artboards before approval.",
  "After approval, create the planned boards that do not exist yet, then hand each board to its worker. Review renders at full size and at thumbnail size; a finding the layout cannot fix by construction is your summary, not a fix order.",
  "Answer in the language of the user's request. Never mention a pixel, colour or render the tools did not return.",
].join("\n");

export const artboardLayoutInstructions = [
  "You compose one or two social artboards on a pixel grid. The artboard is already the exact platform size; do not resize it.",
  "Read the format's safe areas, crops, exclusions and notes before touching the scene. Read the shared copy and the mark. Your job is hierarchy and fit, not a new brand.",
  "Use apply_template to get a composition with slots, then adjust: set_text for copy, place_sprite for the mark at a whole-pixel scale, set_background/pattern for texture, add_rect/frame for structure. Keep every colour a palette index.",
  "Text sizes come from the face's atlas; if set_text rejects a size, choose one it lists. Prefer fewer, larger words over paragraphs. Never scale a sprite by a fraction.",
  "Check before you save: preview_artboard at full size, then check_artboard. Every error must be fixed; warnings are judgement calls you should explain in your final sentence.",
  "Save with save_artboard and stop. Do not edit boards you do not own, do not change the set copy, and do not create or delete boards.",
  "Answer with one sentence naming what you composed, in the language of the user's request.",
].join("\n");

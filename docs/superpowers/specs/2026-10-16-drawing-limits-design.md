# Drawing Limits Removal — Design

**Status:** For review
**Date:** 2026-10-16

## Goal

Remove the drawing maximums the agents impose — frames per request, layers per
frame, colours per palette — replacing every policy cap with the format's
physical bounds, while keeping the parallel painter count a Jev decision and
keeping every minimum and every unrelated limit exactly as it is.

The physical bounds come from how pixels are stored: a pixel is one byte
(`Uint8Array`), so a palette holds index 0 (transparent) plus up to 255
colours — 256 entries. Layers and frames are ordinary arrays and are genuinely
unbounded.

Decisions from the design conversation:

- Palette stops at the byte bound (256 entries); no storage change.
- Layers and frames get no cap at all.
- The style guide's `maxColors` is removed together with its critique check —
  no data migration; the stale key is inert.
- Workers stay Jev's choice of 1–4; nothing changes there.

## Current state — where each cap lives

| Cap                    | Value      | Where it is enforced                                                                                                                 |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Frames per request     | 12         | `plan.ts` `drawPlanSchema.frames.max(12)`; `asset-draw.ts` input `maxFrames`; plan prompt "at most N frames"; worker submit          |
| Layers per frame       | 4          | `pixel/types.ts` `MAX_LAYERS`; `pixel/schema.ts` `layers.max(4)`; `commands.ts` `add_layer` check; plan `layers.max(4)`; editor copy |
| Palette entries        | 33 (32+1)  | `pixel/types.ts` `MAX_COLORS`; `pixel/schema.ts` `palette.max(33)`; `commands.ts` `set_palette` check; `buffer.ts` `isPaletteLength` |
| Palette additions      | 8 per plan | `plan.ts` `palette.max(8)`; `validatePlan` against `maxPalette`; worker submit `maxPalette: 8`                                       |
| Style colour ceiling   | 8 default  | style guide `maxColors` (`pixel/schema.ts` max 32, `buffer.ts` default 8); `critique.ts` `TOO_MANY_COLORS`; editor progress          |
| Parallel workers       | 1–4        | Jev's `workers` question; plan `workers.max(4)`; input `maxWorkers` — **unchanged**                                                  |
| MCP `set_palette` tool | 33         | `apps/mcp/src/index.ts` input schema                                                                                                 |

Unchanged by this design (out of scope): plan references ≤ 8, review ≤ 2 fixes
per round and ≤ 6 rounds, canvas 8–128 px, the 3-frame minimum for motion
requests, and the `w[1-4]` worker-key shape.

## 1. Format — `packages/pixel`

- `types.ts`: `MAX_COLORS = 255` (one byte per pixel; index 0 stays
  transparent). Delete `MAX_LAYERS`. Drop `maxColors` from `StyleGuide`.
- `schema.ts`: `styleGuideSchema` without `maxColors`; `frameSchema.layers`
  without `.max(4)`; `assetSchema.palette` `.max(33)` → `.max(256)`. The
  project schema keeps `format: "pixelaition"` and `version: 1` — the file
  shape does not change, only its capacity.
- `buffer.ts`: `defaultStyle` without `maxColors`; `paletteLimit` derives from
  `MAX_COLORS`, so the constant change carries the bound to 2–256.
- `commands.ts`: `set_palette` keeps refusing a palette longer than 256
  entries, with the bound named in the message; `add_layer` loses its
  `MAX_LAYERS` check.
- `critique.ts`: `critiqueFrame` takes `Pick<StyleGuide, "outline">`; the
  `TOO_MANY_COLORS` issue is deleted. Painting with an index outside the
  palette is still refused (unchanged).
- `index.ts`: export list follows (`MAX_LAYERS` out, `MAX_COLORS` stays).

## 2. Workflow — `packages/agent`

- `plan.ts`: `drawPlanSchema.frames` loses `.max(12)`; `drawPlanFrameSchema.
layers` loses `.max(4)`; `drawPlanSchema.palette` loses `.max(8)` (capacity
  is validated below); `workers.max(4)`, `references.max(8)` and the worker-key
  regex stay. `PlanLimits` loses `maxFrames`; `maxPalette` now means the
  remaining capacity. `validatePlan` drops the frames check and keeps the
  palette check with a message that names the remaining capacity.
- `asset-draw.ts`: the input schema drops `maxFrames`; `maxPalette` stays as a
  field name (old durable records keep their `8`, which is fine) with range
  0–255; `maxWorkers` stays 1–4. `buildPlanPrompt`: the limits line keeps only
  "at most N workers"; the palette instruction becomes "the palette holds up
  to 256 entries including transparent — add only what you need" with the
  remaining capacity when one was passed; the frames maximum disappears (the
  motion guidance "plan its key poses" and the 3-frame minimum stay).
- `roles.ts`: the plan instructions say "(within the palette's remaining
  capacity)" instead of "(within the style guide's colour maximum)"; the
  worker-count wording stays.
- `tools.ts`: the `set_palette` and `create_asset` palette schemas
  (`.max(33)`) become `.max(256)`; the `instructions.ts` line claiming "a
  frame holds at most four layers" is updated. A `paletteCapacity(
currentLength)` helper lives in `plan.ts` and is exported for the worker.

## 3. Workflow — `apps/worker`

- Draw submit: drop `maxFrames: 12`; send `maxPalette` as the remaining
  capacity — `256 - asset.palette.length` when the run targets an asset (no
  asset means nothing to paint on; pass the format's maximum additions, 255);
  `maxWorkers: shape.workers` stays.
- Older durable tasks keep parsing: zod strips unknown keys (`maxFrames`) and
  a missing field is not required anywhere.
- The worker's style line serializes the five `StyleGuide` fields explicitly,
  so an old row's stale `maxColors` key never leaks into a prompt (test:
  `styleLine`).

## 4. Editor — `apps/web`

- `editor.tsx`: the default-style literal drops `maxColors`.
- `PalettePanel`: drop the `maxColors` prop, the `over` flag and the
  `used/total` progress; show the used count only ("12 colors used").
- `StylePanel`: drop the "Max colors" row.
- `editor-panels.tsx`: "3 of 4 layers" → "3 layers".
- Web tests that render these panels are updated.

## 5. MCP — `apps/mcp`

- `set_palette` input schema: `.max(33)` → `.max(256)`.

## 6. Compatibility and data

- No database migration. Assets load their style through plain casts, so the
  stale `maxColors` key in existing `jsonb` rows is inert; `.pxl` imports go
  through `pixelProjectSchema`, whose zod parse strips the unknown key.
- `.pxl` files stay `version: 1`. Old files remain valid. A new file that uses
  more than 4 layers or more than 33 palette entries cannot be read by an
  older build — accepted, recorded here.
- No storage change: 255 colours is the byte bound; going beyond it would need
  `Uint16Array` pixels and is a non-goal.

## 7. Tests

- `packages/pixel`: `set_palette` boundary (256 entries accepted, 257 refused);
  `add_layer` unbounded; schema bounds (palette 256, no layer max, style guide
  without `maxColors`); `critiqueFrame` no longer raises `TOO_MANY_COLORS`;
  `isPaletteLength` bound. Existing tests that pin the old caps are rewritten
  to the new bounds.
- `packages/agent`: plan validation without a frame cap, unbounded layers, and
  the palette-capacity message; the plan prompt carries no frames maximum and
  the new palette wording; fixture plans with more than 12 frames or more than
  4 layers now validate.
- `apps/worker`: submit values (no `maxFrames`; capacity arithmetic) through
  the existing prompt tests.
- `apps/web`: palette panel without `maxColors`; layers copy.

## Acceptance criteria

- A plan with 20 frames, 10 layers on a frame, and palette additions within
  capacity validates, is approved, and paints; the document accepts it.
- A 257-entry palette is refused with the bound named; painting an index
  outside the palette is still refused.
- Jev still picks 1–4 workers; a plan with 5 workers is refused exactly as
  before.
- Critiques no longer report `TOO_MANY_COLORS`; the editor shows the used
  colour count and "N layers".
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.

## Non-goals

- No `Uint16Array` pixels or palettes beyond 255 colours.
- No changes to references, review rounds, canvas bounds, or the motion
  minimum.
- No editing UI for style-guide values (the style guide stays as it is, minus
  `maxColors`).

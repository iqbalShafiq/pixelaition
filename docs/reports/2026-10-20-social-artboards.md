# Social artboards: feasibility and implementation

Date: 2026-10-20
Branch: `feat/social-artboards`

> **Update — one asset, mixed frames.** The first implementation put social
> boards in a separate `artboard_sets` surface and a separate `/studio` route.
> The product now treats an asset as one mixed document: `frames.kind` is
> `sprite` or `social`, both live in the same frame rail and editor, and the
> Studio route only redirects to the editor. `0027_mixed_asset_frames` migrates
> the old sets into the asset and copies the latest shared deck onto
> `assets.copy`; the legacy tables remain read-only for old URLs. A compose run
> is now bound to the asset, not the set, and `GET
/api/projects/:id/resources` plus frame/palette import make project resources
> reusable across assets. The sections below describe the original artboard
> engine; the route and set boundaries are superseded.

## The question

Can Pixelaition turn one pixel sprite and a project palette into every social
asset a small studio actually needs — profile pictures, covers, feed posts,
Reels/TikTok/Shorts covers, YouTube thumbnails, banners and OG images — without
turning the existing 8–128 px editor into a 1080 × 1920 canvas?

Short answer: yes, if the social asset is a **native-size scene graph**, not a
scaled-up pixel document.

## Why the obvious approach fails

A 1080 × 1920 document is 2,073,600 pixels per layer. Four palette-index layers
are ~8.3 MB raw and ~11 MB as base64. The current editor stores a frame as
base64 layers, exports a preview at document size, and keeps a minimum 1× zoom.
That is the wrong representation for a poster-size surface:

- the sprite is one small ingredient, not the whole canvas;
- text at 1080 px needs real layout and reading-size checks, not a 32 px bitmap
  scaled by 33.75;
- one document per format cannot share copy or keep a family consistent;
- storage, autosave, undo and export all pay the full bitmap cost.

## The model that shipped

`packages/artboard` is a shared, pure renderer used by the API, worker and web:

- **Format registry** — 44 presets with native width/height, platform group,
  safe zones, crops, exclusions, pixel unit, minimum text size, byte limit,
  official/industry provenance and a check date.
- **Scene graph** — a palette-indexed `ArtboardScene` with `background`,
  `sprite`, `text`, `rect`, `pattern` and `frame` elements. Coordinates are
  always output pixels. The sprite element references an existing frame; it is
  never copied or re-drawn.
- **1-bit text atlas** — Silkscreen, Pixelify Sans and Departure Mono, baked
  into 1-bit glyph rows at several sizes. `set_text` snaps a requested final
  size to an atlas size plus a whole-pixel scale, so text stays pixel-crisp at
  every output size.
- **Deterministic checks** — dimensions, empty scene, safe zone, crop,
  exclusion, text overflow, minimum reading size, glyph coverage, contrast,
  palette indexes, sprite scale, missing sprite, byte budget, copy and version.
  The checks are the product's guardrail: an agent cannot claim a fit that the
  geometry does not support.
- **Templates** — blank, centered mark, centered copy, split, stack, thumbnail,
  banner and profile. A template reserves a text slot `height`; a longer copy
  refits down the atlas instead of growing into the next element.
- **Copy deck** — one shared deck per set plus per-board overrides. A set copy
  edit re-syncs every board that has not overridden the field. Per-board text
  edits create overrides, not forks.
- **Export** — PNG/JPG at exact dimensions through the existing `@pixelaition/export`
  encoders; a ZIP plus `manifest.json` for a kit (copy, per-board checks, byte
  sizes, preset ids, generated time).

## Persistence

Three tables, added in `0025_social_artboards.sql`:

- `artboard_sets` — project, asset, name, shared copy.
- `artboards` — preset id, native size, scene, copy override, status, optimistic
  `version`.
- `artboard_versions` — snapshots for set and artboard changes, with author,
  run id and kind.

The migration is hand-written because the Drizzle snapshot chain stops at 0007;
the journal was updated alongside it.

## API

| Route                             | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `GET /api/formats`                | Registry, groups and the latest check date         |
| `GET/POST /api/sets`              | List a project's kits / create a kit from an asset |
| `GET/PATCH/DELETE /api/sets/:id`  | Read, edit copy/name, delete                       |
| `POST /api/sets/:id/artboards`    | Add a format (or a second variant)                 |
| `PATCH/DELETE /api/artboards/:id` | Optimistic scene edit / delete                     |
| `GET /api/artboards/:id/preview`  | PNG at native size                                 |
| `GET /api/artboards/:id/state`    | Rendered bytes + checks                            |
| `GET /api/sets/:id/state`         | Whole kit summary + per-board checks               |
| `POST /api/sets/:id/compose`      | Start one art-director run on a kit                |
| `POST /api/export`                | `artboard` or `set`, PNG/JPG/ZIP                   |

`PATCH` returns 409 `VERSION_CONFLICT` when the version is stale. The UI reloads
the board instead of inventing a merge.

## The agent

A compose run uses one `art-director` role with a focused catalog:

`list_formats`, `read_set`, `check_artboard`, `preview_artboard`,
`apply_template`, `set_background`, `place_sprite`, `set_text`, `add_rect`,
`add_pattern`, `add_frame`, `remove_element`, `move_element`, `save_artboard`,
`create_artboard`, `delete_artboard`, `set_copy`, `present_artboard_plan`,
`plan`, `think`.

The director must call `present_artboard_plan` and wait for approval before the
first write. It works inside the same palette, checks every board, saves each
one, and answers in the request's language. A model that cannot see images gets
a description through the existing summary-vision path; a model with vision gets
the actual PNG. The composer never silently substitutes a different model.

A compose run is bound to the kit in the worker. Boot recovery re-loads the set
and re-binds both the asset and artboard tools, and infers plan approval from
boards that already have version > 1.

## UI

`/projects/$projectId/assets/$assetId/studio` is the Social Studio:

- a format rail grouped by platform, with a live thumbnail and check state;
- a contact sheet of the whole kit, each card at its own aspect;
- an artboard stage with fit/1:1, safe-zone/crop/exclusion overlays and direct
  whole-pixel sprite dragging;
- an inspector for background, elements, text (face, weight, size, align),
  palette-only colours, shared copy and the deterministic check list;
- an in-context preview for profile crops, covers, feed posts and vertical
  video, clearly labelled as simulated and never exported;
- an export sheet for one board or the whole kit;
- the existing composer and run console, so a compose run streams, pauses for
  plan approval, and resumes without leaving the screen.

At ≥ 1100 px the rail and inspector are columns. Below that they become sheets;
the stage keeps the composer docked and scrolls independently. The layout was
checked at 1440, 1100, 720 and 390 px.

## Testing

- `packages/artboard/src/presets.integration.test.ts` builds every preset with
  its default template and realistic copy, checks that no error is produced, and
  guards dimensions.
- `packages/artboard/src/render-smoke.test.ts` renders a templated post with a
  sprite and writes a PNG.
- `apps/api/src/app.test.ts` creates a kit over the real API, previews and
  exports it, checks the 409 stale-version path and the ZIP.
- A real MiniMax M3.1 Flash run through OpenRouter composed a six-format kit:
  plan approval, tool calls, per-board checks and saves all completed; the final
  state was 0 errors, 0 warnings across six boards. The run took about seven
  minutes at `low` reasoning before the size-snapping change.
- A second real run on a two-format kit verified the plan gate, text-size
  snapping, save/version path and the shared-copy refit. The final state was
  0 errors, 0 warnings.
- After unification, a real MiniMax M3.1 Flash run on a mixed asset (two sprite
  frames + one LinkedIn cover) planned a LinkedIn cover and an Instagram post,
  waited for plan approval, created both social frames inside the same asset,
  saved them with shared copy and finished 0 errors/0 warnings. The Langfuse
  trace had 73 observations and no refused tool calls.
  `node tools/trace-check.mjs --run <durableRunId>` reads it back.
- A 44-format creation probe built every preset with a real sprite and the
  default template: 44 artboards, 0 errors, 0 warnings.
- `pnpm eval:social` makes a real MiniMax M3.1 Flash planning call, retries a
  failure, then falls back to `meta/muse-spark-1.3-contributor` through the
  Responses API. Both the primary and a forced-fallback run passed.

## Limits and next work

- The first version used a separate Studio route. That boundary is gone: the
  editor frame rail, stage, inspector, composer and export switch on the selected
  frame's kind. The legacy set tables remain only for migration safety.
- A shared copy edit refits text into the slots the composition reserved. A very
  long headline can therefore be legible but smaller than the original
  hierarchy; per-board overrides remain the escape hatch.
- Artboard version history is written but not yet browsable/restorable in the
  UI.
- A composition can take several minutes on a reasoning model; snapping text
  sizes and naming preset ids in errors cut avoidable tool turns, and the nine
  formats can be split across follow-up runs.
- Format dimensions are industry values unless `official` is true; each preset
  records its source and check date so the registry can be refreshed.

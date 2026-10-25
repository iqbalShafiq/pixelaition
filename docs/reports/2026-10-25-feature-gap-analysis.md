# Feature gap analysis: Pixelaition vs. Aseprite-class pixel editors

**Date:** 2026-10-25  
**Repository:** `main` at `a1c2333` (clean working tree)  
**Status:** Research report. No product code was changed.  
**Research run:** OpenCode CLI with `opencode-go/deepseek-v4.1-flash`, reasoning variant `max`; sources fetched from the official documentation and repositories linked below.

## 1. Executive summary

Aseprite is the mainstream reference for a reason that is easy to miss when comparing feature lists: it owns the **whole craft loop**. You can draw precisely, iterate a palette, build an animation on a timeline, and ship a GIF, a sprite sheet, or a game-ready atlas without leaving the tool. Its file format, CLI, and Lua extensions make it a hub rather than a single editor. That is the "masterpiece" part — not one killer feature, but the absence of dead ends.

Pixelaition already has something Aseprite does not: an agentic production loop with planning, parallel workers, a review pass, a shared project palette and style guide, durable runs, version history, and native-size social frames. The gap is not "more AI". The gap is the **last mile around the AI**: bringing existing art in, editing it precisely, giving it timing, and shipping it in the formats people actually use.

If we only close three gaps, they should be:

1. **Raster / sprite-sheet import with palette quantization.** Today the only import is another frame in the same project, so users cannot bring an Aseprite export, a Piskel sheet, a commission, or a reference into the editor.
2. **Animation export plus timing.** The app can create many frames but can only export still images. There is no GIF, no APNG, no sprite sheet, no per-frame duration, and no tag. An animation cannot leave the product.
3. **Selection and transform.** The selection tool is a rectangle with fill and clear. Users cannot cut, copy, paste, move, flip, rotate, or scale a selected region — the basic verbs of editing.

The next tier is **layer compositing** (opacity, blend modes, lock, groups), **palette management** (edit/delete/reorder/lock presets), **drawing essentials** (ellipse, curve, polygon, pixel-perfect, symmetry, larger brushes), and a **real timeline / preview**. After that, the AI-native differentiators become much stronger: selection-scoped inpainting, "animate this frame" with in-betweens, seamless-tile generation, and sprite-sheet/atlas packaging.

## 2. Method and scope

The research combined:

- **Official Aseprite sources:** the repository README and the docs for drawing, brushes, ink, symmetry, selecting, transformations, layers, linked cels, timeline, animation, tags, onion skinning, tiled mode, tilemap, exporting, sprite sheets, files, keyboard shortcuts, scripting, CLI, extensions, slices, preview, and data recovery.
- **Other pixel editors:** Pixelorama, LibreSprite, Piskel, Pyxel Edit, GraphicsGale, Pixquare, and Sprite Fusion, using their repositories, manuals, and product pages.
- **AI-native pixel tools:** PixelLab's tool documentation and Retro Diffusion's MCP README, to separate documented capabilities from marketing claims.
- **The repository itself:** a code audit of the editor's tools, commands, document model, schema, export route, and API surface at `a1c2333`.

In this report, **missing** means there is no user-facing path in the app, even if an agent tool can do something similar. **Partial** means the capability exists but is materially limited. This distinction matters because Pixelaition's agent can already copy regions and draw shapes that the human toolbar cannot.

A note on sourcing: a few Aseprite documentation paths returned 404 during the fetch pass (`/docs/tools/`, `/docs/palettes/`, `/docs/pixel-perfect/`). The report cites the working equivalents and, where Aseprite only advertises a capability as a heading (for example `Pixel Perfect Freehand` and `Export to JSON + Texture Atlas`), it says so rather than treating the heading as a documented behavior.

## 3. What Pixelaition already does well

| Area                | Today                                                                                                                              | Why it matters                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Agentic drawing     | Plan approval, up to four parallel workers, a review pass, `critique_frame`, `check_animation`, reference search and image viewing | This is the product's differentiator. Most editors have no equivalent production loop. |
| Consistency         | One project palette and style guide; asset-level frames; named layers; deterministic critique                                      | Generated assets stay related instead of being one-off images.                         |
| Durability          | Durable `asset-draw` tasks, streaming console, steering, queued prompts, run recovery                                              | A long generation survives tab closes and restarts.                                    |
| History             | Debounced saves (500 ms), server-side versions, labels, preview, restore                                                           | Stronger than most desktop editors' local undo for recovering a good state.            |
| Social output       | Native-size frames, 44 presets, safe zones, checks, copy deck, PNG/JPG export                                                      | A second output surface that Aseprite does not target.                                 |
| Programmatic access | MCP server over the same API and `applyCommand` pixel path                                                                         | Automation exists, even without a Lua runtime.                                         |
| Usage transparency  | Token/cost accounting, context window, Langfuse traces, evals                                                                      | Production-grade observability for an AI product.                                      |

The editor itself is narrower: eight tools (select, pencil, eraser, fill, eyedropper, line, rectangle, pan), brush sizes 1–3, rectangle selection with fill/clear, frames with play and onion skin, layers with visibility, an indexed palette with add/import, and PNG/JPG/SVG/ZIP/PXL export. See `apps/web/src/components/editor-toolbar.tsx` (tools), `apps/web/src/components/pixel-canvas.tsx` (canvas actions), and `packages/export/src/index.ts` (export formats).

## 4. Gap matrix

Priorities are product priorities, not effort estimates: **P0** blocks a core user journey; **P1** is a strong differentiator or a repeated table stake; **P2** matters for a pro segment or later.

### 4.1 Creation and editing

| Capability                                                                           | Pixelaition today                                                                                                                                                      | Reference and why it matters                                                                                                                                                                                                                                                                                    | Priority |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Raster image import (PNG/JPEG/WebP)                                                  | No upload path for pixel frames; only copying a frame from another project asset (`apps/web/src/components/import-frame-dialog.tsx`)                                   | Aseprite opens images and image sequences (`/docs/open/`); Piskel imports sprite sheets and GIFs. Without this, users cannot start from existing art.                                                                                                                                                           | P0       |
| Sprite-sheet import with grid, offset, padding                                       | None                                                                                                                                                                   | Aseprite imports sheets with cell size, padding, and sheet type (`/docs/sprite-sheet/`); Piskel imports and merges sheets. This is how most game art arrives.                                                                                                                                                   | P0       |
| Selection shapes: ellipse, lasso, polygon, magic wand, select-by-color               | Rectangle only; `CanvasAction` has a single `select` rect (`apps/web/src/components/pixel-canvas.tsx`)                                                                 | Aseprite has marquee, lasso, magic wand, and selection modes (`/docs/selecting/`); Pixelorama has seven selection tools. Rectangles alone cannot isolate a character, a shadow, or a palette region.                                                                                                            | P0/P1    |
| Floating selection and transform: move, copy, cut, paste, flip, rotate, scale, nudge | None in the UI; selection can only be filled or cleared                                                                                                                | Aseprite uses handles for move/scale/rotate and supports flip/resize/crop (`/docs/transformations/`); Pixelorama documents transforming; Piskel documents selection copy/paste. This is the core edit loop.                                                                                                     | P0       |
| Layer opacity, blend modes, lock, duplicate, groups                                  | Layer type is `{ id, name, visible, pixels, text? }`; compositing overwrites with the top opaque pixel (`packages/pixel/src/types.ts`, `packages/pixel/src/buffer.ts`) | Aseprite layers have opacity, blend modes, lock, groups, and a background layer (`/docs/layers/`); Pixelorama has blend modes, opacity, clipping masks, and groups; Pixquare has groups, blend modes, opacity, and alpha lock. Without compositing, highlights, shadows, and glows need destructive pixel work. | P0       |
| Palette editing: edit, delete, reorder, lock, presets, palette from image            | Add a color, pick a color, import a project palette; a hard-coded Sweetie 16 helper (`apps/web/src/components/editor-panels.tsx`)                                      | Aseprite edits palette entries and recolors every indexed pixel (`/docs/color-mode/`, `/docs/color-bar/`), starts from DB32 (`/docs/default-palette/`); Pixquare imports Lospec/file/image palettes. Palette iteration is a core pixel-art workflow.                                                            | P0       |
| Drawing shapes: ellipse, curve, polygon                                              | Line and rectangle only                                                                                                                                                | Aseprite has line, curve, rectangle, ellipse, contour, and polygon (`/docs/drawing/`); Pixelorama has line, curve, rectangle, and ellipse.                                                                                                                                                                      | P1       |
| Pixel-perfect freehand                                                               | Bresenham stroke, no corner cleanup (`apps/web/src/components/pixel-canvas.tsx`)                                                                                       | Aseprite's README and features page list "Pixel Perfect freehand mode" (`https://github.com/aseprite/aseprite`, `/features/`). Small doubles at corners are exactly what pixel artists notice.                                                                                                                  | P1       |
| Symmetry / mirrored drawing                                                          | None                                                                                                                                                                   | Aseprite symmetry paints across horizontal/vertical axes (`/docs/symmetry/`); Pixelorama and Pixquare support mirroring.                                                                                                                                                                                        | P1       |
| Custom brushes, brush sizes, pressure/dynamics                                       | Sizes 1–3, square footprints; brush size is capped in the keyboard handler (`apps/web/src/screens/editor.tsx`)                                                         | Aseprite has round/square/line/custom/pattern brushes and dynamics (`/docs/brushes/`, `/docs/dynamics/`).                                                                                                                                                                                                       | P2       |
| Dither / shading inks                                                                | Dither exists as an agent command, not as a human tool                                                                                                                 | Aseprite has shading ink and dithering matrices (`/docs/ink/`); Pixelorama has a shading tool.                                                                                                                                                                                                                  | P1/P2    |
| Canvas crop, trim, rotate, resize with anchor                                        | `resize` copies from the top-left; no crop/trim/rotate (`packages/pixel/src/commands.ts`)                                                                              | Aseprite transformations cover canvas/sprite/selection with flip, resize, crop, trim, rotate (`/docs/transformations/`).                                                                                                                                                                                        | P2       |

### 4.2 Animation

| Capability                                          | Pixelaition today                                                                                                                      | Reference and why it matters                                                                                                                                                                                                       | Priority |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Per-frame duration                                  | No duration field in `frames` (`packages/db/src/schema.ts`); playback uses a fixed 220 ms interval (`apps/web/src/screens/editor.tsx`) | Aseprite edits frame duration (`/docs/animation/`); Piskel has adjustable frame delay; Pixelorama has per-frame duration and FPS. Timing is the difference between a sprite sheet and an animation.                                | P0       |
| Tags with name, range, loop mode                    | None                                                                                                                                   | Aseprite tags name frame ranges and play forward, reverse, or ping-pong (`/docs/tags/`); Pixelorama has tags and cycle/ping-pong/no-loop. Tags are how "idle", "walk", and "attack" coexist in one asset.                          | P1       |
| Timeline UI with scrub, durations, frame/layer grid | A frame rail with play, reorder, add, duplicate, delete, rename; no timeline grid                                                      | Aseprite's Timeline shows layers × frames, toggles with Tab (`/docs/timeline/`); Pixelorama's timeline is the animation workspace.                                                                                                 | P1       |
| Onion-skin controls                                 | Toggle showing only the immediate previous and next frames at a fixed presentation                                                     | Aseprite configures previous/next frames and red/blue tint (`/docs/onion-skinning/`).                                                                                                                                              | P2       |
| Preview window at true speed                        | Inline play only, fixed 220 ms                                                                                                         | Aseprite's Preview window plays the animation live (`/docs/preview-window/`); Piskel has a live preview.                                                                                                                           | P1       |
| Linked cels / shared layers across frames           | Frames own independent pixel layers; duplication copies pixels                                                                         | Aseprite linked cels share image and position across frames (`/docs/linked-cels/`); Pixquare has linked cels. Without this, editing a shared body part in one frame drifts from the others — exactly what `check_animation` flags. | P1/P2    |
| Frame reverse, copy/paste, multi-frame operations   | Add, duplicate, reorder, delete only                                                                                                   | Aseprite supports copying/moving/removing/reversing frames and cels (`/docs/animation/`).                                                                                                                                          | P2       |

### 4.3 Delivery and interop

| Capability                           | Pixelaition today                                                                                                                      | Reference and why it matters                                                                                                                                                            | Priority |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Animated GIF export                  | None; export format enum is `pxl`, `png`, `jpg`, `svg`, `zip` (`apps/api/src/app.ts`)                                                  | Aseprite exports GIF or PNG sequences, with direction and pixel-ratio options (`/docs/exporting/`); Piskel exports GIF; Pixelorama exports GIF/APNG; Pixquare exports GIF/APNG.         | P0       |
| PNG sequence / APNG / WebP animation | PNG/ZIP of still frames only                                                                                                           | Aseprite exports PNG sequences; Pixelorama exports APNG; Pixquare exports APNG and MOV.                                                                                                 | P1       |
| Sprite sheet with layout controls    | None                                                                                                                                   | Aseprite exports sheets horizontally, vertically, or as a matrix, by visible layer or tag (`/docs/sprite-sheet/`); Piskel and Pixelorama export sheets.                                 | P0       |
| JSON atlas / engine-ready metadata   | None; Aseprite's features page advertises "Export to JSON + Texture Atlas", and its docs describe sheet layout but not the JSON schema | Game engines and frameworks need frame boxes, tags, pivots, and durations, not just a PNG. Sprite Fusion demonstrates engine-native exports.                                            | P1       |
| Slices / 9-slice / pivot metadata    | None                                                                                                                                   | Aseprite slices are named regions with 9-slice and pivot data, exportable separately or via JSON (`/docs/slices/`). Useful for UI kits and game HUDs.                                   | P2       |
| `.aseprite` / `.ase` import/export   | `.pxl` JSON only                                                                                                                       | Aseprite's native format preserves color mode, layers, frames, palette, tags, and slices (`/docs/files/`); Pixquare imports/exports ASE. This is the migration path from the incumbent. | P2       |
| CLI / batch export                   | MCP server and HTTP API; no user CLI                                                                                                   | Aseprite's CLI does batch conversion, sheet packing, palette replacement, and scripting (`/docs/cli/`). Pixelaition's MCP covers automation but not a shell workflow.                   | P2       |
| Scripting / extensions               | No user scripting; agent tools are the extension surface                                                                               | Aseprite has Lua scripting (`/docs/scripting/`) and `.aseprite-extension` packages (`/docs/extensions/`); Pixelorama has GDScript extensions.                                           | P2/P3    |

### 4.4 AI-native opportunities

| Capability                                                              | Pixelaition today                                                                        | Reference and why it matters                                                                                                                                                                       | Priority |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Selection-scoped AI edit: inpaint, outpaint, shade, cleanup, variations | The agent can paint, but there is no mask/selection-scoped action or preview-variants UI | PixelLab's inpainting masks a layer and fills a described region; Retro Diffusion's MCP lists inpainting/outpainting and background removal. This turns the agent from a generator into an editor. | P1       |
| AI animation: in-betweens, walk cycles, idle loops                      | The agent can add key frames and duplicate/mirror frames; no interpolation               | PixelLab interpolates between keyframes (64×64 limit) and generates described actions; Retro Diffusion lists animation generation.                                                                 | P1       |
| Background removal / cutout                                             | None                                                                                     | PixelLab has dedicated simple/complex background removal; Retro Diffusion's MCP lists a background remover.                                                                                        | P1       |
| Style/palette lock across generations                                   | Project palette and style guide exist; no explicit "lock" that the agent cannot widen    | PixelLab documents palette locking across animation frames; Retro Diffusion documents palette-controlled output and custom styles. A lock is the trust mechanism for brand work.                   | P1       |
| Seamless tile preview + auto-tile                                       | None                                                                                     | Aseprite tiled mode previews repeats (`/docs/tiled-mode/`); Pixelorama has seamless tile mode; Pyxel Edit has tile references. AI can generate tile variations once the preview exists.            | P1       |
| Spritesheet/atlas packaging after generation                            | None                                                                                     | Aseprite sheet export and Sprite Fusion's engine exports show the expectation: the asset arrives ready for the engine, not as 12 loose PNGs.                                                       | P1       |
| Reference overlay on the canvas                                         | Chat attachments only; no persistent overlay                                             | Pixquare documents reference layers; a pinned, non-exported reference is useful for both humans and the agent.                                                                                     | P1/P2    |

## 5. Detailed recommendations

### 5.1 Import raster images and sprite sheets (P0)

**What to build.** A drop zone and file picker on the frame rail and the asset menu. Decode PNG/JPEG/WebP in the browser (the attachment pipeline already uses `createImageBitmap` and downsamples references), then send RGBA or palette indices to the API. Offer three import modes:

- **Single image → frame.** Nearest-neighbor resize to the target canvas; choose "crop", "fit", or "stretch"; map to the current palette or generate a new one.
- **Sprite sheet → frames.** Ask for columns/rows, cell size, margin, spacing, and reading order. Preview the grid on the image before committing.
- **Reference only.** Store the image outside the indexed document and render it as a pinned overlay; never export it.

Quantization needs a real policy: nearest color in RGB (or Oklab for better perceptual results), optional Bayer/Floyd–Steinberg dithering, and a preview of the palette that will be used. If the source has more colors than the palette can hold, show the count and let the user pick "use current palette" or "generate palette". Every write still goes through `applyCommand` / the same frame route; do not add a second pixel path.

**Acceptance.** A 4×1, 32×32 sheet imports as four frames with the original pixels, names, and order. A 64×64 PNG with 200 colors imports into the current 16-color palette with a visible before/after preview. A failed decode names the cause.

**References:** Aseprite open/image sequences and sprite-sheet import; Piskel sheet/GIF import; Pixelorama import/export.

### 5.2 Animation export and timing (P0)

**What to build.** Add `durationMs` to each frame (default 100 ms) and a `tags` model (name, from, to, direction: forward/reverse/ping-pong, loop). Make playback use durations rather than the fixed 220 ms. Add export formats:

- **GIF** with loop count, per-frame delay, transparency, and scale.
- **APNG/WebP** as a higher-quality alternative.
- **PNG sequence** in a ZIP, with numbered names.
- **Sprite sheet** with columns/rows or packed layout, padding, margin, trim, and power-of-two sizing.
- **JSON atlas** with frame rectangles, durations, tags, and (later) pivots/slices.

The export endpoint already has a scope/format/scale model; extend it rather than creating a parallel route. The compositor used for the sheet must be the same one the canvas and critique use.

**Acceptance.** A four-frame asset with durations 80/120/80/120 exports a GIF that plays at those delays, a sheet with four correctly sized cells, and a JSON file whose frame rects match the sheet. Exporting a single tag exports only that range.

**References:** Aseprite exporting, sprite sheets, animation, tags; Piskel GIF/sheet export; Pixelorama save/export; Pixquare export.

### 5.3 Selection, transform, and clipboard (P0)

**What to build.** Replace the rectangle-only selection with a mask (`Uint8Array` of 0/1 or an alpha mask) so ellipse, lasso, polygon, magic wand, and select-by-color can share one commit path. Add a floating selection:

- Move, nudge with arrow keys, cut/copy/paste, duplicate.
- Flip horizontal/vertical, rotate 90°, and scale with nearest-neighbor (plus an optional RotSprite-style rotation for non-90° angles).
- Select all, deselect, reselect, invert, add/subtract/intersect.
- Fill, clear, and "commit" on click-away or Enter; Escape cancels.

The floating selection should be a UI-level buffer until commit, so undo has one clean step. The agent's `copy_region` / `paste_region` / `mirror_region` tools already prove the backend can move regions; the missing piece is the human workflow and the mask model.

**Acceptance.** Select a head, copy, paste, move it 2 px, flip it, commit; one undo restores the original. Magic wand on a transparent background selects the outside region and leaves the sprite untouched.

**References:** Aseprite selecting and transformations; Pixelorama selecting/transforming; Piskel selection copy/paste; GraphicsGale selection tools.

### 5.4 Layer compositing (P0)

**What to build.** Extend `Layer` with `opacity` (0–100), `blend` (normal, multiply, screen, overlay, add, subtract, darken, lighten, etc.), `locked`, and optional `groupId`. Keep indexed pixels as storage; composite to RGBA for display and export. Update `composite()` to blend rather than overwrite, and make the agent's layer tools respect `locked`. Add duplicate layer, groups (with visibility/opacity), and a background layer that cannot be moved or made transparent.

This is a document-model change, so it needs migrations, schema tests, and a renderer test that proves a multiply layer at 50% exports the same bytes the canvas shows.

**Acceptance.** A highlight layer at 40% opacity and multiply produces a visibly darker result on the canvas and in PNG export. A locked layer refuses agent and human writes with a named cause. Undo restores opacity/blend changes.

**References:** Aseprite layers; Pixelorama layers/blend modes; Pixquare layer types; LibreSprite layer sets.

### 5.5 Palette management (P0)

**What to build.** Edit a swatch (because pixels are indexed, this recolors every use), delete a swatch (remap to transparent or the nearest color, with a preview), reorder swatches (remap indices atomically), lock the palette, and import:

- Aseprite `.gpl` / JASC `.pal` / hex lists.
- Lospec palettes (URL or pasted hex list).
- A palette extracted from an imported image (median cut or k-means, capped at 255).
- A small set of built-in presets (DB32, Sweetie 16, PICO-8, Game Boy, etc.).

Add "replace color" in the UI (the agent already has the command) and a palette-cycling preview for animated recolors. Keep index 0 transparent and enforce the 255-color cap with a named error.

**Acceptance.** Editing index 3 recolors every pixel using index 3 across all frames. Deleting index 3 remaps those pixels to a color the user chose. Importing a Lospec palette of 16 colors adds it without silently changing existing pixels.

**References:** Aseprite color mode, color bar, default palette; Pixelorama palettes; Pixquare palette import; Lospec palette library.

### 5.6 Drawing essentials (P1)

**What to build.** Ellipse (filled/outline), curve, polygon, and a pixel-perfect toggle. Add symmetry with horizontal/vertical axes and a visible axis handle. Allow brush sizes up to at least 32 with round/square/line shapes, and a custom brush that stamps a small pattern. Add a dither/shading tool (Bayer 2×2/4×4, checker, 50%) and a fill tolerance/contiguous toggle.

**Acceptance.** A 32×32 circle drawn with the ellipse tool is symmetric and one undo step. Symmetry on X paints the mirrored stroke in the same command. Pixel-perfect removes the doubled corner pixel on a diagonal drag.

**References:** Aseprite drawing, brushes, ink, symmetry; Pixelorama tools; LibreSprite drawing.

### 5.7 Timeline, tags, and preview (P1)

**What to build.** A timeline grid (layers × frames) with a playhead, per-frame duration editing, tags as colored ranges, loop direction, scrub, and a preview window that plays at true speed. Onion skin should allow N previous/next frames, tint colors, and opacity. Tie the timeline selection to export ("export this tag", "export selected frames").

**Acceptance.** A user sets durations 80/120/80/120, tags frames 0–3 "walk" with ping-pong, previews it at 12 fps, and exports only that tag as GIF and sheet.

**References:** Aseprite timeline, animation, tags, onion skinning, preview window; Pixelorama timeline; Piskel frame delay.

### 5.8 Selection-scoped AI actions (P1)

**What to build.** When a selection exists, the composer offers direct actions: "Fill with…", "Remove", "Shade", "Clean up", "Variations". The request carries the mask, the palette lock, and the style guide. The agent returns N variants as previews; the user picks one; the commit is a single undoable command on the chosen layer. Start with deterministic operations the agent already understands (outline, dither, replace color) and then add model-backed inpainting.

**Acceptance.** Select a sword, ask "make it glow", get three previews that only change the selected pixels, pick one, and undo restores the original. No pixels outside the mask change.

**References:** PixelLab inpainting; Retro Diffusion MCP edit tools; Pixelaition's existing `copy_region`, `dither_rect`, `apply_outline` tools.

### 5.9 AI animation and linked cels (P1)

**What to build.** "Animate this frame" takes a described action, generates key frames, then proposes in-betweens; the user reviews on the onion-skin timeline. Pair this with **linked cels/shared layers** so the body, sword, or UI frame stays identical across frames while only the moving parts are painted. Without shared layers, every AI edit to a shared part creates drift — the exact failure `check_animation` was built to detect.

**Acceptance.** A 32×32 idle sprite generates a four-frame loop with a stable body and a moving flame; editing the shared body layer changes all four frames; the loop exports as GIF with the tag's duration.

**References:** PixelLab animation/interpolation; Retro Diffusion animation; Aseprite linked cels; Aseprite tags.

### 5.10 Seamless tiling and atlas packaging (P1)

**What to build.** A "Tile preview" toggle that draws the canvas 3×3 (or 5×5) around the current frame, so edges are judged in context. Add an agent action "make seamless" that reconciles opposite edges and proposes variants. Then package the result as a sheet + JSON, with presets for common engines/frameworks. Sprite Fusion's export list is a good reminder that "engine-ready" is the actual deliverable.

**Acceptance.** Toggle tile preview, see a visible seam, ask the agent to fix it, and the preview becomes continuous. Export a sheet + JSON whose frame boxes match the preview.

**References:** Aseprite tiled mode; Pixelorama tilemaps/seamless mode; Pyxel Edit tile references; Sprite Fusion engine exports.

## 6. Suggested sequencing

### Phase 1 — Unblock the loop (P0)

Goal: a user can bring a sprite in, edit it precisely, give it timing, and export an animation.

1. Raster and sprite-sheet import with quantization preview.
2. Palette edit/delete/reorder/lock and presets.
3. Selection mask + floating selection + clipboard + transform.
4. Layer opacity/blend/lock/duplicate.
5. Frame durations + GIF/sprite-sheet export (JSON can follow immediately).
6. Basic shortcuts for the new verbs (copy/paste, select all/invert, nudge, frame navigation).

Why this order: import gives the user material; selection and layers let them fix it; timing and export let them ship it. Palette work is needed by import anyway.

### Phase 2 — Animate and differentiate (P1)

Goal: animations become a first-class output, and the agent can edit what the human selected.

1. Timeline UI, tags, loop modes, preview window, onion settings.
2. Selection-scoped AI actions and variant previews.
3. AI in-betweens / "animate this frame".
4. Seamless-tile preview and auto-tile.
5. Sheet + JSON atlas with engine presets.
6. Reference overlay.
7. Drawing essentials: ellipse, curve, polygon, pixel-perfect, symmetry, larger/custom brushes.

### Phase 3 — Pro and ecosystem (P2)

Goal: serve game teams and migrating Aseprite users without diluting the AI-first product.

1. Linked cels/shared layers (if not pulled into Phase 2).
2. `.aseprite` import (then export if demand is proven).
3. Tileset/tilemap layers and autotiling.
4. Slices/9-slice/pivot metadata.
5. Custom brushes, dynamics, pressure.
6. Scripting/CLI/extensions — or a smaller "recipes" surface on top of MCP.
7. RGBA/grayscale color modes, only if the audience asks.

## 7. What not to build yet

- **A full tilemap editor.** Aseprite, Pixelorama, and Sprite Fusion all have one, but they serve map builders. Pixelaition's current edge is asset generation and social output. Build tile _preview_ and auto-tiling first; a full tilemap layer is a separate product bet.
- **A Lua runtime and extension marketplace.** The MCP server and HTTP API already make the product programmable. A plugin ecosystem is a multi-year commitment; wait for real automation demand.
- **3D layers, advanced color management, mobile-first editing.** Pixelorama's 3D layers and Pixquare's Apple Pencil experience are impressive but orthogonal to the current web/AI workflow.
- **`.aseprite` binary compatibility in Phase 1.** It is valuable for migration, but PNG/sheet import covers most of the need at a fraction of the cost. Add ASE import after the import pipeline is stable.
- **Full RGBA painting.** Indexed color is a feature of the product (palette discipline, consistency). Add layer compositing and alpha-aware export before considering a second color mode.

## 8. Success metrics to instrument

- **Import funnel:** drop → preview → commit; success rate by format; time to first import.
- **Export funnel:** assets exported / assets created; animation exports / multi-frame assets; format mix (GIF, sheet, PNG, social).
- **Editing depth:** sessions using selection, transform, clipboard, layer opacity/blend, palette edit; undo-after-action rate (a proxy for mistakes).
- **AI edit quality:** selection-scoped actions accepted vs. discarded; variant pick rate; revert rate; pixels changed outside the mask (should be zero).
- **Animation quality:** tag/loop usage; drift flags from `check_animation`; frames per exported animation.
- **Reliability:** save failures, export failures by cause, version restores.

Do not set targets before the first instrumented week; the point is to see which gap users hit first.

## 9. Open product questions

1. **Who is the primary user after the agent?** A game developer needs tilemaps, atlases, and engine presets. A social/brand designer needs artboards, copy, and native exports. The current app serves both; the next phase should pick a lead for prioritization.
2. **Is animation a first-class asset or a feature of an asset?** If first-class, linked cels, tags, and durations belong in Phase 1. If not, GIF export can ship before the full timeline.
3. **How important is Aseprite migration?** If a meaningful share of users arrive with `.ase` files, import compatibility becomes a acquisition wedge. If they arrive with PNGs and sheets, the simpler import is enough.
4. **Should the agent edit selections directly, or only propose?** The current plan/approval model says propose for structural work; selection-scoped edits are small enough to preview and commit. Define the trust boundary before shipping one-click changes.
5. **Do we want a local-first/offline mode?** Server autosave and versions are a strength; local files would be a different product. Do not drift into it accidentally.

## 10. References

### Aseprite

- Repository and README: <https://github.com/aseprite/aseprite>
- Features: <https://www.aseprite.org/features/>
- Drawing: <https://www.aseprite.org/docs/drawing/>
- Brushes: <https://www.aseprite.org/docs/brushes/>
- Ink: <https://www.aseprite.org/docs/ink/>
- Dynamics: <https://www.aseprite.org/docs/dynamics/>
- Symmetry: <https://www.aseprite.org/docs/symmetry/>
- Selecting: <https://www.aseprite.org/docs/selecting/>
- Transformations: <https://www.aseprite.org/docs/transformations/>
- Layers: <https://www.aseprite.org/docs/layers/>
- Linked cels: <https://www.aseprite.org/docs/linked-cels/>
- Timeline: <https://www.aseprite.org/docs/timeline/>
- Animation: <https://www.aseprite.org/docs/animation/>
- Tags: <https://www.aseprite.org/docs/tags/>
- Onion skinning: <https://www.aseprite.org/docs/onion-skinning/>
- Preview window: <https://www.aseprite.org/docs/preview-window/>
- Tiled mode: <https://www.aseprite.org/docs/tiled-mode/>
- Tilemap: <https://www.aseprite.org/docs/tilemap/>
- Color mode: <https://www.aseprite.org/docs/color-mode/>
- Color bar: <https://www.aseprite.org/docs/color-bar/>
- Default palette: <https://www.aseprite.org/docs/default-palette/>
- Exporting: <https://www.aseprite.org/docs/exporting/>
- Sprite sheet: <https://www.aseprite.org/docs/sprite-sheet/>
- Files: <https://www.aseprite.org/docs/files/>
- Open/image sequences: <https://www.aseprite.org/docs/open/>
- Slices: <https://www.aseprite.org/docs/slices/>
- Keyboard shortcuts: <https://www.aseprite.org/docs/keyboard-shortcuts/>
- Scripting: <https://www.aseprite.org/docs/scripting/>
- CLI: <https://www.aseprite.org/docs/cli/>
- Extensions: <https://www.aseprite.org/docs/extensions/>
- Data recovery: <https://www.aseprite.org/docs/data-recovery/>

### Other pixel editors

- Pixelorama repository: <https://github.com/Orama-Interactive/Pixelorama>
- Pixelorama tools: <https://www.pixelorama.org/user_manual/tools>
- Pixelorama selecting: <https://www.pixelorama.org/user_manual/selecting>
- Pixelorama transforming: <https://www.pixelorama.org/user_manual/transforming>
- Pixelorama timeline: <https://www.pixelorama.org/user_manual/user_interface/timeline>
- Pixelorama tilemaps: <https://www.pixelorama.org/user_manual/tilemaps>
- Pixelorama save/export: <https://www.pixelorama.org/user_manual/save_and_export>
- Pixelorama extensions: <https://www.pixelorama.org/extension_system/extension_basics>
- Pixelorama CLI: <https://www.pixelorama.org/user_manual/cli>
- LibreSprite repository: <https://github.com/LibreSprite/LibreSprite>
- LibreSprite scripting: <https://github.com/LibreSprite/LibreSprite/blob/master/SCRIPTING.md>
- Piskel: <https://www.piskelapp.com/>
- Piskel repository: <https://github.com/piskelapp/piskel>
- Piskel FAQ: <https://www.piskelapp.com/faq>
- Pyxel Edit features: <https://pyxeledit.com/features.php>
- GraphicsGale specification: <https://graphicsgale.com/us/spec.html>
- Pixquare docs: <https://docs.pixquare.art/>
- Pixquare frame operations: <https://docs.pixquare.art/timeline-and-layers/frame-operations.md>
- Pixquare layer types: <https://docs.pixquare.art/timeline-and-layers/layer-types.md>
- Pixquare exporting: <https://docs.pixquare.art/pixquare-file/exporting.md>
- Pixquare symmetry: <https://docs.pixquare.art/additional-features/symmetry.md>
- Pixquare tilemaps: <https://docs.pixquare.art/misc/tilemap-tileset-system.md>
- Pixquare selection: <https://docs.pixquare.art/tools/selection.md>
- Pixquare palette: <https://docs.pixquare.art/palette/overview.md>
- Pixquare color modes: <https://docs.pixquare.art/misc/color-modes.md>
- Sprite Fusion: <https://spritefusion.com/>
- Sprite Fusion export overview: <https://spritefusion.com/docs/tilemap-editor/exporting-maps/export-overview>
- Lospec palette library: <https://lospec.com/palette-list>

### AI-native pixel tools

- PixelLab style generation: <https://www.pixellab.ai/docs/tools/style>
- PixelLab image-to-pixel: <https://www.pixellab.ai/image-to-pixel-art>
- PixelLab inpainting: <https://www.pixellab.ai/docs/tools/inpaint-v3>
- PixelLab animation: <https://www.pixellab.ai/docs/tools/animate-with-text-pro>
- PixelLab interpolation: <https://www.pixellab.ai/docs/tools/interpolation>
- PixelLab rotation: <https://www.pixellab.ai/docs/tools/rotate>
- PixelLab background removal: <https://www.pixellab.ai/docs/tools/remove-background>
- PixelLab installation (Aseprite/Pixelorama extension): <https://www.pixellab.ai/docs/installation>
- Retro Diffusion: <https://www.retrodiffusion.ai/>
- Retro Diffusion MCP README: <https://github.com/Retro-Diffusion/retro-diffusion-mcp>

## 11. Repository evidence

- Tool catalog: `apps/web/src/components/editor-toolbar.tsx` (select, pencil, eraser, fill, eyedropper, line, rectangle, pan).
- Canvas actions and selection: `apps/web/src/components/pixel-canvas.tsx` (`Tool`, `CanvasAction`, rectangle-only selection, 1–3 brush footprints).
- Keyboard handling and playback: `apps/web/src/screens/editor.tsx` (undo/redo, zoom, tool keys, `[`/`]` capped at 3, fixed 220 ms playback).
- Document model: `packages/pixel/src/types.ts` (Layer has `visible` only; no opacity/blend/lock/group; frame has no duration/tag).
- Compositing: `packages/pixel/src/buffer.ts` (top opaque pixel wins; no alpha blending).
- Pixel commands: `packages/pixel/src/commands.ts` (paint, erase, fill, line, rect, region, replaceColor, outline, dither, resize, layers, mirror, stamp, mirrorRegion; no transform/clipboard/ellipse).
- Frame schema: `packages/db/src/schema.ts` (frames: name, index, layers, kind, size, preset, scene, version; no duration/tags).
- Export: `packages/export/src/index.ts` (PNG, JPG, SVG, ZIP, PXL; no GIF/APNG/WebP/sheet/atlas) and `apps/api/src/app.ts` (format enum and export route).
- Import: `apps/web/src/components/import-frame-dialog.tsx` (project frames only) and `apps/api/src/app.ts` (`POST /api/assets/:id/frames/import`; no raster upload route).
- Palette UI: `apps/web/src/components/editor-panels.tsx` (add/import; Sweetie 16 helper; no delete/reorder/lock/presets).
- README claims and current docs: `README.md` (editor tools, export formats, MCP), `AGENTS.md` (product boundaries and architecture).

## 12. Implementation status

The P0/P1 slices landed on `feat/editor-capability-expansion` in the commits
`62bb807`…`f52a1f1` (see `git log`). One indexed document and one renderer stay
the rule: the canvas, PNG/JPG, GIF/APNG/WebP, SVG and sheet export all composite
through `renderFrameDocument`, and every mutation still enters through
`applyCommand`.

Implemented:

- Raster/sheet import with quantisation, dithering, palette mapping and a
  locked palette (`apps/web/src/components/import-image-dialog.tsx`,
  `apps/api/src/import.ts`, `apps/api/src/palette.ts`).
- Ellipse, selection copy/cut/paste/flip/rotate/nudge, symmetry, 1–8 brushes,
  background removal and a reference overlay.
- Layer opacity, blend modes, lock, duplicate, groups and shared group opacity
  (`packages/pixel/src/commands.ts`, `packages/pixel/src/render.ts`).
- Frame delays, tags, timeline panel, real-duration playback, and agent
  timeline/slice/tiling tools.
- GIF, APNG, WebP, PNG sequence, packed/grid sprite sheets, engine atlas presets
  (Unity, Godot, Phaser), Aseprite JSON export/import, slices with nine-slice
  borders and pivots.
- Pixel-perfect pencil cleanup, round/spray brushes, lasso and magic-wand
  selections, mask-aware clipboard/fill, pen-pressure sizing, a reference
  overlay, and tile-size suggestions from the seam scan.
- Tileset packaging (`tileset` export), Aseprite JSON import in the CLI, a
  `.pxl` command-script runner, and `create_variant` for mirrored/remapped
  frames.
- Asset color modes: indexed, grayscale and monochrome palette conversion.
- Indexed `.ase` import (raw and zlib cels, palette, tags, slices) through the
  shared parser, plus `.ase` export.
- A `.pxl` CLI for import, inspect, script and export.
- Integration tests for palette, timing, tags, slices and every export, plus
  Playwright coverage for import, drawing/selection, background removal, GIF
  download and the palette lock.

Still open from the matrix above:

- Named slices in binary `.ase`; frames, layers, groups, linked cels, palette,
  tags and slices metadata round-trip through `.pxl` and Aseprite JSON.
- Tilemap authoring (tileset packaging, tile preview, seam reports and tile-size
  suggestions are in; the map layer/editor is not).
- Custom brush images, richer dynamics, true RGB color mode and Lua/visual
  scripting; grayscale/monochrome modes, pressure sizing and a command-script
  CLI exist.
- Linked/shared layers and auto-tiling remain design work; the style lock,
  mirrored variant frames (API, frame menu and agent tool), selection-scoped
  prompts, AI animation through frames/tags, and reference overlays are in
  place.
- Masked selections now support flip, rotate, move and nudge as well as
  copy/cut/paste and mask-aware drawing.

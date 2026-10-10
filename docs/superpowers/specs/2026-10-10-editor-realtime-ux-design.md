# Editor Realtime & UX — Design

**Status:** Approved for planning
**Date:** 2026-10-10
**Scope:** Sub-project B. Depends on Sub-project A's API (models from the database; no fallbacks).

## Goal

Make the editor feel like watching a real pixel artist work: strokes appear the moment the agent's tools commit them, the agent's steps are legible as structured activity, and the interface around the canvas is quiet, precise, and unmistakably Pixelaition.

## Non-goals

- Drag-and-drop layer reordering.
- A mobile app; existing sheet behavior on narrow screens is extended, not redesigned.
- Prompt migration to Langfuse, offline mode, or multi-user collaboration.

## 1. Realtime contract (the honesty rule)

1. **Strokes are tool calls, never an animation.** The canvas paints exactly what `canvas-stroke` events carry at the moment they arrive. No queued playback, no easing, no synthesized steps.
2. **Autosave never races a run.** While a run is active for the asset, the editor's debounced save is suspended. The agent's persisted strokes are the source of truth. When the run reaches a terminal state, the editor flushes any pending local edits that existed _before_ the run and then reloads the asset from the server.
3. **A reload finds its run.** On mount, the editor checks the active run for the asset; if one exists it reconnects to the stream with the `after` cursor and resumes painting without gaps.
4. Failure states are visible: a failed run leaves a `failed` row in the console with the provider error, not a silent stop.

## 2. Floating composer

Replace the 220px bottom band with a floating well centered at the bottom of the canvas column.

- **Shape:** one row by default (prompt field + model chip + effort chip + Generate/Stop). Grows upward to six rows of text; beyond that, internal scroll.
- **Surface:** `field` well, 2px `line-strong` border, pixel-corners, the standard 3px solid lift bar. Width `min(640px, 100% - 24px)`.
- **Chips:** model and effort are compact mono chips that open the existing select menus; no labels floating around them. When the catalog is empty, the chip reads `no models` and Generate is disabled.
- **Motion:** transform/opacity only, 140–200ms ease-out; honors `prefers-reduced-motion`.
- **Keyboard:** `Enter` generates, `Shift+Enter` newlines, `Escape` blurs and collapses. Focus ring uses `accent`.
- **Removed entirely:** the "Manual editing works without a model…" callout card. When the key is missing, the Generate button's disabled state plus a one-line mono hint inside the composer footer say why.

## 3. Run console

The reasoning/tool log leaves the composer box. A console emerges directly above the floating composer, sharing its width and surface family.

- **Auto-expand while a run is active; collapse to a summary bar when it ends** (`26 steps · completed in 2m 01s` — click to reopen; the bar keeps the last state badge).
- **Rows are structured, not a text dump:**

  | Event             | Row                                                                                                                                                                                                                    |
  | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | model turn starts | `thinking` row with elapsed timer; **reasoning text renders only when the provider sends it** (DeepSeek may; Muse sends encrypted reasoning — then the label is `thinking (encrypted)` with duration, never fake text) |
  | tool starts       | tool name + argument summary (`paint_stroke · 12 px`, `set_palette · 5 colors`) with a pending spinner                                                                                                                 |
  | tool ends         | ✓ result summary or ✕ error text (`That layer is not on this frame.`)                                                                                                                                                  |
  | run status        | running / completed / failed / cancelled badge with elapsed time; failure shows the provider message                                                                                                                   |
  | assistant message | rendered with `StreamMarkdown` as the final block                                                                                                                                                                      |

- **Scrolling:** follows the tail while the user is at the bottom; if the user scrolls up, follow pauses and a `jump to live` affordance appears.
- Data mapping lives in a pure module (`apps/web/src/lib/run-activity.ts`) with unit tests; the component only renders.

## 4. Palette and custom color picker

- The separate "Add color" field row is removed. A `+` tile becomes the **last cell of the swatch grid**.
- Clicking `+` opens a **custom popover** anchored to the tile, drawn in the app's language: square corners, 2px borders, `raised` surface.
  - Hex input with live validation (`#rrggbb`/`#rrggbbaa`).
  - A Sweetie 16 preset row.
  - A compact SV square + hue strip rendered in CSS with a square cursor — no native `<input type="color">`.
  - Preview swatch, `Add` primary button; disabled with reason when the color exists or the palette is at 33.
- The popover is a new shared primitive in `ui.tsx` (base-ui popover wrapped like `Menu`), keyboard reachable, focus returns to the `+` tile on close.

## 5. Panels polish

- **Left rail (frames/layers):** frame rows gain a live sprite thumbnail (`sprite-thumb` already exists) and the active frame keeps the `drawing` lock marker; layer rows share one row pattern with the visibility toggle at the start. Padding tightens to the 20px card rhythm; numbers stay mono.
- **Right rail:** `ViewPanel` becomes a three-item segmented icon control (grid/checker/onion) with tooltips; `Palette` moves its `used/max` count into the panel header; `StylePanel` hierarchy cleanup only.
- **Top bar:** a run status chip (drawing/completed/failed + elapsed) replaces the bare pulsing dot; Export and the mobile sheet buttons stay.
- All changes follow `DESIGN.md` tokens; no new colors; no border radius; copy never uses `faint`.

## 6. Documentation updates

- `DESIGN.md`: floating composer geometry, run console rules (including the encrypted-reasoning honesty rule and the "no post-hoc animation" contract), palette popover, panel patterns.
- `AGENTS.md`: the realtime rule (autosave suspended during a run; strokes come from tool calls only) alongside the existing canvas and Durable rules.

## 7. Testing

- Unit (vitest, web): `run-activity.ts` event→row mapping (tool start/end pairing, encrypted reasoning, failure rows), duration formatting, composer growth logic if extracted.
- The existing `pnpm --filter @pixelaition/web typecheck && lint` gate stays; `pnpm test` runs the new unit tests.
- **End-to-end with a real Muse run** through the browser against the local stack: strokes appear progressively; console rows stream; autosave suspension verified by watching `PATCH /api/assets/.../frames` stay silent during the run; after completion the reload keeps the pixels; the failed-run path renders when the key is removed.
- Accessibility passes: keyboard-only run start/stop, popover focus cycle, `prefers-reduced-motion` honored, contrast per `DESIGN.md`.

## 8. Review focus

- The autosave suspension must not lose user edits made before the run started; the flush-then-reload order is the contract.
- The console must never render invented reasoning text; encrypted reasoning shows as a timed phase.
- The floating composer must not cover the canvas at small heights (min-h-dvh layouts); it docks to the canvas column, not the viewport.
- Popover must not trap focus or leave the page inert (the Base UI `display:none` trap documented in DESIGN.md applies to dialogs; verify against the same bug).

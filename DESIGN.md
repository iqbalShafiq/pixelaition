# Design

Pixelaition looks like a drafting table at night. The canvas is the product. Chrome stays quiet.

## Color

The palette is a warm near-black with a single lime accent. Surfaces carry the
hierarchy, because a shadow cannot be darker than a surface that is already
near-black: every step up is a small, even lift.

| Token       | Value                       | Use                                          |
| ----------- | --------------------------- | -------------------------------------------- |
| paper       | `#14120e`                   | Page base                                    |
| panel       | `#1c1915`                   | Raised: side rails, cards                    |
| raised      | `#241f19`                   | Overlay: menus, dialogs, tooltips, toasts    |
| field       | `#0f0d0a`                   | Inset: input wells, one step down            |
| ink         | `#f4efe4`                   | Primary text                                 |
| muted       | `#9a917f`                   | Secondary text                               |
| faint       | `#6e675b`                   | Placeholder, disabled, decorative            |
| accent      | `#e8ff6a`                   | Focus, active tool, wordmark, primary button |
| erase       | `#ff5d3a`                   | Errors and destructive actions               |
| line        | `rgba(244, 239, 228, 0.14)` | Structural hairlines                         |
| line-strong | `rgba(244, 239, 228, 0.28)` | Edges that must read as a boundary           |

Two border weights, not one. `line` separates surfaces that already differ in
lightness. `line-strong` is for input edges, which need to read as a boundary.

No heavy shadow. No blurred glass. The accent is for state, never for a large
fill besides the primary button, and that button's label is `paper`.

Every text and surface pair clears WCAG 2.2 AA: 4.5:1 for body text and 3:1 for
large text. `accent` on `paper` and `paper` on `accent` are both well above it.
Interactive text never sits below `muted`; `faint` is for placeholders and
decoration only, never for copy.

Base rules live in `@layer base` in `apps/web/src/styles.css`. Unlayered CSS
beats Tailwind utilities, so a bare `button { color: inherit }` silently defeats
every `text-*` utility in the app.

Inputs carry a 16px font so a phone browser does not zoom the viewport when a
field is focused, and they are at least 44px tall.

## Type

IBM Plex Sans for interface text. IBM Plex Mono for coordinates, the wordmark, and activity status. The wordmark is tracked out and stays in the accent color.

## Space

The left rail is 280px and the right rail is 300px. The composer is a 220px band that expands, and it sits on the bottom edge. Cards use 16px padding and an 8px radius. Gaps inside a toolbar are 8px.

## Motion

140–200ms, ease-out, transform and opacity only. Buttons press to scale 0.98. Cards enter with a short rise. Overlays grow from their own origin. `prefers-reduced-motion` removes those transitions. Pixel cells are not eased. A new stroke can reveal its cells in order, then stop.

## Editor

Wide screens keep frames and layers on the left, the canvas in the center, and the palette and style guide on the right. Below 1100px both columns become sheets opened from the header, because a hidden rail with no way to reach it is a dead end rather than a layout choice. Below 720px the toolbar becomes a bottom dock above the composer, and the canvas stays the main surface.

Zoom snaps to 1, 2, 3, 4, 6, 8, 12, 16, 24, and 32, and always aims at the cursor. Opening an asset frames the whole sprite instead of a corner of it.

A sheet is unmounted at desktop widths rather than hidden with `display: none`. Base UI waits for an exit animation to unmount its portal, and a `display: none` popup never fires one, so the dialog stays mounted with an inert overlay that swallows every click on the page.

## Canvas

The frame is composited once into a 1:1 offscreen bitmap and then scaled with smoothing off. Drawing one rect per cell leaves seams and shimmer as soon as a cell is a single pixel, which is exactly what zooming out exposes. The bitmap is cached per frame buffer, so a stroke costs one redraw, not one per cell.

The canvas field is `panel`, one step above the page, so the artwork sits on a raised plane. The transparency checker is tied to the document grid at four pixels per tile and disappears below 2× zoom, where it would only read as noise over the artwork. Onion skin is a display opacity on the neighbouring frames. Grid lines, the selection marquee, and the shape preview are drawn in screen space after the bitmap, so they stay one pixel wide at every zoom.

The wheel listener is attached with `{ passive: false }` on the canvas rather than through React's `onWheel`, which is passive at the root and would let the page scroll while zooming.

## Components

Buttons, fields, cards, selects, menus, dialogs, sheets, tooltips, scroll areas, and toasts live in `apps/web/src/components/ui.tsx`. Screens use those pieces instead of one-off control styles. Scrollbars are thin and use the same ink family. Tool glyphs are inline SVG in `tool-icons.tsx`, so the toolbar needs no icon package.

`Field` associates its label with `htmlFor`, never by wrapping. A wrapped label also absorbs any button inside it, which is how a password field silently becomes "Password Show password" to a screen reader.

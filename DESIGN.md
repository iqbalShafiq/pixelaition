# Design

Pixelaition looks like a drafting table at night. The canvas is the product. Chrome stays quiet.

## Color

The palette is **Sweetie 16** by GrafxKid, the 16-colour palette that ships as
the TIC-80 default and is one of the most used on Lospec. Keeping the chrome on
a published pixel-art palette means an asset drawn in the editor and the
interface around it speak the same language, instead of inventing brand colours
and hoping they sit together.

Surfaces are flat blocks, one step apart, because a shadow cannot be darker than
a near-black page. The canvas sits in a darker well than the chrome around it,
the way a handheld console does.

| Token       | Value                       | Sweetie 16 | Use                                  |
| ----------- | --------------------------- | ---------- | ------------------------------------ |
| navy        | `#1a1c2c`                   | slot 0     | Deepest navy, text on the accent     |
| paper       | `#1a1c2c`                   | slot 0     | Page base                            |
| panel       | `#252a40`                   | derived    | Raised: side rails, cards            |
| raised      | `#333c57`                   | slot 15    | Overlay: menus, dialogs, sheets      |
| field       | `#101220`                   | derived    | Inset wells and the canvas screen    |
| screen      | `#101220`                   | derived    | The canvas plane                     |
| ink         | `#f4f4f4`                   | slot 12    | Primary text                         |
| muted       | `#94b0c2`                   | slot 13    | Secondary text, placeholders, labels |
| faint       | `#566c86`                   | slot 14    | Hairlines and marks only, never copy |
| accent      | `#a7f070`                   | slot 5     | Focus, active tool, primary button   |
| accent-deep | `#38b764`                   | slot 6     | The bar under a primary button       |
| erase       | `#ef7d57`                   | slot 3     | Errors and destructive actions       |
| line        | `rgba(148, 176, 194, 0.28)` | slot 13    | Structural hairlines                 |
| line-strong | `rgba(148, 176, 194, 0.55)` | slot 13    | Edges that must read as a boundary   |

Only `accent` and `erase` carry hue. The accent is for state, never for a large
fill besides the primary button, and that button's label is `navy`.

`faint` is for hairlines, marks, and the checkered transparency field. It
measures about 3.1:1 against the page, which clears the 3:1 a UI boundary needs
and fails the 4.5:1 that copy needs, so **no text uses it**.

Every text and surface pair clears WCAG 2.2 AA: 4.5:1 for body text and 3:1 for
large text. The audit runs over every visible text node, which is how the
`faint`-as-copy mistakes were caught.

Base rules live in `@layer base` in `apps/web/src/styles.css`. Unlayered CSS
beats Tailwind utilities, so a bare `button { color: inherit }` silently defeats
every `text-*` utility in the app.

Inputs carry a 16px font so a phone browser does not zoom the viewport when a
field is focused.

## Pixel craft

The interface is built from the vocabulary of a limited-colour screen.

- **No border radius.** Corners are 90�. Large panels take a stepped corner with
  `clip-path` (`pixel-corners`), which is the pixel-art window frame.
- **Chunky 2px borders**, two weights. `line` separates surfaces that already
  differ in lightness; `line-strong` is for input edges that must read as a
  boundary.
- **A pixel button is a flat block lifted by a solid bar**, not a soft shadow:
  `shadow-[0_3px_0_0_<deeper tone>]`. Pressing it translates down 3px and removes
  the bar. Nothing blurs.
- **A pixel checkbox is an 18px square** that fills with the accent and takes a
  chunky check at `strokeWidth={4}` with square caps.
- **A pixel field is an inset well**, darker than the surface it sits on, so it
  reads as somewhere you type rather than something you press.
- **Icons come from `lucide-react`** at one stroke weight, so the tool set looks
  drawn by one hand.
- **Textures are flat grids** (`pixel-grid`, `pixel-grid-lg`), never gradients or
  noise.

Anything the pointer can act on shows a pointer cursor, declared once in
`@layer base` for buttons, menu items, options, checkboxes, and labels that wrap
a control. Disabled controls show `not-allowed`.

## Type

IBM Plex Sans for interface text. IBM Plex Mono for coordinates, labels, section headings, and status lines. Panel headings and field labels are mono, uppercase, and tracked out; body copy is sans and sentence case.

## Space

The left rail is 280px and the right rail is 300px. The composer is a 220px band that expands, and it sits on the bottom edge. Cards use 20px padding and square corners. Gaps inside a toolbar are 8px.

## Motion

140–200ms, ease-out, transform and opacity only. Buttons press to scale 0.98. Cards enter with a short rise. Overlays grow from their own origin. `prefers-reduced-motion` removes those transitions. Pixel cells are not eased. A new stroke can reveal its cells in order, then stop.

## Editor

Wide screens keep frames and layers on the left, the canvas in the center, and the palette and style guide on the right. Below 1100px both columns become sheets opened from the header, because a hidden rail with no way to reach it is a dead end rather than a layout choice. Below 720px the toolbar becomes a bottom dock above the composer, and the canvas stays the main surface.

Zoom snaps to 1, 2, 3, 4, 6, 8, 12, 16, 24, and 32, and always aims at the cursor. Opening an asset frames the whole sprite instead of a corner of it.

A sheet is unmounted at desktop widths rather than hidden with `display: none`. Base UI waits for an exit animation to unmount its portal, and a `display: none` popup never fires one, so the dialog stays mounted with an inert overlay that swallows every click on the page.

## Canvas

The frame is composited once into a 1:1 offscreen bitmap and then scaled with smoothing off, and the draw origin is snapped to whole pixels so every cell is exactly the same width instead of drifting between 16px and 17px in one row. Drawing one rect per cell leaves seams and shimmer as soon as a cell is a single pixel, which is exactly what zooming out exposes. The bitmap is cached per frame buffer, so a stroke costs one redraw, not one per cell.

The canvas field is `panel`, one step above the page, so the artwork sits on a raised plane. The transparency checker is tied to the document grid at four pixels per tile and disappears below 2× zoom, where it would only read as noise over the artwork. Onion skin is a display opacity on the neighbouring frames. Grid lines, the selection marquee, and the shape preview are drawn in screen space after the bitmap, so they stay one pixel wide at every zoom.

The wheel listener is attached with `{ passive: false }` on the canvas rather than through React's `onWheel`, which is passive at the root and would let the page scroll while zooming.

## Components

Buttons, fields, cards, selects, menus, dialogs, sheets, tooltips, scroll areas, and toasts live in `apps/web/src/components/ui.tsx`. Screens use those pieces instead of one-off control styles. Scrollbars are thin and use the same ink family. Tool glyphs are inline SVG in `tool-icons.tsx`, so the toolbar needs no icon package.

`Field` associates its label with `htmlFor`, never by wrapping. A wrapped label also absorbs any button inside it, which is how a password field silently becomes "Password Show password" to a screen reader.

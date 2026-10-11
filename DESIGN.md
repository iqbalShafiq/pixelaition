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
  `shadow-pixel-sm` (2px navy) on solid and danger, `shadow-pixel-steel` on
  ghost so the bar also reads on the paper page, no bar on quiet. Pressing
  translates the block 2px down and right and removes the bar. Nothing blurs.
- **A pixel checkbox is an 18px square** that fills with the accent and takes a
  chunky check at `strokeWidth={4}` with square caps.
- **A pixel field is an inset well**, darker than the surface it sits on, so it
  reads as somewhere you type rather than something you press.
- **Icons come from pixelarticons** through the `crisp` wrapper in
  `pixel-icons.tsx`, and any missing glyph is drawn on the same 24 grid. Sizes
  are **24 or 12, never 16 or 20** — the library is a 24 grid and 12 is its half
  scale, so both sizes stay crisp at DPR 2.
- **Textures are flat grids** (`pixel-grid`, `pixel-grid-lg`), never gradients or
  noise.

Anything the pointer can act on shows a pointer cursor, declared once in
`@layer base` for buttons, menu items, options, checkboxes, and labels that wrap
a control. Disabled controls show `not-allowed`.

## Type

Three pixel faces, each on its own design grid:

| Face           | Grid                      | Use                                                           |
| -------------- | ------------------------- | ------------------------------------------------------------- |
| Silkscreen     | multiples of 8 (16/24/32) | wordmark, page titles, panel headers, dialog and sheet titles |
| Pixelify Sans  | ≥12px, ≥16px for body     | body copy, labels, buttons, menus, tooltips, inputs           |
| Departure Mono | multiples of 11 (11/22)   | numbers, hex, keyboard hints, run console, status lines       |

The scale lives in `apps/web/src/styles.css` as `text-pixel-display`,
`text-pixel-title`, `text-pixel-label`, `text-pixel-body`, and `text-pixel-mono`;
components never hand-roll sizes. Pixel-font elements carry
`-webkit-font-smoothing: none` and `text-rendering: geometricPrecision`, and a
fractional size off the face's grid is a bug — it blurs.

The micro-label decision (spec open question 6) went to **Silkscreen 16 for panel
headers**: side by side with Pixelify 12 it reads as a section title that belongs
to the same window language as the dialog and sheet titles, it fits the 280px
rail (a "Style guide" header is about 110px), and its 24px line height costs
nothing in a scrollable rail. Pixelify 12 stays the small-copy floor; Departure
Mono stays numbers and logs only.

## Space

The left rail is 280px and the right rail is 300px. The composer is a 220px band that expands, and it sits on the bottom edge. Cards use 20px padding and square corners. Gaps inside a toolbar are 8px.

## Motion

140–200ms, ease-out, transform and opacity only. Buttons press to scale 0.98. Cards enter with a short rise. Overlays grow from their own origin. `prefers-reduced-motion` removes those transitions. Pixel cells are not eased. A new stroke can reveal its cells in order, then stop.

## Editor

Wide screens keep frames and layers on the left, the canvas in the center, and the palette and style guide on the right. Below 1100px both columns become sheets opened from the header, because a hidden rail with no way to reach it is a dead end rather than a layout choice. Below 720px the toolbar becomes a bottom dock above the composer, and the canvas stays the main surface.

Zoom snaps to 1, 2, 3, 4, 6, 8, 12, 16, 24, and 32, and always aims at the cursor. Opening an asset frames the whole sprite instead of a corner of it.

A sheet is unmounted at desktop widths rather than hidden with `display: none`. Base UI waits for an exit animation to unmount its portal, and a `display: none` popup never fires one, so the dialog stays mounted with an inert overlay that swallows every click on the page.

## Canvas

The frame is composited once into a 1:1 offscreen bitmap and then scaled with smoothing off, so a stroke costs one redraw rather than one draw call per cell. The draw origin is snapped to whole pixels, so every cell is exactly the same width instead of drifting between 16px and 17px in one row.

The whole preview is one texture: a checker of **one square per document pixel**, tiled across the canvas and anchored to the document grid at the current zoom. One square per pixel is what makes the hover cell and every drawn pixel cover exactly one square. A fixed screen-size checker looks tidier in the abstract but it drifts against the pixel grid, so a hover outline covers one and a bit squares and nothing reads as a single pixel any more.

The document edge is drawn as a **2px accent border**, painted just outside the pixel bounds so it never covers a cell. It marks exactly the region the tools and the agent may write to; because it lives outside the document, the artwork does not read as a smaller box inside a bigger one, and nothing shifts as you zoom.

The grid overlay is therefore redundant and **off by default**. When it is on it only appears from 1200% up, and it costs one pixel per cell boundary: measured at 1200% a cell reads one line pixel plus eleven body pixels against a flat twelve with the grid off. Below 1200% a boundary line eats an eighth of every cell and blends against two checker tones, which reads as texture rather than as a grid.

Onion skin is a display opacity on the neighbouring frames, drawn from the same bitmap with their transparent pixels left alone so the texture stays visible underneath. The selection marquee, the shape preview, and the hover cell are drawn in screen space afterwards, so they stay one pixel wide at every zoom.

The wheel listener is attached with `{ passive: false }` on the canvas rather than through React's `onWheel`, which is passive at the root and would let the page scroll while zooming.

## Components

Buttons, fields, cards, selects, menus, dialogs, sheets, tooltips, scroll areas, and toasts live in `apps/web/src/components/ui.tsx`. Screens use those pieces instead of one-off control styles. Scrollbars are thin and use the same ink family. Every icon comes from `pixel-icons.tsx`, so the app needs no icon package.

The pixel craft itself lives in `styles.css` utilities: `pixel-corners` (stepped
corner), `pixel-window` (a 6px border-image 9-slice whose frame colour is baked
into the data URI at `muted` 55% — the same tone as `line-strong`; changing it
means editing the SVG), `bevel`/`bevel-in` (2px inset edges), the hard
`shadow-pixel-*` bars, and the `pixel-grid`/`dither` textures. Menus, popovers,
tooltips, dialogs, sheets, and the select popup all use `pixel-window`; only
inline fields keep flat `border-2` edges. Overlays enter with `steps()` keyframes
and the toast fades in two steps; the 140–200ms ease-out motion token covers
everything else.

`Field` associates its label with `htmlFor`, never by wrapping. A wrapped label also absorbs any button inside it, which is how a password field silently becomes "Password Show password" to a screen reader.

## Composer and run console

The composer floats over the canvas column: max width 40rem, `field` surface, 2px `line-strong` border, pixel-corners, the standard solid lift bar, and 28 units of canvas padding underneath so the sprite keeps a resting area. Enter generates, Shift+Enter breaks the line, Escape blurs. When the key or the catalog is missing the composer says so in one mono line; the card that used to explain manual editing is gone. Toasts sit above the composer band (`bottom-32`), so a toast never covers the Generate button.

The run console sits above the composer in the same width and surface family. It shows the agent's real steps — thinking phases (reasoning text only when the provider sends it; encrypted reasoning stays a timed phase), tool rows with argument summaries and results, and the assistant message. It opens while a run is live, collapses to a summary bar when it ends, and never animates a step that did not happen.

## Realtime contract

A stroke appears when the worker's tool call commits it, never as a replay. While a run is active for the asset the editor suspends autosave; the reload after the run makes the server pixels the truth; a reopened editor rejoins an active run and repaints from the retained stream.

## Palette picker

The add-color control is the last tile of the swatch grid and opens a pixel popover: an SV square, a hue strip, the Sweetie 16 presets, a hex field, and one solid Add button. Square corners, 2px borders, no native colour input.

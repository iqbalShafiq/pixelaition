# Design

Pixelaition looks like a drafting table at night. The canvas is the product. Chrome stays quiet.

## Color

The chrome is **Atelier**, a near-black warm graphite ramp with one brass accent
and one coral signal. It is deliberately quieter than the artwork: a neutral
studio wall around the canvas, with every surface a few steps from black. The
values were measured from live dark chrome, not moodboards: ChatGPT's `#000000`
page with `#cdcdcd` secondary text, Grok's `#131211` page over `#201f1d` raised
surfaces and 6% hairlines, Claude's `#151515` page over `#111111` chrome with
`#f0efec` text, and Gemini's `#0f0f0f` page with `#1f1f1f` rails. Linear
(`#08090a`) and Raycast (`#07080a`) have the same shape, and Dribbble's
dark-dashboard set keeps every saturated colour inside the content. The ladder's
structure follows Radix's 12-step dark scale; the values were tuned against this
app's own WCAG audit.

Surfaces are flat blocks, one step apart, because a shadow cannot be darker than
a near-black page. The canvas sits in the deepest well, the way a drafting table
sits under the lamp.

| Token       | Value                       | Ramp step | Use                                   |
| ----------- | --------------------------- | --------- | ------------------------------------- |
| paper       | `#0a0a09`                   | 1         | Page base                             |
| panel       | `#131211`                   | 3         | Raised: side rails, header, cards     |
| raised      | `#1c1b19`                   | 4         | Overlay: menus, dialogs, sheets       |
| field       | `#050505`                   | 0         | Inset wells                           |
| screen      | `#000000`                   | 00        | The canvas plane                      |
| ink         | `#f1efe9`                   | 12        | Primary text                          |
| muted       | `#a7a49e`                   | 11        | Secondary text, placeholders, labels  |
| faint       | `#6d6a64`                   | 8         | Hairlines and marks only, never copy  |
| accent      | `#d8a64e`                   | 9         | Focus, active tool, primary button    |
| accent-deep | `#a5772c`                   | 10        | The bar under a primary button        |
| erase       | `#e07a63`                   | 11        | Errors and destructive actions        |
| coffee      | `#0b0906`                   | 0         | Text on accent/erase, backdrops, bars |
| stone       | `#75726c`                   | 7         | Ghost lift bar and scrollbar thumb    |
| line        | `rgba(241, 239, 233, 0.1)`  | derived   | Structural hairlines                  |
| line-strong | `rgba(241, 239, 233, 0.38)` | derived   | Edges that must read as a boundary    |

Only `accent` and `erase` carry hue. The accent is for state, never for a large
fill besides the primary button, and that button's label is `coffee`. Wordmarks,
page titles, and panel headers are `ink`. `muted` is secondary copy, never a
title.

`faint` is for hairlines, marks, and the checkered transparency field. It
measures 3.67:1 against the page, 3.47:1 against `panel`, and 3.19:1 against
`raised`, which clears the 3:1 a UI boundary needs and fails the 4.5:1 that copy
needs, so **no text uses it**. `line-strong` blends to about 3.2:1 on the
surfaces it edges, so a control boundary still reads.

Every text and surface pair clears WCAG 2.2 AA: 4.5:1 for body text and 3:1 for
large text. `ink` is 17.23:1 on the page, `muted` 7.97:1, `accent` 8.95:1, and
`erase` 6.73:1; the lowest text pair is `erase` on `raised` at 5.85:1. The audit
runs over every visible text node, which is how the `faint`-as-copy mistakes
were caught.

The artwork's palette is the artist's. The palette panel still offers Sweetie 16
as a starting point, but the chrome draws no colour from an asset palette and no
interface token is added to one: the sprite is the only colour on the page.

Base rules live in `@layer base` in `apps/web/src/styles.css`. Unlayered CSS
beats Tailwind utilities, so a bare `button { color: inherit }` silently defeats
every `text-*` utility in the app.

Inputs carry a 16px font so a phone browser does not zoom the viewport when a
field is focused.

## Mark

The app icon is the signed-out slide's dither field, condensed to a mark: a 16×16
grid where a radial falloff is banded into the Atelier ramp — `ink` core, `accent`
ring, `accent-deep` body, and a Bayer-checker halo in the deep tone — on a `coffee`
tile with a one-pixel stepped corner. `favicon.svg` breathes that halo on the
slide's own 2400ms (`prefers-reduced-motion` freezes it at 0.8), and the same grid
exports to the 32/180/192/512 PNGs plus a full-bleed maskable 512, so the tab, the
dock, and an installed window all show one mark.

## Pixel craft

The interface is built from the vocabulary of a limited-colour screen.

- **No border radius.** Corners are 90�. Large panels take a stepped corner with
  `clip-path` (`pixel-corners`), which is the pixel-art window frame.
- **Chunky 2px borders**, two weights. `line` separates surfaces that already
  differ in lightness; `line-strong` is for input edges that must read as a
  boundary.
- **A pixel button is a flat block lifted by a solid bar**, not a soft shadow:
  `shadow-pixel-sm` (2px coffee) on solid and danger, `shadow-pixel-stone` on
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
- **Page backgrounds are flat `paper`.** `pixel-grid` and `pixel-grid-lg` are
  not page wallpaper. The only full-field checker belongs to the canvas, one
  square per document pixel. Empty states may use a small `dither` behind solid
  copy. Never gradients or noise.

Anything the pointer can act on shows a pointer cursor, declared once in
`@layer base` for buttons, menu items, options, checkboxes, and labels that wrap
a control. Disabled controls show `not-allowed`.

## Type

Three pixel faces, each on its own design grid:

| Face           | Grid                                             | Use                                                                               |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Silkscreen     | multiples of 8 (16/24/32)                        | display: wordmark, page titles and heroes, panel headers, dialog and sheet titles |
| Pixelify Sans  | 12px floor for short strings, 16px for body copy | body copy, labels, buttons, menus, tooltips, inputs                               |
| Departure Mono | multiples of 11 (11/22)                          | numbers, hex, keyboard hints, run console and logs, micro-labels and kickers      |

The scale lives in `apps/web/src/styles.css` as `text-pixel-hero`,
`text-pixel-display`, `text-pixel-title`, `text-pixel-label`, `text-pixel-body`,
and `text-pixel-mono`; components never hand-roll sizes. Pixel-font elements
carry `-webkit-font-smoothing: none` and `text-rendering: geometricPrecision`,
and a fractional size off the face's grid is a bug — it blurs.

The micro-label decision (spec open question 6) went to **Silkscreen 16 for panel
headers**: side by side with Pixelify 12 it reads as a section title that belongs
to the same window language as the dialog and sheet titles, it fits the 280px
rail (a "Frames" header measures 95px of text), and its 24px line height costs
nothing in a scrollable rail. Pixelify 12 stays the small-copy floor. Departure
Mono covers numbers and logs plus the uppercase micro-labels and kickers
(field labels, toast titles, empty-state titles, page eyebrows), which stay
mono by design.

## Space

The left rail is 280px and the right rail is 300px. The composer is a 220px band that expands, and it sits on the bottom edge. Cards use 20px padding and square corners. Gaps inside a toolbar are 8px.

## Motion

140–200ms, ease-out, transform and opacity only. Buttons press to scale 0.98. Cards enter with a short rise. Overlays grow from their own origin. `prefers-reduced-motion` removes those transitions. Pixel cells are not eased. A new stroke can reveal its cells in order, then stop.

The home and the editor are joined by one bar. It keeps its flight name across the move, so its surface cross-fades between the home's floating paper and the editor's `panel`; the wordmark glides between the two bar positions, and the account chip, breadcrumb, and action cluster hand over in sequence (out, then in) instead of all at once. The bar's pieces are named, so the browser never resamples the same pixels twice. Signing in flies the signed-out wordmark into the bar as that same shared element, scaling from the slide's display size to the bar's title size; sign-out plays it back. The named box is what the browser scales, so the auth wordmark is wrapped to the glyphs' own width rather than the column's.

## Editor

Wide screens keep frames and layers on the left, the canvas in the center, and the palette and style guide on the right. The header and both rails share the `panel` surface and meet the canvas on a `line` border. The canvas column is the `field` well, so the sprite reads as the stage and the chrome stays quiet. Rails flex between 240px and their caps (280px left, 300px right) so a narrow laptop does not crush the canvas. Below 1100px both columns become sheets opened from the header, because a hidden rail with no way to reach it is a dead end rather than a layout choice. Below 720px the toolbar becomes a bottom dock above the composer, and the canvas stays the main surface.

The signed-in home is the same shell: a sticky bar that starts as part of the page — no background, no hairline, so the wordmark floats on `paper` — and gains its `panel` container and `line` hairline as soon as the library scrolls under it, over 200ms ease-out (`prefers-reduced-motion` keeps the switch instant). Its content shares the page's `max-w-7xl` container. Below it sit the project list (a sticky rail from 1024px, a scrolling chip row under that), the library, and recent runs. The bar ends in the account cluster — the signed-in monogram, the name, and a menu that owns Sign out — so the destructive action is not a loose button in the chrome, and the rails stick below the 64px bar (`top-20`) instead of under it. The page has no hero and no graph-paper background. The composer stays the dock the editor uses.

The signed-out page puts the account form in a full-height `panel` column, from 28rem up to 36rem. The other column is a slide. Branding stays on flat paper at the left. A `pixel-grid-slide` covers the rest of the slide, at 12px so the squares read as a field, and fades out before the type. Assets sit where they belong in that field: a cloud and a bird high, the knight, potion, and slime on the ground. Each asset has two poses and at least two layers. The first pose paints layer by layer. Later poses replace it at once. The name under an asset stays put, with the pose name beside it. Two marks show which pose is on screen, and another set shows how many layers of the current pose are drawn. Below 1024px the same picture is a short band above the form. `prefers-reduced-motion` shows every asset on its second pose, finished.

Zoom snaps to 1, 2, 3, 4, 6, 8, 12, 16, 24, and 32, and always aims at the cursor. Opening an asset frames the whole sprite instead of a corner of it.

`set_palette` replaces the **asset's** palette and persists it, exactly like the
editor's palette panel: every frame adopts the change, the run's `read_project`
legend follows, and the pixels a run paints can never outlive the palette they
were painted against. A palette that would drop a colour another frame still
uses is refused before anything changes.

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
into the data URI at `ink` 38% — the same tone as `line-strong`; changing it
means editing the SVG), `bevel`/`bevel-in` (2px inset edges), the hard
`shadow-pixel-*` bars, and the `pixel-grid`/`dither` textures. Menus, popovers,
tooltips, dialogs, sheets, and the select popup all use `pixel-window`; only
inline fields keep flat `border-2` edges. Overlays enter with `steps()` keyframes
and the toast fades in two steps; the 140–200ms ease-out motion token covers
everything else.

`Field` associates its label with `htmlFor`, never by wrapping. A wrapped label also absorbs any button inside it, which is how a password field silently becomes "Password Show password" to a screen reader.

## Composer and run console

The composer floats over the canvas column: max width 40rem, `field` surface, 2px `line-strong` border, pixel-corners, the standard solid lift bar, and 28 units of canvas padding underneath so the sprite keeps a resting area. Enter generates, Shift+Enter breaks the line, Escape blurs. When the key or the catalog is missing the composer says so in one mono line; the card that used to explain manual editing is gone. Toasts sit above the composer band (`bottom-32`), so a toast never covers the Generate button.

The run console sits above the composer in the same width and surface family. It shows the agent's real steps — thinking phases (reasoning text only when the provider sends it; encrypted reasoning stays a timed phase), tool rows with argument summaries and results, and the assistant message. It opens while a run is live, collapses to a summary bar when it ends, and never animates a step that did not happen. The summary bar is two fixed lines: the state beside the whole asset conversation's elapsed and cost, then the context window as a ten-cell accent bar with its percent, `used / window`, and the model that declared it. Phase progress (`reviewing 2/4`) appears only while the run is live, and a model with no declared window shows `context —`. The agent's reply is a bordered `field` card headed `agent`, apart from tool rows and thinking notes; a settled turn prints the send time and billed input under the user's message and the model, output tokens, cost, and duration under the reply. A streamed answer that matches the run's closing message is shown once — by the transcript row — never twice.

## Realtime contract

A stroke appears when the worker's tool call commits it, never as a replay. While a run is active for the asset the editor suspends autosave; the reload after the run makes the server pixels the truth; a reopened editor rejoins an active run and repaints from the retained stream.

## Palette picker

The add-color control is the last tile of the swatch grid and opens a pixel popover: an SV square, a hue strip, the Sweetie 16 presets, a hex field, and one solid Add button. Square corners, 2px borders, no native colour input.

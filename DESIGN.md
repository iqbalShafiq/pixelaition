# Design

Pixelaition looks like a drafting table at night. The canvas is the product. Chrome stays quiet.

## Color

| Token  | Value                       | Use                            |
| ------ | --------------------------- | ------------------------------ |
| paper  | `#14120e`                   | Page background                |
| panel  | `#1c1915`                   | Side panels and cards          |
| ink    | `#f4efe4`                   | Primary text                   |
| muted  | `#9a917f`                   | Secondary text                 |
| accent | `#e8ff6a`                   | Focus, active tool, wordmark   |
| erase  | `#ff5d3a`                   | Errors and destructive actions |
| line   | `rgba(244, 239, 228, 0.12)` | 1px borders                    |

No heavy shadow. No blurred glass. The accent is for state, not for large fills besides the primary button.

## Type

IBM Plex Sans for interface text. IBM Plex Mono for coordinates, the wordmark, and activity status. The wordmark is tracked out and stays in the accent color.

## Space

Panels are 240–280px. The composer sits on the bottom edge. Cards use 16px padding and an 8px radius. Gaps inside a toolbar are 8px.

## Motion

140–200ms, ease-out, transform and opacity only. Buttons press to scale 0.98. Cards enter with a short rise. `prefers-reduced-motion` removes those transitions. Pixel cells are not eased. A new stroke can reveal its cells in order, then stop.

## Editor

Wide screens keep frames and layers on the left, the canvas in the center, and the palette on the right. Below 1100px the side columns hide and the canvas plus composer remain. Zoom snaps to 1, 2, 3, 4, 6, 8, 12, 16, 24, and 32, and always aims at the cursor.

## Canvas

The frame is composited once into a 1:1 offscreen bitmap and then scaled with smoothing off. Drawing one rect per cell leaves seams and shimmer as soon as a cell is a single pixel, which is exactly what zooming out exposes. The bitmap is cached per frame buffer, so a stroke costs one redraw, not one per cell.

The transparency checker is tied to the document grid at four pixels per tile and disappears below 2× zoom, where it would only read as noise over the artwork. Onion skin is a display opacity on the neighbouring frames. Grid lines, the selection marquee, and the shape preview are drawn in screen space after the bitmap, so they stay one pixel wide at every zoom.

## Components

Buttons, fields, cards, and selects live in `apps/web/src/components/ui.tsx`. Screens use those pieces instead of one-off control styles. Scrollbars are thin and use the same ink family. Tool glyphs are inline SVG in `tool-icons.tsx`, so the toolbar needs no icon package.

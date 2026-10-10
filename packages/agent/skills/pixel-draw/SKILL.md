---
name: pixel-draw
description: Draw consistent pixel assets with palette-indexed strokes and a deterministic critique.
---

# Pixel draw

Paint with tools. A pixel exists only after `paint_stroke`, `fill_rect`, or `mirror_frame` returns.

- Keep the style guide outline and color limit.
- Variants start from the source frame.
- Stop when `critique_frame` returns no issues.

# Agent Capabilities & Pixel Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the pixel theme across every page (Part I, Phases 1–5), then expand the drawing agent to observe, plan, ask, version, and route work (Part II, Phases 6–12).

**Architecture:** Part I changes only `apps/web` styling and components: fonts via `@fontsource` plus a vendored Departure Mono, Tailwind v4 theme tokens, CSS utilities, and the shared `ui.tsx` primitives. Part II extends `packages/agent` (tools), `packages/pixel` (commands, animation checks), `packages/db` (additive migrations 0004–0007), `apps/worker` (multi-frame binding, durable interactions), `apps/api` (routes, versioning), and `apps/web` (interaction card, History panel, home composer) on top of Part I's primitives.

**Tech Stack:** pnpm + Turborepo, TypeScript, React 19, Vite, Tailwind v4, motion (`motion/react`), Base UI wrappers, Drizzle + Postgres, Anvia v1 (`@anvia/core` 1.12.0, `@anvia/durable` 0.6.0), vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-and-pixel-theme-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

- Colour comes only from Sweetie 16 through the tokens in `apps/web/src/styles.css` / `DESIGN.md`. No new colours, no border radius, 2px borders, copy never uses `faint`.
- Body text ≥ 16px; inputs stay ≥ 16px (iOS zoom rule already in `styles.css`).
- Pixel fonts render only at integer sizes on their grids: Silkscreen ≥ 16px (multiples of 8), Departure Mono 11/22px, Pixelify Sans ≥ 12px for short strings and ≥ 16px for body.
- All motion uses `steps()` timing (or ≤ 200ms ease-out where steps is wrong) and is disabled by `prefers-reduced-motion` (the global rule already zeroes durations).
- Pixel mutations go through `applyCommand` in `packages/pixel`; no deterministic fallbacks anywhere (`AGENTS.md`).
- Migrations are additive and numbered from `0004`; generated with `pnpm --filter @pixelaition/db generate`, applied with `pnpm db:migrate`.
- Every phase ends with `pnpm typecheck && pnpm lint && pnpm test` green plus the phase's own browser/live verification, committed as conventional commits.
- `aria-label`s, tooltips, and hit-area sizes (36/28/24 boxes) survive every visual change.

## Review Focus

Failure modes the spec implies that no single test fully covers — each has a pinned test in the owning task below:

1. **Fractional pixel-font sizes blur.** Any size not on the font's grid (e.g. `text-[13px]` in Silkscreen, `text-[10px]` in Departure Mono) renders fuzzy; expected: crisp at 100% and 200% zoom. (Task 1 & 3 tests, Task 16 audit.)
2. **Long user strings overflow the new faces.** Frame/project names are user data; expected: truncation still works in rows, chips, and dialogs. (Task 2 sweep checklist, Task 14 home cards.)
3. **Hard shadows and pixel-window frames overlap neighbours.** Popovers/menus/dialogs with offset shadows can clip or cover adjacent controls; expected: no overlap inside the composer stack, panels, and sheets. (Task 4–7 browser checks, Task 16 audit.)
4. **`steps()` motion under `prefers-reduced-motion`.** Stepped animations must become instant, not janky half-steps. (Task 7 reduced-motion check, Task 16 audit.)
5. **Icon swap changes accessible names or hit areas.** Expected: identical `aria-label`s and box sizes after the swap; contrast of filled glyphs on `raised`/`field` ≥ 4.5:1. (Task 9–11 tests, Task 16 audit.)

---

## File Map

**Part I — created**

- `apps/web/src/assets/fonts/DepartureMono-Regular.woff2` + `DEPARTURE-MONO-LICENSE.txt` — vendored mono (OFL).
- `apps/web/src/components/pixel-icons.tsx` — the icon mapping module (pixelarticons + custom grid icons).
- `apps/web/src/components/pixel-loader.tsx` — 3-frame sprite loader.

**Part I — modified**

- `apps/web/src/styles.css` — fonts, tokens, type scale, utilities, keyframes, scrollbars.
- `apps/web/src/components/ui.tsx` — every primitive.
- `apps/web/src/components/editor-toolbar.tsx`, `editor-panels.tsx`, `run-console.tsx`, `composer.tsx`, `export-dialog.tsx`, `sprite-thumb.tsx`, `pixel-canvas.tsx` — sweep + icons + atmosphere.
- `apps/web/src/screens/auth.tsx`, `projects.tsx`, `editor.tsx` — page polish.
- `DESIGN.md`, `AGENTS.md` — documentation.

**Part II — created**

- `packages/pixel/src/animation.ts` + `animation.test.ts` — continuity metrics.
- `packages/agent/src/format.ts` + `format.test.ts` — RLE row encoding.
- `packages/agent/src/tools.test.ts` — tool handler tests.
- `apps/web/src/lib/versions.ts` + `versions.test.ts` — version mapping helpers.
- `apps/web/src/components/history-panel.tsx` — History UI.
- `apps/web/src/components/interaction-card.tsx` — HITL card.
- `packages/db/drizzle/0004_models_vision.sql`, `0005_runs_override.sql`, `0006_versions.sql`, `0007_thread_scopes.sql` — generated.

**Part II — modified**

- `packages/agent/src/tools.ts`, `runs.ts`, `instructions.ts`, `index.ts`; `evals/deterministic.test.ts`.
- `packages/pixel/src/commands.ts`, `critique.ts` (+ tests).
- `packages/db/src/schema.ts`.
- `apps/worker/src/index.ts` — binding, follow/waiting, respond endpoint, prompt history, maxTurns.
- `apps/api/src/app.ts`, `store.ts` — routes, versions, workspace scope.
- `apps/web/src/lib/run-activity.ts` (+ test), `components/run-console.tsx`, `screens/editor.tsx`, `screens/projects.tsx`, `components/composer.tsx`.

---

# Part I — Pixel Theme

## Phase 1 — Typography

### Task 1: Font packages, tokens, and the type scale

**Files:**

- Modify: `apps/web/package.json` (deps)
- Create: `apps/web/src/assets/fonts/DepartureMono-Regular.woff2`, `apps/web/src/assets/fonts/DEPARTURE-MONO-LICENSE.txt`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Produces: theme tokens `--font-display`, `--font-body` (aliased to `--font-sans`), `--font-mono`; utility classes `.text-pixel-display`, `.text-pixel-title`, `.text-pixel-label`, `.text-pixel-body`, `.text-pixel-mono` used by every later task.

- [ ] **Step 1: Install the two Fontsource faces**

```bash
pnpm --filter @pixelaition/web add @fontsource/silkscreen @fontsource/pixelify-sans
```

- [ ] **Step 2: Vendor Departure Mono (OFL) with its license**

```bash
mkdir -p apps/web/src/assets/fonts
curl -L -o apps/web/src/assets/fonts/DepartureMono-Regular.woff2 \
  https://github.com/rektdeckard/departure-mono/raw/HEAD/public/assets/DepartureMono-Regular.woff2
curl -L -o apps/web/src/assets/fonts/DEPARTURE-MONO-LICENSE.txt \
  https://github.com/rektdeckard/departure-mono/raw/HEAD/LICENSE
ls -la apps/web/src/assets/fonts/   # both files non-zero; license is OFL text
```

If the raw URL 404s, open `https://github.com/rektdeckard/departure-mono` and use the current default branch in place of `HEAD`.

- [ ] **Step 3: Replace the font imports and tokens in `styles.css`**

Replace lines 1–4 imports with:

```css
@import "tailwindcss";
@import "@fontsource/silkscreen/400.css";
@import "@fontsource/silkscreen/700.css";
@import "@fontsource/pixelify-sans/400.css";
@import "@fontsource/pixelify-sans/500.css";
@import "@fontsource/pixelify-sans/600.css";
@import "@fontsource/pixelify-sans/700.css";

@font-face {
  font-family: "Departure Mono";
  src: url("./assets/fonts/DepartureMono-Regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

Replace the two font tokens in `@theme` with:

```css
--font-sans: "Pixelify Sans", ui-sans-serif, sans-serif;
--font-mono: "Departure Mono", ui-monospace, monospace;
--font-display: "Silkscreen", "Pixelify Sans", ui-sans-serif, sans-serif;
--ease-pixel-2: steps(2, end);
--ease-pixel-3: steps(3, end);
--ease-pixel-4: steps(4, end);
```

- [ ] **Step 4: Add the type scale utilities** (below the existing `@utility` blocks)

```css
/* The type scale. Sizes sit on each face's design grid: Silkscreen 16/24,
   Departure Mono 11/22, Pixelify >= 12. Never introduce fractional sizes. */
@layer components {
  .text-pixel-display {
    font-family: var(--font-display);
    font-size: 1.5rem; /* 24px, multiple of 8 */
    line-height: 2rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
  }
  .text-pixel-title {
    font-family: var(--font-display);
    font-size: 1rem; /* 16px */
    line-height: 1.5rem;
    letter-spacing: 0.04em;
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
  }
  .text-pixel-label {
    font-family: var(--font-sans);
    font-size: 0.75rem; /* 12px */
    line-height: 1rem;
  }
  .text-pixel-body {
    font-family: var(--font-sans);
    font-size: 1rem; /* 16px */
    line-height: 1.5rem;
  }
  .text-pixel-mono {
    font-family: var(--font-mono);
    font-size: 0.6875rem; /* 11px */
    line-height: 1rem;
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
  }
}
```

Also change the `body` rule's `font-family: var(--font-sans);` to stay as-is (it now resolves to Pixelify Sans) and add `-webkit-font-smoothing: none;` after it.

- [ ] **Step 5: Verify in the browser**

Run: `pnpm --filter @pixelaition/web dev` (or the running `pnpm dev`), open the editor.
Expected: chrome renders in Pixelify/Departure; DevTools → Computed → `font-family` shows the new faces; no layout break. Zoom to 200% — text stays crisp, not fuzzy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/assets apps/web/src/styles.css
git commit -m "feat(web): add the pixel type system with vendored Departure Mono"
```

### Task 2: Sweep the app onto the type scale

**Files:**

- Modify: `apps/web/src/components/ui.tsx`, `editor-toolbar.tsx`, `editor-panels.tsx`, `run-console.tsx`, `composer.tsx`, `export-dialog.tsx`, `pixel-canvas.tsx`, `screens/editor.tsx`, `screens/projects.tsx`, `screens/auth.tsx`

**Interfaces:**

- Consumes: `.text-pixel-*` from Task 1.

- [ ] **Step 1: Apply the mapping table**

| Current                                                                               | Replace with                                                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `font-mono text-[10px]` / `text-[11px]` (labels, counts, chips)                       | `text-pixel-mono` (11px; drop the size class)                                             |
| `font-mono text-[10px] tracking-[0.16em] uppercase`                                   | `text-pixel-mono tracking-[0.16em] uppercase`                                             |
| Page/dialog/sheet titles (`text-[12px] tracking-[0.16em] text-accent uppercase` etc.) | `text-pixel-title text-accent`                                                            |
| The `PIXELAITION` wordmark in `editor.tsx` header                                     | `text-pixel-display`                                                                      |
| Plain 12–14px text (`text-xs`, `text-[13px]`, `text-sm`)                              | leave size; it now renders Pixelify via the base font — only fix any `font-mono` on prose |
| Long-form paragraphs (composer placeholder is fine; agent markdown)                   | `text-pixel-body` (16px)                                                                  |

Grep to find every site:

```bash
rg -n "font-mono|text-\[10px\]|text-\[11px\]|tracking-\[0.16em\]" apps/web/src
```

- [ ] **Step 2: Verify the sweep**

Browser pass over auth → home → editor → dialog/sheet/toast/menu.
Expected: every mono label is Departure Mono at 11px; titles are Silkscreen; body is Pixelify; **long frame names still truncate** (resize a frame name to 40 chars and check rows and the frame sheet); no clipped ascenders/descenders.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): sweep every surface onto the pixel type scale"
```

### Task 3: Crispness, fallbacks, and the IBM Plex removal

**Files:**

- Modify: `apps/web/src/styles.css`, `apps/web/package.json`

- [ ] **Step 1: Remove the IBM Plex imports and packages**

```bash
pnpm --filter @pixelaition/web remove @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono
```

Delete the `@import "@fontsource/ibm-plex-*"` lines. Confirm nothing references them:

```bash
rg -n "IBM Plex|ibm-plex" apps/web/src apps/web/package.json
```

Expected: no matches.

- [ ] **Step 2: Verify crispness and fallbacks**

In the browser: block the custom fonts (DevTools → Network → block `DepartureMono-Regular.woff2`) and reload; the UI falls back to `ui-sans-serif`/`ui-monospace` without layout break. Then unblock; at 100% and 200% zoom the faces are crisp.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles.css apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): drop IBM Plex and lock the pixel fallbacks"
```

## Phase 2 — Component primitives

### Task 4: Pixel utilities in `styles.css`

**Files:**

- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Produces: `shadow-pixel-sm/md/lg`, `bevel`, `bevel-in`, `pixel-window` (+ `pixel-window-bar`), `dither-sm`, `dither-md` classes used by every component task below.

- [ ] **Step 1: Add the utilities** (after the existing `@utility` blocks)

```css
/* Hard offset shadows: no blur, ever. */
@utility shadow-pixel-sm {
  box-shadow: 2px 2px 0 0 var(--color-navy);
}
@utility shadow-pixel-md {
  box-shadow: 3px 3px 0 0 var(--color-navy);
}
@utility shadow-pixel-lg {
  box-shadow: 4px 4px 0 0 var(--color-navy);
}

/* 2px inset bevels for raised and sunken surfaces. */
@utility bevel {
  box-shadow:
    inset 2px 2px 0 0 rgba(244, 244, 244, 0.08),
    inset -2px -2px 0 0 rgba(26, 28, 44, 0.45);
}
@utility bevel-in {
  box-shadow:
    inset 2px 2px 0 0 rgba(26, 28, 44, 0.55),
    inset -2px -2px 0 0 rgba(244, 244, 244, 0.05);
}

/* A stepped 2px frame that stays sharp at any size (9-slice). */
@utility pixel-window {
  border: 6px solid transparent;
  border-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cg fill='%2394b0c2' fill-opacity='0.55'%3E%3Crect x='2' y='0' width='20' height='2'/%3E%3Crect x='2' y='22' width='20' height='2'/%3E%3Crect x='0' y='2' width='2' height='20'/%3E%3Crect x='22' y='2' width='2' height='20'/%3E%3Crect x='2' y='2' width='2' height='2'/%3E%3Crect x='20' y='2' width='2' height='2'/%3E%3Crect x='2' y='20' width='2' height='2'/%3E%3Crect x='20' y='20' width='2' height='2'/%3E%3C/g%3E%3C/svg%3E")
    6 fill / 6px / 0 stretch;
}

/* Checker dithers for hero and empty-state surfaces. */
@utility dither-sm {
  background-image: conic-gradient(
    from 0deg,
    rgba(148, 176, 194, 0.1) 25%,
    transparent 0 50%,
    rgba(148, 176, 194, 0.1) 0 75%,
    transparent 0
  );
  background-size: 4px 4px;
}
@utility dither-md {
  background-image: conic-gradient(
    from 0deg,
    rgba(148, 176, 194, 0.08) 25%,
    transparent 0 50%,
    rgba(148, 176, 194, 0.08) 0 75%,
    transparent 0
  );
  background-size: 8px 8px;
}
```

- [ ] **Step 2: Verify in isolation**

Temporarily add `pixel-window bevel` to the `ViewPanel` section in the editor right rail, screenshot it, then revert. Expected: 2px frame with stepped corners, crisp at 100%/200%; `dither-sm` reads as a 2px checker.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): add pixel shadow, bevel, window, and dither utilities"
```

### Task 5: Button and IconButton

**Files:**

- Modify: `apps/web/src/components/ui.tsx` (Button root class, IconButton root class)

**Interfaces:**

- Consumes: `shadow-pixel-sm`, `ease-pixel-2` (Task 1).
- Produces: pressed-state behaviour every later component copies: `active:translate-x-[2px] active:translate-y-[2px] active:shadow-none`.

- [ ] **Step 1: Apply the classes**

On the `Button` root element's className, add:

```
shadow-pixel-sm transition-[transform,box-shadow,background-color,border-color] duration-150
active:translate-x-[2px] active:translate-y-[2px] active:shadow-none
```

On `IconButton`'s `motion.button` className, add the same three groups. Keep the existing `press` helper; the CSS active state is the visible "press" and the helper remains for pointer feedback.

- [ ] **Step 2: Verify states**

In the browser: primary (Generate), danger (Delete in the confirm dialog), ghost, quiet, and an icon button. Expected: 3px hard shadow at rest; pressed state drops 2px with the shadow gone; disabled keeps opacity-40 and no shadow change; focus ring unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui.tsx
git commit -m "feat(web): give buttons a hard shadow and a real pressed state"
```

### Task 6: Inputs, checkboxes, radios, chips, slider, progress

**Files:**

- Modify: `apps/web/src/components/ui.tsx` (`well`, `TextInput`, `Textarea`, `Checkbox`, `SelectControl`, chip buttons, hue-strip thumb), `apps/web/src/styles.css` (hue-strip thumb)

- [ ] **Step 1: Sunken inputs**

In the `well` const, replace `border-2 bg-field` with `border-2 bevel-in bg-field` and keep the focus border accent. Apply the same to `Textarea`'s root.

- [ ] **Step 2: Pixel checkbox glyph**

Replace the lucide `Check` inside `Checkbox` with a drawn glyph:

```tsx
<svg viewBox="0 0 8 8" width={12} height={12} shapeRendering="crispEdges" aria-hidden>
  <path d="M1 4h1v1h1v1h1V5h1V4h1V3h1V2H6v1H5v1H4V3H3v1H2v1H1z" fill="currentColor" />
</svg>
```

The box keeps `h-[18px] w-[18px] border-2`; unchecked adds `bevel-in`, checked stays `border-accent bg-accent text-navy`.

- [ ] **Step 3: Radio + slider knob + progress**

- If a radio primitive exists (Base UI), mirror the checkbox glyph with a 4×4 center block. If it does not exist yet, skip — no new radio is introduced here.
- Hue strip thumb in `styles.css`: `width: 10px; height: 14px; border: 2px solid var(--color-paper); box-shadow: 2px 2px 0 0 var(--color-navy);` (square knob).
- Progress bars (palette `used/max` bar if present, run chip): render as cells — a flex row of `w-1.5 h-3` blocks with `gap-px`, filled blocks `bg-accent`, empty `bg-raised`; one block per unit capped at 33.

- [ ] **Step 4: Verify**

Browser: focus a textarea (sunken well + accent border), toggle a checkbox (glyph crisp), drag the hue strip (square knob), inspect the palette usage bar. Expected: no layout shift vs before; 16px input font preserved.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui.tsx apps/web/src/styles.css
git commit -m "feat(web): pixel inputs, checkbox glyph, knob, and cell progress"
```

### Task 7: Menus, popovers, dialogs, sheets, toasts, tooltips

**Files:**

- Modify: `apps/web/src/components/ui.tsx` (`Menu` popup, `Popover` popup, `Dialog`/`ConfirmDialog` popup, `Tooltip` popup), `apps/web/src/styles.css` (keyframes timing)

- [ ] **Step 1: Pixel-window surfaces**

Add `pixel-window` to the popup class of `Menu`, `Popover`, and `Tooltip` (replacing their `border-2 border-line-strong` with `bg-raised pixel-window` — the frame supplies the 2px line). For `Dialog` and `ConfirmDialog`, keep `bg-raised` and add `pixel-window`; give the dialog title row the existing `border-b-2 border-line` plus `text-pixel-title`.

- [ ] **Step 2: Stepped motion**

In `styles.css`, change the animation timings:

```css
.dialog-popup {
  animation: overlay-enter 160ms steps(3, end);
}
.sheet-popup {
  animation: var(--sheet-enter) 200ms steps(4, end);
}
.toast-popup {
  animation: sheet-enter-right 200ms steps(4, end);
  transition: opacity 160ms steps(2, end);
}
```

- [ ] **Step 3: Verify**

Browser: open a menu (⋯ in frames), a popover (palette +), a dialog (export), a sheet (☰), a toast (rename a frame), a tooltip (hover Generate). Expected: stepped, chunky frames; **no overlap** with neighbouring controls (the composer stack and the zoom cluster are the tight spots); with `prefers-reduced-motion: reduce` (DevTools → Rendering) every open/close is instant.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui.tsx apps/web/src/styles.css
git commit -m "feat(web): pixel windows and stepped motion for overlays"
```

### Task 8: Loader sprite, scrollbars, focus

**Files:**

- Create: `apps/web/src/components/pixel-loader.tsx`
- Modify: `apps/web/src/styles.css` (scrollbar base rules), `apps/web/src/screens/editor.tsx` (run chip uses the loader)

**Interfaces:**

- Produces: `<PixelLoader size?: 12 | 16 />` — a 3-frame sprite spinner for pending states (used by the run chip here, by console rows in Part II).

- [ ] **Step 1: The loader**

```tsx
/** A three-frame pixel spinner. Frame swaps via background-position + steps(3). */
export function PixelLoader({ size = 12 }: { size?: 12 | 16 }) {
  return (
    <span
      aria-hidden
      className="pixel-loader inline-block shrink-0"
      style={{ width: size, height: size, backgroundSize: `${size}px ${size * 3}px` }}
    />
  );
}
```

Add to `styles.css`:

```css
.pixel-loader {
  image-rendering: pixelated;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='36'%3E%3Cg fill='%23a7f070'%3E%3Crect x='5' y='0' width='2' height='2'/%3E%3Crect x='8' y='2' width='2' height='2'/%3E%3Crect x='10' y='5' width='2' height='2'/%3E%3Crect x='8' y='8' width='2' height='2'/%3E%3Crect x='5' y='10' width='2' height='2'/%3E%3Crect x='2' y='8' width='2' height='2'/%3E%3Crect x='0' y='5' width='2' height='2'/%3E%3Crect x='2' y='2' width='2' height='2'/%3E%3Crect x='4' y='13' width='4' height='4'/%3E%3Crect x='7' y='16' width='3' height='3'/%3E%3Crect x='5' y='19' width='2' height='2'/%3E%3Crect x='2' y='21' width='4' height='4'/%3E%3Crect x='0' y='30' width='12' height='2'/%3E%3Crect x='0' y='34' width='12' height='2'/%3E%3Crect x='3' y='32' width='6' height='2'/%3E%3C/g%3E%3C/svg%3E");
  background-repeat: no-repeat;
  animation: pixel-loader 600ms steps(3, end) infinite;
}
@keyframes pixel-loader {
  from {
    background-position-y: 0;
  }
  to {
    background-position-y: -36px;
  }
}
```

- [ ] **Step 2: Run chip uses it** — in `editor.tsx`'s header run chip, replace the pulsing dot span with `<PixelLoader size={12} />` when a run is active.

- [ ] **Step 3: Scrollbars** — in the `@layer base` scrollbar rules, keep the 8px width; add to the thumb: `border: 2px solid var(--color-paper); box-shadow: inset 2px 2px 0 0 rgba(244,244,244,0.08);` so the thumb reads beveled.

- [ ] **Step 4: Verify** — start a run (or a fake pending state via DevTools pause) and confirm the spinner steps 3 frames; scroll the left rail; check the thumb.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/pixel-loader.tsx apps/web/src/styles.css apps/web/src/screens/editor.tsx
git commit -m "feat(web): pixel loader sprite and beveled scrollbars"
```

## Phase 3 — Iconography

### Task 9: Install pixelarticons and build the icon module

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/components/pixel-icons.tsx`

**Interfaces:**

- Produces: named icon components (`Pencil`, `Eraser`, `Fill`, `Picker`, `Line`, `Square`, `Select`, `Hand`, `Plus`, `Trash`, `Copy`, `Play`, `Stop`, `Eye`, `Folder`, `Clipboard`, `Flip`, `Wrench`, `Brain`, `Check`, `Close`, `Grid`, `Layers`, `Transparency`, `Export`, `Menu`, `PanelLeft`, `Send`) rendered at 24×24 with `shapeRendering="crispEdges"` and `fill="currentColor"`. Later tasks import from this module only.

- [ ] **Step 1: Install and audit the real export names**

```bash
pnpm --filter @pixelaition/web add pixelarticons
cd apps/web && node --input-type=module -e "import('pixelarticons/react').then(m => console.log(Object.keys(m).sort().join('\n')))" | head -80
```

Record the audit output as a comment table at the top of `pixel-icons.tsx` (lucide name → pixelarticons name or `custom`). Do not guess names — the audit is the source of truth. Expected: pixelarticons exports PascalCase React components on a 24×24 grid.

- [ ] **Step 2: The module**

```tsx
import {
  Pencil as RawPencil,
  // ...the audited names for every icon the app needs
} from "pixelarticons/react";
import type { ComponentType, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Pixelarticons are 24x24; crispEdges keeps every edge on the grid. */
function crisp(Component: ComponentType<IconProps>) {
  return function CrispIcon(props: IconProps) {
    return <Component width={24} height={24} shapeRendering="crispEdges" {...props} />;
  };
}

export const Pencil = crisp(RawPencil);
// ...one export per icon
```

Icons missing from the free set follow Task 10's custom pattern.

- [ ] **Step 3: Verify tree-shaking and rendering**

Render one icon in the editor toolbar (temporarily swap the pencil tool) and check: 24×24, crisp at 100%/200%, `currentColor` follows the button state (accent when active), contrast on `raised`/`field` ≥ 4.5:1.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/pixel-icons.tsx
git commit -m "feat(web): add the pixelarticons module with a crisp wrapper"
```

### Task 10: Custom grid icons where the free set has no match

**Files:**

- Modify: `apps/web/src/components/pixel-icons.tsx`

**Interfaces:**

- Produces: any remaining icon the audit marked `custom`, drawn as rect grids (the `PixelDot` pattern from `editor-toolbar.tsx`).

- [ ] **Step 1: Draw the missing icons**

Use the established pattern — a `viewBox="0 0 16 16"` SVG of `<rect width="1" height="1">` cells on a 16 grid, `fill="currentColor"`, `shapeRendering="crispEdges"`:

```tsx
export function CustomOnion(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      shapeRendering="crispEdges"
      aria-hidden
      {...props}
    >
      <rect x="3" y="3" width="10" height="10" fill="currentColor" opacity="0.35" />
      <rect x="5" y="5" width="6" height="6" fill="currentColor" opacity="0.65" />
      <rect x="7" y="7" width="2" height="2" fill="currentColor" />
    </svg>
  );
}
```

- [ ] **Step 2: Verify** — each custom icon at 100%/200%, contrast ≥ 4.5:1, visually consistent with the pixelarticons next to it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/pixel-icons.tsx
git commit -m "feat(web): draw the missing icons on the pixel grid"
```

### Task 11: Swap every usage and remove lucide

**Files:**

- Modify: `apps/web/src/components/ui.tsx`, `editor-toolbar.tsx`, `editor-panels.tsx`, `run-console.tsx`, `composer.tsx`, `export-dialog.tsx`, `editor.tsx`, `screens/projects.tsx`, `screens/auth.tsx`, `package.json`

- [ ] **Step 1: Swap the imports**

For each file, replace `from "lucide-react"` with `from "./pixel-icons.js"` (or `../components/pixel-icons.js`) and rename usages per the audit table. Keep every `aria-label`, `label` prop, and box size; icon components accept `size`/`strokeWidth` props today — pixel icons take `width`/`height` instead, so drop `strokeWidth` and pass `width={24}` (or the existing size where the layout needs 16/20 — but prefer 24 and shrink the box only if the layout demands it).

- [ ] **Step 2: Remove lucide**

```bash
pnpm --filter @pixelaition/web remove lucide-react
rg -n "lucide" apps/web/src apps/web/package.json
```

Expected: no matches.

- [ ] **Step 3: Verify hit areas and names**

Browser: toolbar (8 tools), frame/layer rows (pencil, ⋯), play, panel add buttons, console rows, dialogs, sheets.
Expected: identical `aria-label`s; 36/28/24 boxes unchanged; no icon overflow at 200% zoom; console tool rows still map (run-activity tests green).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): swap every icon to the pixel set and drop lucide"
```

## Phase 4 — Atmosphere & pages

### Task 12: Shared atmosphere — dithers, wordmark mark, empty states

**Files:**

- Modify: `apps/web/src/components/ui.tsx` (`EmptyState`), `screens/projects.tsx`, `screens/auth.tsx`, `screens/editor.tsx`

- [ ] **Step 1: Empty states get the dither**

`EmptyState`'s root: add `dither-sm` under the existing surface classes. The editor's "no activity yet" console bar keeps its look; only page-level empty states (projects list, auth) take the dither.

- [ ] **Step 2: The wordmark mark**

In the editor header and the auth card, prefix `PIXELAITION` with a small pixel glyph:

```tsx
<svg
  viewBox="0 0 16 16"
  width={16}
  height={16}
  shapeRendering="crispEdges"
  aria-hidden
  className="text-accent"
>
  <rect x="1" y="1" width="6" height="6" fill="currentColor" />
  <rect x="9" y="1" width="6" height="6" fill="currentColor" opacity="0.5" />
  <rect x="1" y="9" width="6" height="6" fill="currentColor" opacity="0.5" />
  <rect x="9" y="9" width="6" height="6" fill="currentColor" />
</svg>
```

- [ ] **Step 3: Verify** — dither reads as texture, not noise; the mark is crisp; no contrast change for text on dithered surfaces (text sits on solid boxes).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): dither empty states and mark the wordmark"
```

### Task 13: Auth page

**Files:**

- Modify: `apps/web/src/screens/auth.tsx`

- [ ] **Step 1: Pixel-window card** — the auth form card root gets `pixel-window bg-raised` (replacing `border-2 border-line-strong`); the title becomes `text-pixel-title text-accent`; the submit button inherits Task 5's pressed state; focus order unchanged.

- [ ] **Step 2: Verify** — login and register flows both render the window frame; tab order unchanged; error text stays readable (≥ 12px Pixelify, contrast checked).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/screens/auth.tsx
git commit -m "feat(web): pixel window auth cards"
```

### Task 14: Home (projects) page

**Files:**

- Modify: `apps/web/src/screens/projects.tsx`

- [ ] **Step 1: Cards become windows with a hover lift**

Project/asset cards: add `shadow-pixel-md pixel-window bg-raised transition-transform duration-150 hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-pixel-lg`; counts and dates switch to `text-pixel-mono`; the page header uses `text-pixel-display`.

- [ ] **Step 2: Verify** — hover lift on every card; **a 60-character project name truncates** (create one via API or rename an existing project) without pushing the layout; grid gap unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/screens/projects.tsx
git commit -m "feat(web): pixel window project cards with a hover lift"
```

### Task 15: Editor chrome details

**Files:**

- Modify: `apps/web/src/styles.css`, `apps/web/src/components/pixel-canvas.tsx`, `apps/web/src/components/run-console.tsx`

- [ ] **Step 1: Pixel crosshair cursor**

Add to `styles.css`:

```css
.cursor-pixel-cross {
  cursor:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Cg fill='%23f4f4f4'%3E%3Crect x='7' y='1' width='2' height='6'/%3E%3Crect x='7' y='9' width='2' height='6'/%3E%3Crect x='1' y='7' width='6' height='2'/%3E%3Crect x='9' y='7' width='6' height='2'/%3E%3C/g%3E%3C/svg%3E")
      8 8,
    crosshair;
}
```

Apply it to the canvas viewport when the active tool paints (`pencil`, `eraser`, `fill`, `picker`, `line`, `rect`); keep `grab`/`grabbing` for `pan` and the default for `select`.

- [ ] **Step 2: Console typography check** — run console rows and summaries already inherit `text-pixel-mono` from the Task 2 sweep; verify tool summaries (`paint_stroke · 32 px`) and durations render in Departure Mono at 11px, and that `restoredMs`/`formatDuration` output does not wrap.

- [ ] **Step 3: Verify** — move the cursor over the canvas with pencil vs pan; console rows crisp; zoom readout (`1600%`), palette hex, and coordinates in Departure Mono.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): pixel crosshair cursor and mono console details"
```

## Phase 5 — Audit, accessibility & documentation

### Task 16: Full audit, micro-label decision, cleanup, docs

**Files:**

- Modify: `apps/web/src/styles.css` (+ any file the audit flags), `DESIGN.md`, `AGENTS.md`

- [ ] **Step 1: Contrast audit** — for each pair used in the new surfaces (`ink` on `panel`/`raised`/`field`, `muted` on `panel`, `accent` on `raised`, `navy` on `accent`, coral danger text), check ≥ 4.5:1 for text. Fix by changing the token usage (never by inventing a colour). List the checked pairs in the commit body.

- [ ] **Step 2: Zoom / motion / keyboard** — 200% zoom across auth/home/editor: no clipping, no horizontal scroll. `prefers-reduced-motion`: dialogs/sheets/toasts/loader are instant/static. Keyboard: Tab reaches every control; focus rings visible on pixel windows.

- [ ] **Step 3: Micro-label decision** — screenshot the frame panel header in Silkscreen 16px vs Pixelify 12px; pick one (spec open question 6) and apply it to every panel header; note the choice in `DESIGN.md`.

- [ ] **Step 4: Cleanup** — `rg -n "IBM Plex|font-mono text-\[1[01]px\]|lucide|border-2 border-line-strong" apps/web/src` → remove stale matches; delete orphaned CSS.

- [ ] **Step 5: Docs** — update `DESIGN.md`: typography section (three faces + grids + crispness rules), components section (shadows/bevels/windows/steps), iconography (pixelarticons + custom pattern). Update `AGENTS.md`'s interface-colour line to mention the type scale and pixel utilities.

- [ ] **Step 6: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): audit the pixel theme and write the rules down"
```

# Part II — Agent Capabilities

## Phase 6 — Observation & foundation

### Task 17: RLE row encoding

**Files:**

- Create: `packages/agent/src/format.ts`
- Test: `packages/agent/src/format.test.ts`

**Interfaces:**

- Produces: `encodeRowsRle(pixels: Uint8Array, width: number, height: number): string[]` — one string per row, runs as `<color>x<count>` separated by single spaces (`"0x5 3x10 0x17"`). Consumed by Task 18's read tools.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { encodeRowsRle } from "./format.js";

describe("encodeRowsRle", () => {
  it("encodes runs per row with unambiguous separators", () => {
    const pixels = new Uint8Array([0, 0, 0, 1, 1, 2, 10, 10, 3]);
    expect(encodeRowsRle(pixels, 3, 3)).toEqual(["0x3", "1x2 2x1", "10x2 3x1"]);
  });

  it("keeps palette indexes >= 10 readable", () => {
    const pixels = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(encodeRowsRle(pixels, 16, 1)).toEqual([
      "1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1",
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @pixelaition/agent test -- format`
Expected: FAIL — `encodeRowsRle` is not exported.

- [ ] **Step 3: Implement**

```ts
/** One RLE string per row: `<color>x<count>` runs joined by spaces. */
export function encodeRowsRle(
  pixels: Uint8Array,
  width: number,
  height: number,
): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const runs: string[] = [];
    let color = -1;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x] ?? 0;
      if (value === color) {
        count += 1;
        continue;
      }
      if (count > 0) runs.push(`${color}x${count}`);
      color = value;
      count = 1;
    }
    if (count > 0) runs.push(`${color}x${count}`);
    rows.push(runs.join(" "));
  }
  return rows;
}
```

- [ ] **Step 4: Pass and commit**

Run: `pnpm --filter @pixelaition/agent test -- format` → PASS.

```bash
git add packages/agent/src/format.ts packages/agent/src/format.test.ts
git commit -m "feat(agent): encode frame rows as unambiguous RLE"
```

### Task 18: Read tools — project, frame (RLE, per-layer, composite), region

**Files:**

- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts` (recovery map)
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Consumes: `encodeRowsRle` (Task 17), `composite` from `@pixelaition/pixel`, `bindRun`/`requireRun` from `./runs.js`.
- Produces: `read_project` returning `frames`/`currentFrame`; `read_frame` with `{ frameId?, layerId?, view? }`; `read_region` with `{ frameId?, x, y, width, height, view? }`. All later tools assume `read_project.frames`.

- [ ] **Step 1: Failing tests** (new file; fixture binds a run with a 4×4, 2-layer buffer and a palette of 12 colors)

```ts
import { createBuffer } from "@pixelaition/pixel";
import { describe, expect, it } from "vitest";
import { bindRun, releaseRun } from "./runs.js";
import { createPixelTools } from "./tools.js";

function boundRun() {
  const buffer = createBuffer({
    width: 4,
    height: 4,
    palette: [
      "#00000000",
      "#f4f4f4",
      "#ef7d57",
      "#a7f070",
      "#38b764",
      "#566c86",
      "#94b0c2",
      "#333c57",
      "#257179",
      "#29366f",
      "#3b5dc9",
      "#41a6f6",
    ],
  });
  bindRun("run-1", {
    assetId: "asset-1",
    frameId: "frame-1",
    style: { outline: "#f4f4f4", maxColors: 12 } as never,
    buffer,
    strokes: [],
    issues: [],
  });
  return buffer;
}

describe("read tools", () => {
  it("read_project lists frames and the current frame", async () => {
    boundRun();
    const tools = createPixelTools();
    const project = tools.find((t) => t.name === "read_project");
    const result = await project!.execute({}, { operationId: "run-1" } as never);
    expect(result).toMatchObject({ assetId: "asset-1", currentFrame: { id: "frame-1" } });
    releaseRun("run-1");
  });

  it("read_region rejects out-of-bounds rectangles", async () => {
    boundRun();
    const tools = createPixelTools();
    const region = tools.find((t) => t.name === "read_region");
    await expect(
      region!.execute({ x: 3, y: 3, width: 4, height: 4 }, {
        operationId: "run-1",
      } as never),
    ).rejects.toThrow(/outside/);
    releaseRun("run-1");
  });
});
```

- [ ] **Step 2: Run and fail** — `pnpm --filter @pixelaition/agent test -- tools` → FAIL.

- [ ] **Step 3: Implement the three tools in `tools.ts`**

- `read_project`: add `frames: [{ id, name, index }]` and `currentFrame` to the binding (`RunBinding` in `runs.ts` gains `frames: Array<{ id: string; name: string }>` — filled by the worker in Task 21; until then default to the single bound frame) and return them plus the palette legend `[{ index, hex }]`.
- `read_frame`: `view` defaults to `"composite"` (uses `composite(run.buffer)`), `layerId` reads one layer; rows via `encodeRowsRle`; `colors: [{ index, hex, count }]` computed from the read pixels.
- `read_region`: bounds-check (`x < 0 || y < 0 || x + width > buffer.width || y + height > buffer.height` → throw `That region is outside the frame.`), slice, encode.

Update `pixelInstructions`: "Read before painting; use read_region for detail; rows are RLE (`colorxcount`)." Add `read_region: "safe"` to `toolRecovery()` in the worker.

- [ ] **Step 4: Pass and commit**

```bash
pnpm --filter @pixelaition/agent test -- tools
git add packages/agent/src packages/agent/src/tools.test.ts apps/worker/src/index.ts
git commit -m "feat(agent): honest read tools with RLE rows and regions"
```

### Task 19: Vision spike, `models.vision`, and `preview_frame`

**Files:**

- Modify: `packages/db/src/schema.ts` (+ generated `packages/db/drizzle/0004_models_vision.sql`), `packages/agent/src/models.ts`, `packages/agent/src/tools.ts`, `apps/worker/src/index.ts`
- Create: `apps/worker/scripts/vision-spike.ts` (throwaway, deleted after the spike)

**Interfaces:**

- Consumes: `frameToPng` from `@pixelaition/export` (add `@pixelaition/export` as a dependency of `@pixelaition/agent`), `ToolOutput` from the Anvia tool module.
- Produces: `preview_frame({ frameId?, mode?, scale? })` registered only when `spec.vision` is true.

- [ ] **Step 1: Run the spike (no code kept)**

Write a small tsx script that sends a 64×64 PNG (data URL, generated by `frameToPng` from a sample buffer) to each catalog model through OpenCode Go with the prompt "What is in this image?", run it with `pnpm exec dotenv -e .env -- pnpm --filter @pixelaition/worker exec tsx scripts/vision-spike.ts`, and record which models answer about the image vs error. Delete the script.

- [ ] **Step 2: Migration 0004**

Add `vision: boolean("vision").notNull().default(false)` to `models` in `packages/db/src/schema.ts`; run `pnpm --filter @pixelaition/db generate` → `0004_models_vision.sql`; `pnpm db:migrate`. Seed `true` only for models the spike verified: add an `UPDATE` to the migration SQL by hand (the generated file allows edits) or a follow-up statement in the migration.

- [ ] **Step 3: `preview_frame`**

First confirm the exact import path for `ToolOutput`:

```bash
cd apps/web/../.. && node -p "Object.keys(require('@anvia/core/package.json').exports).filter(k => k.includes('tool')).join('\n')"
```

Implement in `tools.ts`:

```ts
const preview = createTool({
  name: "preview_frame",
  description:
    "Render the frame (or every frame as one strip) to a PNG you can see. Use it to verify your work before finishing.",
  inputSchema: z.object({
    frameId: z.string().optional(),
    mode: z.enum(["frame", "strip"]).default("frame"),
    scale: z.number().int().min(1).max(10).default(4),
  }),
  execute: (input, context) => {
    const run = requireRun(context.operationId);
    // frame: frameToPng(buffer, scale); strip: compose all frames side by side first.
    // Return ToolOutput.content([{ type: "text", value: "…" }, { type: "image", image: pngBytes, mediaType: "image/png" }]).
  },
});
```

Register it in the returned array only when the factory receives `{ vision: true }`; `apps/worker` builds agents per spec, so pass `vision: spec.vision` (extend `parseModelSpecRow` in `models.ts` and `ModelSpec`).

- [ ] **Step 4: Verify** — with a vision-capable model (if any): run the agent on ux-check and watch it call `preview_frame` and describe the sprite; otherwise confirm the tool is absent from `/internal/agents`-driven runs and the filmstrip fallback data stays. Add `preview_frame: "safe"` to `toolRecovery()`.

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/agent apps/worker
git commit -m "feat(agent): vision-gated frame preview"
```

### Task 20: Console rows for the new reads

**Files:**

- Modify: `apps/web/src/lib/run-activity.ts` (+ `run-activity.test.ts`), `apps/web/src/components/run-console.tsx`

**Interfaces:**

- Consumes: `toolIcons` map in `run-console.tsx`.
- Produces: row summaries for `read_region` (`w×h`), `preview_frame` (`frame`/`strip`), `read_project`.

- [ ] **Step 1: Failing test**

```ts
it("summarizes the observation tools", () => {
  const rows = applyRunEvent([], 1, "tool_started", {
    input: {
      toolCall: { toolName: "read_region", input: { x: 0, y: 0, width: 8, height: 8 } },
    },
  });
  expect(rows[0]).toMatchObject({ kind: "tool", name: "read_region", summary: "8×8" });
});
```

- [ ] **Step 2: Implement** — extend `toolSummary` with `read_region` → `${width}×${height}`, `preview_frame` → `mode`, and add icons in `toolIcons` (pixel icons from Part I). Run: `pnpm --filter @pixelaition/web test -- run-activity` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib apps/web/src/components/run-console.tsx
git commit -m "feat(web): console rows for the observation tools"
```

## Phase 7 — Multi-frame work & animation continuity

### Task 21: Multi-frame run binding

**Files:**

- Modify: `packages/agent/src/runs.ts` (+ tests in `packages/agent/src/tools.test.ts`), `apps/worker/src/index.ts`

**Interfaces:**

- Produces: `RunBinding` = `{ assetId, originFrameId, currentFrameId, frames: Map<string, { name: string; buffer: FrameBuffer }>, palette: string[], width: number, height: number, style, approvedScope: Set<string>, strokes, issues, onStroke?: (stroke, buffer, frameId) => void }`; helper `frameBuffer(run, frameId?)` returning the current frame's buffer and throwing `Choose or create a frame first.` when missing. Every drawing tool uses it.

- [ ] **Step 1: Failing test**

```ts
it("paints on the frame named by the tool call", async () => {
  // bind two frames, use_frame to switch, paint_stroke with explicit frameId
  const paint = tools.find((t) => t.name === "paint_stroke");
  await paint!.execute(
    { layerId: "layer-a", label: "dot", points: [{ x: 1, y: 1, color: 2 }] },
    { operationId: "run-1" } as never,
  );
  const run = getRun("run-1")!;
  expect(run.frames.get("frame-2")!.buffer.layers[0]!.pixels[1 * 4 + 1]).toBe(2);
});
```

- [ ] **Step 2: Implement** — reshape `bindRun`/`RunBinding`; worker's `loadAsset` already returns every frame: build the map, `originFrameId = body.frameId`, `currentFrameId = originFrameId`. `paintStroke`/`fillRect`/`setPalette`/`mirror`/`critique` operate on `frameBuffer(run, input.frameId)`. `onStroke(stroke, buffer, frameId)`.

- [ ] **Step 3: Worker persists the edited frame**

```ts
onStroke: (_stroke, buffer, editedFrameId) => {
  publish(body.runId, "canvas-stroke", { frameId: editedFrameId, layers: /* buffer.layers */ });
  void db.update(frames)
    .set({ layers: bufferToFrame(buffer, { id: editedFrameId, name: "" }).layers, updatedAt: new Date() })
    .where(eq(frames.id, editedFrameId));
},
```

- [ ] **Step 4: Pass, verify live, commit** — run an agent that paints two frames; both persist; `canvas-stroke` carries the right `frameId`.

```bash
git add packages/agent apps/worker
git commit -m "feat(agent): bind every frame of the asset to the run"
```

### Task 22: Frame CRUD tools

**Files:**

- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts`
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Consumes: `frameBuffer`, `RunBinding` (Task 21); `addFrame`, `duplicateFrame`, `moveFrame` from `@pixelaition/pixel`; worker DB access for persistence.
- Produces: `use_frame`, `add_frame`, `rename_frame`, `move_frame`, `delete_frame` — each updates both the in-memory binding and the database (via a callback on the binding: `onFrameChange?: (change) => Promise<void>` set by the worker, mirroring `onStroke`).

- [ ] **Step 1: Failing tests** — `use_frame` switches `currentFrameId`; `add_frame` appends and joins `approvedScope`; `delete_frame` on the last frame replaces it (name `frame-1`).

- [ ] **Step 2: Implement** — thin handlers over the pixel functions; the worker callback persists (insert/update/delete rows exactly like `store.ts` does for the editor, reusing the same naming rules).

- [ ] **Step 3: Pass + live check** — the agent creates two frames in one run; the editor shows them live; refresh keeps them.

- [ ] **Step 4: Commit**

```bash
git add packages/agent apps/worker
git commit -m "feat(agent): frame CRUD tools with live persistence"
```

### Task 23: Lock all frames during a run

**Files:**

- Modify: `apps/web/src/screens/editor.tsx`, `apps/api/src/app.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: while any run is active for the asset, the editor blocks frame mutations and canvas edits on **every** frame; the API returns 409 `RUN_IN_PROGRESS` on every frame/asset mutation route.

- [ ] **Step 1: Editor** — set the editing lock to `running` (not only the run's frame); keep `runFrameId` for the `drawing` marker; guard `frameAction`, `frameReorder`, `updateAsset`, and `onAction` with the existing `running` state.

- [ ] **Step 2: API** — add a helper and call it in `POST/PATCH/DELETE /api/assets/:id/frames*`, `PUT /api/assets/:id/frames/:frameId`, and `PATCH /api/assets/:id`:

```ts
async function activeRunFor(assetId: string): Promise<boolean> {
  // join thread by asset, latest run status in ("queued","running","waiting")
}
```

Return `fail(res, 409, "RUN_IN_PROGRESS", "The agent is drawing on this asset right now.")`.

- [ ] **Step 3: Verify** — start a run; the frame/layer buttons, renames, deletes, reorder, and canvas all refuse; stop; everything works again. `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/editor.tsx apps/api/src/app.ts
git commit -m "feat: lock the whole asset while a run draws on it"
```

### Task 24: `check_animation`

**Files:**

- Create: `packages/pixel/src/animation.ts`, `packages/pixel/src/animation.test.ts`
- Modify: `packages/pixel/src/index.ts`, `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts`, `apps/web/src/lib/run-activity.ts`

**Interfaces:**

- Produces: `checkAnimation(frames: Array<{ id: string; buffer: FrameBuffer }>): { pairs: PairReport[]; loop: PairReport; flags: string[] }` where `PairReport = { from, to, changedPixels, diffBox: Rect | null, centroidShift, silhouetteDrift }`; tool `check_animation({ frameIds? })` returns it plus per-frame stats.

- [ ] **Step 1: Failing tests**

```ts
it("reports zero drift for identical frames", () => {
  const buffer = createBuffer({ width: 8, height: 8 });
  const report = checkAnimation([
    { id: "a", buffer },
    { id: "b", buffer: cloneBuffer(buffer) },
  ]);
  expect(report.pairs[0]).toMatchObject({ changedPixels: 0, centroidShift: 0 });
});

it("measures a one-pixel shift", () => {
  // paint (2,2) on frame a and (3,2) on frame b with color 1
  expect(report.pairs[0]!.centroidShift).toBeCloseTo(1, 5);
});
```

- [ ] **Step 2: Implement** — composite each buffer; opaque centroid = mean x/y over non-zero pixels; `silhouetteDrift` = max(|minX−minX'|, |maxX−maxX'|, …); `flags` when `centroidShift > 2`, `changedPixels === 0` between distinct frames, or the loop pair jumps more than any internal pair.

- [ ] **Step 3: Tool + instructions + console row** — `check_animation: "safe"`; instructions: "Before finishing animation work, call check_animation and fix flagged drift."; row summary `3 pairs · clean` / `2 flags`.

- [ ] **Step 4: Pass + live check** — muse-anim's idle/hop/land report sane drift; commit.

```bash
git add packages/pixel packages/agent apps/worker apps/web/src/lib
git commit -m "feat(agent): deterministic animation continuity checks"
```

## Phase 8 — Plan-first & rich human clarification

### Task 25: The `plan` tool and its console row

**Files:**

- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts`, `apps/web/src/lib/run-activity.ts` (+ test)

**Interfaces:**

- Produces: `plan({ steps: string[] })` → `{ steps }`, stored on the binding (`run.plan`); console row `plan · 4 steps`.

- [ ] **Step 1: Failing test** — `plan` returns the steps; a `tool_started` for `plan` maps to a tool row with summary `3 steps`.

- [ ] **Step 2: Implement** — tool + `plan: "safe"` recovery + instructions: "Write a plan for multi-step work before painting; for animation jobs propose frames in present_plan."

- [ ] **Step 3: Commit**

```bash
git add packages/agent apps/worker apps/web/src/lib
git commit -m "feat(agent): an explicit plan tool"
```

### Task 26: Durable interaction wiring

**Files:**

- Modify: `apps/worker/src/index.ts`, `apps/api/src/app.ts`
- Test: manual live (no unit harness for durable interactions)

**Interfaces:**

- Consumes: `snapshot.run.status === "waiting"` and `snapshot.run.outcome.interaction` (an `AgentInteractionOutcome`); `runtime.run(durableId).respond(interactionId, response)`.
- Produces: stream event `interaction` (`{ interactionId, type, toolName, questions? , input? }`); `generation_runs.status = "waiting"` + the sanitized interaction persisted in `events`; `POST /internal/runs/:id/respond`; `POST /api/runs/:id/respond`; `active-run` returns waiting runs.

- [ ] **Step 1: Worker `follow()`**

In the poll loop, before the terminal check:

```ts
const outcome = snapshot.run.outcome as
  { type?: string; interaction?: AgentInteractionRequest } | undefined;
if (
  snapshot.run.status === "waiting" &&
  outcome?.type === "interaction" &&
  outcome.interaction
) {
  const interaction = outcome.interaction;
  if (!publishedInteractions.has(interaction.id)) {
    publishedInteractions.add(interaction.id);
    publish(publicId, "interaction", sanitizeInteraction(interaction));
    await db
      .update(generationRuns)
      .set({
        status: "waiting",
        events: consoleEvents(publicId, interactionsFor(publicId)),
      })
      .where(eq(generationRuns.id, publicId));
  }
}
```

`sanitizeInteraction` keeps `{ id, type, toolName, questions?, input? }` (approval `input` is the tool args; question arrays pass through). Keep the interaction list in a module map so terminal persistence includes it.

- [ ] **Step 2: Respond endpoints**

Worker:

```ts
app.post("/internal/runs/:id/respond", async (req, res) => {
  if (!authorized(req)) return res.status(401).end();
  const body = z
    .object({ interactionId: z.string(), response: z.unknown() })
    .parse(req.body);
  const runtime = await runtimeOr503(res);
  if (!runtime) return;
  const [row] = await db
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, req.params.id ?? ""));
  if (!row?.durableRunId)
    return res.status(404).json({ message: "That run is not waiting." });
  await runtime
    .run(row.durableRunId)
    .respond(body.interactionId, parseAgentInteractionResponse(body.response));
  res.status(204).end();
});
```

API: ownership-checked `POST /api/runs/:id/respond` forwarding with the internal token; 409 when the run is not `waiting`.

- [ ] **Step 3: active-run + editor restore** — `active-run` treats `waiting` as active and returns the pending interaction from the stored events; the editor's mount check and the console restore path accept `waiting`.

- [ ] **Step 4: Live verification** — temporarily make `present_plan` the only tool and approve/reject from the console; refresh mid-waiting and confirm the card survives; restart the worker mid-waiting and confirm the interaction re-publishes.

- [ ] **Step 5: Commit**

```bash
git add apps/worker apps/api
git commit -m "feat: durable interactions between the run and the user"
```

### Task 27: `present_plan`, staged override, and dynamic approval

**Files:**

- Modify: `packages/db/src/schema.ts` (+ `0005_runs_override.sql`), `packages/agent/src/tools.ts`, `packages/agent/src/runs.ts`, `apps/worker/src/index.ts`
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Consumes: `requiresApproval` (dynamic function form), `generation_runs.override` jsonb (new column).
- Produces: `present_plan` (approval) returning `{ approved, plan, scope: string[] }`; drawing tools carry `requiresApproval: (args, ctx) => !run.approvedScope.has(args.frameId ?? run.currentFrameId)` when that frame is not the origin; `delete_frame` and `resize_canvas` always require approval.

- [ ] **Step 1: Migration 0005** — `override: jsonb("override")` on `generation_runs`; generate + migrate.

- [ ] **Step 2: Failing test** — the dynamic predicate: with `approvedScope = {frame-2}` and `originFrameId = frame-1`, painting frame-2 needs no approval, painting frame-3 does.

- [ ] **Step 3: Implement**

- `present_plan.execute`: read the staged override from the binding (`run.stagedOverride`, hydrated by the worker from `generation_runs.override` when it responds), validate its shape (`{ frames: [{ frameId?, name, description }] }`), set `run.approvedScope` (existing `frameId`s + later `add_frame` results), return the confirmed plan.
- Worker: when it publishes an interaction, also persist `override` when the API staged one; when it responds, hydrate `stagedOverride` into the binding before `respond` (a single SQL read at respond time).
- Dynamic approval predicate lives beside the tool factory, reading the current binding via the run id in `context.operationId`.

- [ ] **Step 4: Pass + live check** — the 4-frame hop flow: plan → card → edit scope (drop a frame) → run edits exactly the approved frames; painting an unapproved frame raises a second card; rejection stops that path.

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/agent apps/worker
git commit -m "feat(agent): plan approval with editable scope and dynamic gates"
```

### Task 28: The interaction card

**Files:**

- Create: `apps/web/src/components/interaction-card.tsx`
- Modify: `apps/web/src/components/run-console.tsx`, `apps/web/src/screens/editor.tsx`, `apps/web/src/lib/run-activity.ts` (+ test)

**Interfaces:**

- Consumes: the `interaction` stream event (Task 26), Part I primitives (`pixel-window`, `Button`, `Checkbox`), frame thumbs from `editor-panels.tsx`.
- Produces: `<InteractionCard interaction={…} frames={…} onRespond={(response) => …} />`; pending state restored after refresh; `run-activity` ignores `interaction` events for step rows (they render as a card, not a row).

- [ ] **Step 1: Failing test** — `applyRunEvent` leaves rows unchanged for `interaction`; the console exposes `pendingInteraction` from state.

- [ ] **Step 2: Implement the card**

- Approval type: title `Confirm the plan`, the summary, the frame list with thumbnails (join `input.frames` ids against the asset), a checkbox per frame (multi-select), an always-visible free-text field (`Add a note…`), `Continue` (sends `{type:"tool-approval", approved:true, reason: note}`) and `Cancel run` (sends `approved:false` + note as reason). Scope edits are staged through `POST /api/runs/:id/stage-override` before responding (same pattern as Task 26's respond route).
- Question type: each question renders radio choices (or checkboxes when the id ends in `_multi`, serialized as a JSON array string) plus the free-text field; `Continue` disabled until every question has an answer.
- The card renders above the composer inside the run console, in `pixel-window` surface, with stepped entry motion.

- [ ] **Step 3: Verify** — answer via mouse and keyboard (Enter submits, Escape focuses the composer); refresh restores the card; multi-select sends `["idle","land"]`; the run continues after answering.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): the interaction card for plans and questions"
```

## Phase 9 — Versioning

### Task 29: `versions` table and store creation rules

**Files:**

- Modify: `packages/db/src/schema.ts` (+ `0006_versions.sql`), `apps/api/src/store.ts`
- Test: `apps/api/src/store.test.ts` (new; use a mock `Database` shaped like the existing store tests — check `apps/api` for the established pattern first and mirror it)

**Interfaces:**

- Produces: `createVersion(db, { assetId, frameId?, scope, kind, author, runId?, label?, snapshot })`; `listVersions(db, assetId, { scope?, frameId?, limit, cursor })`; coalescing rule (same author+kind+frame within 120 s replaces the newest snapshot); prune rule (newest 200/asset, unlabeled first).

- [ ] **Step 1: Failing tests** — coalescing within the window; no coalescing across authors; prune keeps labeled entries.
- [ ] **Step 2: Implement** — schema + generated migration + store functions with `ORDER BY created_at DESC` paging by `(createdAt, id)`.
- [ ] **Step 3: Pass and commit**

```bash
git add packages/db apps/api/src/store.ts apps/api/src/store.test.ts
git commit -m "feat(api): version snapshots with coalescing and retention"
```

### Task 30: Version hooks, restore, and routes

**Files:**

- Modify: `apps/api/src/store.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`
- Test: `apps/api/src/store.test.ts`

**Interfaces:**

- Consumes: Task 29.
- Produces: versions written on `saveFrame` (user flush), run terminal (per touched frame — the worker writes directly), frame add/delete/move/rename, resize/palette/name, and restore; `GET/PATCH/POST` routes.

- [ ] **Step 1: Failing tests** — `restoreVersion` writes a new `restore` version and returns the asset; a restore while a run is active returns the `RUN_IN_PROGRESS` failure.
- [ ] **Step 2: Implement** — hooks in the store's existing mutation functions (they already load the before/after asset); worker terminal writes one `run` version per touched frame (it knows `binding.frames` keys); routes:

```
GET    /api/assets/:id/versions?scope=&frameId=&limit=&cursor=
PATCH  /api/assets/:id/versions/:versionId        { label }
POST   /api/assets/:id/versions/:versionId/restore
```

- [ ] **Step 3: Pass + live check** — draw, run the agent, restore the pre-run version; a new `restore` entry appears; the run link is intact.
- [ ] **Step 4: Commit**

```bash
git add apps/api apps/worker
git commit -m "feat(api): version hooks, restore, and routes"
```

### Task 31: History panel

**Files:**

- Create: `apps/web/src/lib/versions.ts`, `apps/web/src/lib/versions.test.ts`, `apps/web/src/components/history-panel.tsx`
- Modify: `apps/web/src/screens/editor.tsx` (right rail + sheet)

**Interfaces:**

- Produces: `toHistoryRows(versions)` mapping (author badge text, relative time, kind label); `<HistoryPanel assetId frameId onPreview onRestore />`.

- [ ] **Step 1: Failing test** — `toHistoryRows` maps agent runs to `Agent · <model>` when `runId` resolves and user edits to `You`.
- [ ] **Step 2: Implement** — panel with frame timeline (thumbnail from the snapshot via the existing thumb renderer), label edit (PATCH), restore with `ConfirmDialog`, preview overlay (onion diff vs current) in the canvas, asset tab grouping by run. Built on Part I primitives.
- [ ] **Step 3: Verify** — the timeline updates after a run; restore works from the panel; preview overlay renders; narrow screens use the sheet.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): the history panel with preview and restore"
```

## Phase 10 — Drawing primitives & quality

### Task 32: New pixel commands — `replaceColor`, `outline`, `dither`

**Files:**

- Modify: `packages/pixel/src/commands.ts`, `packages/pixel/src/types.ts`, `packages/pixel/src/index.ts`
- Test: `packages/pixel/src/commands.test.ts`

**Interfaces:**

- Produces: command variants `{ type: "replaceColor", layerId?, from, to }`, `{ type: "outline", layerId, color }`, `{ type: "dither", layerId, x, y, width, height, colorA, colorB, pattern }` — all validated through `applyCommand` (bounds, palette range) with unit tests.

- [ ] **Step 1: Failing tests** — replaceColor swaps only `from`; outline rings only silhouette edges (a 1px dot gains a ring, an interior pixel does not); dither alternates cells in `checker`/`50` patterns.
- [ ] **Step 2: Implement + pass + commit**

```bash
git add packages/pixel
git commit -m "feat(pixel): replace-color, outline, and dither commands"
```

### Task 33: Tools, critique expansion, instructions

**Files:**

- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `packages/pixel/src/critique.ts` (+ `commands.test.ts` critique cases), `apps/worker/src/index.ts`, `apps/web/src/lib/run-activity.ts`

**Interfaces:**

- Produces: `erase_stroke`, `draw_line`, `flood_fill`, `fill_region`, `clear_region`, `replace_color`, `resize_canvas` (approval), `apply_outline`, `dither_rect`; critique issues `STRAY_PIXEL`, `OUTLINE_INTERIOR`, `TOUCHES_EDGE`.

- [ ] **Step 1: Failing tests** — stray pixel detection on an isolated dot; outline interior detection; edge-touch detection.
- [ ] **Step 2: Implement** — thin tools over the commands with labels; critique additions; recovery entries (`idempotent`); instructions updated ("use apply_outline for the silhouette ring; dither for texture; finish only when critique is empty").
- [ ] **Step 3: Pass + live check** — draw a 3-shade rock with outline + dither; critique clean.
- [ ] **Step 4: Commit**

```bash
git add packages/pixel packages/agent apps/worker apps/web/src/lib
git commit -m "feat(agent): drawing primitives and sharper critique"
```

## Phase 11 — Layers, workflow & infra

### Task 34: Layer tools and the think tool

**Files:**

- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts`, `apps/web/src/lib/run-activity.ts`
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Produces: `add_layer`, `rename_layer`, `set_layer_visible`, `remove_layer` (≥1 layer), `think` (Anvia `createThinkTool()`).

- [ ] **Step 1: Failing tests** — add/rename/visible/remove against the bound buffer; removing the last layer throws.
- [ ] **Step 2: Implement + recovery (`idempotent`; `think` `safe`) + console row for `think` + instructions.**
- [ ] **Step 3: Pass + live check** — a two-layer build with visibility toggles.
- [ ] **Step 4: Commit**

```bash
git add packages/agent apps/worker apps/web/src/lib
git commit -m "feat(agent): layer tools and a scratchpad"
```

### Task 35: Run history in the prompt, maxTurns, evals

**Files:**

- Modify: `apps/worker/src/index.ts`, `packages/agent/src/evals/deterministic.test.ts`

**Interfaces:**

- Consumes: `generation_runs.prompt`/`answer` (already shipped).
- Produces: the worker prompt gains a `Recent runs:` block (last 3 finished runs for the asset, `prompt → answer` truncated to 200 chars each); `maxTurns: 40`.

- [ ] **Step 1: Implement the prompt block**

```ts
const recent = await db
  .select({ prompt: generationRuns.prompt, answer: generationRuns.answer })
  .from(generationRuns)
  .innerJoin(generationThreads, eq(generationThreads.id, generationRuns.threadId))
  .where(
    and(
      eq(generationThreads.assetId, body.assetId),
      notInArray(generationRuns.status, ["queued", "running", "waiting"]),
    ),
  )
  .orderBy(desc(generationRuns.createdAt))
  .limit(3);
const history = recent
  .map((r) => `${(r.prompt ?? "").slice(0, 200)} → ${(r.answer ?? "").slice(0, 200)}`)
  .join("\n");
```

Append `\nRecent runs:\n${history}` to the submitted prompt when non-empty.

- [ ] **Step 2: maxTurns 40 + eval case** — a deterministic eval asserting a follow-up prompt sees the history block.
- [ ] **Step 3: Pass + commit**

```bash
git add apps/worker packages/agent
git commit -m "feat(agent): recent runs in context and more headroom"
```

## Phase 12 — Workspace agent & home composer

### Task 36: Thread scopes and workspace runs

**Files:**

- Modify: `packages/db/src/schema.ts` (+ `0007_thread_scopes.sql`), `apps/api/src/store.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`

**Interfaces:**

- Produces: `generation_threads.projectId` (nullable) + `assetId` (nullable) with a one-of check; `ensureThread` variants for asset and project scope; `POST /api/runs` accepts `{ scope: "workspace", projectId?, prompt, modelId, reasoningEffort }`.

- [ ] **Step 1: Migration 0007** — drop the `notNull` on `assetId`, add `projectId`, add `CHECK (asset_id IS NOT NULL OR project_id IS NOT NULL)`; generate + migrate; adjust `ensureThread`.
- [ ] **Step 2: API** — accept the workspace shape; pass `scope` through to the worker.
- [ ] **Step 3: Worker** — submit a run with no asset binding; `bindRun` is optional (Task 37).
- [ ] **Step 4: Tests** — store tests for the two thread shapes; API 422 when neither id is present.
- [ ] **Step 5: Commit**

```bash
git add packages/db apps/api apps/worker
git commit -m "feat(api): workspace-scoped runs"
```

### Task 37: Workspace tools and lazy binding

**Files:**

- Modify: `packages/agent/src/runs.ts`, `packages/agent/src/tools.ts`, `packages/agent/src/instructions.ts`, `apps/worker/src/index.ts`
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Produces: `list_projects`, `list_assets({ projectId })`, `create_asset({ projectId, name, width, height, palette? })`, `use_asset({ assetId })`; drawing tools throw `Choose or create an asset first.` until bound; `RunBinding.assetId` becomes optional.

- [ ] **Step 1: Failing tests** — drawing before binding throws; `use_asset` binds frames; `create_asset` creates and binds (worker callback persists).
- [ ] **Step 2: Implement** — the tools call worker callbacks (`onListProjects`, `onCreateAsset`, …) mirroring `onFrameChange`; ownership is enforced in the callbacks (user id from the run row).
- [ ] **Step 3: Pass + commit**

```bash
git add packages/agent apps/worker
git commit -m "feat(agent): workspace tools with lazy asset binding"
```

### Task 38: Home composer

**Files:**

- Modify: `apps/web/src/screens/projects.tsx`, `apps/web/src/components/composer.tsx`, `apps/web/src/lib/run-activity.ts` (+ test), `apps/web/src/router.tsx` (only if a route change is needed)

**Interfaces:**

- Consumes: the composer component, the run console, the interaction card, workspace runs (Task 36).
- Produces: a home composer that starts workspace runs, streams into a console, and links to the touched asset on completion.

- [ ] **Step 1: Failing test** — a workspace run's `canvas-stroke`/`asset-created` event maps to a row with an asset link target.
- [ ] **Step 2: Implement** — composer reuse with `scope: "workspace"`; console below it; on terminal, a `Open <asset name>` action navigates to the editor; recent runs list on home.
- [ ] **Step 3: Live verification** — from the home composer: "buat slime hijau 32px dengan 4 frame hop, taruh di project Pixelaition" → list projects → plan card → confirm → asset created, frames drawn, `check_animation` clean, console links to the new asset.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): the home composer for workspace runs"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — Phase 1 → Tasks 1–3; Phase 2 → Tasks 4–8; Phase 3 → Tasks 9–11; Phase 4 → Tasks 12–15; Phase 5 → Task 16; Phase 6 → Tasks 17–20 (incl. the vision spike and `models.vision`); Phase 7 → Tasks 21–24; Phase 8 → Tasks 25–28 (plan, durable interactions, present_plan + override, card); Phase 9 → Tasks 29–31; Phase 10 → Tasks 32–33; Phase 11 → Tasks 34–35; Phase 12 → Tasks 36–38. Open questions land in tasks: vision (19), assert strictness (26 verification), override persistence (27), filmstrip caps (19), retention (29), micro-label (16), Departure vendoring (1).

**Placeholder scan:** no "TBD"/"similar to Task N"; every code step carries real snippets. Tasks that depend on reading existing files first (store tests pattern in Task 29, ToolOutput subpath in Task 19, pixelarticons export names in Task 9) state the exact command to run, not a guess.

**Type consistency:** `RunBinding` is defined once (Task 21) and used by name afterwards; `encodeRowsRle` (17) feeds the read tools (18); `checkAnimation` (24) types match the tool output; interaction shapes use the Anvia names (`tool-approval` / `tool-question`) everywhere; version rows use `author/kind/scope` consistently in Tasks 29–31.

**Review Focus:** each of the five lines has a pinned check — fractional sizes (Tasks 1–3, 16), long strings (Task 2, 14), shadow overlap (Tasks 4–7, 16), reduced motion (Tasks 7, 16), icon swap (Tasks 9–11, 16).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-11-agent-and-pixel-theme-plan.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Subagent-driven**: 38 tasks across two tracks, with interface handoffs between tasks (RunBinding, interaction shapes, version rows) — a fresh reviewer per task catches the kind of drift that compounds over this many phases, and Part I's visual tasks benefit from a second pair of eyes against the spec's screenshots. Does the plan capture what you want, and which approach should we use?

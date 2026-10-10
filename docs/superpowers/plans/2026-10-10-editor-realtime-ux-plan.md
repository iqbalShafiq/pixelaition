# Editor Realtime & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the floating composer, the structured run console, the custom palette popover, panel polish, and the autosave/realtime contract that stops the editor from ever painting over a live agent.

**Architecture:** Pure helpers first (`run-activity.ts`, `hsv.ts`) with Vitest. A new `Popover` primitive in `ui.tsx` (the `@base-ui/react` pattern the Menu already uses). `Composer` is rewritten as a floating well; a new `RunConsole` renders `RunRow[]`; `editor.tsx` wires both, suspends autosave while a run is active, flushes before starting a run, resumes from the stream cursor on mount, and reloads the asset on terminal states.

**Tech Stack:** React 19, TanStack Query, `@base-ui/react` (popover/menu/select), Tailwind 4 utilities from `styles.css`, Motion, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-editor-realtime-ux-design.md`

## Global Constraints

- `DESIGN.md` is the law: Sweetie 16 tokens only, no border radius, 2px borders, lift-bar buttons, mono for labels, `faint` never for copy, motion 140–200ms transform/opacity only, `prefers-reduced-motion` honored.
- Strokes render only from `canvas-stroke` events — no playback, no easing, no invented steps. Muse reasoning is encrypted; the console labels it honestly and never fabricates text.
- Autosave is suspended while a run is active for the asset; local edits made before a run are flushed before the run starts; terminal states reload from the server.
- Every pure helper gets a failing test first (TDD); UI wiring is verified by typecheck/lint plus the live browser pass in Task 6.
- Existing helpers are reused: `base64ToBytes`/`bytesToBase64`/`FrameDto` from `src/lib/types.ts`, `hexToRgba` from `src/lib/color.ts`, `composite`/`frameToBuffer` from `@pixelaition/pixel`, `StreamMarkdown` from `@anvia/react-ui/stream`.
- Conventional Commits; husky/lint-staged run on every commit.

## Review Focus

- The floating composer must never cover the canvas at short viewport heights (it docks to the canvas column with a max height and internal scroll — Task 3).
- The console must never render invented reasoning text: encrypted reasoning is a timed phase row only (Task 1 tests; Task 3 rendering).
- The popover must not trap focus or leave an inert overlay (Base UI's `display:none` trap documented in DESIGN.md — Task 2 verification).
- The autosave guard must not drop user edits made before a run: flush-then-start order (Task 4 test + live check).
- An externally started run (started while the editor tab is already open) must still pause the editor: focus re-check adopts the active run (Task 4).

---

### Task 1: Run-activity mapping (pure, tested)

**Files:**

- Create: `apps/web/src/lib/run-activity.ts`
- Create: `apps/web/src/lib/run-activity.test.ts`
- Create: `apps/web/src/lib/hsv.ts`
- Create: `apps/web/src/lib/hsv.test.ts`

**Interfaces:**

- Produces: `type RunRow`, `applyRunEvent(rows: RunRow[], sequence: number, type: string, data: unknown): RunRow[]`, `formatDuration(ms: number): string`, `hsvToHex(h, s, v): string`, `hexToHsv(hex): { h, s, v }`.

- [ ] **Step 1: Write the failing tests**

`run-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyRunEvent, formatDuration, type RunRow } from "./run-activity.js";

describe("run activity rows", () => {
  it("pairs a tool call with its result", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 3, "tool_call", {
      operationId: "0:tool:3",
      name: "paint_stroke",
      input: { points: [{ x: 1, y: 1, color: 2 }] },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      name: "paint_stroke",
      summary: "1 px",
      state: "running",
    });
    rows = applyRunEvent(rows, 4, "tool_completed", {
      operationId: "0:tool:3",
      result: { failed: false },
    });
    expect(rows[0]).toMatchObject({ kind: "tool", state: "ok" });
  });

  it("keeps the provider error on a failed tool", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "tool_call", {
      operationId: "0:tool:1",
      name: "paint_stroke",
    });
    rows = applyRunEvent(rows, 2, "tool_completed", {
      operationId: "0:tool:1",
      result: { failed: true, error: "That layer is not on this frame." },
    });
    expect(rows[0]).toMatchObject({
      kind: "tool",
      state: "error",
      detail: "That layer is not on this frame.",
    });
  });

  it("marks a reasoning phase without inventing text", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 9, "model_started", { operationId: "0:model:1" });
    expect(rows[0]).toMatchObject({ kind: "phase", label: "thinking", state: "running" });
    rows = applyRunEvent(rows, 10, "model_completed", { operationId: "0:model:1" });
    expect(rows[0]).toMatchObject({ kind: "phase", state: "done" });
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("reasoning");
    }
  });

  it("records terminal status with the provider error", () => {
    let rows: RunRow[] = [];
    rows = applyRunEvent(rows, 1, "status", { status: "running" });
    rows = applyRunEvent(rows, 2, "done", {
      status: "failed",
      error: "Reached max turn limit: 24",
    });
    expect(rows.at(-1)).toMatchObject({ kind: "status", state: "failed" });
  });

  it("ignores unknown events", () => {
    expect(applyRunEvent([], 1, "heartbeat", {})).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations the way the summary bar reads", () => {
    expect(formatDuration(900)).toBe("0.9s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(121_000)).toBe("2m 01s");
  });
});
```

`hsv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "./hsv.js";

describe("hsv helpers", () => {
  it("round-trips a swatch", () => {
    const { h, s, v } = hexToHsv("#38b764");
    expect(hsvToHex(h, s, v)).toBe("#38b764");
  });
  it("maps the extremes", () => {
    expect(hsvToHex(0, 0, 1)).toBe("#ffffff");
    expect(hsvToHex(0, 0, 0)).toBe("#000000");
    expect(hsvToHex(120, 1, 1)).toBe("#00ff00");
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `pnpm --filter @pixelaition/web test`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

`run-activity.ts`:

```ts
export type RunRow =
  | { id: string; kind: "phase"; label: string; state: "running" | "done" }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary?: string;
      state: "running" | "ok" | "error";
      detail?: string;
    }
  | {
      id: string;
      kind: "status";
      label: string;
      state: "running" | "completed" | "failed" | "cancelled";
      detail?: string;
    };

const TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function toolSummary(name: string, data: unknown): string | undefined {
  const input = (data as { input?: Record<string, unknown> } | undefined)?.input;
  if (!input) return undefined;
  if (name === "paint_stroke" && Array.isArray(input.points)) {
    return `${input.points.length} px`;
  }
  if (name === "set_palette" && Array.isArray(input.palette)) {
    return `${input.palette.length} colors`;
  }
  if (name === "fill_rect") {
    return `${input.width}×${input.height}`;
  }
  return undefined;
}

/**
 * Folds one worker stream event into the console rows. Unknown events are
 * ignored on purpose: the console shows what the run really did, never a guess.
 * Reasoning text is rendered only when an event carries it; Muse sends
 * encrypted reasoning, so its turns appear as timed "thinking" phases.
 */
export function applyRunEvent(
  rows: RunRow[],
  sequence: number,
  type: string,
  data: unknown,
): RunRow[] {
  const body = data as Record<string, unknown> | undefined;
  const operationId =
    typeof body?.operationId === "string" ? body.operationId : undefined;
  const id = operationId ?? `seq-${sequence}`;

  if (type === "model_started") {
    if (rows.some((row) => row.id === id)) return rows;
    return [...rows, { id, kind: "phase", label: "thinking", state: "running" }];
  }
  if (type === "model_completed") {
    return rows.map((row) =>
      row.id === id && row.kind === "phase" ? { ...row, state: "done" } : row,
    );
  }
  if (type === "tool_call" || type === "tool_started") {
    if (rows.some((row) => row.id === id)) return rows;
    const name = typeof body?.name === "string" ? body.name : "tool";
    return [
      ...rows,
      { id, kind: "tool", name, summary: toolSummary(name, body), state: "running" },
    ];
  }
  if (type === "tool_completed") {
    const result = body?.result as { failed?: boolean; error?: string } | undefined;
    const detail =
      typeof result?.error === "string"
        ? result.error
        : typeof body?.error === "string"
          ? body.error
          : undefined;
    return rows.map((row) =>
      row.id === id && row.kind === "tool"
        ? { ...row, state: result?.failed ? "error" : "ok", detail }
        : row,
    );
  }
  if (type === "status") {
    const status = typeof body?.status === "string" ? body.status : "running";
    const state = TERMINAL[status] ?? "running";
    return [
      ...rows.filter((row) => row.kind !== "status"),
      {
        id: `status-${sequence}`,
        kind: "status",
        label: state === "running" ? "running" : state,
        state,
        detail: typeof body?.error === "string" ? body.error : undefined,
      },
    ];
  }
  if (type === "done") {
    const status = typeof body?.status === "string" ? body.status : "completed";
    const state = TERMINAL[status] ?? "completed";
    return [
      ...rows.filter((row) => row.kind !== "status"),
      { id: `done-${sequence}`, kind: "status", label: state, state },
    ];
  }
  return rows;
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
```

`hsv.ts`:

```ts
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  const to = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace("#", "").slice(0, 6);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
```

- [ ] **Step 4: Watch them pass**

Run: `pnpm --filter @pixelaition/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/run-activity.ts apps/web/src/lib/run-activity.test.ts apps/web/src/lib/hsv.ts apps/web/src/lib/hsv.test.ts
git commit -m "feat(web): add the run-activity and hsv helpers"
```

---

### Task 2: Popover primitive and the palette redesign

**Files:**

- Modify: `apps/web/src/components/ui.tsx` (add `Popover`)
- Modify: `apps/web/src/components/editor-panels.tsx` (`PalettePanel` rewrite)

**Interfaces:**

- Consumes: `Popover` in `ui.tsx`; `hsvToHex`/`hexToHsv` (Task 1); `hexToRgba` from `lib/color.ts`.
- Produces: `PalettePanel` props unchanged (`palette, color, usedColors, maxColors, onPick, onAdd`) so `editor.tsx` needs no change for this task.

- [ ] **Step 1: Add the Popover primitive**

In `ui.tsx`, next to `Menu` (same file/import style: `import { Popover as BasePopover } from "@base-ui/react/popover";`):

```tsx
export function Popover({
  trigger,
  label,
  children,
  align = "end",
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger
        aria-label={label}
        className="border-2 border-line text-muted hover:border-line-strong hover:bg-raised hover:text-ink"
      >
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={6} align={align} className="z-40">
          <BasePopover.Popup className="w-64 border-2 border-line-strong bg-raised p-2 text-[13px]">
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
```

- [ ] **Step 2: Rewrite `PalettePanel`**

Replace the whole `PalettePanel` in `editor-panels.tsx` (imports add `Popover` from `./ui.js`, `hsvToHex`, `hexToHsv` from `../lib/hsv.js`). Full component:

```tsx
const sweetie16 = [
  "#1a1c2c",
  "#5d275d",
  "#b13e53",
  "#ef7d57",
  "#ffcd75",
  "#a7f070",
  "#38b764",
  "#257179",
  "#29366f",
  "#3b5dc9",
  "#41a6f6",
  "#73eff7",
  "#f4f4f4",
  "#94b0c2",
  "#566c86",
  "#333c57",
];

export function PalettePanel({
  palette,
  color,
  usedColors,
  maxColors,
  onPick,
  onAdd,
}: {
  palette: string[];
  color: number;
  usedColors: number;
  maxColors: number;
  onPick: (index: number) => void;
  onAdd: (hex: string) => void;
}) {
  const [draft, setDraft] = useState("#a7f070");
  const [hsv, setHsv] = useState(() => hexToHsv("#a7f070"));
  const over = usedColors > maxColors;
  const valid = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(draft);
  const exists = palette.includes(draft.toLowerCase());

  function setFromHex(hex: string) {
    setDraft(hex);
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setHsv(hexToHsv(hex));
  }
  function setFromHsv(next: { h: number; s: number; v: number }) {
    setHsv(next);
    setDraft(hsvToHex(next.h, next.s, next.v));
  }
  function squareHandlers(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setFromHsv({ ...hsv, s, v });
  }

  return (
    <Panel
      title="Palette"
      action={
        <span className={`font-mono text-[10px] ${over ? "text-erase" : "text-muted"}`}>
          {usedColors}/{maxColors}
        </span>
      }
    >
      <div className="grid grid-cols-8 gap-1">
        {palette.map((swatch, index) => (
          <button
            key={`${swatch}-${index}`}
            type="button"
            aria-label={`Color ${index} ${index === 0 ? "transparent" : swatch}`}
            aria-pressed={color === index}
            onClick={() => onPick(index)}
            className={`aspect-square border-2 transition-colors duration-150 ${
              color === index ? "border-accent" : "border-line hover:border-line-strong"
            } ${index === 0 ? "checkerboard" : ""}`}
            style={index === 0 ? undefined : { background: swatch }}
          />
        ))}
        <Popover
          label="Add a color"
          trigger={
            <span className="grid aspect-square place-items-center font-mono text-[13px]">
              +
            </span>
          }
        >
          <div className="grid gap-2">
            <div
              role="slider"
              aria-label="Saturation and brightness"
              tabIndex={0}
              className="relative h-24 cursor-pointer border-2 border-line-strong"
              style={{
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})`,
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                squareHandlers(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) squareHandlers(event);
              }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute h-2 w-2 border-2 border-ink"
                style={{
                  left: `calc(${hsv.s * 100}% - 4px)`,
                  top: `calc(${(1 - hsv.v) * 100}% - 4px)`,
                }}
              />
            </div>
            <input
              aria-label="Hue"
              type="range"
              min={0}
              max={359}
              value={Math.round(hsv.h)}
              onChange={(event) => setFromHsv({ ...hsv, h: Number(event.target.value) })}
              className="hue-strip w-full border-2 border-line-strong bg-transparent"
            />
            <div className="grid grid-cols-8 gap-1">
              {sweetie16.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Preset ${preset}`}
                  onClick={() => setFromHex(preset)}
                  className="aspect-square border-2 border-line hover:border-line-strong"
                  style={{ background: preset }}
                />
              ))}
            </div>
            <TextInput
              value={draft}
              aria-label="Hex color"
              className="font-mono text-[13px]"
              onChange={(event) => setFromHex(event.target.value)}
            />
            <Button
              tone="solid"
              disabled={!valid || exists || palette.length >= 33}
              onClick={() => onAdd(draft.toLowerCase())}
            >
              {exists ? "In palette" : "Add color"}
            </Button>
          </div>
        </Popover>
      </div>
    </Panel>
  );
}
```

Add the hue-strip styling to `styles.css` under the utilities section:

```css
@utility hue-strip {
  appearance: none;
  height: 14px;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
}
@utility hue-strip::-webkit-slider-thumb {
  appearance: none;
  width: 10px;
  height: 14px;
  background: var(--color-ink);
  border: 2px solid var(--color-paper);
}
```

(If Tailwind 4 rejects pseudo-element utilities, move those two rules into `@layer base` targeting `.hue-strip::-webkit-slider-thumb` and add the gradient class inline instead.)

- [ ] **Step 3: Verify the popover does not leave an inert overlay**

Base UI unmounts popovers on close (no exit-animation trap like the Sheet case: it has no custom exit animation). Confirm with `pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint`, then in the browser: open, close by Escape and by clicking outside, and click a canvas tool afterwards — the tool must act (this is the DESIGN.md trap check).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui.tsx apps/web/src/components/editor-panels.tsx apps/web/src/styles.css
git commit -m "feat(web): give the palette a pixel popover picker"
```

---

### Task 3: Floating composer and run console

**Files:**

- Rewrite: `apps/web/src/components/composer.tsx`
- Create: `apps/web/src/components/run-console.tsx`

**Interfaces:**

- `Composer` props (new shape): `prompt, onPrompt, modelId, models, onModel, effort, efforts, onEffort, running, modelReady, onGenerate, onStop`. The callout card, activity log, message, and expanded state are gone.
- `RunConsole` props: `rows: RunRow[], running: boolean, open: boolean, onOpen: (next: boolean) => void, message: string`.
- Consumes: `RunRow`, `formatDuration` (Task 1), `StreamMarkdown`.

- [ ] **Step 1: Rewrite `Composer`**

Full replacement for `composer.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Button, SelectControl, Textarea } from "./ui.js";

/** A floating well over the canvas column: prompt, then the run controls. */
export function Composer({
  prompt,
  onPrompt,
  modelId,
  models,
  onModel,
  effort,
  efforts,
  onEffort,
  running,
  modelReady,
  onGenerate,
  onStop,
}: {
  prompt: string;
  onPrompt: (value: string) => void;
  modelId: string;
  models: string[];
  onModel: (value: string) => void;
  effort: string;
  efforts: string[];
  onEffort: (value: string) => void;
  running: boolean;
  modelReady: boolean;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "0px";
    area.style.height = `${Math.min(area.scrollHeight, 144)}px`;
  }, [prompt]);

  const noCatalog = models.length === 0 || efforts.length === 0;
  const modelOptions = models.length > 0 ? models : ["no models"];

  return (
    <section
      aria-label="Prompt composer"
      className="pointer-events-auto w-full border-2 border-line-strong bg-field shadow-[0_3px_0_0_var(--color-panel)] pixel-corners-sm"
      style={{ maxWidth: "40rem" }}
    >
      <Textarea
        ref={areaRef}
        value={prompt}
        aria-label="Prompt"
        placeholder="Describe the pixel asset, or ask for another state of this frame"
        className="min-h-[2.75rem] resize-none border-0 bg-transparent focus:border-0"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!running && prompt.trim() && modelReady && !noCatalog) onGenerate();
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        onChange={(event) => onPrompt(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5 border-t-2 border-line px-2 py-1.5">
        <SelectControl
          label="Model"
          value={models.includes(modelId) ? modelId : (modelOptions[0] ?? "")}
          options={modelOptions}
          onChange={onModel}
          className="max-w-[16rem]"
        />
        <SelectControl
          label="Reasoning effort"
          value={efforts.includes(effort) ? effort : (efforts[0] ?? "none")}
          options={efforts.length > 0 ? efforts : ["none"]}
          onChange={onEffort}
        />
        {!modelReady ? (
          <span className="font-mono text-[10px] text-muted">
            OPENAI_API_KEY is missing on the server
          </span>
        ) : noCatalog ? (
          <span className="font-mono text-[10px] text-muted">
            the model catalog is empty
          </span>
        ) : null}
        <span className="ml-auto">
          {running ? (
            <Button tone="danger" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              onClick={onGenerate}
              disabled={!prompt.trim() || !modelReady || noCatalog || !modelId}
            >
              Generate
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}
```

Add the ref-forwarding to `Textarea` in `ui.tsx` (`TextareaHTMLAttributes` + `ref` via prop spread — React 19 passes `ref` as a normal prop to function components, so `Textarea` can simply accept it: extend its props with `ref?: React.Ref<HTMLTextAreaElement>` and pass through).

- [ ] **Step 2: Create `RunConsole`**

```tsx
import { StreamMarkdown } from "@anvia/react-ui/stream";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "./ui.js";
import { formatDuration, type RunRow } from "../lib/run-activity.js";

/** The agent's work, one honest row at a time. */
export function RunConsole({
  rows,
  running,
  open,
  onOpen,
  message,
}: {
  rows: RunRow[];
  running: boolean;
  open: boolean;
  onOpen: (next: boolean) => void;
  message: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const startedAt = useRef<number>(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) startedAt.current = Date.now();
  }, [running]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows, follow, message]);

  const steps = rows.length;
  const summary = running
    ? `working · ${formatDuration(now - startedAt.current)}`
    : `${steps} steps · finished`;

  return (
    <section
      aria-label="Agent activity"
      className="pointer-events-auto w-full border-2 border-line-strong bg-panel pixel-corners-sm"
      style={{ maxWidth: "40rem" }}
    >
      <button
        type="button"
        onClick={() => onOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[10px] tracking-[0.16em] text-muted uppercase hover:text-ink"
      >
        <span className={running ? "text-accent" : ""}>agent</span>
        <span>{summary}</span>
        <span className="ml-auto">{open ? "▾" : "▴"}</span>
      </button>
      {open ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-64 min-h-24 overflow-auto border-t-2 border-line p-2"
          aria-live="polite"
        >
          <ul className="grid gap-1">
            {rows.map((row) => (
              <li key={row.id} className="font-mono text-[10px] text-muted">
                {row.kind === "phase" ? (
                  <span>
                    {row.state === "running" ? "…" : "✓"} {row.label}
                  </span>
                ) : row.kind === "tool" ? (
                  <span className={row.state === "error" ? "text-erase" : "text-ink"}>
                    {row.state === "error" ? "✕" : row.state === "ok" ? "✓" : "…"}{" "}
                    {row.name}
                    {row.summary ? ` · ${row.summary}` : ""}
                    {row.detail ? ` — ${row.detail}` : ""}
                  </span>
                ) : (
                  <span className={row.state === "failed" ? "text-erase" : "text-ink"}>
                    {row.label}
                    {row.detail ? ` — ${row.detail}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {message ? (
            <div className="mt-2 border-t-2 border-line pt-2 text-xs text-ink">
              <StreamMarkdown content={message} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint`
If the editor still passes the old props and tsc fails, do Task 4's wiring now and commit Tasks 3+4 together; otherwise commit this task alone.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/composer.tsx apps/web/src/components/run-console.tsx apps/web/src/components/ui.tsx
git commit -m "feat(web): float the composer and structure the run console"
```

---

### Task 4: Editor wiring — realtime contract

**Files:**

- Modify: `apps/web/src/screens/editor.tsx`

**Interfaces:**

- Consumes: `Composer` (Task 3), `RunConsole` (Task 3), `applyRunEvent`/`RunRow` (Task 1).
- Produces: the autosave guard, flush-then-start ordering, `after` cursor restore, terminal reload, focus re-check, and the floating layer placement.

- [ ] **Step 1: Replace the activity state**

- `const [activity, setActivity] = useState<ActivityLine[]>([]);` → `const [rows, setRows] = useState<RunRow[]>([]);`
- `const [expanded, setExpanded] = useState(false);` → `const [consoleOpen, setConsoleOpen] = useState(false);`
- `log` becomes a status-row notice:

```ts
const log = useCallback((text: string) => {
  setRows((current) => [
    ...current.slice(-120),
    { id: crypto.randomUUID(), kind: "status", label: text, state: "running" },
  ]);
}, []);
```

- Remove the `ActivityLine` import (delete that export from `composer.tsx` in Task 3).

- [ ] **Step 2: Stream handler feeds the console and resumes with a cursor**

In `listen(id, fallbackFrameId, after = 0)`:

```ts
const source = new EventSource(`/api/runs/${id}/stream?after=${after}`);
```

In `source.onmessage`, after the existing `canvas-stroke` branch, replace the tool/model/done branches with:

```ts
setRows((current) => applyRunEvent(current, sequence, body.type, body.data));
```

where `sequence` comes from the parsed body: `const { type, data, sequence } = JSON.parse(event.data) as { type: string; data: unknown; sequence: number };`

Keep the `done` handler but extend it:

```ts
if (body.type === "done") {
  const data = body.data as { status?: string; error?: string };
  setRows((current) => applyRunEvent(current, sequence, "done", data));
  setMessage(data.status === "completed" ? "" : (data.error ?? ""));
  source.close();
  sourceRef.current = null;
  setRunId(null);
  setRunFrameId(null);
  const target = runFrameIdRef.current;
  if (target) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
  }
  void client.invalidateQueries({ queryKey: ["asset", assetId] });
  return;
}
```

Add `const runFrameIdRef = useRef<string | null>(null);` and keep it in sync with `runFrameId` so the closure sees the latest value. The restore effect calls `listen(result.run.id, "", 0)` unchanged (the worker replays retained events from 0).

- [ ] **Step 3: The autosave guard and flush-then-start**

Make `flush` awaitable and skip scheduling while a run is active:

```ts
const flush = useCallback(async () => {
  if (debounce.current !== null) {
    window.clearTimeout(debounce.current);
    debounce.current = null;
  }
  const batch = [...pending.current.entries()];
  pending.current.clear();
  await Promise.all(
    batch.map(([id, buffer]) =>
      mutate.current({ frameId: id, buffer }).catch((reason: unknown) =>
        notify({
          title: "A frame did not save",
          description: reason instanceof Error ? reason.message : "Unknown error",
        }),
      ),
    ),
  );
}, [notify]);
```

The debounce effect gains one guard at the top:

```ts
useEffect(() => {
  if (running) return; // the agent owns the frame while a run is live
  if (!present || !frameId) return;
  ...
}, [present, frameId, flush, running]);
```

`generate()` starts with `await flush();` before the preferences PATCH and `POST /api/runs`.

- [ ] **Step 4: Adopt externally started runs on focus**

Extend the active-run effect with a focus/visibility re-check (the tab may already be open when a run starts elsewhere):

```ts
useEffect(() => {
  let cancelled = false;
  async function check() {
    const result = await api<{ run: { id: string; status: string } | null }>(
      `/api/assets/${assetId}/active-run`,
    ).catch(() => ({ run: null }));
    if (cancelled || !result.run || sourceRef.current) return;
    setRunId(result.run.id);
    setConsoleOpen(true);
    log("Rejoined a run that was still going");
    listen(result.run.id, "", 0);
  }
  void check();
  window.addEventListener("focus", check);
  return () => {
    cancelled = true;
    window.removeEventListener("focus", check);
  };
}, [assetId, listen, log]);
```

- [ ] **Step 5: Lay the floating layer over the canvas column**

Replace the bottom `Composer` block and the column grid with a relative wrapper. Inside the center column (the `div` that holds the canvas), after the canvas wrapper, add:

```tsx
<div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2 px-3">
  <RunConsole
    rows={rows}
    running={running}
    open={consoleOpen || running}
    onOpen={setConsoleOpen}
    message={message}
  />
  <Composer ... />
</div>
```

The center column becomes `relative` (`className="relative flex min-h-0 min-w-0 flex-col"`), the outer `grid-rows-[1fr_auto]` no longer reserves a composer row, and the canvas gets `pb-28` so the sprite keeps a clear resting area under the floating layer. Pass the new `Composer` props only (drop `activity`, `message`, `expanded`, `onExpanded`); `consoleOpen` opens automatically while running.

- [ ] **Step 6: Typecheck, lint, and commit**

Run: `pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint`
Expected: exit 0.

```bash
git add apps/web/src/screens/editor.tsx
git commit -m "feat(web): keep the editor honest while the agent draws"
```

---

### Task 5: Panels, top bar, and documentation

**Files:**

- Modify: `apps/web/src/components/editor-panels.tsx` (FramePanel thumb, palette count already moved in Task 2)
- Modify: `apps/web/src/components/editor-toolbar.tsx` (`ViewPanel` segmented control)
- Modify: `apps/web/src/screens/editor.tsx` (top-bar run chip)
- Modify: `DESIGN.md`, `AGENTS.md`

- [ ] **Step 1: Frame thumbnails**

Add a `FrameThumb` inside `editor-panels.tsx` (imports `base64ToBytes`, `FrameDto` from `../lib/types.js`; `composite` from `@pixelaition/pixel`; `hexToRgba` from `../lib/color.js`):

```tsx
function FrameThumb({ frame, size = 36 }: { frame: FrameDto; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const layer = frame.layers.find((item) => item.visible) ?? frame.layers[0];
    if (!layer) return;
    const pixels = base64ToBytes(layer.pixels);
    const width = Math.sqrt(pixels.length);
    if (!Number.isInteger(width)) return;
    canvas.width = width;
    canvas.height = width;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(width, width);
    for (let index = 0; index < pixels.length; index += 1) {
      const value = pixels[index] ?? 0;
      if (value === 0) continue;
      const [r, g, b, a] = hexToRgba(frame.palette?.[value] ?? "#000000");
      image.data.set([r, g, b, a], index * 4);
    }
    context.putImageData(image, 0, 0);
  }, [frame]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0 border-2 border-line bg-screen"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}
```

Problem: `FrameDto` has no `palette`. Either pass `palette` as a prop from `FramePanel` (add a `palette: string[]` prop, wired from `editor.tsx` where `buffer?.palette` exists) or skip colors and draw indexes in `ink`. Choose: add `palette: string[]` to `FramePanel` props and use it; when the thumbnail cannot resolve a width, render a bordered placeholder. Insert `<FrameThumb frame={frame} palette={palette} />` as the first cell of each frame row.

- [ ] **Step 2: ViewPanel segmented control**

Replace `ViewPanel`'s body with three icon toggles (import `Grid3X3`, `Eraser`, `Layers` from `lucide-react` or the closest existing set; labels via `Tooltip`):

```tsx
<Panel title="View">
  <div className="flex items-center gap-1">
    <IconButton label="Grid" active={grid} onClick={() => onGrid(!grid)}>
      <Grid3X3 size={15} strokeWidth={2} />
    </IconButton>
    <IconButton label="Transparency" active={checker} onClick={() => onChecker(!checker)}>
      <CheckerboardIcon size={15} strokeWidth={2} />
    </IconButton>
    <IconButton label="Onion skin" active={onion} onClick={() => onOnion(!onion)}>
      <Layers size={15} strokeWidth={2} />
    </IconButton>
  </div>
</Panel>
```

Use only icons that exist in the installed `lucide-react`; if `Grid3X3`/`Layers` are absent, pick the nearest available grid/layers glyphs and note the substitution in the commit body.

- [ ] **Step 3: Top-bar run chip**

In `editor.tsx`, replace the bare pulsing dot with a status chip driven by `running` and the latest status row (`rows.findLast?.(...)` or `[...rows].reverse().find(...)` for TS targets without `findLast`):

```tsx
{
  running ? (
    <span className="hidden items-center gap-1.5 border-2 border-line px-2 py-0.5 font-mono text-[10px] text-accent sm:flex">
      <span className="inline-block h-1.5 w-1.5 animate-pulse bg-accent" />
      drawing
    </span>
  ) : null;
}
```

(Failed/completed states live in the console bar; the chip stays a live indicator to avoid duplicate status surfaces.)

- [ ] **Step 4: Update `DESIGN.md`**

Add sections: the floating composer geometry (max-width 40rem, docks to the canvas column, `pb-28` canvas resting area), the run-console rules (structured rows; encrypted reasoning shows as a timed phase, never text; no post-hoc animation; autosave suspension), the palette popover (square corners, hue strip, SVG-free CSS pickers), and the panel patterns from this task.

- [ ] **Step 5: Update `AGENTS.md`**

Add one bullet under the drawing rules: `While a run is active for an asset, the editor never writes the frame back; strokes come from the agent's tool calls as they happen. The canvas is a live feed, not a replay.`

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint
git add apps/web DESIGN.md AGENTS.md
git commit -m "feat(web): polish the panels and write the realtime rules down"
```

---

### Task 6: Verification with a real run in the browser

**Files:** none (verification only)

- [ ] **Step 1: The suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green (web now has real tests).

- [ ] **Step 2: Live browser pass**

Using the desktop browser tools: open `http://localhost:3000`, sign in (`shafiq@testing.com` / `Test@123`), open the trial asset, then:

1. The composer floats over the canvas; no callout card exists.
2. `+` on the palette opens the popover; pick a preset, add it; close with Escape; the pencil still draws afterwards.
3. Type a prompt, pick Muse + `xhigh`, Generate: strokes appear progressively **while** the run streams; the console grows rows (thinking phases, tool rows with summaries, the final status).
4. Collapse and re-open the console; the summary bar shows steps and duration.
5. While the run is active, confirm server-side silence from the editor: watch the dev log for `PATCH /api/assets/.../frames` — none may appear during the run (the guard); after completion the reloaded canvas keeps the agent's pixels.
6. Start a second run from the browser; mid-run, reload the tab: the editor rejoins the run and repaints from the replayed strokes.

- [ ] **Step 3: Reduced-motion and keyboard checks**

Enable `prefers-reduced-motion` in the browser tools; re-run the composer growth, console open/close, and popover open/close — transitions must be removed. Keyboard-only: focus the prompt, `Enter` generates, `Tab` reaches the model/effort chips, the popover is operable with arrows/Enter, focus returns to `+` when closed.

- [ ] **Step 4: Commit verification fixes (if any)**

```bash
git add -A
git commit -m "fix(web): close the gaps the live pass found"
```

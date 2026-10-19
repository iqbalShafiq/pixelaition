# Drawing Limits Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the drawing maximums — frames, layers, palette colours — replacing policy caps with the format's physical bounds, while the parallel painter count stays Jev's choice of 1–4.

**Architecture:** The pixel format (`packages/pixel`) raises `MAX_COLORS` to the byte bound (255), drops `MAX_LAYERS` and the style guide's `maxColors`; the agent layer (`packages/agent`) drops the plan/input caps and computes palette room as `256 − current length`; the worker submits the real capacity and stops leaking a stale style key; the editor and MCP follow. Nothing is capped at the workflow level except the workers, which stay as they are.

**Tech Stack:** TypeScript, zod, vitest, pnpm workspaces + Turborepo, React (editor), Drizzle/Postgres (untouched here).

**Spec:** `docs/superpowers/specs/2026-10-16-drawing-limits-design.md` — the plan argues from the spec; read both.

## Global Constraints

- `MAX_COLORS = 255`; a palette carries 2–256 entries (index 0 is `#00000000`, transparent). A longer palette is refused with the bound named — this is the byte-safety guard: one pixel is one `Uint8Array` byte, so an index above 255 would silently wrap.
- No layer cap and no frame cap anywhere.
- Workers keep Jev's choice, 1–4: `assetDrawInputSchema.maxWorkers` 1–4, plan `workers.max(4)`, worker keys `w[1-4]`, `assetDrawOutputSchema.workers` 1–4.
- The style guide loses `maxColors`; no database migration; `.pxl` keeps `version: 1`.
- Unchanged: plan references ≤ 8, review ≤ 2 fixes per round and ≤ 6 rounds, canvas 8–128 px, the 3-frame minimum for motion.
- Commit messages follow Conventional Commits (AGENTS.md). The workspace owner asked not to commit unless asked — treat every "Commit" step below as ready but pending their go-ahead.
- Test commands: `pnpm --filter @pixelaition/pixel exec vitest run <file>`, `pnpm --filter @pixelaition/agent exec vitest run <file>`, `pnpm --filter @pixelaition/worker exec vitest run <file>`; full runs: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Review Focus

1. A palette longer than 256 arriving from a hand-built `.pxl`, an MCP call, or a direct tool input — refused with the bound named, never stored, so no index can exceed one byte. (Pinned in Task 1; paint bounds already exist in `commands.ts` `PALETTE_INDEX`.)
2. Old data: a `jsonb` style row and a `.pxl` v1 file that still carry `maxColors` — load cleanly, and the key never reaches a prompt or a round-trip. (Pinned in Task 3 and Task 7.)
3. A durable draw task submitted before the deploy, resuming after it — `maxFrames` is stripped, its `maxPalette: 8` still applies, and the task continues. (Pinned in Task 5.)
4. Editor surfaces with a large palette (100+ swatches) and many layers (10+) — render; the palette panel shows a count only; the layers line reads "N layers". (Manual check in Task 10.)
5. A plan past the old caps (13+ frames, 5+ layers, additions within capacity) — parses, validates, paints, and every layer stays addressable. (Pinned in Task 4 and Task 6; live check optional in Task 10.)

---

### Task 1: Pixel palette capacity — 256 entries

**Files:**

- Modify: `packages/pixel/src/types.ts:4` (`MAX_COLORS`), `packages/pixel/src/commands.ts:302-307` (message), `packages/pixel/src/schema.ts:34` (palette max)
- Test: `packages/pixel/src/commands.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `MAX_COLORS = 255`; `applyCommand` `setPalette` accepts 2–256 entries and refuses 257 with code `PALETTE_SIZE`; `assetSchema` accepts a 256-entry palette.

- [ ] **Step 1: Write the failing test**

Append inside the `describe` block that owns `applyCommand` tests (near the layer tests), in `packages/pixel/src/commands.test.ts`:

```ts
it("accepts a 256-entry palette and refuses one longer", () => {
  const buffer = createBuffer({ width: 8, height: 8 });
  const palette = [
    "#00000000",
    ...Array.from(
      { length: 255 },
      (_, index) => `#${(index + 1).toString(16).padStart(6, "0")}`,
    ),
  ];
  const result = applyCommand(buffer, { type: "setPalette", palette });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.buffer.palette).toHaveLength(256);

  const tooLong = applyCommand(buffer, {
    type: "setPalette",
    palette: [...palette, "#ffffff"],
  });
  expect(tooLong).toMatchObject({ ok: false, code: "PALETTE_SIZE" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts -t "accepts a 256-entry palette"`
Expected: FAIL — `PALETTE_SIZE` on the 256-entry palette (the current bound is 33).

- [ ] **Step 3: Implement**

`packages/pixel/src/types.ts`, line 4:

```ts
export const MAX_COLORS = 255;
```

`packages/pixel/src/commands.ts`, the `setPalette` message:

```ts
          "A palette needs a transparent color and at most 255 others.",
```

`packages/pixel/src/schema.ts`, `assetSchema` palette:

```ts
  palette: z.array(hex).min(2).max(256),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts`
Expected: PASS (all; `paletteLimit` in `buffer.ts` derives from `MAX_COLORS` and follows automatically).

- [ ] **Step 5: Commit**

```bash
git add packages/pixel/src/types.ts packages/pixel/src/commands.ts packages/pixel/src/schema.ts packages/pixel/src/commands.test.ts
git commit -m "feat(pixel): hold 256 palette entries, the byte bound"
```

---

### Task 2: Pixel layers unbounded

**Files:**

- Modify: `packages/pixel/src/types.ts:3` (delete `MAX_LAYERS`), `packages/pixel/src/commands.ts:356-359` (delete the check), `packages/pixel/src/schema.ts:26` (drop `.max(4)`), `packages/pixel/src/index.ts:28-36` (export list)
- Test: `packages/pixel/src/commands.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `addLayer` never refuses for count; `frameSchema.layers` has no maximum; `MAX_LAYERS` is no longer exported.

- [ ] **Step 1: Write the failing test**

Append near the existing layer tests in `packages/pixel/src/commands.test.ts`:

```ts
it("adds layers past four", () => {
  const { buffer } = paint();
  let next = buffer;
  for (let index = 2; index <= 6; index += 1) {
    const added = applyCommand(next, {
      type: "addLayer",
      id: `layer-${index}`,
      name: `layer ${index}`,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    next = added.buffer;
  }
  expect(next.layers).toHaveLength(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts -t "adds layers past four"`
Expected: FAIL — `LAYER_LIMIT`, "A frame can hold four layers."

- [ ] **Step 3: Implement**

`packages/pixel/src/types.ts`: delete the `MAX_LAYERS` line.

`packages/pixel/src/commands.ts`, the `addLayer` case — delete the guard:

```ts
    case "addLayer": {
      const name = command.name.trim();
```

`packages/pixel/src/schema.ts`:

```ts
  layers: z.array(layerSchema).min(1),
```

`packages/pixel/src/index.ts`: delete `MAX_LAYERS,` from the `./types.js` export list.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts && pnpm --filter @pixelaition/pixel typecheck`
Expected: PASS; no references to `MAX_LAYERS` remain.

- [ ] **Step 5: Commit**

```bash
git add packages/pixel/src/types.ts packages/pixel/src/commands.ts packages/pixel/src/schema.ts packages/pixel/src/index.ts packages/pixel/src/commands.test.ts
git commit -m "feat(pixel): remove the four-layer cap"
```

---

### Task 3: Pixel critique — drop `maxColors`

**Files:**

- Modify: `packages/pixel/src/types.ts:13-20` (`StyleGuide`), `packages/pixel/src/schema.ts:9` (`styleGuideSchema`), `packages/pixel/src/buffer.ts:20-22` (`defaultStyle`), `packages/pixel/src/critique.ts:15-29`
- Test: `packages/pixel/src/commands.test.ts`, `packages/export/src/export.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `StyleGuide` without `maxColors`; `critiqueFrame(buffer, style: Pick<StyleGuide, "outline">)`; no `TOO_MANY_COLORS` issue code.

- [ ] **Step 1: Write the failing test**

Inside the `describe("pixel critique")` block of `packages/pixel/src/commands.test.ts`, add — and change the block's shared `style` to `{ outline: "#1a1c2c" }`:

```ts
it("does not flag a colour count without a style ceiling", () => {
  const palette = [
    "#00000000",
    ...Array.from(
      { length: 10 },
      (_, index) => `#${(index + 1).toString(16).padStart(6, "0")}`,
    ),
  ];
  const buffer = createBuffer({ width: 8, height: 8, palette });
  const points = Array.from({ length: 9 }, (_, index) => ({
    x: 3 + (index % 3),
    y: 3 + Math.floor(index / 3),
    color: index + 2,
  }));
  const painted = paintPoints(buffer, points);
  expect(codes(painted)).not.toContain("TOO_MANY_COLORS");
});
```

And in `packages/export/src/export.test.ts`, inside `describe("export")`:

```ts
it("imports a v1 file whose style still carries maxColors", () => {
  const project = sample();
  const raw = JSON.parse(serializeProject(project)) as {
    project: { style: Record<string, unknown> };
  };
  raw.project.style.maxColors = 8;
  const parsed = parseProject(JSON.stringify(raw));
  expect(parsed.project.style).not.toHaveProperty("maxColors");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts -t "does not flag a colour count" && pnpm --filter @pixelaition/export exec vitest run src/export.test.ts -t "carries maxColors"`
Expected: FAIL — nine colours against `maxColors: 8` produce `TOO_MANY_COLORS`, and the kept key fails the import assertion.

- [ ] **Step 3: Implement**

`packages/pixel/src/types.ts` — `StyleGuide` loses the field:

```ts
export type StyleGuide = {
  defaultWidth: number;
  defaultHeight: number;
  outline: string;
  shadowDirection: ShadowDirection;
  notes: string;
};
```

`packages/pixel/src/schema.ts` — `styleGuideSchema` loses the line:

```ts
  maxColors: z.number().int().min(1).max(32),
```

`packages/pixel/src/buffer.ts` — `defaultStyle` loses `maxColors: 8,`.

`packages/pixel/src/critique.ts` — the signature and the issue:

```ts
export function critiqueFrame(
  buffer: FrameBuffer,
  style: Pick<StyleGuide, "outline">,
): CritiqueIssue[] {
```

delete the `const colors = usedColorCount(buffer); if (colors > style.maxColors) { ... }` block; drop the now-unused `usedColorCount` import.

Also in `packages/pixel/src/commands.test.ts` line ~119, the literal becomes:

```ts
expect(critiqueFrame(painted.buffer, { outline: "#1a1c2c" })).toEqual([]);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/pixel exec vitest run src/commands.test.ts && pnpm --filter @pixelaition/export exec vitest run src/export.test.ts && pnpm --filter @pixelaition/pixel typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pixel/src/types.ts packages/pixel/src/schema.ts packages/pixel/src/buffer.ts packages/pixel/src/critique.ts packages/pixel/src/commands.test.ts packages/export/src/export.test.ts
git commit -m "feat(pixel): drop the style guide's colour ceiling"
```

---

### Task 4: Agent plan — remove frame/layer caps, add `paletteCapacity`

**Files:**

- Modify: `packages/agent/src/tasks/plan.ts:12,29,30,38-42,57-63,105-109`, `packages/agent/src/index.ts:75`
- Test: `packages/agent/src/tasks/plan.test.ts`

**Interfaces:**

- Consumes: `MAX_COLORS` from `@pixelaition/pixel` (new import in `plan.ts`).
- Produces: `PlanLimits` = `{ maxWorkers; maxPalette; minFrames? }` (no `maxFrames`); `paletteCapacity(currentLength: number): number`; `drawPlanSchema` with no frames/layers/palette maxima.

- [ ] **Step 1: Write the failing tests**

In `packages/agent/src/tasks/plan.test.ts`:

```ts
it("accepts plans past the old frame and layer caps", () => {
  const frames = Array.from({ length: 20 }, (_, index) => ({
    name: `pose-${index + 1}`,
    intent: "a key pose",
    layers: [
      "body",
      "face",
      "hair",
      "shadow",
      "glow",
      "eyes",
      "mouth",
      "outline",
      "highlight",
      "props",
    ],
  }));
  const parsed = drawPlanSchema.safeParse({
    ...base,
    frames,
    workers: [{ key: "w1", frames: frames.map((frame) => frame.name) }],
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(validatePlan(parsed.data, { maxWorkers: 4, maxPalette: 16 })).toEqual({
    ok: true,
  });
});

it("computes the remaining palette room", () => {
  expect(paletteCapacity(4)).toBe(252);
  expect(paletteCapacity(256)).toBe(0);
  expect(paletteCapacity(300)).toBe(0);
});
```

Update the shared limits and the message test:

```ts
const limits = { maxWorkers: 4, maxPalette: 16 };
```

```ts
expect(validatePlan(palette, { ...limits, maxPalette: 0 })).toEqual({
  ok: false,
  error: "The plan adds 1 colour; the palette has room for 0 more.",
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tasks/plan.test.ts`
Expected: FAIL — the 20-frame parse fails (old `.max(12)`), `paletteCapacity` is not exported, and the message differs.

- [ ] **Step 3: Implement**

`packages/agent/src/tasks/plan.ts` — add the import and the helper:

```ts
import { MAX_COLORS } from "@pixelaition/pixel";
```

```ts
/** How many colours the palette can still take: 256 entries less what it holds. */
export function paletteCapacity(currentLength: number): number {
  return Math.max(0, MAX_COLORS + 1 - currentLength);
}
```

Schema: `layers: z.array(z.string().min(1).max(40)),`; `frames: z.array(drawPlanFrameSchema).min(1),`; `palette: z.array(paletteAdditionSchema),` (leave `references.max(8)` and `workers.max(4)`).

`PlanLimits` loses `maxFrames`; `validatePlan` loses the frames-cap block; the palette message:

```ts
      error: `The plan adds ${plan.palette.length} colour${plan.palette.length === 1 ? "" : "s"}; the palette has room for ${limits.maxPalette} more.`,
```

`packages/agent/src/index.ts` line 75:

```ts
export { drawPlanSchema, paletteCapacity, validatePlan } from "./tasks/plan.js";
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tasks/plan.test.ts && pnpm --filter @pixelaition/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks/plan.ts packages/agent/src/index.ts packages/agent/src/tasks/plan.test.ts
git commit -m "feat(agent): plans carry no frame or layer cap"
```

---

### Task 5: Agent asset-draw — input and prompt

**Files:**

- Modify: `packages/agent/src/tasks/asset-draw.ts:38-41,243`, `packages/agent/src/tasks/roles.ts:61`
- Test: `packages/agent/src/tasks/asset-draw.test.ts`

**Interfaces:**

- Consumes: `MAX_COLORS` from `@pixelaition/pixel`.
- Produces: `assetDrawInputSchema` without `maxFrames`, `maxPalette` 0–255; the plan prompt's limits line becomes `Limits: at most N workers. The palette holds up to 256 entries including transparent; M more can be added.` (still starting with `Limits:` — `userRequestFromPrompt` cuts there).

- [ ] **Step 1: Write the failing tests**

In `packages/agent/src/tasks/asset-draw.test.ts`, update the fixture (`maxPalette: 24`, no `maxFrames`) and the prompt test:

```ts
it("states the limits so the first plan already fits them", () => {
  const prompt = buildPlanPrompt(input);
  expect(prompt).toContain("at most 4 workers");
  expect(prompt).toContain(
    "The palette holds up to 256 entries including transparent; 24 more can be added.",
  );
  expect(prompt).not.toContain("at most 12 frames");
});
```

Add the legacy-input test:

```ts
it("parses without a frames cap and strips a legacy one", () => {
  const legacy = { ...input, maxFrames: 12 } as unknown as Record<string, unknown>;
  const parsed = assetDrawInputSchema.parse(legacy);
  expect("maxFrames" in parsed).toBe(false);
  expect(parsed.maxPalette).toBe(24);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tasks/asset-draw.test.ts`
Expected: FAIL — the fixture no longer satisfies the schema (`maxFrames` required), and the prompt text differs.

- [ ] **Step 3: Implement**

`packages/agent/src/tasks/asset-draw.ts` — import and schema:

```ts
import { MAX_COLORS } from "@pixelaition/pixel";
```

```ts
  maxWorkers: z.number().int().min(1).max(4),
  review: z.boolean(),
  maxPalette: z.number().int().min(0).max(255),
```

(delete the `maxFrames` line). The two `PlanLimits` objects that `asset-draw.ts` builds for `validatePlan` (around lines 382-384 and 393-395) also lose their `maxFrames: ctx.input.maxFrames,` entry — `maxPalette: ctx.input.maxPalette` stays. The limits line in `buildPlanPrompt`:

```ts
    `Limits: at most ${input.maxWorkers} workers. The palette holds up to ${
      MAX_COLORS + 1
    } entries including transparent; ${input.maxPalette} more can be added.` +
```

`packages/agent/src/tasks/roles.ts` line 61: replace "(within the style guide's colour maximum)" with "(within the palette's remaining capacity)".

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tasks/asset-draw.test.ts && pnpm --filter @pixelaition/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tasks/asset-draw.ts packages/agent/src/tasks/roles.ts packages/agent/src/tasks/asset-draw.test.ts
git commit -m "feat(agent): the plan prompt names the palette room, not a frame cap"
```

---

### Task 6: Agent tools — palette bounds, layer copy

**Files:**

- Modify: `packages/agent/src/tools.ts:754,973`, `packages/agent/src/instructions.ts:11`
- Test: `packages/agent/src/tools.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `set_palette` and `create_asset` accept up to 256 entries; the painter instructions no longer claim a layer cap.

- [ ] **Step 1: Write the failing tests**

In `packages/agent/src/tools.test.ts`, replace the "refuses a fifth layer" test and add the palette test (same harness as the neighbouring tool tests):

```ts
it("add_layer keeps adding layers past four", async () => {
  boundRun();
  await tool("add_layer").call({}, { operationId: "run-1" });
  await tool("add_layer").call({}, { operationId: "run-1" });
  await tool("add_layer").call({}, { operationId: "run-1" });
  await tool("add_layer").call({}, { operationId: "run-1" });
  expect(getRun("run-1")!.frames.get("frame-1")!.buffer.layers).toHaveLength(6);
  releaseRun("run-1");
});

it("set_palette accepts a 256-entry palette", async () => {
  boundRun();
  const palette = [
    "#00000000",
    ...Array.from(
      { length: 255 },
      (_, index) => `#${(index + 1).toString(16).padStart(6, "0")}`,
    ),
  ];
  const result = (await tool("set_palette").call(
    { palette },
    { operationId: "run-1" },
  )) as { palette: string[] };
  expect(result.palette).toHaveLength(256);
  releaseRun("run-1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tools.test.ts -t "past four"`
Expected: FAIL — the fourth add is refused by `LAYER_LIMIT`; the 256-entry palette fails the tool's zod `.max(33)`.

- [ ] **Step 3: Implement**

`packages/agent/src/tools.ts` line 754 and line 973:

```ts
      palette: z.array(z.string()).min(2).max(256),
```

```ts
      palette: z.array(z.string()).min(2).max(256).optional(),
```

`packages/agent/src/instructions.ts` line 11: replace "A frame holds at most four layers and one must remain;" with "Layers have no limit and one must remain;".

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/agent exec vitest run src/tools.test.ts && pnpm --filter @pixelaition/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/instructions.ts packages/agent/src/tools.test.ts
git commit -m "feat(agent): palette tools take the byte bound, layers uncapped"
```

---

### Task 7: Worker — submit capacity, strip the stale style key

**Files:**

- Modify: `apps/worker/src/tasks.ts:120-124`, `apps/worker/src/index.ts` (the `@pixelaition/agent` and `@pixelaition/pixel` import blocks; the draw submit around lines 1720-1727)
- Test: `apps/worker/src/tasks.test.ts`

**Interfaces:**

- Consumes: `paletteCapacity` (Task 4), `MAX_COLORS` from `@pixelaition/pixel`.
- Produces: `styleLine(style: unknown): string`; the draw submit sends `maxPalette: asset ? paletteCapacity(asset.palette.length) : MAX_COLORS` and no `maxFrames`.

- [ ] **Step 1: Write the failing test**

In `apps/worker/src/tasks.test.ts`:

```ts
it("drops a stale maxColors key from the style line", () => {
  expect(styleLine({ outline: "#1a1c2c", maxColors: 8 })).not.toContain("maxColors");
  expect(styleLine(undefined)).toContain("defaultWidth");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pixelaition/worker exec vitest run src/tasks.test.ts`
Expected: FAIL — `styleLine` is not exported.

- [ ] **Step 3: Implement**

`apps/worker/src/tasks.ts` — export the builder and use it:

```ts
/**
 * The style line the run prompts carry: the StyleGuide fields only, so a
 * stale `maxColors` key from an older row never reaches a prompt.
 */
export function styleLine(style: unknown): string {
  const value = (style as StyleGuide | undefined) ?? defaultStyle;
  return JSON.stringify({
    defaultWidth: value.defaultWidth,
    defaultHeight: value.defaultHeight,
    outline: value.outline,
    shadowDirection: value.shadowDirection,
    notes: value.notes,
  });
}
```

and the inner function's body:

```ts
function styleLines(style: unknown): string[] {
  return [styleLine(style)];
}
```

`apps/worker/src/index.ts` — add `paletteCapacity,` to the `@pixelaition/agent` import block and `MAX_COLORS,` to the `@pixelaition/pixel` import block; in the draw submit input:

```ts
          maxWorkers: shape.workers,
          review: shape.review,
          maxPalette: asset ? paletteCapacity(asset.palette.length) : MAX_COLORS,
```

(delete `maxFrames: 12` and `maxPalette: 8`).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @pixelaition/worker exec vitest run src/tasks.test.ts && pnpm --filter @pixelaition/worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/tasks.ts apps/worker/src/index.ts apps/worker/src/tasks.test.ts
git commit -m "feat(worker): submit the real palette room, drop the stale style key"
```

---

### Task 8: Editor — panels and copy

**Files:**

- Modify: `apps/web/src/screens/editor.tsx:115-121,2067-2068`, `apps/web/src/components/editor-panels.tsx:32,732,755-770,774,814-820,947-953`

**Interfaces:**

- Consumes: `StyleGuide` without `maxColors`.
- Produces: no `maxColors` anywhere in `apps/web/src`; the palette panel shows `N colors used`; the layers line reads `N layers`.

- [ ] **Step 1: Implement** (no unit test exists for these panels; Task 10's manual check pins them)

`apps/web/src/screens/editor.tsx` — remove `maxColors: 8,` from `fallbackStyle`; at the `PalettePanel` call site remove the `maxColors={style.maxColors}` line.

`apps/web/src/components/editor-panels.tsx`:

- Drop `maxColors,` from the `PalettePanel` destructuring and `maxColors: number;` from its props type.
- Delete `const over = usedColors > maxColors;`.
- The action span becomes:

```tsx
<span className="flex min-w-0 items-center gap-2">
  <span className="text-pixel-mono text-muted">{usedColors} colors used</span>
</span>
```

- Remove `ProgressCells,` from the `./ui.js` import (its only use was here).
- Line 732: `{layers.length} of 4 layers` → `{layers.length} layers`.
- In `StylePanel`, delete the "max colors" definition row (the `<div>` wrapping `<dt className="text-muted">max colors</dt>` and `<dd className="text-ink">{style.maxColors}</dd>`).

- [ ] **Step 2: Verify nothing references it**

Run: `grep -rn "maxColors\|of 4 layers" apps/web/src` — expect no matches.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @pixelaition/web typecheck && pnpm --filter @pixelaition/web lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/screens/editor.tsx apps/web/src/components/editor-panels.tsx
git commit -m "feat(web): the palette panel counts colours, layers uncapped"
```

---

### Task 9: MCP — palette bound

**Files:**

- Modify: `apps/mcp/src/index.ts:212`

**Interfaces:**

- Produces: the MCP `set_palette` tool accepts up to 256 entries.

- [ ] **Step 1: Implement**

```ts
    inputSchema: { assetId: z.string(), palette: z.array(z.string()).min(2).max(256) },
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @pixelaition/mcp typecheck` (or `pnpm typecheck` if the package has no script)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/index.ts
git commit -m "feat(mcp): set_palette takes the byte bound"
```

---

### Task 10: Sweep, full checks, live acceptance

**Files:** none planned; fix anything the sweep finds.

- [ ] **Step 1: Leftover scan**

```bash
grep -rn "maxFrames\|MAX_LAYERS\|maxColors\|TOO_MANY_COLORS\|at most 12\|four layers\|at most 32\|style guide's colour maximum" packages apps --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: none, except the two intentional parser-sample strings in `packages/agent/src/tasks/asset-draw.test.ts` ("Limits: at most 4 frames") which keep proving `userRequestFromPrompt` still reads historical prompts — leave them.

- [ ] **Step 2: Full workspace checks**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green.

- [ ] **Step 3: Live acceptance (dev stack running)**

1. Editor: on any frame, add layers until you pass 6 — each add succeeds; the panel reads "N layers".
2. Palette: add swatches past 32 — accepted; the panel shows "N colors used"; the style panel has no "max colors" row.
3. Draw a frame using more than 8 colours, then run `critique_frame` via the agent console — no "style guide allows" complaint appears.
4. Submit a small drawing request and open the plan prompt on the run row — it reads "Limits: at most N workers. The palette holds up to 256 entries including transparent; M more can be added." with M = 256 − current palette length.
5. Optional end-to-end: ask for a multi-pose sprite; confirm the plan can exceed 4 layers and 12 frames, the plan card approves, and workers paint.

- [ ] **Step 4: Ledger**

Append a short entry to `.superpowers/sdd/grok-handoff/progress.md` recording the change, the checks, and the live acceptance result.

- [ ] **Step 5: Commit (if the sweep changed anything)**

```bash
git add -A
git commit -m "chore: drawing limits removal sweep"
```

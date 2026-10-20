import { useEffect, useState } from "react";
import {
  availableSizes,
  availableWeights,
  paletteRoles,
  presetAspect,
  presetsByGroup,
  summarizeChecks,
  type Artboard,
  type ArtboardCheck,
  type ArtboardScene,
  type CopyDeck,
  type Element,
  type FormatPreset,
  type TemplateId,
} from "@pixelaition/artboard";
import {
  Button,
  Dialog,
  Field,
  SegmentedControl,
  SelectControl,
  Textarea,
  TextInput,
} from "./ui.js";

/** Artboard editing panels shared by the unified editor. No kit/Studio surface. */
const templates: Array<{ value: TemplateId; label: string }> = [
  { value: "split-copy", label: "Split — copy left, mark right" },
  { value: "stack-copy", label: "Stack — copy top, mark middle" },
  { value: "centered-copy", label: "Centered copy" },
  { value: "centered-mark", label: "Centered mark" },
  { value: "thumbnail", label: "Thumbnail — big mark, bold copy" },
  { value: "banner-copy", label: "Banner — horizontal copy" },
  { value: "profile-mark", label: "Profile mark" },
  { value: "blank", label: "Blank" },
];

export function Inspector({
  board,
  preset,
  copy,
  checks,
  palette,
  spriteChoices,
  selectedElementId,
  tab,
  onTab,
  onTemplate,
  onRename,
  onBackground,
  onUpdateElement,
  onText,
  onRemoveElement,
  onCopy,
  onClearOverrides,
  onSelectElement,
  onAddText,
  onAddElement,
  onImportPalette,
  onImportBackground,
  running,
}: {
  board: Artboard;
  preset: FormatPreset | undefined;
  copy: CopyDeck;
  checks: ArtboardCheck[];
  palette: string[];
  spriteChoices?: Array<{
    assetId: string;
    assetName: string;
    frameId: string;
    frameName: string;
  }>;
  selectedElementId: string | null;
  tab: "layout" | "copy" | "checks";
  onTab: (tab: "layout" | "copy" | "checks") => void;
  onTemplate: (template: TemplateId) => void;
  onRename: (name: string) => void;
  onBackground: (background: ArtboardScene["background"]) => void;
  onUpdateElement: (id: string, patch: Partial<Element>) => void;
  onText: (id: string, text: string, key?: keyof CopyDeck) => void;
  onRemoveElement: (id: string) => void;
  onCopy: (copy: CopyDeck) => void;
  onClearOverrides: () => void;
  onSelectElement: (id: string) => void;
  onAddText: () => void;
  onAddElement: (kind: "rect" | "pattern" | "frame") => void;
  onImportPalette?: () => void;
  onImportBackground?: () => void;
  running: boolean;
}) {
  const [elementId, setElementId] = useState<string | null>(
    board.scene.elements[0]?.id ?? null,
  );
  const [copyDraft, setCopyDraft] = useState<CopyDeck>(copy);
  const [nameDraft, setNameDraft] = useState(board.name);
  useEffect(() => setCopyDraft(copy), [copy]);
  useEffect(() => setNameDraft(board.name), [board.name]);
  useEffect(() => {
    if (selectedElementId) setElementId(selectedElementId);
  }, [selectedElementId]);
  const selected = board.scene.elements.find((element) => element.id === elementId);
  const roles = paletteRoles(palette);
  const summary = summarizeChecks(checks);

  return (
    <div className="grid gap-3">
      <Field label="Frame name" htmlFor="artboard-name">
        <TextInput
          id="artboard-name"
          value={nameDraft}
          disabled={running}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => onRename(nameDraft)}
        />
      </Field>
      <SegmentedControl
        label="Inspector section"
        value={tab}
        options={[
          { value: "layout", label: "Layout" },
          { value: "copy", label: "Copy" },
          { value: "checks", label: `Checks ${checks.length}` },
        ]}
        onChange={(next) => onTab(next as "layout" | "copy" | "checks")}
      />
      {tab === "layout" ? (
        <>
          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Background
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                tone={board.scene.background.kind === "solid" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() => onBackground({ kind: "solid", color: roles.background })}
              >
                Solid
              </Button>
              <Button
                tone={board.scene.background.kind === "transparent" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() => onBackground({ kind: "transparent" })}
              >
                Transparent
              </Button>
              <Button
                tone={board.scene.background.kind === "pattern" ? "solid" : "ghost"}
                className="px-2 py-1 text-pixel-label"
                onClick={() =>
                  onBackground({
                    kind: "pattern",
                    colorA: roles.background,
                    colorB: roles.muted,
                    unit: Math.max(2, board.pixelUnit),
                    mode: "checker",
                  })
                }
              >
                Pattern
              </Button>
              {onImportBackground ? (
                <Button
                  tone="ghost"
                  className="px-2 py-1 text-pixel-label"
                  onClick={onImportBackground}
                >
                  From project
                </Button>
              ) : null}
            </div>
          </section>

          {onImportPalette ? (
            <Button
              tone="ghost"
              className="justify-start px-2 py-1 text-pixel-label"
              onClick={onImportPalette}
            >
              Import project palette
            </Button>
          ) : null}

          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Elements
            </p>
            <div className="grid gap-1">
              {board.scene.elements.map((element) => (
                <button
                  key={element.id}
                  type="button"
                  onClick={() => {
                    setElementId(element.id);
                    onSelectElement(element.id);
                  }}
                  className={`flex items-center justify-between gap-2 border-2 px-2 py-1 text-left ${
                    selected?.id === element.id
                      ? "border-accent text-ink"
                      : "border-transparent text-muted hover:border-line hover:text-ink"
                  }`}
                >
                  <span className="truncate font-mono text-[11px]">
                    {element.kind === "text"
                      ? `“${element.text.slice(0, 22)}”`
                      : element.kind}
                  </span>
                  <span className="font-mono text-[9px] text-muted">
                    {element.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={onAddText}
                disabled={running}
              >
                + Text
              </Button>
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={() => onAddElement("rect")}
                disabled={running}
              >
                + Block
              </Button>
              <Button
                tone="ghost"
                className="px-2 py-1 text-pixel-label"
                onClick={() => onAddElement("pattern")}
                disabled={running}
              >
                + Pattern
              </Button>
            </div>
          </section>

          <section className="grid gap-2 border-2 border-line bg-field p-2">
            <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
              Template
            </p>
            <SelectControl
              label="Template"
              value=""
              options={[{ value: "", label: "Apply a template…" }, ...templates]}
              onChange={(value) => {
                if (value.length > 0) onTemplate(value as TemplateId);
              }}
            />
          </section>

          {selected ? (
            <ElementEditor
              element={selected}
              palette={palette}
              board={board}
              spriteChoices={spriteChoices}
              disabled={running}
              onUpdate={(patch) => onUpdateElement(selected.id, patch)}
              onText={(text) =>
                onText(
                  selected.id,
                  text,
                  ["eyebrow", "headline", "subhead", "cta", "handle", "legal"].includes(
                    selected.id,
                  )
                    ? (selected.id as keyof CopyDeck)
                    : undefined,
                )
              }
              onRemove={() => {
                onRemoveElement(selected.id);
                setElementId(null);
              }}
            />
          ) : null}

          {preset ? (
            <section className="grid gap-1 border-2 border-line bg-field p-2 font-mono text-[10px] text-muted">
              <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
                Format notes
              </p>
              {preset.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <p className="mt-1 break-all">
                {preset.official ? "Official" : "Industry"} · {preset.source} · checked{" "}
                {preset.verifiedAt}
              </p>
            </section>
          ) : null}
        </>
      ) : null}

      {tab === "copy" ? (
        <section className="grid gap-2 border-2 border-line bg-field p-2">
          <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
            Shared copy
          </p>
          <p className="text-[11px] text-muted">
            This deck feeds every format that has not overridden a field. A text edit on a
            board creates an override, not a fork.
          </p>
          {(
            [
              ["eyebrow", "Eyebrow"],
              ["headline", "Headline"],
              ["subhead", "Subhead"],
              ["cta", "CTA"],
              ["handle", "Handle"],
              ["caption", "Post caption"],
            ] as Array<[keyof CopyDeck, string]>
          ).map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`copy-${key}`}>
              <TextInput
                id={`copy-${key}`}
                value={copyDraft[key] ?? ""}
                onChange={(event) =>
                  setCopyDraft({ ...copyDraft, [key]: event.target.value })
                }
              />
            </Field>
          ))}
          <div className="flex flex-wrap gap-1">
            <Button onClick={() => onCopy(copyDraft)} disabled={running}>
              Apply to all formats
            </Button>
            <Button tone="ghost" onClick={onClearOverrides} disabled={running}>
              Reset overrides
            </Button>
          </div>
        </section>
      ) : null}

      {tab === "checks" ? (
        <section className="grid gap-2 border-2 border-line bg-field p-2">
          <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
            {summary.errors} errors · {summary.warnings} warnings
          </p>
          {checks.length === 0 ? (
            <p className="text-[12px] text-muted">No deterministic findings.</p>
          ) : (
            checks.map((check, index) => (
              <div
                key={`${check.code}-${index}`}
                className={`border-l-2 px-2 py-1 ${
                  check.severity === "error" ? "border-erase" : "border-line-strong"
                }`}
              >
                <p className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">
                  {check.code}
                </p>
                <p className="text-[11px] text-ink">{check.message}</p>
              </div>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}

function ElementEditor({
  element,
  palette,
  board,
  spriteChoices,
  disabled,
  onUpdate,
  onText,
  onRemove,
}: {
  element: Element;
  palette: string[];
  board: Artboard;
  spriteChoices?: Array<{
    assetId: string;
    assetName: string;
    frameId: string;
    frameName: string;
  }>;
  disabled: boolean;
  onUpdate: (patch: Partial<Element>) => void;
  onText: (text: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(element.kind === "text" ? element.text : "");
  useEffect(() => {
    if (element.kind === "text") setText(element.text);
  }, [element.kind === "text" ? element.text : ""]);
  return (
    <section className="grid gap-2 border-2 border-line bg-field p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-pixel-mono tracking-[0.14em] text-accent uppercase">
          {element.kind} · {element.id}
        </p>
        <Button
          tone="danger"
          className="px-2 py-1 text-pixel-label"
          onClick={onRemove}
          disabled={disabled}
        >
          Remove
        </Button>
      </div>
      {element.kind === "sprite" && spriteChoices && spriteChoices.length > 0 ? (
        <Field label="Source sprite" htmlFor="element-sprite-source">
          <SelectControl
            id="element-sprite-source"
            label="Source sprite"
            value={`${element.assetId}:${element.frameId ?? ""}`}
            options={spriteChoices.map((choice) => ({
              value: `${choice.assetId}:${choice.frameId}`,
              label: `${choice.assetName} · ${choice.frameName}`,
            }))}
            onChange={(value) => {
              const [assetId, frameId] = value.split(":");
              if (assetId && frameId) onUpdate({ assetId, frameId } as Partial<Element>);
            }}
          />
        </Field>
      ) : null}
      {element.kind === "text" ? (
        <>
          <Field label="Text" htmlFor="element-text">
            <Textarea
              id="element-text"
              value={text}
              rows={2}
              onChange={(event) => setText(event.target.value)}
              onBlur={() => onText(text)}
              disabled={disabled}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Face" htmlFor="element-face">
              <SelectControl
                id="element-face"
                label="Face"
                value={element.face}
                options={["silkscreen", "pixelify", "mono"]}
                onChange={(face) => {
                  const nextFace = face as "silkscreen" | "pixelify" | "mono";
                  const weight = availableWeights(nextFace).includes(element.weight)
                    ? element.weight
                    : (availableWeights(nextFace)[0] ?? 400);
                  const sizes = availableSizes(nextFace, weight);
                  onUpdate({
                    face: nextFace,
                    weight,
                    size: sizes.includes(element.size)
                      ? element.size
                      : (sizes.at(-1) ?? element.size),
                  } as Partial<Element>);
                }}
              />
            </Field>
            <Field label="Weight" htmlFor="element-weight">
              <SelectControl
                id="element-weight"
                label="Weight"
                value={String(element.weight)}
                options={availableWeights(element.face).map(String)}
                onChange={(weight) => {
                  const nextWeight = Number(weight) as 400 | 600 | 700;
                  const sizes = availableSizes(element.face, nextWeight);
                  onUpdate({
                    weight: nextWeight,
                    size: sizes.includes(element.size)
                      ? element.size
                      : (sizes.at(-1) ?? element.size),
                  } as Partial<Element>);
                }}
              />
            </Field>
            <Field label="Size" htmlFor="element-size">
              <SelectControl
                id="element-size"
                label="Size"
                value={String(element.size)}
                options={availableSizes(element.face, element.weight).map(String)}
                onChange={(size) => onUpdate({ size: Number(size) } as Partial<Element>)}
              />
            </Field>
            <Field label="Align" htmlFor="element-align">
              <SelectControl
                id="element-align"
                label="Align"
                value={element.align}
                options={["left", "center", "right"]}
                onChange={(align) =>
                  onUpdate({
                    align: align as "left" | "center" | "right",
                  } as Partial<Element>)
                }
              />
            </Field>
          </div>
        </>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label="X" htmlFor="element-x">
          <TextInput
            id="element-x"
            type="number"
            value={element.x}
            onChange={(event) =>
              onUpdate({ x: Number(event.target.value) } as Partial<Element>)
            }
            disabled={disabled}
          />
        </Field>
        <Field label="Y" htmlFor="element-y">
          <TextInput
            id="element-y"
            type="number"
            value={element.y}
            onChange={(event) =>
              onUpdate({ y: Number(event.target.value) } as Partial<Element>)
            }
            disabled={disabled}
          />
        </Field>
        {element.kind === "sprite" ? (
          <>
            <Field label="Scale" htmlFor="element-scale">
              <TextInput
                id="element-scale"
                type="number"
                min={1}
                max={64}
                value={element.scale}
                onChange={(event) =>
                  onUpdate({
                    scale: Math.max(1, Number(event.target.value)),
                  } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
            <Field label="Anchor" htmlFor="element-anchor">
              <SelectControl
                id="element-anchor"
                label="Anchor"
                value={element.anchor}
                options={[
                  "top-left",
                  "top-center",
                  "top-right",
                  "center-left",
                  "center",
                  "center-right",
                  "bottom-left",
                  "bottom-center",
                  "bottom-right",
                ]}
                onChange={(anchor) => onUpdate({ anchor } as Partial<Element>)}
              />
            </Field>
          </>
        ) : null}
        {element.kind === "text" ? (
          <>
            <Field label="Width" htmlFor="element-width">
              <TextInput
                id="element-width"
                type="number"
                value={element.width}
                onChange={(event) =>
                  onUpdate({ width: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
            <Field label="Max lines" htmlFor="element-lines">
              <TextInput
                id="element-lines"
                type="number"
                min={1}
                max={20}
                value={element.maxLines ?? 3}
                onChange={(event) =>
                  onUpdate({ maxLines: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
          </>
        ) : null}
      </div>
      {"color" in element ? (
        <ColorPicker
          label="Colour"
          palette={palette}
          value={element.color}
          onChange={(color) => onUpdate({ color } as Partial<Element>)}
        />
      ) : null}
      {"colorA" in element ? (
        <>
          <ColorPicker
            label="Colour A"
            palette={palette}
            value={element.colorA}
            onChange={(color) => onUpdate({ colorA: color } as Partial<Element>)}
          />
          <ColorPicker
            label="Colour B"
            palette={palette}
            value={element.colorB}
            onChange={(color) => onUpdate({ colorB: color } as Partial<Element>)}
          />
        </>
      ) : null}
      {element.kind === "rect" || element.kind === "frame" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width" htmlFor="element-w">
            <TextInput
              id="element-w"
              type="number"
              value={element.width}
              onChange={(event) =>
                onUpdate({ width: Number(event.target.value) } as Partial<Element>)
              }
              disabled={disabled}
            />
          </Field>
          <Field label="Height" htmlFor="element-h">
            <TextInput
              id="element-h"
              type="number"
              value={element.height}
              onChange={(event) =>
                onUpdate({ height: Number(event.target.value) } as Partial<Element>)
              }
              disabled={disabled}
            />
          </Field>
          {element.kind === "frame" ? (
            <Field label="Thickness" htmlFor="element-t">
              <TextInput
                id="element-t"
                type="number"
                value={element.thickness}
                onChange={(event) =>
                  onUpdate({ thickness: Number(event.target.value) } as Partial<Element>)
                }
                disabled={disabled}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
      <p className="font-mono text-[10px] text-muted">
        Board {board.width}×{board.height} · x/y in output pixels
      </p>
    </section>
  );
}

function ColorPicker({
  label,
  palette,
  value,
  onChange,
}: {
  label: string;
  palette: string[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <p className="font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {palette.map((hex, index) => (
          <button
            key={`${hex}-${index}`}
            type="button"
            title={`${index} ${hex}`}
            onClick={() => onChange(index)}
            className={`h-6 w-6 border-2 ${
              value === index ? "border-accent" : "border-line hover:border-line-strong"
            }`}
            style={{ background: index === 0 ? "transparent" : hex }}
          />
        ))}
      </div>
    </div>
  );
}

export function FormatPicker({
  open,
  onOpenChange,
  existing,
  onPick,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Set<string>;
  onPick: (presetId: string) => void;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a format"
      description="Native output sizes, safe areas and byte limits come from the format registry."
      width="54rem"
    >
      <Field label="Search" htmlFor="format-search">
        <TextInput
          id="format-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="LinkedIn, Reels, thumbnail…"
        />
      </Field>
      <div className="grid max-h-[60vh] gap-4 overflow-auto pr-1">
        {presetsByGroup().map((group) => {
          const items = group.presets.filter(
            (preset) =>
              query.length === 0 ||
              `${preset.label} ${preset.platform} ${preset.id}`
                .toLowerCase()
                .includes(query),
          );
          if (items.length === 0) return null;
          return (
            <section key={group.group} className="grid gap-2">
              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                {group.label}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(preset.id)}
                    className={`grid gap-1 border-2 p-2 text-left ${
                      existing.has(preset.id)
                        ? "border-line-strong bg-field"
                        : "border-line hover:border-accent"
                    } disabled:opacity-50`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-pixel-label text-ink">
                        {preset.label}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        {preset.width}×{preset.height}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      {preset.platform} · {presetAspect(preset)} ·{" "}
                      {existing.has(preset.id) ? "in asset — add variant" : "add"}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

import type { FrameTag, TagDirection } from "@pixelaition/pixel";
import { useEffect, useState } from "react";
import type { FrameDto } from "../lib/types.js";
import { Button, Checkbox, Field, Panel, SelectControl, TextInput } from "./ui.js";

/**
 * Animation timing lives beside the frames rather than in a separate screen.
 * Durations save per frame; tags save as one list so a range never points at a
 * frame that was deleted halfway through an edit.
 */
export function TimelinePanel({
  frames,
  tags,
  locked,
  onDuration,
  onSaveTags,
}: {
  frames: FrameDto[];
  tags: FrameTag[];
  locked: boolean;
  onDuration: (frameId: string, durationMs: number) => void;
  onSaveTags: (tags: FrameTag[]) => void;
}) {
  const spriteFrames = frames.filter((frame) => frame.kind !== "social");
  const [draft, setDraft] = useState<FrameTag[]>(tags);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(tags);
    setDirty(false);
  }, [tags]);

  function update(index: number, patch: Partial<FrameTag>) {
    setDraft((current) =>
      current.map((tag, position) => (position === index ? { ...tag, ...patch } : tag)),
    );
    setDirty(true);
  }

  function addTag() {
    const first = spriteFrames[0];
    const last = spriteFrames.at(-1);
    if (!first || !last) return;
    setDraft((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: current.length === 0 ? "loop" : `tag-${current.length + 1}`,
        fromFrameId: first.id,
        toFrameId: last.id,
        direction: "forward",
        loop: true,
      },
    ]);
    setDirty(true);
  }

  function removeTag(index: number) {
    setDraft((current) => current.filter((_, position) => position !== index));
    setDirty(true);
  }

  const options = spriteFrames.map((frame) => ({
    value: frame.id,
    label: frame.name,
  }));

  return (
    <Panel
      title="Timeline"
      action={
        <Button
          tone="ghost"
          className="px-2 py-1 text-pixel-label"
          disabled={locked || spriteFrames.length === 0}
          onClick={addTag}
        >
          Add tag
        </Button>
      }
    >
      <div className="grid gap-1">
        {spriteFrames.map((frame) => (
          <label
            key={frame.id}
            className="flex items-center gap-2 border-2 border-transparent px-2 py-1.5 hover:border-line"
          >
            <span className="min-w-0 flex-1 truncate text-pixel-label text-ink">
              {frame.name}
            </span>
            <input
              type="number"
              min={10}
              max={60_000}
              defaultValue={frame.durationMs ?? 100}
              disabled={locked}
              aria-label={`${frame.name} delay in milliseconds`}
              className="w-20 border-2 border-line bg-field px-1.5 py-1 text-right font-mono text-[11px] text-ink outline-none focus:border-accent disabled:opacity-50"
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value >= 10 && value <= 60_000) {
                  onDuration(frame.id, Math.round(value));
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span className="text-pixel-mono text-muted">ms</span>
          </label>
        ))}
      </div>

      {spriteFrames.length > 1 ? (
        <div className="mt-2 grid gap-2 border-t-2 border-line pt-2">
          {draft.map((tag, index) => (
            <div key={tag.id} className="grid gap-1 border-2 border-line p-2">
              <div className="flex items-center gap-2">
                <TextInput
                  aria-label={`Tag ${index + 1} name`}
                  value={tag.name}
                  disabled={locked}
                  className="min-w-0 flex-1 px-1.5 py-1 font-mono text-[11px]"
                  onChange={(event) => update(index, { name: event.currentTarget.value })}
                />
                <Button
                  tone="quiet"
                  className="px-1.5 py-1 text-pixel-mono"
                  disabled={locked}
                  onClick={() => removeTag(index)}
                >
                  Remove
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="From" htmlFor={`tag-from-${tag.id}`}>
                  <SelectControl
                    id={`tag-from-${tag.id}`}
                    label="From"
                    value={tag.fromFrameId}
                    options={options}
                    onChange={(next) => update(index, { fromFrameId: next })}
                  />
                </Field>
                <Field label="To" htmlFor={`tag-to-${tag.id}`}>
                  <SelectControl
                    id={`tag-to-${tag.id}`}
                    label="To"
                    value={tag.toFrameId}
                    options={options}
                    onChange={(next) => update(index, { toFrameId: next })}
                  />
                </Field>
              </div>
              <div className="flex items-end gap-2">
                <Field label="Direction" htmlFor={`tag-direction-${tag.id}`}>
                  <SelectControl
                    id={`tag-direction-${tag.id}`}
                    label="Direction"
                    value={tag.direction}
                    options={["forward", "reverse", "pingpong"]}
                    onChange={(next) =>
                      update(index, { direction: next as TagDirection })
                    }
                  />
                </Field>
                <Checkbox
                  label="Loop"
                  checked={tag.loop}
                  disabled={locked}
                  onChange={(next) => update(index, { loop: next })}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {dirty ? (
        <Button
          tone="solid"
          className="justify-start px-2 py-1 text-pixel-label"
          disabled={locked}
          onClick={() => {
            onSaveTags(draft);
            setDirty(false);
          }}
        >
          Save tags
        </Button>
      ) : null}
    </Panel>
  );
}

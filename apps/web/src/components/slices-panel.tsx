import type { Slice } from "@pixelaition/pixel";
import { useEffect, useState } from "react";
import { Button, Field, Panel, TextInput } from "./ui.js";

/** Asset-level export slices; the same list rides the sheet atlas. */
export function SlicesPanel({
  slices,
  width,
  height,
  locked,
  onSave,
}: {
  slices: Slice[];
  width: number;
  height: number;
  locked: boolean;
  onSave: (slices: Slice[]) => void;
}) {
  const [draft, setDraft] = useState<Slice[]>(slices);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(slices);
    setDirty(false);
  }, [slices]);

  function update(index: number, patch: Partial<Slice>) {
    setDraft((current) =>
      current.map((slice, position) =>
        position === index ? { ...slice, ...patch } : slice,
      ),
    );
    setDirty(true);
  }

  function number(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
  }

  return (
    <Panel
      title="Slices"
      action={
        <Button
          tone="ghost"
          className="px-2 py-1 text-pixel-label"
          disabled={locked}
          onClick={() => {
            setDraft((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                name: `slice-${current.length + 1}`,
                x: 0,
                y: 0,
                width: Math.min(16, width),
                height: Math.min(16, height),
              },
            ]);
            setDirty(true);
          }}
        >
          Add slice
        </Button>
      }
    >
      {draft.length === 0 ? (
        <p className="text-pixel-mono text-muted">
          No slices. Slices become named rectangles in the sheet atlas.
        </p>
      ) : null}
      <div className="grid gap-2">
        {draft.map((slice, index) => (
          <div key={slice.id} className="grid gap-2 border-2 border-line p-2">
            <div className="flex items-center gap-2">
              <TextInput
                aria-label={`Slice ${index + 1} name`}
                value={slice.name}
                disabled={locked}
                className="min-w-0 flex-1 px-1.5 py-1 font-mono text-[11px]"
                onChange={(event) => update(index, { name: event.currentTarget.value })}
              />
              <Button
                tone="quiet"
                className="px-1.5 py-1 text-pixel-mono"
                disabled={locked}
                onClick={() => {
                  setDraft((current) =>
                    current.filter((_, position) => position !== index),
                  );
                  setDirty(true);
                }}
              >
                Remove
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <Field
                  key={key}
                  label={key.toUpperCase()}
                  htmlFor={`slice-${slice.id}-${key}`}
                >
                  <TextInput
                    id={`slice-${slice.id}-${key}`}
                    inputMode="numeric"
                    value={slice[key]}
                    disabled={locked}
                    className="px-1 py-1 font-mono text-[11px]"
                    onChange={(event) =>
                      update(index, {
                        [key]: number(event.currentTarget.value, slice[key]),
                      })
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {(["x", "y"] as const).map((key) => (
                <Field
                  key={key}
                  label={`Pivot ${key.toUpperCase()}`}
                  htmlFor={`pivot-${slice.id}-${key}`}
                >
                  <TextInput
                    id={`pivot-${slice.id}-${key}`}
                    inputMode="numeric"
                    value={slice.pivot?.[key] ?? 0}
                    disabled={locked}
                    className="px-1 py-1 font-mono text-[11px]"
                    onChange={(event) =>
                      update(index, {
                        pivot: {
                          x: slice.pivot?.x ?? 0,
                          y: slice.pivot?.y ?? 0,
                          [key]: number(event.currentTarget.value, 0),
                        },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
        ))}
      </div>
      {dirty ? (
        <Button
          tone="solid"
          className="justify-start px-2 py-1 text-pixel-label"
          disabled={locked}
          onClick={() => {
            onSave(draft);
            setDirty(false);
          }}
        >
          Save slices
        </Button>
      ) : null}
    </Panel>
  );
}

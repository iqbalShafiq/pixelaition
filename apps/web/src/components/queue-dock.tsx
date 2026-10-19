import { useRef } from "react";
import { Check, Close, Menu } from "./pixel-icons.js";
import { Button } from "./ui.js";
import type { QueuedRun } from "../lib/run-queue.js";

/**
 * The follow-up queue, docked above the composer: prompts typed while a run
 * is working. Drag a row by its handle to reorder, click the text to pull it
 * back into the composer, remove it with the cross. "Send now" steers every
 * queued prompt into the live run instead of waiting for the next turn.
 */
export function QueueDock({
  items,
  canSteer,
  busy = false,
  onSendNow,
  onRemove,
  onReorder,
  onRecall,
}: {
  items: QueuedRun[];
  /** A live run exists; without one the queue drains as runs finish. */
  canSteer: boolean;
  /** A steer request is in flight; Send now waits for it. */
  busy?: boolean;
  onSendNow: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRecall: (id: string) => void;
}) {
  const dragIndexRef = useRef<number | null>(null);
  if (items.length === 0) return null;

  return (
    <section
      aria-label="Queued follow-ups"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-panel shadow-[0_3px_0_0_var(--color-field)]"
      style={{ maxWidth: "40rem" }}
    >
      <header className="flex items-center gap-2 border-b-2 border-line px-2 py-1.5">
        <span className="text-pixel-mono tracking-[0.16em] text-muted uppercase">
          queue
        </span>
        <span className="text-pixel-mono text-muted">{items.length}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {canSteer ? (
            <Button onClick={onSendNow} disabled={busy} className="min-h-7 px-2 py-0.5">
              Send now
            </Button>
          ) : null}
        </span>
      </header>
      <ul className="grid max-h-[7.5rem] gap-1 overflow-y-auto overscroll-contain p-1.5">
        {items.map((item, index) => (
          <li
            key={item.id}
            draggable
            onDragStart={(event) => {
              dragIndexRef.current = index;
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragIndexRef.current;
              dragIndexRef.current = null;
              if (from !== null && from !== index) onReorder(from, index);
            }}
            onDragEnd={() => {
              dragIndexRef.current = null;
            }}
            className="group flex min-h-8 items-center gap-1.5 border-2 border-transparent px-1 py-0.5 transition-colors duration-150 hover:border-line hover:bg-raised"
          >
            <span
              aria-hidden
              title="Drag to reorder"
              className="grid h-5 w-5 shrink-0 cursor-grab place-items-center text-muted active:cursor-grabbing"
            >
              <Menu width={12} height={12} />
            </span>
            <button
              type="button"
              onClick={() => onRecall(item.id)}
              title="Pull back into the composer"
              className="min-w-0 flex-1 truncate text-left text-pixel-mono text-ink"
            >
              {item.text}
            </button>
            <button
              type="button"
              aria-label={`Remove "${item.text}"`}
              title="Remove"
              onClick={() => onRemove(item.id)}
              className="grid h-5 w-5 shrink-0 place-items-center border-2 border-transparent text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
            >
              <Close width={10} height={10} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The composer's tiny confirmation that a queue write landed. */
export function QueueHint({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1 text-pixel-mono text-muted">
      <Check width={10} height={10} className="text-accent" />
      {count} queued
    </span>
  );
}

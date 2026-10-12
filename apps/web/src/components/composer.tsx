import { useEffect, useRef, type ReactNode } from "react";
import { Button, SelectControl, Textarea } from "./ui.js";

/**
 * The floating well over the canvas column: prompt, model, effort, go.
 * DESIGN.md: no border radius, 2px borders, the solid lift bar, motion that
 * only touches transform and opacity.
 */
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
  starting = false,
  stopping = false,
  modelReady,
  onGenerate,
  onStop,
  onQueue,
  scope,
  blockedReason,
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
  /** An optimistic start is in flight; the button says so immediately. */
  starting?: boolean;
  /** An optimistic stop is in flight; the button says so immediately. */
  stopping?: boolean;
  modelReady: boolean;
  onGenerate: () => void;
  onStop: () => void;
  /** While a run is working, text goes to the follow-up queue instead. */
  onQueue?: (() => void) | undefined;
  /** An extra bar control before the model select (the home scope picker). */
  scope?: ReactNode;
  /** A named cause that keeps the run from starting; shown in the bar. */
  blockedReason?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "0px";
    area.style.height = `${Math.min(area.scrollHeight, 144)}px`;
  }, [prompt]);

  const blocked = Boolean(blockedReason);
  const noCatalog = models.length === 0 || efforts.length === 0;
  const modelOptions = models.length > 0 ? models : ["no models"];
  const hasText = prompt.trim().length > 0;
  const canQueue =
    running && hasText && onQueue !== undefined && modelReady && !noCatalog && !blocked;
  const queueable = running && hasText && onQueue !== undefined;

  return (
    <section
      aria-label="Prompt composer"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-field shadow-[0_3px_0_0_var(--color-panel)] transition-colors duration-150 focus-within:border-accent"
      style={{ maxWidth: "40rem" }}
    >
      <Textarea
        bare
        ref={areaRef}
        value={prompt}
        aria-label="Prompt"
        placeholder={
          starting
            ? "Starting the run…"
            : running
              ? "The agent is working — type a follow-up to queue it"
              : "Describe the pixel asset, ask a question, or request another state of this frame"
        }
        className="min-h-[2.75rem] px-3 py-2.5"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (canQueue) onQueue();
            else if (!running && hasText && modelReady && !noCatalog && !blocked) {
              onGenerate();
            }
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        onChange={(event) => onPrompt(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        {scope}
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
        {blocked ? (
          <span className="text-pixel-mono text-muted">{blockedReason}</span>
        ) : !modelReady ? (
          <span className="text-pixel-mono text-muted">
            AGENT_API_KEY is missing on the server
          </span>
        ) : noCatalog ? (
          <span className="text-pixel-mono text-muted">the model catalog is empty</span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {starting ? (
            <Button disabled>Starting…</Button>
          ) : running ? (
            stopping ? (
              <Button tone="danger" disabled>
                Stopping…
              </Button>
            ) : queueable ? (
              <Button
                onClick={onQueue}
                disabled={!modelReady || noCatalog || blocked}
                title="Run this when the current run finishes, or Send now from the queue"
              >
                Add to queue
              </Button>
            ) : (
              <Button tone="danger" onClick={onStop}>
                Stop
              </Button>
            )
          ) : (
            <Button
              onClick={onGenerate}
              disabled={!hasText || !modelReady || noCatalog || !modelId || blocked}
            >
              Send
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}

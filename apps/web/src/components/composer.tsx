import { useEffect, useRef } from "react";
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
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-field shadow-[0_3px_0_0_var(--color-panel)] transition-colors duration-150 focus-within:border-accent"
      style={{ maxWidth: "40rem" }}
    >
      <Textarea
        bare
        ref={areaRef}
        value={prompt}
        aria-label="Prompt"
        placeholder="Describe the pixel asset, or ask for another state of this frame"
        className="min-h-[2.75rem] px-3 py-2.5"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!running && prompt.trim() && modelReady && !noCatalog) onGenerate();
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        onChange={(event) => onPrompt(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
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
          <span className="text-pixel-mono text-muted">
            OPENAI_API_KEY is missing on the server
          </span>
        ) : noCatalog ? (
          <span className="text-pixel-mono text-muted">the model catalog is empty</span>
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

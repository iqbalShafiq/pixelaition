import { StreamMarkdown } from "@anvia/react-ui/stream";
import { useEffect, useRef } from "react";
import { Button, Callout, IconButton, SelectControl, Textarea } from "./ui.js";

export type ActivityLine = { id: string; text: string };

/**
 * The composer is its own 220px band, and it expands. The model and effort
 * pickers live inside the prompt field, as the plan asks.
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
  activity,
  message,
  error,
  expanded,
  onExpanded,
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
  activity: ActivityLine[];
  message: string;
  error: string | null;
  expanded: boolean;
  onExpanded: (next: boolean) => void;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [activity, message]);

  const modelOptions = models.length > 0 ? models : ["No models listed"];
  // No invented effort options: an empty list means Generate stays disabled.
  const effortOptions = efforts;

  return (
    <section
      className={`grid min-h-0 min-w-0 grid-rows-[auto_1fr] gap-2 border-t-2 border-line bg-paper p-3 transition-[height] duration-200 ease-out ${
        expanded ? "h-[22rem]" : "h-[13.75rem]"
      }`}
      aria-label="Prompt composer"
    >
      <header className="flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">
          {running ? "Drawing" : "Prompt"}
        </span>
        {running ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-accent">
            <span className="inline-block h-1.5 w-1.5 animate-pulse bg-accent" />
            the agent is working
          </span>
        ) : null}
        <span className="ml-auto">
          <IconButton
            label={expanded ? "Collapse the composer" : "Expand the composer"}
            size="sm"
            onClick={() => onExpanded(!expanded)}
          >
            {expanded ? "▾" : "▴"}
          </IconButton>
        </span>
      </header>

      <div className="grid min-h-0 min-w-0 gap-2 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="relative flex min-h-0 flex-1 flex-col border-2 border-line bg-field focus-within:border-accent">
            <Textarea
              value={prompt}
              aria-label="Prompt"
              placeholder="Describe the pixel asset, or ask for another state of this frame"
              className="min-h-0 flex-1 border-0 bg-transparent focus:border-0"
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
                value={effortOptions.includes(effort) ? effort : (effortOptions[0] ?? "")}
                options={effortOptions}
                onChange={onEffort}
              />
              <span className="ml-auto flex gap-1.5">
                {running ? (
                  <Button tone="danger" onClick={onStop}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    onClick={onGenerate}
                    disabled={
                      !prompt.trim() ||
                      !modelReady ||
                      !modelId ||
                      effortOptions.length === 0
                    }
                  >
                    Generate
                  </Button>
                )}
              </span>
            </div>
          </div>
          {!modelReady ? (
            <Callout>
              Manual editing works without a model. Add OPENAI_API_KEY on the server to
              generate, or set DECISION_MODEL to route an offline decision.
            </Callout>
          ) : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </div>

        <div
          ref={logRef}
          className="min-h-0 overflow-auto border-2 border-line bg-field p-2"
          aria-live="polite"
        >
          {activity.length === 0 && !message ? (
            <p className="font-mono text-[10px] text-muted">
              The agent&apos;s reasoning and tool calls appear here, one step at a time.
            </p>
          ) : null}
          <ul className="grid gap-1">
            {activity.slice(-40).map((line) => (
              <li key={line.id} className="font-mono text-[10px] text-muted">
                {line.text}
              </li>
            ))}
          </ul>
          {message ? (
            <div className="mt-2 border-t-2 border-line pt-2 text-xs text-ink">
              <StreamMarkdown content={message} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

import { StreamMarkdown } from "@anvia/react-ui/stream";
import { Button, ModelSelect, TextInput } from "./ui.js";

export type ActivityLine = { id: string; text: string };

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
  onGenerate: () => void;
  onStop: () => void;
}) {
  const options = models.length > 0 ? models : ["No models listed"];
  const effortOptions = efforts.length > 0 ? efforts : ["none", "low", "medium", "high"];
  const recent = activity.slice(-6);
  return (
    <div className="grid gap-2">
      {recent.length > 0 ? (
        <ul className="grid gap-0.5">
          {recent.map((line) => (
            <li key={line.id} className="font-mono text-[11px] text-muted">
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <div className="max-h-32 overflow-auto text-sm text-ink">
          <StreamMarkdown content={message} />
        </div>
      ) : null}
      {error ? <p className="text-sm text-erase">{error}</p> : null}
      {!modelReady ? (
        <p className="text-xs text-muted">
          Manual editing works without a model. Add OPENAI_API_KEY on the server to
          generate.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          className="min-w-64 flex-1"
          value={prompt}
          aria-label="Prompt"
          placeholder="Describe the pixel asset or a new state"
          onChange={(event) => onPrompt(event.target.value)}
        />
        <ModelSelect
          label="Model"
          value={models.includes(modelId) ? modelId : (options[0] ?? "")}
          options={options}
          onChange={onModel}
        />
        <ModelSelect
          label="Reasoning effort"
          value={effortOptions.includes(effort) ? effort : (effortOptions[0] ?? "")}
          options={effortOptions}
          onChange={onEffort}
        />
        {running ? (
          <Button tone="danger" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={onGenerate}
            disabled={!prompt.trim() || !modelReady || !modelId}
          >
            Generate
          </Button>
        )}
      </div>
    </div>
  );
}

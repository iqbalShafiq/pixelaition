import { useEffect, useRef, useState, type ReactNode } from "react";
import { MAX_ATTACHMENTS, type PreparedAttachment } from "../lib/attachments.js";
import { Attach, Info, Select } from "./pixel-icons.js";
import { Button, IconButton, SelectControl, Textarea } from "./ui.js";

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
  attachments = [],
  attachmentError,
  attachmentIssue,
  onAttach,
  onRemoveAttachment,
  frameContext,
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
  /** Reference images staged for the next message. */
  attachments?: PreparedAttachment[];
  /** Why the last attach was refused. */
  attachmentError?: string | undefined;
  /** Why the staged attachments cannot reach the selected model. */
  attachmentIssue?: string | undefined;
  onAttach?: ((files: Iterable<File>) => void) | undefined;
  onRemoveAttachment?: ((id: string) => void) | undefined;
  /** When present, the composer can anchor a message to the frame in view. */
  frameContext?: { name: string; enabled: boolean; onToggle: () => void } | undefined;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
  // Attachments belong to a fresh message; a live run takes queue text only.
  const attachable =
    !running &&
    !starting &&
    onAttach !== undefined &&
    attachments.length < MAX_ATTACHMENTS;
  const showAttachments =
    attachments.length > 0 ||
    attachmentError !== undefined ||
    attachmentIssue !== undefined;

  return (
    <section
      aria-label="Prompt composer"
      className={`pointer-events-auto pixel-corners-sm w-full border-2 bg-field shadow-[0_3px_0_0_var(--color-panel)] transition-colors duration-150 focus-within:border-accent ${
        dragging ? "border-accent" : "border-line-strong"
      }`}
      style={{ maxWidth: "40rem" }}
      onDragOver={(event) => {
        if (!attachable) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!attachable) return;
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length > 0) onAttach?.(event.dataTransfer.files);
      }}
    >
      {showAttachments ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b-2 border-line px-2 py-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="pixel-corners-sm inline-flex items-center gap-1.5 border-2 border-line-strong bg-panel py-0.5 pr-1 pl-0.5 transition-colors duration-150 hover:bg-raised"
              title={`${attachment.name} — ${attachment.width}×${attachment.height}`}
            >
              <img
                src={attachment.preview}
                alt={attachment.name}
                className="h-8 w-8 object-contain"
                style={{ imageRendering: "pixelated" }}
              />
              <span className="text-pixel-mono max-w-[7rem] truncate text-muted">
                {attachment.name}
              </span>
              {onRemoveAttachment ? (
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  className="text-pixel-mono px-0.5 text-muted hover:text-accent"
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
          {attachable ? (
            <button
              type="button"
              aria-label="Add another reference image"
              className="pixel-corners-sm inline-flex h-10 items-center gap-1 border-2 border-dashed border-line px-2 text-pixel-mono text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
              onClick={() => fileRef.current?.click()}
            >
              ＋ Add
            </button>
          ) : null}
          {attachmentError !== undefined ? (
            <span className="flex items-center gap-1 text-pixel-mono text-muted">
              <Info width={12} height={12} />
              {attachmentError}
            </span>
          ) : null}
          {attachmentIssue !== undefined ? (
            <span className="flex items-center gap-1 text-pixel-mono text-muted">
              <Info width={12} height={12} />
              {attachmentIssue}
            </span>
          ) : null}
        </div>
      ) : null}
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
              : "Describe the pixel asset, ask a question, or attach a reference image"
        }
        className="min-h-[2.75rem] px-3 py-2.5"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (canQueue) onQueue();
            else if (
              !running &&
              hasText &&
              modelReady &&
              !noCatalog &&
              !blocked &&
              attachmentIssue === undefined
            ) {
              onGenerate();
            }
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        onChange={(event) => onPrompt(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        {scope}
        {frameContext?.enabled ? (
          <span className="pixel-corners-sm flex min-h-10 items-center border-2 border-accent bg-accent/15 px-2 text-pixel-mono text-accent">
            {frameContext.name}
          </span>
        ) : null}
        {frameContext !== undefined ? (
          <IconButton
            label="About this frame"
            hint="Send the message to this frame's worker"
            size="lg"
            active={frameContext.enabled}
            subtle
            disabled={blocked}
            onClick={frameContext.onToggle}
          >
            <Select />
          </IconButton>
        ) : null}
        <IconButton
          label="Attach reference images"
          hint={`PNG, JPEG, WebP, or GIF, up to ${MAX_ATTACHMENTS}`}
          size="lg"
          disabled={!attachable || !modelReady || noCatalog || blocked}
          onClick={() => fileRef.current?.click()}
        >
          <Attach />
        </IconButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) onAttach?.(files);
            event.target.value = "";
          }}
        />
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
              disabled={
                !hasText ||
                !modelReady ||
                noCatalog ||
                !modelId ||
                blocked ||
                attachmentIssue !== undefined
              }
            >
              Send
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}

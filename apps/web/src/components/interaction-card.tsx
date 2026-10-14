import { motion } from "motion/react";
import { agentLabel } from "../lib/agent-label.js";
import { TruncatedText } from "./ui.js";
import { useState } from "react";
import { FrameThumb } from "./editor-panels.js";
import { Button, Checkbox, SelectControl, Textarea, TextInput } from "./ui.js";
import {
  answerValue,
  isTargetQuestion,
  type AnswerState,
  type InteractionQuestion,
} from "../lib/interaction-answers.js";
import type { FrameDto } from "../lib/types.js";

export type { InteractionQuestion } from "../lib/interaction-answers.js";

/**
 * The pending card as the worker publishes it: no call ids. An approval
 * carries the tool arguments as `input` and, when one produced it, the reason
 * (the Jev request check's verdict). A question carries its prompts. The card
 * is the only place either type is answered.
 */
export type PendingInteraction = {
  id: string;
  type: "tool-approval" | "tool-question";
  toolName: string;
  reason?: string;
  questions?: InteractionQuestion[];
  input?: unknown;
};

/** The canonical Anvia response bodies the worker parses. */
export type InteractionResponse =
  | { type: "tool-approval"; approved: boolean; reason?: string }
  | { type: "tool-question"; answers: Array<{ questionId: string; value: string }> };

/** One frame of a staged plan edit, shaped exactly like the stage-override schema. */
export type StagedPlanFrame = { frameId?: string; name: string; description: string };
export type StagedPlanExtras = {
  workers?: Array<{ key: string; frames: string[] }>;
  palette?: Array<{ color: string; name: string }>;
  references?: Array<{ url: string; note: string }>;
};

/** steps(4, end): the card lands on whole pixels, never a smooth glide. */
const steppedEase = (t: number) => Math.min(1, Math.floor(t * 4) / 4);

/**
 * `present_plan`'s arguments, read defensively because the stream carries them
 * as unknown. A frame without a name or description is not a plan frame.
 */
function planInput(
  input: unknown,
): { summary: string; frames: StagedPlanFrame[]; extras: StagedPlanExtras } | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.frames)) return null;
  const frames: StagedPlanFrame[] = [];
  for (const item of value.frames) {
    if (!item || typeof item !== "object") continue;
    const frame = item as Record<string, unknown>;
    if (typeof frame.name !== "string" || typeof frame.description !== "string") continue;
    frames.push({
      ...(typeof frame.frameId === "string" ? { frameId: frame.frameId } : {}),
      name: frame.name,
      description: frame.description,
    });
  }
  const extras: StagedPlanExtras = {};
  if (Array.isArray(value.workers)) {
    const workers = value.workers
      .filter(
        (item): item is { key: string; frames: string[] } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { key?: unknown }).key === "string" &&
          Array.isArray((item as { frames?: unknown }).frames),
      )
      .map((item) => ({
        key: item.key,
        frames: (item.frames as unknown[]).filter(
          (name): name is string => typeof name === "string",
        ),
      }));
    if (workers.length > 0) extras.workers = workers;
  }
  if (Array.isArray(value.palette)) {
    const palette = value.palette
      .filter(
        (item): item is { color: string; name: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { color?: unknown }).color === "string" &&
          typeof (item as { name?: unknown }).name === "string",
      )
      .map((item) => ({ color: item.color, name: item.name }));
    if (palette.length > 0) extras.palette = palette;
  }
  if (Array.isArray(value.references)) {
    const references = value.references
      .filter(
        (item): item is { url: string; note: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { url?: unknown }).url === "string",
      )
      .map((item) => ({
        url: item.url,
        note:
          typeof (item as { note?: unknown }).note === "string"
            ? (item as { note: string }).note
            : "",
      }));
    if (references.length > 0) extras.references = references;
  }
  return {
    summary: typeof value.summary === "string" ? value.summary : "",
    frames,
    extras,
  };
}

/**
 * The interaction card: the plan to confirm or the questions to answer. It
 * renders in the run console above the composer; answering it is the run's
 * only way forward, so nothing here is invented — the frames, choices, and
 * summary are the agent's own payload.
 */
export function InteractionCard({
  interaction,
  frames,
  palette,
  projects,
  assets,
  onRespond,
  onEscape,
}: {
  interaction: PendingInteraction;
  frames: FrameDto[];
  palette: string[];
  /** Live library for target questions; omitted keeps the default card. */
  projects?: Array<{ id: string; name: string }>;
  assets?: Array<{ id: string; projectId: string; name: string }>;
  /** Stages a scope edit (when one exists) before responding. Rejects on failure. */
  onRespond: (
    response: InteractionResponse,
    stagedFrames?: StagedPlanFrame[],
  ) => Promise<void>;
  /** Escape hands the keyboard back to the prompt composer. */
  onEscape: () => void;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: steppedEase }}
      aria-label={
        interaction.type === "tool-approval"
          ? "Approve the agent's request"
          : "Answer the agent"
      }
      className="pointer-events-auto pixel-window flex max-h-[38vh] min-h-0 w-full max-w-full flex-col bg-panel"
      style={{ maxWidth: "40rem" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {interaction.type === "tool-approval" ? (
          <ApprovalBody
            interaction={interaction}
            frames={frames}
            palette={palette}
            onRespond={onRespond}
          />
        ) : (
          <QuestionBody
            interaction={interaction}
            projects={projects}
            assets={assets}
            onRespond={onRespond}
          />
        )}
      </div>
    </motion.section>
  );
}

/* ----------------------------------------------------------------- approval */

function ApprovalBody({
  interaction,
  frames,
  palette,
  onRespond,
}: {
  interaction: PendingInteraction;
  frames: FrameDto[];
  palette: string[];
  onRespond: (
    response: InteractionResponse,
    stagedFrames?: StagedPlanFrame[],
  ) => Promise<void>;
}) {
  const plan = planInput(interaction.input);
  const planFrames = plan?.frames ?? [];
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));
  // Frames are included unless the user explicitly unchecks them, keyed by the
  // plan's own position: a proposed frame has no frameId yet, so only the
  // index lets it be pruned like any other. The plan that arrives before the
  // asset query settles still reads correctly.
  const [removed, setRemoved] = useState<Set<number>>(() => new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const staged = planFrames.filter((_, index) => !removed.has(index));
  const edited = removed.size > 0;
  const empty = planFrames.length > 0 && staged.length === 0;

  async function submit(approved: boolean) {
    if (busy || (approved && empty)) return;
    setBusy(true);
    try {
      const reason = note.trim();
      await onRespond(
        { type: "tool-approval", approved, ...(reason ? { reason } : {}) },
        // A denial clears any staged edit on the worker; only an approval
        // carries the user's scope back.
        approved && edited ? staged : undefined,
      );
    } catch {
      setBusy(false);
    }
  }

  const inputLines = plan
    ? []
    : Object.entries(
        interaction.input &&
          typeof interaction.input === "object" &&
          !Array.isArray(interaction.input)
          ? (interaction.input as Record<string, unknown>)
          : {},
      ).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : (JSON.stringify(value) ?? "null"),
      }));

  return (
    <>
      <h3 className="text-pixel-title text-accent">
        {plan ? "Confirm the plan" : `Confirm ${interaction.toolName}`}
      </h3>
      {!plan && interaction.reason ? (
        <p className="mt-1 text-pixel-mono text-muted">{interaction.reason}</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 pb-1">
        {plan !== null ? (
          <>
            {plan.summary ? (
              <p className="mt-2 text-pixel-body text-ink">{plan.summary}</p>
            ) : null}
            {plan.extras.workers !== undefined ? (
              <ul className="mt-2 grid gap-1 text-pixel-mono text-muted">
                {plan.extras.workers.map((worker) => (
                  <li key={worker.key}>
                    <span className="text-accent">{agentLabel(worker.key)}</span> →{" "}
                    {worker.frames.join(", ")}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.extras.palette !== undefined ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-pixel-mono text-muted">
                <span>palette +{plan.extras.palette.length}</span>
                {plan.extras.palette.map((entry) => (
                  <span
                    key={`${entry.color}-${entry.name}`}
                    className="flex items-center gap-1"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 border-2 border-line"
                      style={{ backgroundColor: entry.color }}
                    />
                    {entry.name}
                  </span>
                ))}
              </div>
            ) : null}
            {plan.extras.references !== undefined ? (
              <p className="mt-2 text-pixel-mono text-muted">
                {plan.extras.references.length} reference
                {plan.extras.references.length === 1 ? "" : "s"} to look at
              </p>
            ) : null}
          </>
        ) : null}
        {inputLines.length > 0 ? (
          <ul className="mt-2 grid gap-0.5">
            {inputLines.map((line) => (
              <li key={line.key} className="text-pixel-mono text-ink">
                <span className="text-muted">{line.key}:</span> {line.value}
              </li>
            ))}
          </ul>
        ) : null}
        {planFrames.length > 0 ? (
          <ul className="mt-2 grid gap-1.5">
            {planFrames.map((frame, index) => {
              const assetFrame = frame.frameId ? frameById.get(frame.frameId) : undefined;
              return (
                <li
                  key={frame.frameId ?? `new-${index}`}
                  className="flex items-center gap-2 border-2 border-line bg-field px-2 py-1"
                >
                  {assetFrame ? (
                    <FrameThumb frame={assetFrame} palette={palette} />
                  ) : (
                    <span
                      aria-hidden
                      className="grid h-7 w-7 shrink-0 place-items-center border-2 border-line bg-screen text-pixel-mono text-[10px] text-muted"
                    >
                      new
                    </span>
                  )}
                  <span className="w-0 min-w-0 flex-1">
                    <span className="block truncate text-[12px] leading-4 text-ink">
                      {frame.name}
                    </span>
                    <TruncatedText
                      text={frame.description}
                      className="text-pixel-mono text-[11px] leading-4 text-muted"
                    />
                  </span>
                  <Checkbox
                    hideLabel
                    label={`Include ${frame.name}`}
                    checked={!removed.has(index)}
                    disabled={busy}
                    onChange={(next) =>
                      setRemoved((current) => {
                        const indexes = new Set(current);
                        if (next) indexes.delete(index);
                        else indexes.add(index);
                        return indexes;
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <Textarea
        value={note}
        aria-label="Note to the agent"
        placeholder="Add a note…"
        rows={2}
        className="mt-2 min-h-[2.25rem]"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit(true);
          }
        }}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={busy || empty} onClick={() => void submit(true)}>
          Continue
        </Button>
        <Button tone="danger" disabled={busy} onClick={() => void submit(false)}>
          {plan ? "Deny plan" : "Deny call"}
        </Button>
        {empty ? (
          <span className="text-pixel-mono text-erase">keep at least one frame</span>
        ) : null}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- questions */

function QuestionBody({
  interaction,
  onRespond,
  projects = [],
  assets = [],
}: {
  interaction: PendingInteraction;
  onRespond: (response: InteractionResponse) => Promise<void>;
  /** Live library for the target questions; empty keeps the default card. */
  projects?: Array<{ id: string; name: string }>;
  assets?: Array<{ id: string; projectId: string; name: string }>;
}) {
  const questions = interaction.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [busy, setBusy] = useState(false);

  const setChoice = (id: string, choice: string) =>
    setAnswers((current) => ({ ...current, [id]: { text: "", choice } }));
  const setText = (id: string, text: string) =>
    setAnswers((current) => ({ ...current, [id]: { ...current[id], text } }));

  /** The default card: the model's choices plus an always-available free text. */
  function defaultBody(question: InteractionQuestion, state: AnswerState | undefined) {
    const multi = question.id.endsWith("_multi");
    const typed = (state?.text.trim() ?? "") !== "";
    const selected = state?.multi ?? [];
    return (
      <>
        {question.choices && question.choices.length > 0 ? (
          <div className="mt-1.5 grid gap-1.5">
            {question.choices.map((choice) => (
              <Checkbox
                key={choice.value}
                label={choice.label}
                checked={
                  multi
                    ? !typed && selected.includes(choice.value)
                    : !typed && state?.choice === choice.value
                }
                disabled={busy}
                onChange={(next) =>
                  setAnswers((current) => {
                    const previous = current[question.id];
                    if (multi) {
                      const values = new Set(previous?.multi ?? []);
                      if (next) values.add(choice.value);
                      else values.delete(choice.value);
                      return {
                        ...current,
                        [question.id]: { text: "", multi: [...values] },
                      };
                    }
                    return {
                      ...current,
                      [question.id]: { text: "", choice: choice.value },
                    };
                  })
                }
              />
            ))}
          </div>
        ) : null}
        <Textarea
          value={state?.text ?? ""}
          aria-label={`Or answer in your own words: ${question.text}`}
          placeholder="Or type your own answer…"
          rows={1}
          disabled={busy}
          className="mt-2"
          onChange={(event) => setText(question.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </>
    );
  }

  const complete = questions.every(
    (question) => answerValue(question, answers[question.id]) !== "",
  );

  async function submit() {
    if (busy || !complete) return;
    setBusy(true);
    try {
      await onRespond({
        type: "tool-question",
        answers: questions.map((question) => ({
          questionId: question.id,
          value: answerValue(question, answers[question.id]),
        })),
      });
    } catch {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        <h3 className="text-pixel-title text-accent">The agent asks</h3>
        <div className="mt-2 grid gap-2">
          {questions.map((question) => {
            const state = answers[question.id];
            const target = isTargetQuestion(question.id) ? question.id : undefined;
            const chosenProject = answers.project?.choice;
            const assetOptions =
              chosenProject === undefined || chosenProject === "new"
                ? assets
                : assets.filter((asset) => asset.projectId === chosenProject);
            return (
              <fieldset key={question.id} className="border-2 border-line bg-field p-2.5">
                <legend className="px-1 text-[13px] text-ink">{question.text}</legend>
                {target === "project" && projects.length > 0 ? (
                  <SelectControl
                    label="Project"
                    value={state?.choice ?? ""}
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    }))}
                    onChange={(value) => setChoice(question.id, value)}
                    className="mt-1.5"
                  />
                ) : target === "asset" && assetOptions.length > 0 ? (
                  <SelectControl
                    label="Asset"
                    value={state?.choice ?? ""}
                    options={[
                      ...assetOptions.map((asset) => ({
                        value: asset.id,
                        label: asset.name,
                      })),
                      { value: "new", label: "＋ New asset" },
                      { value: "none", label: "No asset" },
                    ]}
                    onChange={(value) => setChoice(question.id, value)}
                    className="mt-1.5"
                  />
                ) : target === "project_name" || target === "asset_name" ? (
                  <TextInput
                    value={state?.text ?? ""}
                    aria-label={question.text}
                    placeholder="name"
                    disabled={busy}
                    className="mt-1.5"
                    onChange={(event) => setText(question.id, event.target.value)}
                  />
                ) : (
                  defaultBody(question, state)
                )}
                {(target === "project" && projects.length > 0) ||
                (target === "asset" && assetOptions.length > 0) ? (
                  <TextInput
                    value={state?.text ?? ""}
                    aria-label={`Or answer in your own words: ${question.text}`}
                    placeholder="Or type your own answer…"
                    disabled={busy}
                    className="mt-2"
                    onChange={(event) => setText(question.id, event.target.value)}
                  />
                ) : null}
              </fieldset>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button disabled={busy || !complete} onClick={() => void submit()}>
          Continue
        </Button>
        {complete ? null : (
          <span className="text-pixel-mono text-muted">
            every question needs an answer
          </span>
        )}
      </div>
    </>
  );
}

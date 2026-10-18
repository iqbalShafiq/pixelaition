import { StreamMarkdown } from "@anvia/react-ui/stream";
import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  Checklist,
  Clipboard,
  Close,
  Dither,
  Eraser,
  Eye,
  Fill,
  Flip,
  Folder,
  Grid,
  Line,
  Outline,
  Palette,
  Pencil,
  Play,
  Select,
  Square,
  Wrench,
  Info,
  Send,
  type IconProps,
} from "./pixel-icons.js";
import { agentLabel } from "../lib/agent-label.js";
import { consoleTabs, type ConsoleTurn, type RunRow } from "../lib/run-activity.js";
import { TurnPrompt } from "./turn-prompt.js";
import {
  contextBarCells,
  contextTone,
  formatCost,
  formatDuration,
  formatTokens,
  formatWindow,
  headerTotals,
  userMetaParts,
  type LiveTurn,
  type SessionTotals,
} from "../lib/run-usage.js";
import {
  InteractionCard,
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "./interaction-card.js";
import { PixelLoader } from "./pixel-loader.js";
import { Popover } from "./ui.js";
import type { FrameDto } from "../lib/types.js";

const toolIcons: Record<string, ComponentType<IconProps>> = {
  paint_stroke: Pencil,
  erase_stroke: Eraser,
  draw_line: Line,
  fill_rect: Square,
  fill_region: Fill,
  clear_region: Eraser,
  flood_fill: Fill,
  replace_color: Palette,
  resize_canvas: Grid,
  apply_outline: Outline,
  dither_rect: Dither,
  set_palette: Palette,
  read_frame: Eye,
  read_region: Select,
  preview_frame: Eye,
  read_project: Folder,
  critique_frame: Clipboard,
  check_animation: Play,
  plan: Checklist,
  think: Brain,
  mirror_frame: Flip,
  follow_up: Checklist,
};

/** The phase a person reads. The task stores plan, execute, and review. */
function phaseLabel(phase: string): string {
  if (phase === "plan") return "planning";
  if (phase === "review") return "reviewing";
  if (phase === "execute") return "drawing";
  return phase;
}

/** Status labels a run or task really ends on; notes are not outcomes. */
const TERMINAL_WORDS = new Set(["running", "completed", "failed", "cancelled"]);

/** The text of a row the agent said to the user; routing notes and thoughts
 * have none, so they keep their log line. */
function agentMessageText(row: RunRow): string | null {
  if (row.kind !== "supervisor") return null;
  if (row.channel === "thinking" || row.to !== undefined || row.held === true)
    return null;
  return row.message;
}

/**
 * The context window as one hard-edged rectangle: ten cells inside a bordered
 * well, filled from the left. As the window fills the cells dither from
 * `accent` toward `erase`, so a nearly full window reads as danger before it
 * overflows. No rounding, no opacity: every cell is a palette colour.
 */
function ContextBar({ percent }: { percent: number }) {
  const filled = contextBarCells(percent);
  const tone = contextTone(percent);
  return (
    <span
      aria-hidden
      className="flex h-3 w-16 items-stretch gap-px border-2 border-line bg-field"
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={`flex-1 ${
            index >= filled
              ? ""
              : tone === "danger" || (tone === "warm" && index % 2 === 0)
                ? "bg-erase"
                : "bg-accent"
          }`}
        />
      ))}
    </span>
  );
}

/**
 * The exact tokens behind a console line. The header's context cell is one
 * generation's window state; this popover is the additive side — input, cached
 * input, and output, read straight from the persisted usage — so a session
 * whose runs predate the window snapshot still shows its real spend on hover.
 */
function TokenPopover({
  title,
  rows,
  trigger,
  align = "start",
  triggerClassName,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
  trigger: ReactNode;
  align?: "start" | "end";
  triggerClassName: string;
}) {
  return (
    <Popover
      label={`${title} details`}
      openOnHover
      align={align}
      trigger={trigger}
      triggerClassName={triggerClassName}
      popupClassName="w-56"
    >
      <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">{title}</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-pixel-mono">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted">{row.label}</dt>
            <dd className="text-right text-ink">{row.value.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
}

/** Where a follow-up sits, under the user's own words. */
function followUpStatus(row: Extract<RunRow, { kind: "steering" }>): string {
  const frame = row.frameName ? ` · ${row.frameName}` : "";
  if (row.delivery === "record") return "";
  if (row.delivery === "clarify") return `not sent yet · pick a frame${frame}`;
  if (row.delivery === "queued") return `queued for the next turn${frame}`;
  if (row.delivery === "applied") return `applied on the next turn${frame}`;
  if (row.relayed === true || row.delivery === "relayed") {
    const who =
      row.routed === "supervisor" || row.routed === "plan"
        ? "Supervisor"
        : agentLabel(row.routed);
    return `sent to ${who}${frame}`;
  }
  return `with the supervisor${frame}`;
}

/** The settled requests of this asset, for the header's word when nothing is
 * on screen. Their steps are turns like any other and never a second list. */
export type HistoryRun = {
  id: string;
  status: string;
  prompt: string | null;
  answer: string | null;
  usage?: { cost?: number } | null;
  durationMs: number | null;
};

/**
 * The agent's work, one honest row at a time. Encrypted reasoning shows as a
 * timed phase; nothing is invented here.
 */
export function RunConsole({
  rows,
  running,
  open,
  onOpen,
  message,
  prompt = "",
  turns,
  restoredMs = null,
  interaction,
  frames,
  palette,
  projects,
  assets,
  onRespond,
  onEscape,
  taskProgress,
  session = null,
  live = null,
  model = null,
  modelNames,
}: {
  rows: RunRow[];
  running: boolean;
  open: boolean;
  onOpen: (next: boolean) => void;
  message: string;
  prompt?: string;
  /**
   * One section per user request. While a section is on screen its prompt and
   * its own tabs stay pinned; the next request's header replaces them.
   * Omitted, the console is a single turn of `prompt` and `rows`.
   */
  turns?: ConsoleTurn[];
  restoredMs?: number | null;
  interaction: PendingInteraction | null;
  frames: FrameDto[];
  palette: string[];
  /** Live library for target questions; omitted keeps the default card. */
  projects?: Array<{ id: string; name: string }>;
  assets?: Array<{ id: string; projectId: string; name: string }>;
  onRespond: (
    response: InteractionResponse,
    stagedFrames?: StagedPlanFrame[],
  ) => Promise<void>;
  onEscape: () => void;
  /** Live task progress for the header; only read while the run is running. */
  taskProgress?: { phase: string; done: number; total: number } | undefined;
  /** The settled spend of the whole asset conversation, from the API. */
  session?: SessionTotals | null;
  /** The turn on screen that the session totals do not cover yet. */
  live?: LiveTurn | null;
  /**
   * The model the composer has selected. The context bar is scaled to this
   * model's window, so switching models re-scales the same used-token count
   * instead of showing a window the next run will not use.
   */
  model?: {
    id: string;
    displayName: string;
    contextWindow: number | null;
  } | null;
  /** Display names by model id, so a turn's meta reads a name, not a slug. */
  modelNames?: Record<string, string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [tabByTurn, setTabByTurn] = useState<Record<string, string>>({});
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastRunMs, setLastRunMs] = useState<number | null>(null);
  // While a run is live the header's clock ticks; settled turns read stored
  // durations and need no timer.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedAt.current = null;
      setElapsed(0);
      setNow(null);
      return;
    }
    startedAt.current = Date.now();
    setLastRunMs(null);
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - (startedAt.current ?? Date.now()));
      setNow(Date.now());
    }, 500);
    return () => {
      if (startedAt.current !== null) setLastRunMs(Date.now() - startedAt.current);
      window.clearInterval(timer);
    };
  }, [running]);
  const settled = !running;
  const sections: ConsoleTurn[] =
    turns !== undefined && turns.length > 0 ? turns : [{ id: "current", prompt, rows }];
  const lastTurn = sections.at(-1);
  const lastTurnId = lastTurn?.id ?? "";
  const lastTurnIdRef = useRef(lastTurnId);
  lastTurnIdRef.current = lastTurnId;
  const allRows = sections.flatMap((turn) => turn.rows);
  // A chat room opens on its newest line. The first expand always jumps to the
  // bottom once the body has mounted; a later expand lands at the bottom again
  // when the reader was following, or back where they had scrolled to.
  const openedOnceRef = useRef(false);
  const followRef = useRef(follow);
  followRef.current = follow;
  const scrollTopRef = useRef(0);
  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el === null) return;
    if (!openedOnceRef.current || followRef.current) {
      openedOnceRef.current = true;
      el.scrollTop = el.scrollHeight;
      setFollow(true);
      return;
    }
    el.scrollTop = scrollTopRef.current;
  }, [open]);
  useEffect(() => {
    setFollow(true);
  }, [lastTurnId, lastTurn?.prompt]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lastTurn?.rows, follow, message, tabByTurn, lastTurnId]);
  // Review starts after a long worker log. Bring that pass to the bottom,
  // where follow already keeps the latest line. Only the live turn's tab moves.
  useEffect(() => {
    if (taskProgress?.phase !== "review") return;
    const id = lastTurnIdRef.current;
    if (id.length > 0) setTabByTurn((current) => ({ ...current, [id]: "all" }));
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [taskProgress?.phase]);

  const usage = [...allRows].reverse().find((row) => row.kind === "usage");
  // The header's numbers: the settled session totals plus the live turn's own
  // contribution. `session` is the whole asset conversation; `live` is only
  // non-null while a turn is on screen and not yet folded into the session.
  const totals = headerTotals(session, live, now ?? Date.now());
  const elapsedMs = totals
    ? totals.elapsedMs + (running && live?.startedAtMs == null ? elapsed : 0)
    : running
      ? elapsed
      : (lastRunMs ?? restoredMs ?? 0);
  const elapsedKnown =
    totals !== null || running || lastRunMs !== null || restoredMs !== null;
  const cost = totals ? totals.cost : (usage?.cost ?? 0);
  const context = totals ? totals.context : (usage?.context ?? null);
  // The additive token buckets behind the header: the same numbers each turn
  // breaks down, summed for the whole conversation. Unlike the context window
  // state these are totals, so the detail popover has real numbers even for a
  // session whose runs predate the window snapshot.
  const tokenTotals = totals
    ? { input: totals.input, cached: totals.cached, output: totals.output }
    : usage
      ? { input: usage.input, cached: usage.cached, output: usage.output }
      : null;
  const empty =
    !running &&
    allRows.length === 0 &&
    !message &&
    sections.every((turn) => turn.prompt.trim().length === 0);
  // The outcome the header names. Note rows ("The task finished") never mask
  // a cancelled or failed status, and a failed attempt that was retried ends
  // with its retry's "completed" row, which is the one that wins.
  const lastStatus = [...allRows]
    .reverse()
    .find((row) => row.kind === "status" && TERMINAL_WORDS.has(row.label));
  const stateWord = interaction
    ? "waiting for your answer"
    : running
      ? "working"
      : lastStatus?.kind === "status"
        ? lastStatus.label === "failed" ||
          lastStatus.label === "cancelled" ||
          lastStatus.label === "completed"
          ? lastStatus.label
          : "finished"
        : "finished";
  const stateTone =
    running || interaction
      ? "text-accent"
      : stateWord === "failed" || stateWord === "cancelled"
        ? "text-erase"
        : "text-muted";
  // The asset a workspace run created; its row carries the editor link. The
  // action appears once the run is terminal — mid-run the editor could not
  // write to the asset and would not rejoin a workspace run's stream.
  const asset = [...allRows].reverse().find((row) => row.kind === "asset");
  // The closing reply's own card. When the streamed answer is already the
  // turn's last message row, that row carries the card and its meta; the
  // separate block appears only when nothing in the transcript matches it
  // (a withheld reply, or a run whose notes never streamed).
  const closingText = (lastTurn?.rows ?? [])
    .map(agentMessageText)
    .filter((text): text is string => text !== null)
    .at(-1);
  const closingDuplicatesRow =
    closingText !== undefined &&
    message.trim().length > 0 &&
    closingText.trim() === message.trim();

  const rowIcon = (row: RunRow) => {
    if (row.kind === "phase") {
      return <Brain width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "asset") {
      return <Folder width={12} height={12} className="text-muted" />;
    }
    // Usage rows never reach a rendered row: the turn meta owns their numbers.
    if (row.kind === "usage") return null;
    if (row.kind === "worker") {
      return row.status === "failed" ? (
        <Close width={12} height={12} className="text-erase" />
      ) : row.status === "waiting" ? (
        <Info width={12} height={12} className="text-accent" />
      ) : (
        <PixelLoader size={12} />
      );
    }
    if (row.kind === "task-phase") {
      return <Grid width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "steering") {
      return <Send width={12} height={12} className="text-accent" />;
    }
    if (row.kind === "supervisor") {
      return <Brain width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "question") {
      return <Info width={12} height={12} className="text-accent" />;
    }
    if (row.kind === "tool") {
      const Icon = toolIcons[row.name] ?? Wrench;
      return (
        <Icon
          width={12}
          height={12}
          className={row.state === "error" ? "text-erase" : "text-muted"}
        />
      );
    }
    if (row.state === "completed")
      return <Check width={12} height={12} className="text-accent" />;
    if (row.state === "failed" || row.state === "cancelled") {
      return <Close width={12} height={12} className="text-erase" />;
    }
    return <PixelLoader size={12} />;
  };

  const rowAgent = (row: RunRow): string | null => {
    if (
      "workerKey" in row &&
      typeof row.workerKey === "string" &&
      row.workerKey.length > 0
    ) {
      return agentLabel(row.workerKey);
    }
    if (row.kind === "supervisor") return "Supervisor";
    if (row.kind === "steering") {
      return row.routed === "supervisor" || row.routed === "plan"
        ? "Supervisor"
        : agentLabel(row.routed);
    }
    return null;
  };

  const tabMark = (status: "running" | "done" | "failed", selected: boolean) => {
    if (status === "running") {
      return <PixelLoader size={12} tone={selected ? "navy" : "accent"} />;
    }
    if (status === "failed") {
      return (
        <Close width={12} height={12} className={selected ? "text-navy" : "text-erase"} />
      );
    }
    return (
      <Check width={12} height={12} className={selected ? "text-navy" : "text-accent"} />
    );
  };

  // The session's context row doubles as the door to its token detail: the
  // used tokens come from the newest generation's snapshot, while the scale is
  // the composer's selected model, because that is the window the next request
  // will read. The label is gone; the used/window numbers carry the underline.
  const headerModelId = model?.id ?? session?.modelId ?? context?.model.modelId ?? null;
  const headerModelName =
    model?.displayName ??
    (headerModelId !== null ? (modelNames?.[headerModelId] ?? headerModelId) : null);
  const contextWindow =
    model?.contextWindow ??
    context?.model.context.contextWindow ??
    session?.contextWindow ??
    null;
  const usedTokens = context?.usedTokens ?? 0;
  // The snapshot's percent is relative to its own model; rescale it to the
  // selected window so switching models changes the bar, not just the label.
  const usedPercent =
    contextWindow !== null && contextWindow > 0
      ? (usedTokens / contextWindow) * 100
      : (context?.usedPercent ?? 0);
  const percentTone = contextTone(usedPercent);
  const scaledFromAnotherModel =
    context !== null &&
    model !== null &&
    model !== undefined &&
    model.id !== context.model.modelId;
  // No "context" label: the bar and the used/window numbers are the trigger,
  // and the numbers carry the dotted underline where that label used to be.
  const contextTokens = (
    <>
      <ContextBar percent={usedPercent} />
      <span
        className={`normal-case ${percentTone === "danger" ? "text-erase" : "text-ink"}`}
        title={
          context === null
            ? "No generation has recorded a context snapshot yet; the next successful run fills this bar"
            : `${usedTokens} tokens from the newest request against ${contextWindow !== null ? formatWindow(contextWindow) : "an unknown window"}${scaledFromAnotherModel ? " (the selected model's window)" : ""}`
        }
      >
        {Math.round(usedPercent)}%
      </span>
      <span className="normal-case underline decoration-dotted decoration-line-strong underline-offset-4">
        {formatTokens(usedTokens)} /{" "}
        {contextWindow !== null ? formatWindow(contextWindow) : "—"}
      </span>
    </>
  );

  return (
    <section
      aria-label="Agent activity"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-panel"
      style={{ maxWidth: "40rem" }}
    >
      {empty ? (
        <div className="px-2 py-1.5 text-pixel-mono tracking-[0.16em] text-muted uppercase">
          no activity yet
        </div>
      ) : (
        <div className="grid w-full gap-1 px-2 py-1.5 text-pixel-mono tracking-[0.16em] text-muted uppercase">
          <button
            type="button"
            onClick={() => onOpen(!open)}
            aria-expanded={open}
            className="flex w-full items-center gap-2 text-left hover:text-ink"
          >
            {running ? <PixelLoader size={12} tone="accent" /> : null}
            <span className={stateTone}>{stateWord}</span>
            {running && taskProgress !== undefined ? (
              <span className="text-accent normal-case">
                {phaseLabel(taskProgress.phase)} · {taskProgress.done}/
                {taskProgress.total}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-1 normal-case">
              {elapsedKnown ? (
                <span title="Total agent time on this asset">
                  {formatDuration(elapsedMs)}
                </span>
              ) : null}
              {elapsedKnown && cost > 0 ? <span>·</span> : null}
              {cost > 0 ? (
                <span
                  className={stateWord === "failed" ? "text-erase" : "text-ink"}
                  title="Total cost on this asset"
                >
                  {formatCost(cost)}
                </span>
              ) : null}
            </span>
            <span className="pl-1">{open ? "▾" : "▴"}</span>
          </button>
          <div className="flex w-full items-center gap-2">
            <TokenPopover
              title="session tokens"
              align="start"
              rows={[
                { label: "input", value: tokenTotals?.input ?? 0 },
                { label: "cached input", value: tokenTotals?.cached ?? 0 },
                { label: "output", value: tokenTotals?.output ?? 0 },
              ]}
              trigger={contextTokens}
              triggerClassName="flex items-center gap-2 text-left hover:text-ink"
            />
            {headerModelName !== null ? (
              <Popover
                label="model details"
                openOnHover
                align="end"
                popupClassName="w-64"
                trigger={<span>{headerModelName}</span>}
                triggerClassName="ml-auto max-w-[45%] truncate text-left normal-case hover:text-ink focus-visible:text-ink"
              >
                <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                  model
                </p>
                <p className="mt-1 text-pixel-body text-ink">{headerModelName}</p>
              </Popover>
            ) : null}
          </div>
        </div>
      )}
      {open && !empty ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            scrollTopRef.current = el.scrollTop;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-80 overflow-auto border-t-2 border-line"
          aria-live="polite"
        >
          {sections.map((turn, index) => {
            const isLast = index === sections.length - 1;
            const turnTabs = consoleTabs(turn.rows, settled || !isLast);
            const selectedId = tabByTurn[turn.id] ?? "all";
            const tab = turnTabs.find((item) => item.id === selectedId) ?? turnTabs[0];
            const liveNoteId =
              running && isLast
                ? [...(tab?.rows ?? [])]
                    .reverse()
                    .find((row) => row.kind === "supervisor")?.id
                : undefined;
            // The turn's meta sits under the user's message: when it was sent,
            // which model with which effort, what it cost, and its total
            // tokens. The total opens the exact input/cached/output breakdown;
            // the agent's reply carries no usage line of its own.
            const turnMeta =
              turn.meta !== undefined
                ? userMetaParts(
                    turn.meta,
                    now ?? Date.now(),
                    turn.meta.modelId !== null
                      ? modelNames?.[turn.meta.modelId]
                      : undefined,
                  )
                : null;
            const metaPrefix =
              turnMeta !== null
                ? [turnMeta.clock, turnMeta.model, turnMeta.cost]
                    .filter((part): part is string => part !== null)
                    .join(" · ")
                : "";
            const turnUsage = turnMeta?.usage ?? null;
            return (
              <section key={turn.id}>
                {turn.prompt || turnTabs.length > 1 ? (
                  <div className="sticky top-0 z-10 border-b-2 border-line bg-panel px-2 pt-2">
                    {turn.prompt ? (
                      <TurnPrompt prompt={turn.prompt}>
                        {turnMeta !== null &&
                        (metaPrefix.length > 0 || turnMeta.tokens !== null) ? (
                          <p className="mt-1 text-pixel-mono text-muted">
                            {metaPrefix.length > 0 ? (
                              <span>
                                {metaPrefix}
                                {turnMeta.tokens !== null ? " · " : null}
                              </span>
                            ) : null}
                            {turnMeta.tokens !== null && turnUsage !== null ? (
                              <TokenPopover
                                title="total tokens"
                                rows={[
                                  { label: "input", value: turnUsage.input },
                                  { label: "cached input", value: turnUsage.cached },
                                  { label: "output", value: turnUsage.output },
                                ]}
                                trigger={<span>{turnMeta.tokens}</span>}
                                triggerClassName="text-left text-pixel-mono text-muted underline decoration-dotted decoration-line-strong underline-offset-2 hover:text-ink focus-visible:text-ink"
                              />
                            ) : null}
                          </p>
                        ) : null}
                      </TurnPrompt>
                    ) : null}
                    {turnTabs.length > 1 ? (
                      <div
                        role="tablist"
                        aria-label="Agent steps"
                        className="flex gap-1 overflow-x-auto pb-2"
                      >
                        {turnTabs.map((item) => {
                          const selected = item.id === tab?.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              role="tab"
                              aria-selected={selected}
                              onClick={() => {
                                setTabByTurn((current) => ({
                                  ...current,
                                  [turn.id]: item.id,
                                }));
                                if (isLast) setFollow(true);
                              }}
                              className={`flex shrink-0 items-center gap-1 border-2 px-1.5 py-1 text-pixel-mono tracking-[0.12em] uppercase ${
                                selected
                                  ? "border-accent bg-accent text-navy"
                                  : "border-line bg-panel text-muted hover:text-ink"
                              }`}
                            >
                              <span className="grid h-3 w-3 place-items-center">
                                {tabMark(item.status, selected)}
                              </span>
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <ul className="grid gap-1.5 px-2 py-2">
                  {(tab?.rows ?? []).map((row) => {
                    // The turn's meta under the user's message owns the usage
                    // numbers; a log line would only repeat them.
                    if (row.kind === "usage") return null;
                    const owner = tab?.id === "all" ? rowAgent(row) : null;
                    const agentMessage = agentMessageText(row);
                    if (agentMessage !== null) {
                      // The agent's reply is a message, not a log line: a card
                      // that reads apart from tool rows and thinking notes.
                      return (
                        <li key={row.id} className="text-pixel-mono text-muted">
                          <div className="border-2 border-line bg-field px-2 py-1.5">
                            <p className="text-pixel-mono tracking-[0.16em] uppercase">
                              <span className="text-accent">agent</span>
                              {owner !== null ? (
                                <span className="text-muted"> · {owner}</span>
                              ) : null}
                            </p>
                            <StreamMarkdown
                              className="console-markdown mt-1"
                              content={agentMessage}
                              live={row.id === liveNoteId}
                            />
                          </div>
                        </li>
                      );
                    }
                    return (
                      <li
                        key={row.id}
                        className="flex items-start gap-1.5 text-pixel-mono text-muted"
                      >
                        <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                          {rowIcon(row)}
                        </span>
                        <div
                          className={`min-w-0 flex-1 break-words ${
                            row.kind === "supervisor" ? "" : "whitespace-pre-wrap"
                          }`}
                        >
                          {owner && row.kind !== "steering" ? (
                            <span className="text-accent">{owner} · </span>
                          ) : null}
                          {row.kind === "phase" ? (
                            <span className={row.state === "running" ? "text-ink" : ""}>
                              {row.label}
                              {row.state === "running" ? "…" : ""}
                            </span>
                          ) : row.kind === "asset" ? (
                            <span className="text-ink">asset · {row.name}</span>
                          ) : row.kind === "tool" ? (
                            <span
                              className={
                                row.state === "error" ? "text-erase" : "text-ink"
                              }
                            >
                              {row.name}
                              {row.summary ? ` · ${row.summary}` : ""}
                              {row.detail ? ` — ${row.detail}` : ""}
                            </span>
                          ) : row.kind === "worker" ? (
                            <span
                              className={
                                row.status === "failed" ? "text-erase" : "text-ink"
                              }
                            >
                              {row.status}
                              {row.frames.length > 0 ? ` · ${row.frames.join(", ")}` : ""}
                            </span>
                          ) : row.kind === "task-phase" ? (
                            <span className="text-muted">
                              {row.phase} · {row.status}
                            </span>
                          ) : row.kind === "supervisor" ? (
                            <div
                              className={
                                row.channel === "thinking" ? "text-muted" : "text-ink"
                              }
                            >
                              {row.channel === "thinking" ||
                              row.to !== undefined ||
                              row.held === true ? (
                                <p className="text-pixel-mono text-muted">
                                  {row.channel === "thinking"
                                    ? "thinking"
                                    : row.to !== undefined
                                      ? `to ${agentLabel(row.to)}`
                                      : "noted for review"}
                                </p>
                              ) : null}
                              <StreamMarkdown
                                className="console-markdown mt-1"
                                content={row.message}
                                live={row.id === liveNoteId}
                              />
                            </div>
                          ) : row.kind === "steering" ? (
                            <div>
                              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                                you
                              </p>
                              {row.message ? (
                                <p className="mt-1 text-pixel-body whitespace-pre-wrap text-ink">
                                  {row.message}
                                </p>
                              ) : null}
                              {followUpStatus(row) ? (
                                <p
                                  className={`mt-1 text-pixel-mono ${
                                    row.delivery === "clarify"
                                      ? "text-accent"
                                      : "text-muted"
                                  }`}
                                >
                                  {followUpStatus(row)}
                                </p>
                              ) : null}
                            </div>
                          ) : row.kind === "question" ? (
                            <span className="text-accent">needs you</span>
                          ) : (
                            <span
                              className={
                                row.state === "failed" ? "text-erase" : "text-ink"
                              }
                            >
                              {row.label}
                              {row.detail ? ` — ${row.detail}` : ""}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {asset && !running ? (
            <div className="mx-2 mt-2 border-t-2 border-line pt-2">
              <Link
                to="/projects/$projectId/assets/$assetId"
                params={{ projectId: asset.projectId, assetId: asset.assetId }}
                className="inline-flex min-h-9 items-center border-2 border-accent bg-field px-3 py-1.5 text-pixel-body text-ink shadow-pixel-sm transition-transform duration-150 hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-pixel-md"
              >
                Open {asset.name}
              </Link>
            </div>
          ) : null}
          {message && !closingDuplicatesRow ? (
            <div className="mx-2 mt-2">
              <div className="border-2 border-line bg-field px-2 py-1.5">
                <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                  agent
                </p>
                <StreamMarkdown className="console-markdown mt-1" content={message} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {interaction ? (
        <div className="border-t-2 border-line p-2">
          <InteractionCard
            key={interaction.id}
            interaction={interaction}
            frames={frames}
            palette={palette}
            projects={projects}
            assets={assets}
            onRespond={onRespond}
            onEscape={onEscape}
          />
        </div>
      ) : null}
    </section>
  );
}

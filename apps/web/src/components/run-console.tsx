import { StreamMarkdown } from "@anvia/react-ui/stream";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
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
import { consoleTabs, formatDuration, type RunRow } from "../lib/run-activity.js";
import {
  InteractionCard,
  type InteractionResponse,
  type PendingInteraction,
  type StagedPlanFrame,
} from "./interaction-card.js";
import { PixelLoader } from "./pixel-loader.js";
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

/** `$0.00042` — small costs keep five decimals; large ones keep two. */
function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(5)}`;
}

/** `14.6k` over a thousand, otherwise the count. */
function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** One earlier run, kept small: what was asked and what came back. */
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
  history = [],
  restoredMs = null,
  interaction,
  frames,
  palette,
  projects,
  assets,
  onRespond,
  onEscape,
  taskProgress,
}: {
  rows: RunRow[];
  running: boolean;
  open: boolean;
  onOpen: (next: boolean) => void;
  message: string;
  prompt?: string;
  history?: HistoryRun[];
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
  /** Task progress for the header: phase and how many workers finished. */
  taskProgress?: { phase: string; done: number; total: number } | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [tabId, setTabId] = useState("all");
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lastRunMs, setLastRunMs] = useState<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setLastRunMs(null);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - (startedAt.current ?? Date.now()));
    }, 500);
    return () => {
      if (startedAt.current !== null) setLastRunMs(Date.now() - startedAt.current);
      window.clearInterval(timer);
    };
  }, [running]);
  const settled = !running;
  const tabs = consoleTabs(rows, settled);
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0];
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows, follow, message, tab?.id]);
  // Review starts after a long worker log. Bring that pass to the bottom,
  // where follow already keeps the latest line.
  useEffect(() => {
    if (taskProgress?.phase !== "review") return;
    setTabId("all");
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [taskProgress?.phase]);

  const steps = rows.length;
  const lastStatus = [...rows].reverse().find((row) => row.kind === "status");
  const stateLabel = lastStatus?.kind === "status" ? lastStatus.label : "finished";
  const usage = [...rows].reverse().find((row) => row.kind === "usage");
  const durationMs = running ? elapsed : (lastRunMs ?? restoredMs);
  const empty = !running && rows.length === 0 && !message && history.length === 0;
  // The asset a workspace run created; its row carries the editor link. The
  // action appears once the run is terminal — mid-run the editor could not
  // write to the asset and would not rejoin a workspace run's stream.
  const asset = [...rows].reverse().find((row) => row.kind === "asset");
  const summary = interaction
    ? "waiting for your answer"
    : running
      ? `working · ${formatDuration(elapsed)}${usage && usage.cost > 0 ? ` · ${formatCost(usage.cost)}` : ""}`
      : empty
        ? "no activity yet"
        : steps === 0
          ? `${history.length} earlier run${history.length === 1 ? "" : "s"}`
          : `${steps} step${steps === 1 ? "" : "s"} · ${stateLabel}${
              durationMs !== null ? ` in ${formatDuration(durationMs)}` : ""
            }${usage && usage.cost > 0 ? ` · ${formatCost(usage.cost)}` : ""}`;

  const rowIcon = (row: RunRow) => {
    if (row.kind === "phase") {
      return <Brain width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "asset") {
      return <Folder width={12} height={12} className="text-muted" />;
    }
    if (row.kind === "usage") {
      return <Clipboard width={12} height={12} className="text-muted" />;
    }
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

  const tabMark = (status: "running" | "done" | "failed") => {
    if (status === "running") return <PixelLoader size={12} />;
    if (status === "failed") return <Close width={12} height={12} />;
    return <Check width={12} height={12} />;
  };

  return (
    <section
      aria-label="Agent activity"
      className="pointer-events-auto pixel-corners-sm w-full border-2 border-line-strong bg-panel"
      style={{ maxWidth: "40rem" }}
    >
      <button
        type="button"
        onClick={empty ? undefined : () => onOpen(!open)}
        disabled={empty}
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-pixel-mono tracking-[0.16em] text-muted uppercase ${
          empty ? "cursor-default" : "hover:text-ink"
        }`}
      >
        <span className={running ? "text-accent" : ""}>agent</span>
        {taskProgress !== undefined ? (
          <span className="text-accent normal-case">
            {phaseLabel(taskProgress.phase)} · {taskProgress.done}/{taskProgress.total}
          </span>
        ) : null}
        <span>{summary}</span>
        {empty ? null : <span className="ml-auto">{open ? "▾" : "▴"}</span>}
      </button>
      {open && !empty ? (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-80 overflow-auto border-t-2 border-line"
          aria-live="polite"
        >
          {prompt || tabs.length > 1 ? (
            <div className="sticky top-0 z-10 border-b-2 border-line bg-panel px-2 pt-2">
              {prompt ? (
                <div className="pb-2">
                  <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                    you
                  </p>
                  <p className="mt-1 text-pixel-body whitespace-pre-wrap text-ink">
                    {prompt}
                  </p>
                </div>
              ) : null}
              {tabs.length > 1 ? (
                <div
                  role="tablist"
                  aria-label="Agent steps"
                  className="flex gap-1 overflow-x-auto pb-2"
                >
                  {tabs.map((item) => {
                    const selected = item.id === tab?.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => {
                          setTabId(item.id);
                          setFollow(true);
                        }}
                        className={`flex shrink-0 items-center gap-1 border-2 px-1.5 py-1 text-pixel-mono tracking-[0.12em] uppercase ${
                          selected
                            ? "border-accent bg-accent text-navy"
                            : "border-line bg-panel text-muted hover:text-ink"
                        }`}
                      >
                        <span className="grid h-3 w-3 place-items-center">
                          {tabMark(item.status)}
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
              const owner = tab?.id === "all" ? rowAgent(row) : null;
              return (
                <li
                  key={row.id}
                  className="flex items-start gap-1.5 text-pixel-mono text-muted"
                >
                  <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                    {rowIcon(row)}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {owner ? <span className="text-accent">{owner} · </span> : null}
                    {row.kind === "phase" ? (
                      <span className={row.state === "running" ? "text-ink" : ""}>
                        {row.label}
                        {row.state === "running" ? "…" : ""}
                      </span>
                    ) : row.kind === "asset" ? (
                      <span className="text-ink">asset · {row.name}</span>
                    ) : row.kind === "usage" ? (
                      <span
                        className="text-ink"
                        title={`model ${formatCost(row.modelCost)} (${row.modelCalls} calls) · Jev ${formatCost(row.jevCost)} (${row.jevCalls} calls)`}
                      >
                        usage · {formatCost(row.cost)}
                        {row.total > 0 ? ` · ${formatTokens(row.total)} tok` : ""}
                        {row.cached > 0 ? ` · ${formatTokens(row.cached)} cached` : ""}
                      </span>
                    ) : row.kind === "tool" ? (
                      <span className={row.state === "error" ? "text-erase" : "text-ink"}>
                        {row.name}
                        {row.summary ? ` · ${row.summary}` : ""}
                        {row.detail ? ` — ${row.detail}` : ""}
                      </span>
                    ) : row.kind === "worker" ? (
                      <span
                        className={row.status === "failed" ? "text-erase" : "text-ink"}
                      >
                        {row.status}
                        {row.frames.length > 0 ? ` · ${row.frames.join(", ")}` : ""}
                      </span>
                    ) : row.kind === "task-phase" ? (
                      <span className="text-muted">
                        {row.phase} · {row.status}
                      </span>
                    ) : row.kind === "supervisor" ? (
                      <span
                        className={row.channel === "thinking" ? "text-muted" : "text-ink"}
                      >
                        {row.channel === "thinking"
                          ? "thinking · "
                          : row.to !== undefined
                            ? `to ${agentLabel(row.to)} · `
                            : row.held === true
                              ? "noted for review · "
                              : ""}
                        {row.message}
                      </span>
                    ) : row.kind === "steering" ? (
                      <span className="text-accent">
                        {row.relayed === true
                          ? `relayed to ${agentLabel(row.routed)}`
                          : "kept by the supervisor"}
                        {row.frameName ? ` (${row.frameName})` : ""}
                        {row.message ? ` · ${row.message}` : ""}
                      </span>
                    ) : row.kind === "question" ? (
                      <span className="text-accent">needs you</span>
                    ) : (
                      <span
                        className={row.state === "failed" ? "text-erase" : "text-ink"}
                      >
                        {row.label}
                        {row.detail ? ` — ${row.detail}` : ""}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
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
          {message ? (
            <div className="mx-2 mt-2 border-t-2 border-line pt-2 pb-2 text-pixel-body text-ink">
              <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">
                agent
              </p>
              <div className="mt-1">
                <StreamMarkdown content={message} />
              </div>
            </div>
          ) : null}
          {history.length > 0 ? (
            <div className="mx-2 mt-2 border-t-2 border-line pt-2 pb-2">
              <p className="text-pixel-mono tracking-[0.16em] text-muted uppercase">
                earlier
              </p>
              <ul className="mt-1 grid gap-1.5">
                {history.map((item) => (
                  <li key={item.id} className="text-pixel-mono">
                    <p className="truncate text-muted" title={item.prompt ?? ""}>
                      <span className="text-accent">you</span> {item.prompt ?? "—"}
                    </p>
                    <p className="truncate text-ink" title={item.answer ?? ""}>
                      <span className="text-accent">agent</span>{" "}
                      {item.answer ?? item.status}
                      {typeof item.usage?.cost === "number" && item.usage.cost > 0
                        ? ` · ${formatCost(item.usage.cost)}`
                        : ""}
                    </p>
                  </li>
                ))}
              </ul>
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

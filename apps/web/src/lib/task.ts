import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "./api.js";
import type { RunStreamMessage } from "./run-stream.js";

/** One frame's place in a task, as the snapshot reports it. */
export type TaskFrameStatus = {
  id: string;
  name: string;
  status: "queued" | "working" | "done" | "failed" | "asking";
};

export type TaskWorkerState = {
  key: string;
  runId?: string;
  status: string;
  /** A later attempt of the same role replaced this one. */
  superseded?: boolean;
  frames: TaskFrameStatus[];
  pendingInteraction?: {
    id: string;
    /** A pending call waits for approval; a question waits for an answer. */
    type?: "tool-approval" | "tool-question";
    toolName?: string;
    questions?: Array<{
      id: string;
      text: string;
      choices?: Array<{ value: string; label: string }>;
    }>;
  };
};

export type TaskSnapshot = {
  task: {
    id: string;
    phase: string;
    status: string;
    plan: unknown;
    usage?: Record<string, number>;
  } | null;
  workers: TaskWorkerState[];
  pendingQuestions: number;
};

/** The asset's task, refreshed while anything is running. */
export function useTaskSnapshot(assetId: string, enabled = true) {
  return useQuery({
    queryKey: ["task", assetId],
    queryFn: () => api<TaskSnapshot>(`/api/assets/${assetId}/task`),
    refetchInterval: (query) => {
      const data = query.state.data as TaskSnapshot | undefined;
      const active =
        data?.task !== null &&
        data?.task !== undefined &&
        ["queued", "running", "waiting"].includes(data.task.status);
      // A task started from the home is only discovered by asking again:
      // never stop the probe, just slow it down when nothing is running.
      return active ? 3000 : 5000;
    },
    enabled,
  });
}

/**
 * The task stream carries the console tree (task phases, worker statuses,
 * steering, questions, and mirrored child tool events). Strokes stay out of
 * it, so each child run's own stream feeds its frame's canvas.
 */
export function useTaskStream() {
  const sourceRef = useRef<EventSource | null>(null);
  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);
  const open = useCallback(
    (
      taskId: string,
      handlers: { onMessage: (message: RunStreamMessage) => void; onDrop: () => void },
    ) => {
      sourceRef.current?.close();
      const source = new EventSource(`/api/tasks/${taskId}/stream?after=0`);
      sourceRef.current = source;
      source.onmessage = (event) => {
        handlers.onMessage(JSON.parse(event.data) as RunStreamMessage);
      };
      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        handlers.onDrop();
      };
    },
    [],
  );
  useEffect(() => close, [close]);
  return { open, close };
}

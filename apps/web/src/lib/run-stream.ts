import { useCallback, useEffect, useRef } from "react";

/** One parsed message from a run's server-sent event stream. */
export type RunStreamMessage = { sequence: number; type: string; data: unknown };

/**
 * A dropped stream must not spin when the worker is unreachable: each rejoin
 * waits, the wait grows while drops continue (capped), and any received
 * message resets the pace. The caller decides whether a rejoin is warranted;
 * this only paces it and reports whether a drop was the first of its burst,
 * so the console logs the rejoin once instead of once per retry.
 */
export function useRejoinPacer() {
  const delayRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    delayRef.current = 0;
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pace = useCallback((rejoin: () => void): boolean => {
    const firstDrop = delayRef.current === 0;
    delayRef.current = Math.min(8000, firstDrop ? 1500 : delayRef.current * 2);
    if (timerRef.current !== null) return false;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      rejoin();
    }, delayRef.current);
    return firstDrop;
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  return { pace, reset, cancel };
}

/**
 * The run stream's transport: one EventSource at a time, parsed messages to
 * the caller, and a drop that closes the source before it is reported — an
 * EventSource would otherwise reconnect to a finished run forever. What the
 * messages mean stays with the screen that opened the stream.
 */
export function useRunStream() {
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const open = useCallback(
    (
      id: string,
      handlers: {
        onMessage: (message: RunStreamMessage) => void;
        onDrop: () => void;
        after?: number;
      },
    ) => {
      sourceRef.current?.close();
      const source = new EventSource(
        `/api/runs/${id}/stream?after=${handlers.after ?? 0}`,
      );
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

  useEffect(() => () => close(), [close]);

  return { sourceRef, open, close };
}

import { useCallback, useEffect, useRef } from "react";

/** One parsed message from a run's server-sent event stream. */
export type RunStreamMessage = { sequence: number; type: string; data: unknown };

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

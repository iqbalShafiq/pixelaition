import { useCallback, useRef, useState } from "react";
import {
  MAX_ATTACHMENTS,
  prepareAttachment,
  type PreparedAttachment,
} from "./attachments.js";

/** The composer's staged reference images: add from a picker or a drop. */
export function useAttachments() {
  const [items, setItems] = useState<PreparedAttachment[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const countRef = useRef(0);
  countRef.current = items.length;

  const add = useCallback(async (files: Iterable<File>) => {
    setError(undefined);
    const incoming = [...files];
    if (incoming.length === 0) return;
    const room = Math.max(0, MAX_ATTACHMENTS - countRef.current);
    let problem: string | undefined =
      incoming.length > room ? `Up to ${MAX_ATTACHMENTS} reference images.` : undefined;
    const prepared: PreparedAttachment[] = [];
    for (const file of incoming.slice(0, room)) {
      try {
        prepared.push(await prepareAttachment(file));
      } catch (reason) {
        problem =
          reason instanceof Error ? reason.message : "That image could not be attached.";
        break;
      }
    }
    if (prepared.length > 0) {
      setItems((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS));
    }
    if (problem !== undefined) setError(problem);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setError(undefined);
  }, []);

  return { items, error, add, remove, clear };
}

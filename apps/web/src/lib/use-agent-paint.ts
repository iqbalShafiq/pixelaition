import type { History } from "@pixelaition/pixel";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  AgentPaintSession,
  decodeStroke,
  type FrameUpdate,
  type Point,
} from "./agent-paint.js";

/**
 * Paces agent strokes onto the open drafts. The session is the source of
 * truth while a stroke walks; React only mirrors the cells the cursor has
 * reached. Each frame walks on its own timer entry, so parallel workers do
 * not queue behind each other.
 */
export function useAgentPaint(
  draftsRef: RefObject<Record<string, History>>,
  setDrafts: Dispatch<SetStateAction<Record<string, History>>>,
) {
  const session = useRef(new AgentPaintSession());
  const [cursors, setCursors] = useState<Record<string, Point | null>>({});
  const stepTimer = useRef<number | null>(null);
  const burstTimer = useRef<number | null>(null);

  const apply = useCallback(
    (updates: FrameUpdate[]) => {
      if (updates.length === 0) return;
      const palette = [...updates].reverse().find((update) => update.palette)?.palette;
      setDrafts((current) => {
        let next = current;
        if (palette) {
          for (const [id, entry] of Object.entries(next)) {
            if (entry.present.palette.join(",") === palette.join(",")) continue;
            if (next === current) next = { ...current };
            const latest = next[id] ?? entry;
            next[id] = {
              ...latest,
              present: { ...latest.present, palette: [...palette] },
            };
          }
        }
        for (const update of updates) {
          if (!update.layers) continue;
          const entry = next[update.frameId];
          if (!entry || sameLayers(entry.present.layers, update.layers)) continue;
          if (next === current) next = { ...current };
          next[update.frameId] = {
            ...entry,
            present: { ...entry.present, layers: update.layers },
          };
        }
        return next;
      });
      setCursors((current) => {
        let next = current;
        let changed = false;
        for (const update of updates) {
          if (!("cursor" in update)) continue;
          const cursor = update.cursor ?? null;
          const previous = next[update.frameId];
          if (cursor === null) {
            if (!(update.frameId in next)) continue;
            if (!changed) {
              next = { ...current };
              changed = true;
            }
            delete next[update.frameId];
            continue;
          }
          if (previous && previous.x === cursor.x && previous.y === cursor.y) continue;
          if (!changed) {
            next = { ...current };
            changed = true;
          }
          next[update.frameId] = cursor;
        }
        return changed ? next : current;
      });
    },
    [setDrafts],
  );

  const readFrame = useCallback(
    (frameId: string) => {
      const present = draftsRef.current?.[frameId]?.present;
      if (!present) return undefined;
      return { width: present.width, height: present.height, layers: present.layers };
    },
    [draftsRef],
  );

  const arm = useCallback(() => {
    if (stepTimer.current !== null) window.clearTimeout(stepTimer.current);
    const at = session.current.nextAt();
    if (at === null) {
      stepTimer.current = null;
      return;
    }
    stepTimer.current = window.setTimeout(
      () => {
        stepTimer.current = null;
        apply(session.current.tick(performance.now()));
        arm();
      },
      Math.max(0, at - performance.now()),
    );
  }, [apply]);

  const flush = useCallback(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    apply(session.current.flush(performance.now(), readFrame, reduced));
    arm();
  }, [apply, arm, readFrame]);

  const receive = useCallback(
    (raw: Record<string, unknown>, fallbackFrameId: string) => {
      const stroke = decodeStroke(raw, fallbackFrameId);
      if (!stroke || stroke.layers.length === 0) return;
      session.current.push(stroke);
      if (burstTimer.current !== null) return;
      // Strokes that arrive in one chunk (a rejoin replay) flush together.
      // A live tool call arrives alone and walks.
      burstTimer.current = window.setTimeout(() => {
        burstTimer.current = null;
        flush();
      }, 0);
    },
    [flush],
  );

  const stop = useCallback(() => {
    if (burstTimer.current !== null) window.clearTimeout(burstTimer.current);
    if (stepTimer.current !== null) window.clearTimeout(stepTimer.current);
    burstTimer.current = null;
    stepTimer.current = null;
    const reduced = session.current.flush(performance.now(), readFrame, true);
    apply([...reduced, ...session.current.finish()]);
  }, [apply, readFrame]);

  useEffect(() => {
    const painting = session.current;
    return () => {
      if (burstTimer.current !== null) window.clearTimeout(burstTimer.current);
      if (stepTimer.current !== null) window.clearTimeout(stepTimer.current);
      painting.finish();
    };
  }, []);

  return { receive, stop, cursors };
}

function sameLayers(
  before: Array<{ id: string; name: string; visible: boolean; pixels: Uint8Array }>,
  after: Array<{ id: string; name: string; visible: boolean; pixels: Uint8Array }>,
): boolean {
  if (before.length !== after.length) return false;
  return before.every((layer, index) => {
    const other = after[index];
    if (!other) return false;
    if (
      layer.id !== other.id ||
      layer.name !== other.name ||
      layer.visible !== other.visible
    ) {
      return false;
    }
    if (layer.pixels.length !== other.pixels.length) return false;
    for (let pixel = 0; pixel < layer.pixels.length; pixel += 1) {
      if (layer.pixels[pixel] !== other.pixels[pixel]) return false;
    }
    return true;
  });
}

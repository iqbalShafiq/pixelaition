import { cloneBuffer } from "./buffer.js";
import { MAX_HISTORY, type FrameBuffer } from "./types.js";

export type History = {
  past: FrameBuffer[];
  present: FrameBuffer;
  future: FrameBuffer[];
};

export function createHistory(present: FrameBuffer): History {
  return { past: [], present: cloneBuffer(present), future: [] };
}

export function pushHistory(history: History, next: FrameBuffer): History {
  const past = [...history.past, history.present];
  const trimmed =
    past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past;
  return { past: trimmed, present: cloneBuffer(next), future: [] };
}

export function undoHistory(history: History): History {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHistory(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
  };
}

import { agentLabel } from "../lib/agent-label.js";
import { PixelLoader } from "./pixel-loader.js";
import { Check, Close } from "./pixel-icons.js";

/** The states a frame can be in while its worker paints it. */
export type FrameTaskState = {
  status: "queued" | "working" | "done" | "failed" | "asking";
  workerKey: string;
  /** The user already looked at this frame; its tick stays quiet. */
  seen?: boolean;
};

/**
 * A frame's place in the running task. Colour, shape, and a text label travel
 * together (never colour alone), and every animation is a whole-pixel
 * `steps()` loop that `prefers-reduced-motion` turns off.
 */
export function FrameStatus({ state }: { state: FrameTaskState }) {
  if (state.status === "queued") {
    return (
      <span className="flex items-center gap-1 text-pixel-mono text-muted">
        <span className="h-2 w-2 border-2 border-line" />
        queued
      </span>
    );
  }
  if (state.status === "working") {
    return (
      <span className="flex items-center gap-1 text-pixel-mono text-accent">
        <span className="worker-blink h-2 w-2 bg-accent" />
        <PixelLoader size={12} />
        {agentLabel(state.workerKey)}
      </span>
    );
  }
  if (state.status === "done") {
    if (state.seen === true) {
      return (
        <span className="flex items-center gap-1 text-pixel-mono text-muted">
          <Check width={12} height={12} />
          {agentLabel(state.workerKey)}
        </span>
      );
    }
    return (
      <span className="done-pop flex items-center gap-1 text-pixel-mono text-accent">
        <Check width={12} height={12} />
        done
      </span>
    );
  }
  if (state.status === "failed") {
    return (
      <span className="glitch flex items-center gap-1 text-pixel-mono text-erase">
        <Close width={12} height={12} />
        failed
      </span>
    );
  }
  return (
    <span className="ask-pulse flex items-center gap-1 border-2 border-accent px-1 text-pixel-mono text-accent">
      ? needs you
    </span>
  );
}

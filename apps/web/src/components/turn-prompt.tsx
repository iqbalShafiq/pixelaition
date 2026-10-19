import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The request a turn answered, pinned above its steps. A prompt is the user's
 * own words and is never shortened; past a handful of lines it scrolls inside
 * a fixed-height box, so one long request cannot push the live steps (the
 * part a person watches while the agent works) out of the console.
 */
const MAX_LINES = 4;
/** Pixel body line-height (20px) plus the box's own padding. */
const LINE_PX = 20;

export function TurnPrompt({
  prompt,
  children,
}: {
  prompt: string;
  /** The turn's meta line, printed under the box. */
  children?: ReactNode;
}) {
  const body = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const measure = useCallback(() => {
    const element = body.current;
    if (!element) return;
    setOverflows(element.scrollHeight > element.clientHeight + 1);
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 1);
  }, []);

  useEffect(() => {
    measure();
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt, measure]);

  return (
    <div className="pb-2">
      <p className="text-pixel-mono tracking-[0.16em] text-accent uppercase">you</p>
      <div
        className={`turn-prompt mt-1 ${overflows && !atBottom ? "turn-prompt-more" : ""}`}
        style={{ maxHeight: `${MAX_LINES * LINE_PX}px` }}
        onScroll={(event) => {
          const element = event.currentTarget;
          setAtBottom(
            element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
          );
        }}
      >
        <p ref={body} className="text-pixel-body whitespace-pre-wrap text-ink">
          {prompt}
        </p>
      </div>
      {children}
    </div>
  );
}

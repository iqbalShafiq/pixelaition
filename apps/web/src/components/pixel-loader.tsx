import type { CSSProperties } from "react";

/**
 * A three-frame pixel spinner. Frame swaps via background-position + steps(3).
 * The sheet is three squares tall, so the keyframes derive their offset from
 * `--pixel-loader-size`: a hardcoded -36px only steps correctly at size 12.
 */
export function PixelLoader({ size = 12 }: { size?: 12 | 16 }) {
  return (
    <span
      aria-hidden
      className="pixel-loader inline-block shrink-0"
      style={
        {
          width: size,
          height: size,
          backgroundSize: `${size}px ${size * 3}px`,
          "--pixel-loader-size": `${size}px`,
        } as CSSProperties
      }
    />
  );
}

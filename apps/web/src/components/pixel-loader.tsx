/** A three-frame pixel spinner. Frame swaps via background-position + steps(3). */
export function PixelLoader({ size = 12 }: { size?: 12 | 16 }) {
  return (
    <span
      aria-hidden
      className="pixel-loader inline-block shrink-0"
      style={{ width: size, height: size, backgroundSize: `${size}px ${size * 3}px` }}
    />
  );
}

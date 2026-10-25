/**
 * A shelf thumbnail is one small PNG from the API, not a full asset download.
 * The editor and the card both use this: the card can paint as soon as the
 * image lands, and opening the asset no longer competes with twenty-five
 * decoded frame stacks on the main thread.
 */
export function SpriteThumb({
  assetId,
  display = 48,
  flight = false,
}: {
  assetId: string;
  display?: number;
  /** The image is flying here: the artwork carries the flight's name. */
  flight?: boolean;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center border-2 border-line bg-screen"
      style={{ width: display, height: display }}
    >
      <img
        src={`/api/assets/${assetId}/thumbnail`}
        alt=""
        loading="lazy"
        decoding="async"
        style={{
          width: display - 4,
          height: display - 4,
          imageRendering: "pixelated",
          objectFit: "contain",
          ...(flight ? { viewTransitionName: "asset-flight" } : {}),
        }}
      />
    </span>
  );
}

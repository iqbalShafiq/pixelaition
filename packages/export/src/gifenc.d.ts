declare module "gifenc" {
  export type GifPalette = Array<
    [number, number, number] | [number, number, number, number]
  >;
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: GifPalette;
        first?: boolean;
        transparent?: boolean;
        transparentIndex?: number;
        delay?: number;
        repeat?: number;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  };
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: Record<string, unknown>,
  ): GifPalette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: string,
  ): Uint8Array;
  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  };
  export default gifenc;
}

declare module "upng-js" {
  export type UPNGImage = {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: Array<{
      rect: { x: number; y: number; width: number; height: number };
      delay: number;
      dispose: number;
      blend: number;
      data?: Uint8Array;
    }>;
    tabs: Record<string, unknown>;
  };
  const UPNG: {
    encode(
      buffers: ArrayBuffer[],
      width: number,
      height: number,
      colors?: number,
      delays?: number[],
      forbidPlte?: boolean,
    ): ArrayBuffer;
    decode(buffer: ArrayBuffer | Uint8Array): UPNGImage;
    toRGBA8(image: UPNGImage): ArrayBuffer[];
    crc: { crc(input: Uint8Array | number[], offset: number, length: number): number };
  };
  export default UPNG;
}

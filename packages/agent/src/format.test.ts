import { describe, expect, it } from "vitest";
import { encodeRowsRle } from "./format.js";

describe("encodeRowsRle", () => {
  it("encodes runs per row with unambiguous separators", () => {
    const pixels = new Uint32Array([
      0x00000000, 0x00000000, 0x00000000, 0xff0000ff, 0xff0000ff, 0x00ff00ff, 0x0000ffff,
      0x0000ffff, 0xffffffff,
    ]);
    expect(encodeRowsRle(pixels, 3, 3)).toEqual([
      "#00000000x3",
      "#ff0000x2 #00ff00x1",
      "#0000ffx2 #ffffffx1",
    ]);
  });

  it("keeps non-index colours readable", () => {
    const pixels = new Uint32Array([
      0xff0000ff, 0x00000000, 0xff0000ff, 0x00000000, 0xff0000ff, 0x00000000, 0xff0000ff,
      0x00000000, 0xff0000ff, 0x00000000, 0xff0000ff, 0x00000000, 0xff0000ff, 0x00000000,
      0xff0000ff, 0x00000000,
    ]);
    expect(encodeRowsRle(pixels, 16, 1)[0]).toBe(
      "#ff0000x1 #00000000x1 ".repeat(8).trim(),
    );
  });
});

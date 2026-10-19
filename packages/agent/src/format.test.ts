import { describe, expect, it } from "vitest";
import { encodeRowsRle } from "./format.js";

describe("encodeRowsRle", () => {
  it("encodes runs per row with unambiguous separators", () => {
    const pixels = new Uint8Array([0, 0, 0, 1, 1, 2, 10, 10, 3]);
    expect(encodeRowsRle(pixels, 3, 3)).toEqual(["0x3", "1x2 2x1", "10x2 3x1"]);
  });

  it("keeps palette indexes >= 10 readable", () => {
    const pixels = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(encodeRowsRle(pixels, 16, 1)).toEqual([
      "1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1 1x1 0x1",
    ]);
  });
});

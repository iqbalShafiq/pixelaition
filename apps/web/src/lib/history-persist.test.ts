import { describe, expect, it } from "vitest";
import { createBuffer, createHistory, pushHistory, writeCell } from "@pixelaition/pixel";
import { decodeHistory, encodeHistory } from "./history-persist.js";

const palette = ["#00000000", "#ff0000", "#00ff00"];

describe("persistent undo history", () => {
  it("round-trips past, present, and future pixels", () => {
    const before = createBuffer({ width: 8, height: 8, palette });
    writeCell(before.layers[0]!.pixels, 0, 0xff0000ff);
    const after = createBuffer({ width: 8, height: 8, palette });
    writeCell(after.layers[0]!.pixels, 63, 0x00ff00ff);
    const history = pushHistory(createHistory(before), after);
    const stepped = pushHistory(history, before);
    const restored = decodeHistory(encodeHistory(stepped), 8, 8, palette);
    expect(restored?.past).toHaveLength(2);
    expect(restored?.future).toHaveLength(0);
    expect(restored?.present.layers[0]?.pixels).toEqual(before.layers[0]?.pixels);
  });

  it("drops a malformed or wrong-sized history instead of throwing", () => {
    expect(decodeHistory(null, 8, 8, palette)).toBeNull();
    expect(decodeHistory({ past: "no" }, 8, 8, palette)).toBeNull();
    expect(
      decodeHistory(
        {
          past: [],
          present: { layers: [{ id: "x", name: "x", visible: true, pixels: "AAAA" }] },
          future: [],
        },
        8,
        8,
        palette,
      ),
    ).toBeNull();
  });
});

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
    const restored = decodeHistory(
      encodeHistory(stepped),
      8,
      8,
      palette,
      stepped.present,
    );
    expect(restored?.past).toHaveLength(2);
    expect(restored?.future).toHaveLength(0);
    expect(restored?.present.layers[0]?.pixels).toEqual(before.layers[0]?.pixels);
  });

  it("stores only the layers a step changed", () => {
    const withShade = (baseColor: number) => {
      const buffer = createBuffer({ width: 8, height: 8, palette });
      buffer.layers.push({
        id: "shade",
        name: "shade",
        visible: true,
        pixels: new Uint8Array(8 * 8 * 4),
      });
      writeCell(buffer.layers[0]!.pixels, 0, baseColor);
      writeCell(buffer.layers[1]!.pixels, 0, 0x00ff00ff);
      return buffer;
    };
    const past = withShade(0xff0000ff);
    const present = withShade(0x0000ffff);
    const stored = encodeHistory(pushHistory(createHistory(past), present));
    expect(stored.past[0]?.layers[0]?.pixels).toBeTypeOf("string");
    expect(stored.past[0]?.layers[1]?.pixels).toBeUndefined();
    const restored = decodeHistory(stored, 8, 8, palette, present);
    expect(restored?.past[0]?.layers[1]?.pixels).toEqual(past.layers[1]?.pixels);
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

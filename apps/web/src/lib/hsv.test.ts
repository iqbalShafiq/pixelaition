import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "./hsv.js";

describe("hsv helpers", () => {
  it("round-trips a swatch", () => {
    const { h, s, v } = hexToHsv("#38b764");
    expect(hsvToHex(h, s, v)).toBe("#38b764");
  });
  it("maps the extremes", () => {
    expect(hsvToHex(0, 0, 1)).toBe("#ffffff");
    expect(hsvToHex(0, 0, 0)).toBe("#000000");
    expect(hsvToHex(120, 1, 1)).toBe("#00ff00");
  });
});

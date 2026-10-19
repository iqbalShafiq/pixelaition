import { describe, expect, it } from "vitest";
import {
  assetCells,
  demoAssets,
  demoPalette,
  demoSize,
  spriteBounds,
} from "./auth-demo.js";

describe("auth demo cast", () => {
  it("gives every asset more than one pose and more than one layer", () => {
    expect(demoAssets.length).toBeGreaterThanOrEqual(5);
    for (const asset of demoAssets) {
      expect(asset.poses.length).toBeGreaterThanOrEqual(2);
      for (const item of asset.poses) {
        expect(item.layers.length).toBeGreaterThanOrEqual(2);
        expect(new Set(item.layers.map((part) => part.name)).size).toBe(
          item.layers.length,
        );
        for (const part of item.layers) {
          expect(part.cells.length).toBeGreaterThan(0);
          for (const cell of part.cells) {
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x).toBeLessThan(demoSize);
            expect(cell.y).toBeLessThan(demoSize);
            expect(demoPalette[cell.color]).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
      }
    }
  });

  it("crops an asset to the cells it paints", () => {
    for (const asset of demoAssets) {
      const bounds = spriteBounds(assetCells(asset));
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.width).toBeLessThanOrEqual(demoSize);
      expect(bounds.minY + bounds.height).toBeLessThanOrEqual(demoSize);
    }
  });
});

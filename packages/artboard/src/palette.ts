import { colorToHex, hexToColor } from "@pixelaition/pixel";
import { upgradeScene } from "./scene.js";
import type { ArtboardScene } from "./types.js";

/**
 * Rewrite every palette index in a scene through an explicit mapping. Unlike a
 * colour-distance remap, this is exact: a palette delete or reorder must not
 * silently choose a near neighbour for a layer's colour.
 */
export function mapSceneIndices(
  scene: ArtboardScene,
  mapping: readonly number[],
): ArtboardScene {
  const map = (value: number) => mapping[value] ?? 0;
  return {
    ...scene,
    background:
      scene.background.kind === "solid"
        ? { ...scene.background, color: map(scene.background.color) }
        : scene.background.kind === "pattern"
          ? {
              ...scene.background,
              colorA: map(scene.background.colorA),
              colorB: map(scene.background.colorB),
            }
          : scene.background,
    elements: scene.elements.map((element) => {
      switch (element.kind) {
        case "rect":
        case "frame":
          return { ...element, color: map(element.color) };
        case "pattern":
          return {
            ...element,
            colorA: map(element.colorA),
            colorB: map(element.colorB),
          };
        case "text":
          return { ...element, color: map(element.color) };
        default:
          return element;
      }
    }),
  };
}

/**
 * Palette edits now move full RGBA scenes by colour, not by index. A colour
 * that survives in the target palette keeps its exact packed value; a colour
 * the new palette does not carry is preserved rather than snapped to a
 * near-match, because a scene may hold any RGBA.
 */
export function mapSceneColors(
  scene: ArtboardScene,
  source: string[],
  target: string[],
): ArtboardScene {
  const upgraded = upgradeScene(scene, source);
  const map = (color: number): number => {
    const hex = colorToHex(color).toLowerCase();
    const index = target.findIndex((entry) => entry.toLowerCase() === hex);
    return index >= 0 ? (hexToColor(target[index] ?? "#00000000") ?? color) : color;
  };
  return {
    ...upgraded,
    background:
      upgraded.background.kind === "solid"
        ? { ...upgraded.background, color: map(upgraded.background.color) }
        : upgraded.background.kind === "pattern"
          ? {
              ...upgraded.background,
              colorA: map(upgraded.background.colorA),
              colorB: map(upgraded.background.colorB),
            }
          : upgraded.background,
    elements: upgraded.elements.map((element) => {
      switch (element.kind) {
        case "rect":
        case "frame":
        case "text":
          return { ...element, color: map(element.color) };
        case "pattern":
          return {
            ...element,
            colorA: map(element.colorA),
            colorB: map(element.colorB),
          };
        default:
          return element;
      }
    }),
  };
}

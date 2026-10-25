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

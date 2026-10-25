import { hexToColor } from "@pixelaition/pixel";
import type { ArtboardScene, Element } from "./types.js";

/**
 * Scene colours are packed RGBA, one number per colour, matching pixel
 * commands. Version 1 scenes stored palette indices; they are upgraded through
 * the asset palette on read, never guessed.
 */
export function sceneColor(value: number, palette: string[]): number {
  if (value >= 0 && value < palette.length && value < 16) {
    return hexToColor(palette[value] ?? "#00000000") ?? 0;
  }
  return value;
}

function upgradeElement(element: Element, palette: string[]): Element {
  if ("color" in element) {
    return { ...element, color: sceneColor(element.color, palette) };
  }
  if (element.kind === "pattern") {
    return {
      ...element,
      colorA: sceneColor(element.colorA, palette),
      colorB: sceneColor(element.colorB, palette),
    };
  }
  return element;
}

/** Read a scene at any version into the current packed-RGBA shape. */
export function upgradeScene(scene: ArtboardScene, palette: string[]): ArtboardScene {
  if (scene.version === 2) return scene;
  const background =
    scene.background.kind === "solid"
      ? { ...scene.background, color: sceneColor(scene.background.color, palette) }
      : scene.background.kind === "pattern"
        ? {
            ...scene.background,
            colorA: sceneColor(scene.background.colorA, palette),
            colorB: sceneColor(scene.background.colorB, palette),
          }
        : scene.background;
  return {
    ...scene,
    version: 2,
    background,
    elements: scene.elements.map((element) => upgradeElement(element, palette)),
  };
}

import { zoomSteps, type Camera } from "./types.js";

export function zoomAt(
  camera: Camera,
  screenX: number,
  screenY: number,
  nextZoom: number,
): Camera {
  const worldX = (screenX - camera.x) / camera.zoom;
  const worldY = (screenY - camera.y) / camera.zoom;
  return {
    zoom: nextZoom,
    x: screenX - worldX * nextZoom,
    y: screenY - worldY * nextZoom,
  };
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps: number[] = [...zoomSteps];
  if (direction > 0) return steps.find((step) => step > zoom) ?? steps.at(-1) ?? zoom;
  const smaller = [...steps].reverse().find((step) => step < zoom);
  return smaller ?? steps[0] ?? zoom;
}

export function fitZoom(
  viewWidth: number,
  viewHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding = 48,
): number {
  const availableWidth = Math.max(viewWidth - padding * 2, 1);
  const availableHeight = Math.max(viewHeight - padding * 2, 1);
  const raw = Math.min(availableWidth / canvasWidth, availableHeight / canvasHeight);
  // Fit is an exact camera zoom, not a toolbar step: a 1080px canvas must be
  // allowed to sit at 40% when that is what the viewport needs.
  return Math.max(0.05, raw);
}

export function centerCamera(
  viewWidth: number,
  viewHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
): Camera {
  return {
    zoom,
    x: (viewWidth - canvasWidth * zoom) / 2,
    y: (viewHeight - canvasHeight * zoom) / 2,
  };
}

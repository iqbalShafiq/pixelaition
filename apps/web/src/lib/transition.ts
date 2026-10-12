/**
 * The home-to-editor move is a typed View Transition: elements marked with
 * `data-flight` morph into the editor's named counterparts. The option only
 * carries types when the browser has the API; otherwise navigation is plain.
 */

export const FLIGHT_TYPE = "editor";

export function supportsViewTransition(target?: Document): boolean {
  if (target === undefined) {
    return (
      typeof document !== "undefined" &&
      typeof (document as Document & { startViewTransition?: unknown })
        .startViewTransition === "function"
    );
  }
  return (
    typeof (target as Document & { startViewTransition?: unknown })
      .startViewTransition === "function"
  );
}

export function viewTransitionOption(target?: Document): { types: string[] } | boolean {
  if (!supportsViewTransition(target)) return false;
  // Chromium aborts a transition in a hidden document; a plain navigation is
  // what the user gets anyway when they come back to the tab.
  const doc = target ?? (typeof document !== "undefined" ? document : undefined);
  if (doc !== undefined && doc.visibilityState === "hidden") return false;
  return { types: [FLIGHT_TYPE] };
}

export type FlightName = "composer" | "console" | "asset";

/** Marks (or clears) the elements CSS names during the morph. */
export function markFlight(
  elements: Array<Element | null | undefined>,
  on: boolean,
  name: FlightName = "composer",
): void {
  for (const element of elements) {
    if (!element) continue;
    if (on) element.setAttribute("data-flight", name);
    else element.removeAttribute("data-flight");
  }
}

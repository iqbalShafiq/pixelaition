/**
 * The home-to-editor move is a typed View Transition: elements marked with
 * `data-flight` morph into the editor's named counterparts. The option only
 * carries types when the browser has the API; otherwise navigation is plain.
 */

/** Home → editor, reached from the agent's plan card. */
export const FLIGHT_TYPE = "editor";
/** Home → editor, reached by opening an asset card. */
export const FLIGHT_CARD_TYPE = "editor-card";
/** Editor → home, the same move played backwards. */
export const FLIGHT_BACK_TYPE = "editor-back";

export type FlightType =
  typeof FLIGHT_TYPE | typeof FLIGHT_CARD_TYPE | typeof FLIGHT_BACK_TYPE;

/** Which home control the editor visit came from, or "back" on the way home. */
export type Door = "plan" | "card" | "back";

/** What the home remembers about the editor it was left from. */
export type HomeReturn = {
  /** The card the editor was opened from, so the same card can fly it back. */
  cardAssetId?: string;
};

/**
 * History state arrives from the browser's storage as whatever was written
 * there, so the home reads it back instead of trusting its shape.
 */
export function decodeHomeReturn(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const cardAssetId = (raw as HomeReturn).cardAssetId;
  return typeof cardAssetId === "string" ? cardAssetId : undefined;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Carried on the editor's history entry, so a plain navigation keeps it. */
    door?: Door;
    /** Carried on the home's entry after an editor visit. */
    homeReturn?: HomeReturn;
  }
}

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

export function viewTransitionOption(
  target?: Document,
  type: FlightType = FLIGHT_TYPE,
): { types: string[] } | boolean {
  if (!supportsViewTransition(target)) return false;
  // Chromium aborts a transition in a hidden document; a plain navigation is
  // what the user gets anyway when they come back to the tab.
  const doc = target ?? (typeof document !== "undefined" ? document : undefined);
  if (doc !== undefined && doc.visibilityState === "hidden") return false;
  return { types: [type] };
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

/**
 * The asset card the user is opening carries the flight, so the card itself is
 * what travels into the editor's canvas. `data-flight="asset"` names it
 * `asset-flight`; the editor's canvas carries the same name statically.
 */
export function markCardFlight(element: Element | null | undefined): void {
  if (!element) return;
  element.setAttribute("data-flight", "asset");
}

/** A typed navigation that falls back to a plain one when a transition aborts. */
export async function navigateTyped(
  go: (options: { viewTransition: { types: string[] } | boolean }) => Promise<void>,
  type: FlightType,
  plain: () => Promise<void>,
): Promise<void> {
  try {
    await go({ viewTransition: viewTransitionOption(undefined, type) });
  } catch {
    // A transition the browser aborted (hidden tab, another transition) must
    // not strand the user; the plain navigation still lands.
    await plain().catch(() => undefined);
  }
}

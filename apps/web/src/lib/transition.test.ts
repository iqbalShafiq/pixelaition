import { describe, expect, it } from "vitest";
import {
  FLIGHT_AUTH_TYPE,
  FLIGHT_BACK_TYPE,
  FLIGHT_CARD_TYPE,
  FLIGHT_SIGN_OUT_TYPE,
  FLIGHT_TYPE,
  decodeHomeReturn,
  navigateTyped,
  markCardFlight,
  markFlight,
  supportsViewTransition,
  viewTransitionOption,
} from "./transition.js";

describe("view transitions", () => {
  it("detects support on a document with startViewTransition", () => {
    const fake = { startViewTransition: () => undefined } as unknown as Document;
    expect(supportsViewTransition(fake)).toBe(true);
    expect(supportsViewTransition({} as unknown as Document)).toBe(false);
    expect(supportsViewTransition(undefined)).toBe(false);
  });

  it("names the card door by default and the card's own type on request", () => {
    const visible = {
      startViewTransition: () => undefined,
      visibilityState: "visible",
    } as unknown as Document;
    expect(viewTransitionOption(visible)).toEqual({ types: [FLIGHT_TYPE] });
    expect(viewTransitionOption(visible, FLIGHT_CARD_TYPE)).toEqual({
      types: ["editor-card"],
    });
    // Without the API there is no type to carry, whichever door was used.
    expect(viewTransitionOption({} as unknown as Document, FLIGHT_CARD_TYPE)).toBe(false);
  });

  it("returns the typed option only when the API exists and the tab is visible", () => {
    const visible = {
      startViewTransition: () => undefined,
      visibilityState: "visible",
    } as unknown as Document;
    expect(viewTransitionOption(visible)).toEqual({ types: ["editor"] });
    const hidden = {
      startViewTransition: () => undefined,
      visibilityState: "hidden",
    } as unknown as Document;
    expect(viewTransitionOption(hidden)).toBe(false);
    expect(viewTransitionOption({} as unknown as Document)).toBe(false);
  });

  it("names the card door by default and the card's own type on request", () => {
    const visible = {
      startViewTransition: () => undefined,
      visibilityState: "visible",
    } as unknown as Document;
    expect(viewTransitionOption(visible)).toEqual({ types: [FLIGHT_TYPE] });
    expect(viewTransitionOption(visible, FLIGHT_CARD_TYPE)).toEqual({
      types: ["editor-card"],
    });
    // Without the API there is no type to carry, whichever door was used.
    expect(viewTransitionOption({} as unknown as Document, FLIGHT_CARD_TYPE)).toBe(false);
  });

  it("marks a card as the flying element", () => {
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
    } as unknown as Element;
    markCardFlight(element);
    expect(element.getAttribute("data-flight")).toBe("asset");
    markCardFlight(null);
  });

  it("carries the back type, and navigates plainly when a transition aborts", async () => {
    const visible = {
      startViewTransition: () => undefined,
      visibilityState: "visible",
    } as unknown as Document;
    expect(viewTransitionOption(visible, FLIGHT_BACK_TYPE)).toEqual({
      types: ["editor-back"],
    });

    const aborted = new Error("aborted");
    const plain: string[] = [];
    await navigateTyped(
      () => Promise.reject(aborted),
      FLIGHT_BACK_TYPE,
      async () => {
        plain.push("plain");
      },
    );
    expect(plain).toEqual(["plain"]);

    const typed: string[] = [];
    await navigateTyped(
      (options) => {
        typed.push(JSON.stringify(options.viewTransition));
        return Promise.resolve();
      },
      FLIGHT_CARD_TYPE,
      async () => {
        plain.push("never");
      },
    );
    expect(typed).toHaveLength(1);
    expect(plain).toEqual(["plain"]);
  });

  it("carries the auth doors as their own types", () => {
    const visible = {
      startViewTransition: () => undefined,
      visibilityState: "visible",
    } as unknown as Document;
    expect(viewTransitionOption(visible, FLIGHT_AUTH_TYPE)).toEqual({
      types: ["auth-in"],
    });
    expect(viewTransitionOption(visible, FLIGHT_SIGN_OUT_TYPE)).toEqual({
      types: ["auth-out"],
    });
  });

  it("reads the return state back instead of trusting it", () => {
    expect(decodeHomeReturn({ cardAssetId: "a1" })).toBe("a1");
    expect(decodeHomeReturn({})).toBeUndefined();
    expect(decodeHomeReturn({ cardAssetId: 7 })).toBeUndefined();
    expect(decodeHomeReturn(null)).toBeUndefined();
    expect(decodeHomeReturn("card")).toBeUndefined();
  });

  it("marks and clears the flight attributes", () => {
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      hasAttribute: (name: string) => attributes.has(name),
    } as unknown as Element;
    markFlight([element], true, "composer");
    expect(element.getAttribute("data-flight")).toBe("composer");
    markFlight([element], false);
    expect(element.hasAttribute("data-flight")).toBe(false);
  });
});

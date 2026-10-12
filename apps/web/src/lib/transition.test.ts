import { describe, expect, it } from "vitest";
import {
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

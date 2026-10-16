import { describe, expect, it } from "vitest";
import { toastPayload } from "./toast.js";

describe("toastPayload", () => {
  it("keeps a named id so a repeated notice replaces its own toast", () => {
    expect(
      toastPayload({ id: "frame-save", title: "A frame did not save" }),
    ).toMatchObject({
      id: "frame-save",
      title: "A frame did not save",
    });
    expect(toastPayload({ title: "Saved" })).not.toHaveProperty("id");
  });

  it("gives a failure text the longer life", () => {
    expect(toastPayload({ title: "x", description: "The save failed." }).timeout).toBe(
      8000,
    );
    expect(toastPayload({ title: "x", description: "Saved." }).timeout).toBe(4000);
    expect(toastPayload({ title: "x" }).timeout).toBe(4000);
  });
});

import { describe, expect, it } from "vitest";
import { roleOfKey } from "./asset-draw.js";

describe("task child keys", () => {
  it("reads each role's own prefix", () => {
    expect(roleOfKey("plan")).toBe("plan");
    expect(roleOfKey("plan-1")).toBe("plan");
    expect(roleOfKey("plan-create")).toBe("plan");
    expect(roleOfKey("plan-retry-2")).toBe("plan");
    expect(roleOfKey("w1")).toBe("worker");
    expect(roleOfKey("w4-retry-1")).toBe("worker");
    expect(roleOfKey("review-1")).toBe("review");
    expect(roleOfKey("review-2-retry-1")).toBe("review");
    expect(roleOfKey("fix-1-2")).toBe("fix");
    expect(roleOfKey("fix-unpainted")).toBe("fix");
  });

  it("never reads an unknown key as a role", () => {
    // A plan frame called "putar-1" once reached the bind path, where a
    // startswith("plan") / startswith("w") guess made it a worker; an unknown
    // key is unknown, and the worker logs it instead of binding a guess.
    expect(roleOfKey("putar-1")).toBeUndefined();
    expect(roleOfKey("window")).toBeUndefined();
    expect(roleOfKey("")).toBeUndefined();
  });
});

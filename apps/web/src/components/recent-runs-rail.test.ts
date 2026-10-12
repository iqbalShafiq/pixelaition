import { describe, expect, it } from "vitest";
import { timeAgo } from "./recent-runs-rail.js";

const now = new Date("2026-10-13T12:00:00Z").getTime();

describe("timeAgo", () => {
  it("reads like an activity feed, with a date once a week has passed", () => {
    expect(timeAgo("2026-10-13T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-13T11:42:00Z", now)).toBe("18m ago");
    expect(timeAgo("2026-10-13T07:30:00Z", now)).toBe("5h ago");
    expect(timeAgo("2026-10-10T12:00:00Z", now)).toBe("3d ago");
    expect(timeAgo("2026-09-01T12:00:00Z", now)).toMatch(/^\d/);
  });

  it("stays quiet on a value the browser cannot parse", () => {
    expect(timeAgo("not a date", now)).toBe("");
  });
});

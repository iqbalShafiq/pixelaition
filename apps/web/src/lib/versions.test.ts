import { describe, expect, it } from "vitest";
import {
  authorLabel,
  frameSnapshotOf,
  groupByRun,
  kindLabel,
  relativeTime,
  snapshotToBuffer,
  toHistoryRows,
  type VersionRow,
} from "./versions.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function version(overrides: Partial<VersionRow>): VersionRow {
  return {
    id: "v1",
    assetId: "a1",
    frameId: "f1",
    scope: "frame",
    kind: "run",
    author: "agent",
    runId: null,
    label: null,
    snapshot: { name: "idle", layers: [] },
    createdAt: "2026-10-11T11:59:30.000Z",
    ...overrides,
  };
}

describe("history rows", () => {
  it("names the run's model when the run resolves", () => {
    const models = new Map([["run-1", "muse-spark-1.3-contributor"]]);
    const rows = toHistoryRows([version({ runId: "run-1" })], models, NOW);
    expect(rows[0]?.authorLabel).toBe("Agent · muse-spark-1.3-contributor");
  });

  it("stays plain Agent when the run does not resolve", () => {
    const rows = toHistoryRows(
      [version({ runId: "run-gone" })],
      new Map([["run-1", "muse"]]),
      NOW,
    );
    expect(rows[0]?.authorLabel).toBe("Agent");
  });

  it("badges user edits as You even with a run id", () => {
    const rows = toHistoryRows(
      [version({ author: "user", runId: "run-1", kind: "edit" })],
      new Map([["run-1", "muse"]]),
      NOW,
    );
    expect(rows[0]?.authorLabel).toBe("You");
    expect(rows[0]?.kindLabel).toBe("Drawing");
  });

  it("passes a stored label through and keeps a null label null", () => {
    const rows = toHistoryRows(
      [version({ label: "before the jump" }), version({ id: "v2", label: null })],
      new Map(),
      NOW,
    );
    expect(rows[0]?.label).toBe("before the jump");
    expect(rows[1]?.label).toBeNull();
  });

  it("formats relative time without a ticker", () => {
    expect(relativeTime("2026-10-11T11:59:30.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-11T11:40:00.000Z", NOW)).toBe("20 min ago");
    expect(relativeTime("2026-10-11T09:00:00.000Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-10-08T12:00:00.000Z", NOW)).toBe("3 d ago");
    expect(relativeTime("not a date", NOW)).toBe("");
  });

  it("labels every stored kind, and leaves an unknown kind verbatim", () => {
    expect(kindLabel("run")).toBe("Agent run");
    expect(kindLabel("edit")).toBe("Drawing");
    expect(kindLabel("restore")).toBe("Restore");
    expect(kindLabel("frame-add")).toBe("Frame added");
    expect(kindLabel("resize")).toBe("Canvas resize");
    expect(kindLabel("future-kind")).toBe("future-kind");
  });

  it("reads a frame snapshot and refuses anything else", () => {
    const snapshot = {
      name: "jump",
      layers: [{ id: "l1", name: "pixels", visible: true, pixels: "AA==" }],
    };
    expect(frameSnapshotOf(snapshot)).toEqual(snapshot);
    expect(frameSnapshotOf({ name: "asset", width: 8 })).toBeNull();
    expect(frameSnapshotOf(null)).toBeNull();
    expect(
      frameSnapshotOf({ name: "bad", layers: [{ id: 1, name: "x", visible: true }] }),
    ).toBeNull();
  });

  it("builds a canvas buffer from a snapshot, or nothing when it cannot", () => {
    // 2x2 frame, one opaque pixel: base64 of [1,0,0,0].
    const pixels = Buffer.from([1, 0, 0, 0]).toString("base64");
    const buffer = snapshotToBuffer(
      { name: "idle", layers: [{ id: "l1", name: "pixels", visible: true, pixels }] },
      2,
      2,
      ["#00000000", "#ff0000"],
    );
    expect(buffer?.width).toBe(2);
    expect(buffer?.layers[0]?.pixels[0]).toBe(1);
    expect(snapshotToBuffer({ name: "asset" }, 2, 2, ["#00000000"])).toBeNull();
    // A frame whose pixels do not fill this canvas must not preview.
    expect(
      snapshotToBuffer(
        { name: "idle", layers: [{ id: "l1", name: "pixels", visible: true, pixels }] },
        4,
        4,
        ["#00000000", "#ff0000"],
      ),
    ).toBeNull();
  });

  it("groups frame entries by run, skipping user edits", () => {
    const rows = toHistoryRows(
      [
        version({ id: "v1", runId: "run-1" }),
        version({ id: "v2", runId: "run-1", frameId: "f2" }),
        version({ id: "v3", author: "user", kind: "edit" }),
        version({ id: "v4", scope: "asset", frameId: null, kind: "resize" }),
      ],
      new Map([["run-1", "muse"]]),
      NOW,
    );
    const groups = groupByRun(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runId).toBe("run-1");
    expect(groups[0]?.authorLabel).toBe("Agent · muse");
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["v1", "v2"]);
  });

  it("resolves an author label directly", () => {
    expect(authorLabel("agent", null, new Map())).toBe("Agent");
    expect(authorLabel("agent", "r", new Map([["r", "gpt"]]))).toBe("Agent · gpt");
    expect(authorLabel("user", "r", new Map([["r", "gpt"]]))).toBe("You");
  });
});

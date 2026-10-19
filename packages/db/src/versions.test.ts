import { describe, expect, it } from "vitest";
import {
  COALESCE_WINDOW_MS,
  pruneOrder,
  RETENTION_LIMIT,
  shouldCoalesce,
  toVersionRow,
  type VersionCandidate,
  type VersionInput,
  type VersionRow,
} from "./versions.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

function row(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    id: "version-1",
    assetId: "asset-1",
    frameId: "frame-1",
    scope: "frame",
    kind: "stroke",
    author: "user",
    runId: null,
    label: null,
    snapshot: {},
    createdAt: NOW,
    ...overrides,
  };
}

function incoming(overrides: Partial<VersionInput> = {}): VersionInput {
  return {
    assetId: "asset-1",
    frameId: "frame-1",
    scope: "frame",
    kind: "stroke",
    author: "user",
    snapshot: {},
    ...overrides,
  };
}

function candidate(
  index: number,
  overrides: Partial<VersionCandidate> = {},
): VersionCandidate {
  return {
    id: `version-${index}`,
    label: null,
    createdAt: new Date(NOW.getTime() - index * 1_000),
    ...overrides,
  };
}

describe("shouldCoalesce", () => {
  it("coalesces the same author and kind inside the window", () => {
    const existing = row({ createdAt: new Date(NOW.getTime() - COALESCE_WINDOW_MS + 1) });
    expect(shouldCoalesce(existing, incoming(), NOW)).toBe(true);
  });

  it("coalesces on the exact window boundary", () => {
    const existing = row({ createdAt: new Date(NOW.getTime() - COALESCE_WINDOW_MS) });
    expect(shouldCoalesce(existing, incoming(), NOW)).toBe(true);
  });

  it("does not coalesce across authors", () => {
    expect(shouldCoalesce(row(), incoming({ author: "agent" }), NOW)).toBe(false);
  });

  it("does not coalesce outside the window", () => {
    const existing = row({ createdAt: new Date(NOW.getTime() - COALESCE_WINDOW_MS - 1) });
    expect(shouldCoalesce(existing, incoming(), NOW)).toBe(false);
  });

  it("does not coalesce a different kind, frame, or scope", () => {
    expect(shouldCoalesce(row(), incoming({ kind: "palette" }), NOW)).toBe(false);
    expect(shouldCoalesce(row(), incoming({ frameId: "frame-2" }), NOW)).toBe(false);
    expect(shouldCoalesce(row(), incoming({ scope: "asset", frameId: null }), NOW)).toBe(
      false,
    );
    expect(shouldCoalesce(row({ frameId: null, scope: "asset" }), incoming(), NOW)).toBe(
      false,
    );
  });

  it("never overwrites a labeled snapshot", () => {
    expect(shouldCoalesce(row({ label: "before palette swap" }), incoming(), NOW)).toBe(
      false,
    );
  });
});

describe("pruneOrder", () => {
  it("keeps a short list untouched", () => {
    expect(pruneOrder([candidate(0), candidate(1)])).toEqual([]);
    expect(
      pruneOrder(Array.from({ length: RETENTION_LIMIT }, (_, index) => candidate(index))),
    ).toEqual([]);
  });

  it("drops the oldest unlabeled snapshots past the limit", () => {
    const rows = Array.from({ length: RETENTION_LIMIT + 5 }, (_, index) =>
      candidate(index),
    );
    expect(pruneOrder(rows)).toEqual([
      "version-204",
      "version-203",
      "version-202",
      "version-201",
      "version-200",
    ]);
  });

  it("prunes unlabeled snapshots before newer labeled ones", () => {
    const rows = [
      ...Array.from({ length: RETENTION_LIMIT - 1 }, (_, index) => candidate(index)),
      candidate(199, { label: "oldest labeled" }),
      candidate(200),
      candidate(201),
    ];
    expect(pruneOrder(rows)).toEqual(["version-201", "version-200"]);
  });

  it("never prunes a labeled snapshot, so an all-labeled list stays over the limit", () => {
    const rows = Array.from({ length: RETENTION_LIMIT + 3 }, (_, index) =>
      candidate(index, { label: `checkpoint ${index}` }),
    );
    expect(pruneOrder(rows)).toEqual([]);
  });
});

describe("toVersionRow", () => {
  it("normalizes absent optionals to null", () => {
    expect(
      toVersionRow({
        id: "version-1",
        assetId: "asset-1",
        scope: "asset",
        kind: "palette",
        author: "agent",
        snapshot: { layers: [] },
        createdAt: NOW,
      }),
    ).toEqual({
      id: "version-1",
      assetId: "asset-1",
      frameId: null,
      scope: "asset",
      kind: "palette",
      author: "agent",
      runId: null,
      label: null,
      snapshot: { layers: [] },
      createdAt: NOW,
    });
  });

  it("keeps the values it is given", () => {
    expect(
      toVersionRow({
        id: "version-2",
        assetId: "asset-1",
        frameId: "frame-1",
        scope: "frame",
        kind: "stroke",
        author: "user",
        runId: "run-1",
        label: "checkpoint",
        snapshot: [1, 2],
        createdAt: NOW,
      }),
    ).toMatchObject({
      frameId: "frame-1",
      runId: "run-1",
      label: "checkpoint",
      snapshot: [1, 2],
    });
  });
});

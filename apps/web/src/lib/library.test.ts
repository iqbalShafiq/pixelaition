import { describe, expect, it } from "vitest";
import { filterLibrary } from "./library.js";

const projects = [
  {
    id: "p1",
    name: "knights",
    summary: "armored heroes",
    updatedAt: "2026-10-10T10:00:00Z",
  },
  {
    id: "p2",
    name: "potions",
    summary: "bottles and flasks",
    updatedAt: "2026-10-11T10:00:00Z",
  },
];
const assets = [
  {
    id: "a1",
    projectId: "p2",
    name: "flask",
    summary: "a round flask",
    width: 32,
    height: 32,
    updatedAt: "2026-10-11T09:00:00Z",
  },
  {
    id: "a2",
    projectId: "p2",
    name: "red potion",
    summary: "a red bottle with a cork",
    width: 32,
    height: 32,
    updatedAt: "2026-10-11T11:00:00Z",
  },
];

describe("filterLibrary", () => {
  it("matches name and summary, case-insensitively", () => {
    const result = filterLibrary({ projects, assets, query: "FLASK", group: "recent" });
    expect(result.assets.map((asset) => asset.id)).toEqual(["a1"]);
  });

  it("matches a project by its summary and keeps its assets", () => {
    const result = filterLibrary({ projects, assets, query: "armored", group: "recent" });
    expect(result.projects.map((project) => project.id)).toEqual(["p1"]);
    expect(result.assets).toEqual([]);
  });

  it("groups by project with newest-first assets", () => {
    const result = filterLibrary({ projects, assets, query: "", group: "project" });
    const potions = result.projects.find((project) => project.id === "p2");
    expect(potions?.assets[0]?.id).toBe("a2");
    expect(result.projects.find((project) => project.id === "p1")?.assets).toHaveLength(
      0,
    );
  });

  it("returns everything for an empty query", () => {
    expect(
      filterLibrary({ projects, assets, query: "  ", group: "recent" }).assets,
    ).toHaveLength(assets.length);
  });
});

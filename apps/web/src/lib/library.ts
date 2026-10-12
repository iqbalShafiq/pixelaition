/**
 * The home library's filtering: one query over project and asset names and
 * generated summaries, with a grouping toggle. Pure so the rules stay testable
 * without a browser.
 */

export type LibraryProject = {
  id: string;
  name: string;
  summary: string;
  updatedAt: string;
};

export type LibraryAsset = {
  id: string;
  projectId: string;
  name: string;
  summary: string;
  width: number;
  height: number;
  updatedAt: string;
};

export type LibraryResult = {
  /** Assets matching the query, newest first (the "recent" view). */
  assets: LibraryAsset[];
  /** Projects matching the query or holding a matching asset, with those assets. */
  projects: Array<LibraryProject & { assets: LibraryAsset[] }>;
};

function matches(query: string, name: string, summary: string): boolean {
  if (query.length === 0) return true;
  return `${name} ${summary}`.toLowerCase().includes(query);
}

function newestFirst(assets: LibraryAsset[]): LibraryAsset[] {
  return [...assets].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function filterLibrary(input: {
  projects: LibraryProject[];
  assets: LibraryAsset[];
  query: string;
  group: "recent" | "project";
}): LibraryResult {
  const query = input.query.trim().toLowerCase();
  const matchedAssets = newestFirst(
    input.assets.filter((asset) => matches(query, asset.name, asset.summary)),
  );
  const matchedProjects = input.projects.filter(
    (project) =>
      matches(query, project.name, project.summary) ||
      matchedAssets.some((asset) => asset.projectId === project.id),
  );
  return {
    assets: matchedAssets,
    projects: matchedProjects.map((project) => ({
      ...project,
      assets: matchedAssets.filter((asset) => asset.projectId === project.id),
    })),
  };
}

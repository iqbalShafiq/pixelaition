import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Folder, Plus } from "../components/pixel-icons.js";
import { useState } from "react";
import { SpriteThumb } from "../components/sprite-thumb.js";
import {
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  TextInput,
  useToast,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

type Project = { id: string; name: string; description: string };
type Asset = { id: string; name: string; width: number; height: number };

export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const notify = useToast();
  const [name, setName] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: Project[] }>("/api/projects"),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: async (project) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      notify({ title: "Project created", description: project.name });
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not create the project",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const list = projects.data?.projects ?? [];

  return (
    <main id="content" className="pixel-grid-lg min-h-dvh bg-paper">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-8">
        <header className="flex items-center justify-between gap-4 border-b-2 border-line pb-4">
          <span className="flex items-center gap-2.5">
            <PixelMark />
            <span className="text-pixel-display text-accent">PIXELAITION</span>
          </span>
          <Button
            tone="ghost"
            className="px-3 py-1.5 text-[12px]"
            onClick={() => {
              void authClient.signOut().then(() => window.location.assign("/login"));
            }}
          >
            Sign out
          </Button>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1fr_24rem] lg:items-end">
          <div>
            <p className="text-pixel-mono tracking-[0.2em] text-muted uppercase">
              Workspace
            </p>
            <h1 className="mt-3 text-[2.5rem] leading-[1.05] font-medium tracking-[-0.02em] text-ink text-balance">
              Your sprite families
            </h1>
            <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-muted">
              One project keeps one palette and one style guide, so every asset you draw
              inside it stays recognisably related.
            </p>
          </div>

          <Card className="grid gap-3">
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <Field label="New project" htmlFor="project-name">
                <TextInput
                  id="project-name"
                  value={name}
                  placeholder="Knights, potions, dungeon tiles…"
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={!name.trim() || create.isPending}
                className="w-full"
              >
                {create.isPending ? "Creating" : "Create project"}
                <ArrowRight />
              </Button>
            </form>
          </Card>
        </section>

        <section className="grid gap-4">
          <div className="flex items-baseline justify-between gap-4 border-b-2 border-line pb-2">
            <h2 className="text-pixel-mono tracking-[0.2em] text-muted uppercase">
              Projects
            </h2>
            <span className="text-pixel-mono text-muted">
              {list.length.toString().padStart(2, "0")}
            </span>
          </div>

          {projects.isPending ? (
            <p className="text-pixel-mono text-muted">
              Reading your projects from the server…
            </p>
          ) : projects.isError ? (
            <Callout tone="danger">
              {projects.error instanceof Error
                ? projects.error.message
                : "The project list could not be loaded."}
            </Callout>
          ) : list.length === 0 ? (
            <EmptyState
              title="No projects yet"
              body="Create one above. Every asset inside it inherits the same palette and style guide."
            />
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function PixelMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden>
      <rect x="0" y="0" width="4" height="4" fill="var(--color-accent)" />
      <rect x="4" y="0" width="4" height="4" fill="var(--color-ink)" />
      <rect x="0" y="4" width="4" height="4" fill="var(--color-ink)" />
      <rect x="4" y="4" width="4" height="4" fill="var(--color-accent)" />
    </svg>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["project-assets", project.id],
    // Loaded eagerly so the shelf can show a real sprite instead of a folder.
    queryFn: () => api<{ assets: Asset[] }>(`/api/projects/${project.id}`),
  });
  const createAsset = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/projects/${project.id}/assets`, {
        method: "POST",
        body: JSON.stringify({ name: "Untitled" }),
      }),
    onSuccess: async (asset) => {
      await queryClient.invalidateQueries({ queryKey: ["project-assets", project.id] });
      window.location.assign(`/projects/${project.id}/assets/${asset.id}`);
    },
    onError: (reason: unknown) =>
      notify({
        title: "Could not open a new asset",
        description: reason instanceof Error ? reason.message : "Unknown error",
      }),
  });

  const assets = detail.data?.assets ?? [];
  const newest = assets.at(-1);

  return (
    <Card interactive className="grid h-full grid-rows-[auto_auto_auto] gap-4">
      <div className="flex items-start gap-3">
        {newest ? (
          <SpriteThumb assetId={newest.id} />
        ) : (
          <span className="grid h-12 w-12 shrink-0 place-items-center border-2 border-dashed border-line text-muted">
            <Folder />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[17px] leading-tight font-medium text-ink">
            {project.name}
          </h3>
          <p className="mt-1 text-[12px] text-muted">
            {detail.isPending
              ? "Loading…"
              : assets.length === 0
                ? "Nothing drawn yet"
                : `${assets.length} asset${assets.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      <div className="min-h-0">
        <p className="text-[13px] leading-relaxed text-muted">
          {project.description || "No description yet."}
        </p>
        {open ? (
          detail.isPending ? (
            <p className="mt-3 text-pixel-mono text-muted">Loading…</p>
          ) : assets.length === 0 ? (
            <p className="mt-3 text-pixel-mono text-muted">Nothing drawn here yet.</p>
          ) : (
            <ul className="mt-3 grid gap-1">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <Link
                    to="/projects/$projectId/assets/$assetId"
                    params={{ projectId: project.id, assetId: asset.id }}
                    className="flex items-center gap-2 border-2 border-transparent px-2 py-1.5 text-[13px] text-ink transition-colors duration-150 hover:border-line hover:bg-raised"
                  >
                    <SpriteThumb assetId={asset.id} display={26} />
                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                    <span className="text-pixel-mono text-muted">
                      {asset.width}×{asset.height}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          className="flex-1 px-3 py-1.5 text-[12px]"
          disabled={createAsset.isPending}
          onClick={() => createAsset.mutate()}
        >
          <Plus />
          New asset
        </Button>
        <Button
          tone="ghost"
          className="px-3 py-1.5 text-[12px]"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : `Browse ${assets.length > 0 ? `(${assets.length})` : ""}`}
        </Button>
      </div>
    </Card>
  );
}

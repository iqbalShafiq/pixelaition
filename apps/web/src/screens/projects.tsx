import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
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
    <main id="content" className="mx-auto grid max-w-5xl gap-8 px-6 py-10">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-accent">PIXELAITION</p>
          <h1 className="mt-2 text-3xl">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            One project keeps one palette and one style guide, so the assets inside it
            stay related.
          </p>
        </div>
        <Button
          tone="ghost"
          onClick={() => {
            void authClient.signOut().then(() => window.location.assign("/login"));
          }}
        >
          Sign out
        </Button>
      </header>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <span className="min-w-56 flex-1">
          <Field label="New project" htmlFor="project-name">
            <TextInput
              id="project-name"
              value={name}
              placeholder="Sprite family, tileset, icons…"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </span>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating" : "Create project"}
        </Button>
      </form>

      {projects.isPending ? (
        <p className="text-sm text-muted">Loading your projects from the server.</p>
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
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const assets = useQuery({
    queryKey: ["project-assets", project.id],
    enabled: open,
    queryFn: () =>
      api<{ assets: Array<{ id: string; name: string; width: number; height: number }> }>(
        `/api/projects/${project.id}`,
      ),
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

  const list = assets.data?.assets ?? [];

  return (
    <Card className="flex h-full flex-col">
      <h2 className="text-lg">{project.name}</h2>
      <p className="mt-1 flex-1 text-sm text-muted">
        {project.description || "No description yet."}
      </p>

      {open ? (
        assets.isPending ? (
          <p className="mt-3 font-mono text-[11px] text-muted">Loading assets…</p>
        ) : list.length === 0 ? (
          <p className="mt-3 font-mono text-[11px] text-muted">
            No assets yet in this project.
          </p>
        ) : (
          <ul className="mt-3 grid gap-0.5">
            {list.map((asset) => (
              <li key={asset.id}>
                <Link
                  to="/projects/$projectId/assets/$assetId"
                  params={{ projectId: project.id, assetId: asset.id }}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-paper"
                >
                  <span className="truncate">{asset.name}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {asset.width}×{asset.height}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={() => createAsset.mutate()} disabled={createAsset.isPending}>
          {createAsset.isPending ? "Opening" : "New asset"}
        </Button>
        <Button
          tone="ghost"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? "Hide assets" : "Browse assets"}
        </Button>
      </div>
    </Card>
  );
}

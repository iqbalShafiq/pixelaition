import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, TextInput } from "../components/ui.js";
import { api } from "../lib/api.js";
import { authClient } from "../lib/auth.js";

type Project = { id: string; name: string; description: string };

export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: Project[] }>("/api/projects"),
  });
  const create = useMutation({
    mutationFn: () =>
      api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: async () => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-accent">PIXELAITION</p>
          <h1 className="mt-2 text-4xl">Projects</h1>
        </div>
        <Button tone="ghost" onClick={() => void authClient.signOut()}>
          Sign out
        </Button>
      </header>
      <form
        className="mt-8 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New project name"
        />
        <Button type="submit">Create</Button>
      </form>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {projects.data?.projects.length === 0 ? (
          <p className="text-muted">Create a project to start a pixel family.</p>
        ) : null}
        {projects.data?.projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </main>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const createAsset = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/projects/${project.id}/assets`, {
        method: "POST",
        body: JSON.stringify({ name: "Untitled" }),
      }),
    onSuccess: async (asset) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      window.location.assign(`/projects/${project.id}/assets/${asset.id}`);
    },
  });
  return (
    <Card>
      <h2 className="text-xl">{project.name}</h2>
      <p className="mt-1 text-sm text-muted">
        {project.description || "No description yet."}
      </p>
      <Button className="mt-4" onClick={() => createAsset.mutate()}>
        Open a new asset
      </Button>
    </Card>
  );
}

import type { FormEvent } from "react";
import { Button, Field, TextInput } from "./ui.js";

export type ProjectNavItem = {
  id: string;
  name: string;
};

/**
 * The home's project switcher. `rail` is the sticky column on a wide screen;
 * `strip` is the same control as a scrolling row, so a phone never gets a
 * fixed sidebar it cannot reach.
 */
export function ProjectNav({
  projects,
  counts,
  activeId,
  onSelect,
  name,
  onName,
  onCreate,
  creating,
  layout,
}: {
  projects: ProjectNavItem[];
  counts: Record<string, number>;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  name: string;
  onName: (value: string) => void;
  onCreate: () => void;
  creating: boolean;
  layout: "rail" | "strip";
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate();
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  if (layout === "strip") {
    return (
      <div className="grid min-w-0 gap-3">
        <div
          role="group"
          aria-label="Projects"
          className="flex gap-1 overflow-x-auto pb-1"
        >
          <ProjectChip
            label="All"
            count={total}
            active={activeId === null}
            onClick={() => onSelect(null)}
          />
          {projects.map((project) => (
            <ProjectChip
              key={project.id}
              label={project.name}
              count={counts[project.id] ?? 0}
              active={activeId === project.id}
              onClick={() => onSelect(project.id)}
            />
          ))}
        </div>
        <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-2" onSubmit={submit}>
          <TextInput
            aria-label="New project"
            value={name}
            placeholder="New project"
            autoComplete="off"
            onChange={(event) => onName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || creating}>
            {creating ? "Creating" : "Create"}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <nav aria-label="Projects" className="grid min-w-0 content-start gap-4">
      <h2 className="text-pixel-title text-ink">Projects</h2>
      <ul className="grid gap-1">
        <li>
          <ProjectRow
            label="All projects"
            count={total}
            active={activeId === null}
            onClick={() => onSelect(null)}
          />
        </li>
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectRow
              label={project.name}
              count={counts[project.id] ?? 0}
              active={activeId === project.id}
              onClick={() => onSelect(project.id)}
            />
          </li>
        ))}
      </ul>
      <form className="grid gap-3 border-t-2 border-line pt-4" onSubmit={submit}>
        <Field label="New project" htmlFor="project-name">
          <TextInput
            id="project-name"
            value={name}
            placeholder="Knights, potions…"
            autoComplete="off"
            onChange={(event) => onName(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!name.trim() || creating} className="w-full">
          {creating ? "Creating" : "Create project"}
        </Button>
      </form>
    </nav>
  );
}

function ProjectRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={`flex w-full min-w-0 items-center justify-between gap-2 border-2 px-2 py-1.5 text-left text-pixel-label transition-colors duration-150 ${
        active
          ? "border-accent bg-field text-ink"
          : "border-transparent text-muted hover:border-line hover:bg-panel hover:text-ink"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="text-pixel-mono">{count.toString().padStart(2, "0")}</span>
    </button>
  );
}

function ProjectChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`pixel-corners-sm inline-flex shrink-0 items-center gap-2 border-2 px-2.5 py-1.5 text-pixel-label transition-colors duration-150 ${
        active
          ? "border-accent bg-field text-ink"
          : "border-line text-muted hover:border-line-strong hover:text-ink"
      }`}
    >
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className="text-pixel-mono">{count.toString().padStart(2, "0")}</span>
    </button>
  );
}

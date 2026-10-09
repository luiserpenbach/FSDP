import { useWorkspace } from "./WorkspaceContext";

/**
 * Project and fluid-system selectors in the sidebar, available on every page.
 * Creating, renaming, and deleting projects and systems stays on /systems.
 */
export function WorkspaceSwitcher({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }) {
  const { projects, selectedProjectId, selectedProject, selectProject, systems, selectedSystemId, selectedSystem, selectSystem } = useWorkspace();

  if (collapsed) {
    const initials = (selectedProject?.name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "–";
    const summary = selectedProject
      ? `${selectedProject.name}${selectedSystem ? ` · ${selectedSystem.name}` : ""} (expand to switch)`
      : "No project selected (expand to switch)";
    return (
      <button type="button" className="switcherChip" onClick={onExpand} title={summary} aria-label={summary}>
        {initials}
      </button>
    );
  }

  return (
    <div className="workspaceSwitcher" role="group" aria-label="Working context">
      <label>
        Project
        <select value={selectedProjectId} onChange={(event) => selectProject(event.target.value)} disabled={!projects.length}>
          {!projects.length && <option value="">No projects yet</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        System
        <select value={selectedSystemId} onChange={(event) => selectSystem(event.target.value)} disabled={!systems.length}>
          {!systems.length && <option value="">{selectedProjectId ? "No systems yet" : "—"}</option>}
          {systems.map((system) => (
            <option key={system.id} value={system.id}>
              {system.name}
              {system.fluid ? ` (${system.fluid})` : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

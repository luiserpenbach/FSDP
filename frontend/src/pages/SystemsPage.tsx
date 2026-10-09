import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, TextArea, TextInput } from "../components/ui";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

/** Create, edit, and delete projects and their fluid systems. */
export function SystemsPage() {
  const {
    busy,
    formErrors,
    runAction,
    projects,
    refreshProjects,
    selectedProjectId,
    selectedProject,
    selectProject,
    systems,
    refreshSystems,
    selectedSystemId,
    selectedSystem,
    selectSystem,
    confirmDiscard
  } = useWorkspace();
  const [projectForm, setProjectForm] = useState({ name: "Demo Propulsion System", owner: "Propulsion Engineering", description: "MVP digital-thread project for FSDP." });
  const [systemForm, setSystemForm] = useState({ name: "Helium Pressurization", fluid: "GHe", description: "Pressurization system MVP workspace." });

  useEffect(() => {
    if (selectedProject) {
      setProjectForm({ name: selectedProject.name, owner: selectedProject.owner ?? "", description: selectedProject.description ?? "" });
    }
  }, [selectedProject]);

  useEffect(() => {
    if (selectedSystem) {
      setSystemForm({ name: selectedSystem.name, fluid: selectedSystem.fluid ?? "", description: selectedSystem.description ?? "" });
    }
  }, [selectedSystem]);

  function submitProject(event: FormEvent) {
    event.preventDefault();
    // Creating a project selects it, which discards editor work bound to the
    // current project. Ask before the project is created.
    if (!confirmDiscard("project")) return;
    void runAction("Created project.", async () => {
      const project = await api.createProject(projectForm);
      await refreshProjects();
      selectProject(project.id, { confirmed: true });
    }, "project");
  }

  function updateProject() {
    if (!selectedProject) return;
    void runAction("Updated project.", async () => {
      await api.updateProject(selectedProject.id, projectForm);
      await refreshProjects();
    }, "project");
  }

  function deleteProject() {
    if (!selectedProject || !window.confirm(`Delete project "${selectedProject.name}"?`)) return;
    void runAction("Deleted project.", async () => {
      await api.deleteProject(selectedProject.id);
      const next = await refreshProjects();
      selectProject(next[0]?.id || "", { confirmed: true });
    });
  }

  function submitSystem(event: FormEvent) {
    event.preventDefault();
    if (!selectedProject) return;
    // Creating a system selects it; ask before discarding work bound to the current system.
    if (!confirmDiscard("system")) return;
    void runAction("Created system.", async () => {
      const system = await api.createSystem(selectedProject.id, systemForm);
      await refreshSystems(selectedProject.id);
      selectSystem(system.id, { confirmed: true });
    }, "system");
  }

  function updateSystem() {
    if (!selectedProject || !selectedSystem) return;
    void runAction("Updated system.", async () => {
      await api.updateSystem(selectedSystem.id, systemForm);
      await refreshSystems(selectedProject.id);
    }, "system");
  }

  function deleteSystem() {
    if (!selectedProject || !selectedSystem || !window.confirm(`Delete system "${selectedSystem.name}"?`)) return;
    void runAction("Deleted system.", async () => {
      await api.deleteSystem(selectedSystem.id);
      const next = await refreshSystems(selectedProject.id);
      selectSystem(next[0]?.id || "", { confirmed: true });
    });
  }

  return (
    <PageLayout title="Systems" description="Projects and fluid systems">
      <section className="grid">
        <Panel title="Project">
          <form onSubmit={submitProject}>
            <TextInput label="Name" value={projectForm.name} onChange={(name) => setProjectForm({ ...projectForm, name })} />
            <TextInput label="Owner" value={projectForm.owner} onChange={(owner) => setProjectForm({ ...projectForm, owner })} />
            <TextArea label="Description" value={projectForm.description} onChange={(description) => setProjectForm({ ...projectForm, description })} />
            <FormError message={formErrors.project} />
            <button disabled={busy || !projectForm.name}>Create project</button>
          </form>
          <div className="buttonRow">
            <button disabled={busy || !selectedProject} onClick={updateProject}>Update selected</button>
            <button className="danger" disabled={busy || !selectedProject} onClick={deleteProject}>Delete selected</button>
          </div>
          <DataTable rows={projects} selectedKey={selectedProjectId} getKey={(project) => project.id} onSelect={(project) => selectProject(project.id)} columns={[{ header: "Name", render: (project) => project.name }, { header: "Owner", render: (project) => project.owner ?? "-" }]} />
        </Panel>
        <Panel title="Fluid System">
          <form onSubmit={submitSystem}>
            <TextInput label="Name" value={systemForm.name} onChange={(name) => setSystemForm({ ...systemForm, name })} />
            <TextInput label="Fluid" value={systemForm.fluid} onChange={(fluid) => setSystemForm({ ...systemForm, fluid })} />
            <TextArea label="Description" value={systemForm.description} onChange={(description) => setSystemForm({ ...systemForm, description })} />
            <FormError message={formErrors.system} />
            <button disabled={busy || !selectedProject || !systemForm.name}>Create system</button>
          </form>
          <div className="buttonRow">
            <button disabled={busy || !selectedSystem} onClick={updateSystem}>Update selected</button>
            <button className="danger" disabled={busy || !selectedSystem} onClick={deleteSystem}>Delete selected</button>
          </div>
          <DataTable rows={systems} selectedKey={selectedSystemId} getKey={(system) => system.id} onSelect={(system) => selectSystem(system.id)} columns={[{ header: "Name", render: (system) => system.name }, { header: "Fluid", render: (system) => system.fluid ?? "-" }]} />
        </Panel>
      </section>
    </PageLayout>
  );
}

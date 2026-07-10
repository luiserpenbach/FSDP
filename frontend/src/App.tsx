import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange
} from "reactflow";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, bomCsvUrl } from "./api";
import { AppShell, type NavItem } from "./components/AppShell";
import { DataTable, FormError, Panel, SummaryCard, TextArea, TextInput } from "./components/ui";
import { PageLayout, PlaceholderPage } from "./pages/PageLayout";
import { PartsCatalogPage } from "./pages/PartsCatalogPage";
import { PidEditorPage } from "./pages/PidEditorPage";
import { RequirementsPage } from "./pages/RequirementsPage";
import type { BomSnapshot, ComponentInstance, Diagram, FluidSystem, Impact, Part, Project, Requirement } from "./types";
import {
  DEFAULT_EDITOR_SETTINGS,
  normalizeEdge,
  normalizeNode,
  type PidEdgeData,
  type PidEditorSettings,
  type PidNodeData,
  type PidSymbolDefinition
} from "./utils/pidEditor";

const starterNodes: Node<PidNodeData>[] = [
  { id: "source-1", type: "pidSymbol", position: { x: 0, y: 80 }, style: { width: 140, height: 78 }, data: { label: "Tank / Source", symbolType: "source", rotation: 0 } },
  { id: "valve-1", type: "pidSymbol", position: { x: 220, y: 80 }, style: { width: 120, height: 72 }, data: { label: "Valve", symbolType: "valve", rotation: 0 } },
  { id: "sink-1", type: "pidSymbol", position: { x: 460, y: 80 }, style: { width: 140, height: 78 }, data: { label: "Engine / Sink", symbolType: "sink", rotation: 0 } }
];

const starterEdges: Edge<PidEdgeData>[] = [
  { id: "line-1", type: "pidLine", source: "source-1", target: "valve-1", label: "Feed line" },
  { id: "line-2", type: "pidLine", source: "valve-1", target: "sink-1", label: "Outlet line" }
];

const navItems: NavItem[] = [
  { path: "/dashboard", label: "Dashboard", description: "Project overview" },
  { path: "/systems", label: "Systems", description: "Fluid systems" },
  { path: "/diagrams", label: "Diagrams", description: "P&ID workspace" },
  { path: "/parts", label: "Parts Catalog", description: "Internal and vendor parts" },
  { path: "/requirements", label: "Requirements", description: "Traceable requirements" },
  { path: "/bom", label: "BoM & Procurement", description: "Snapshots and exports" },
  { path: "/safety", label: "Safety", description: "Hazards and analyses" },
  { path: "/reviews", label: "Reviews", description: "Impact and approvals" },
  { path: "/certification", label: "Certification", description: "Evidence packages" },
  { path: "/settings", label: "Settings", description: "Project configuration" }
];


export function App() {
  return (
    <BrowserRouter>
      <WorkspaceApp />
    </BrowserRouter>
  );
}

function WorkspaceApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [systems, setSystems] = useState<FluidSystem[]>([]);
  const [diagrams, setDiagrams] = useState<Diagram[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [components, setComponents] = useState<ComponentInstance[]>([]);
  const [bom, setBom] = useState<BomSnapshot | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [selectedDiagramId, setSelectedDiagramId] = useState("");
  const [selectedPartId, setSelectedPartId] = useState("");
  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [selectedComponentId, setSelectedComponentId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("valve-1");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");

  const [projectForm, setProjectForm] = useState({ name: "Demo Propulsion System", owner: "Propulsion Engineering", description: "MVP digital-thread project for FSDP." });
  const [systemForm, setSystemForm] = useState({ name: "Helium Pressurization", fluid: "GHe", description: "Pressurization system MVP workspace." });
  const [diagramName, setDiagramName] = useState("MVP P&ID");
  const [componentTag, setComponentTag] = useState("V-1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [error, setError] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [graphDirty, setGraphDirty] = useState(false);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState(starterNodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(starterEdges);
  const [editorSettings, setEditorSettings] = useState<PidEditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [customSymbols, setCustomSymbols] = useState<PidSymbolDefinition[]>([]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedSystem = systems.find((system) => system.id === selectedSystemId) ?? null;
  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const selectedComponent = components.find((component) => component.id === selectedComponentId) ?? null;

  const graphPayload = useMemo(
    () => ({
      graph: { nodes, edges, editorSettings, symbols: customSymbols },
      nodes: nodes.map((node) => ({
        external_id: node.id,
        node_type: String(node.data?.symbolType ?? node.type ?? "component"),
        label: String(node.data?.label ?? node.id),
        position: node.position,
        properties: { ...(node.data ?? {}), style: node.style ?? {} }
      })),
      edges: edges.map((edge) => ({
        external_id: edge.id,
        source_node_id: edge.source,
        target_node_id: edge.target,
        fluid: "TBD",
        flow_direction: "forward",
        properties: { label: edge.label, ...(edge.data ?? {}) }
      }))
    }),
    [customSymbols, edges, editorSettings, nodes]
  );

  useEffect(() => {
    void runAction("Loaded projects.", async () => {
      const next = await api.listProjects();
      setProjects(next);
      setSelectedProjectId((current) => current || next[0]?.id || "");
    });
    void runAction("Loaded parts.", async () => {
      const next = await api.listParts();
      setParts(next);
      setSelectedPartId((current) => current || "");
    });
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setSystems([]);
      setRequirements([]);
      return;
    }
    void runAction("Loaded project details.", async () => {
      const [nextSystems, nextRequirements] = await Promise.all([
        api.listSystems(selectedProjectId),
        api.listRequirements(selectedProjectId)
      ]);
      setSystems(nextSystems);
      setRequirements(nextRequirements);
      setSelectedSystemId((current) => (nextSystems.some((system) => system.id === current) ? current : nextSystems[0]?.id || ""));
      setSelectedRequirementId((current) => (nextRequirements.some((requirement) => requirement.id === current) ? current : ""));
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedSystemId) {
      setDiagrams([]);
      setSelectedDiagramId("");
      return;
    }
    void runAction("Loaded system diagrams.", async () => {
      const next = await api.listDiagrams(selectedSystemId);
      setDiagrams(next);
      setSelectedDiagramId((current) => (next.some((diagram) => diagram.id === current) ? current : next[0]?.id || ""));
    });
  }, [selectedSystemId]);

  useEffect(() => {
    if (!selectedDiagramId) {
      setComponents([]);
      setBom(null);
      setNodes(starterNodes.map(normalizeNode));
      setEdges(starterEdges.map(normalizeEdge));
      setEditorSettings(DEFAULT_EDITOR_SETTINGS);
      setCustomSymbols([]);
      return;
    }
    void runAction("Loaded saved diagram.", async () => {
      const diagram = await api.getDiagram(selectedDiagramId);
      setDiagramName(diagram.name);
      setNodes((diagram.graph.nodes?.length ? diagram.graph.nodes : starterNodes).map(normalizeNode));
      setEdges((diagram.graph.edges?.length ? diagram.graph.edges : starterEdges).map(normalizeEdge));
      setEditorSettings({ ...DEFAULT_EDITOR_SETTINGS, ...diagram.graph.editorSettings });
      setCustomSymbols(diagram.graph.symbols ?? []);
      setComponents(await api.listComponents(diagram.id));
      const snapshots = await api.listDiagramBoms(diagram.id);
      setBom(snapshots[0] ?? null);
      setGraphDirty(false);
    });
  }, [selectedDiagramId, setEdges, setNodes]);

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

  useEffect(() => {
    if (selectedComponent) {
      setComponentTag(selectedComponent.tag);
    }
  }, [selectedComponent]);

  async function runAction(successMessage: string, action: () => Promise<void>, formKey?: string) {
    setBusy(true);
    setError("");
    if (formKey) setFormErrors((current) => ({ ...current, [formKey]: "" }));
    try {
      await action();
      setMessage(successMessage);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Unknown error";
      setError(detail);
      if (formKey) setFormErrors((current) => ({ ...current, [formKey]: detail }));
      setMessage("Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setGraphDirty(true);
      onNodesChangeBase(changes);
    },
    [onNodesChangeBase]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setGraphDirty(true);
      onEdgesChangeBase(changes);
    },
    [onEdgesChangeBase]
  );

  function selectProject(id: string) {
    setSelectedProjectId(id);
    setSelectedSystemId("");
    setSelectedDiagramId("");
    setBom(null);
    setImpact(null);
  }

  function selectSystem(id: string) {
    setSelectedSystemId(id);
    setSelectedDiagramId("");
    setBom(null);
  }

  function submitProject(event: FormEvent) {
    event.preventDefault();
    void runAction("Created project.", async () => {
      const project = await api.createProject(projectForm);
      setProjects(await api.listProjects());
      setSelectedProjectId(project.id);
    }, "project");
  }

  function updateProject() {
    if (!selectedProject) return;
    void runAction("Updated project.", async () => {
      await api.updateProject(selectedProject.id, projectForm);
      setProjects(await api.listProjects());
    }, "project");
  }

  function deleteProject() {
    if (!selectedProject || !window.confirm(`Delete project "${selectedProject.name}"?`)) return;
    void runAction("Deleted project.", async () => {
      await api.deleteProject(selectedProject.id);
      const next = await api.listProjects();
      setProjects(next);
      setSelectedProjectId(next[0]?.id || "");
    });
  }

  function submitSystem(event: FormEvent) {
    event.preventDefault();
    if (!selectedProject) return;
    void runAction("Created system.", async () => {
      const system = await api.createSystem(selectedProject.id, systemForm);
      setSystems(await api.listSystems(selectedProject.id));
      setSelectedSystemId(system.id);
    }, "system");
  }

  function updateSystem() {
    if (!selectedProject || !selectedSystem) return;
    void runAction("Updated system.", async () => {
      await api.updateSystem(selectedSystem.id, systemForm);
      setSystems(await api.listSystems(selectedProject.id));
    }, "system");
  }

  function deleteSystem() {
    if (!selectedProject || !selectedSystem || !window.confirm(`Delete system "${selectedSystem.name}"?`)) return;
    void runAction("Deleted system.", async () => {
      await api.deleteSystem(selectedSystem.id);
      const next = await api.listSystems(selectedProject.id);
      setSystems(next);
      setSelectedSystemId(next[0]?.id || "");
    });
  }

  function submitDiagram(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedSystem) return;
    void runAction("Created diagram.", async () => {
      const created = await api.createDiagram(selectedSystem.id, { name: diagramName });
      await api.updateDiagramGraph(created.id, graphPayload);
      setDiagrams(await api.listDiagrams(selectedSystem.id));
      setSelectedDiagramId(created.id);
    }, "diagram");
  }

  function saveGraph() {
    if (!selectedDiagram) return;
    void runAction("Saved graph.", async () => {
      await api.updateDiagramGraph(selectedDiagram.id, graphPayload);
      setGraphDirty(false);
      setDiagrams(await api.listDiagrams(selectedDiagram.system_id));
    }, "diagram");
  }

  function updateDiagram() {
    if (!selectedDiagram) return;
    void runAction("Updated diagram.", async () => {
      await api.updateDiagram(selectedDiagram.id, { name: diagramName });
      setDiagrams(await api.listDiagrams(selectedDiagram.system_id));
    }, "diagram");
  }

  function deleteDiagram() {
    if (!selectedDiagram || !window.confirm(`Delete diagram "${selectedDiagram.name}"?`)) return;
    void runAction("Deleted diagram.", async () => {
      await api.deleteDiagram(selectedDiagram.id);
      const next = await api.listDiagrams(selectedDiagram.system_id);
      setDiagrams(next);
      setSelectedDiagramId(next[0]?.id || "");
    });
  }

  function placeComponent() {
    if (!selectedDiagram || !selectedPart || !selectedNodeId) return;
    void runAction("Placed component.", async () => {
      const component = await api.createComponent(selectedDiagram.id, { tag: componentTag, part_id: selectedPart.id, quantity: 1, properties: { node_external_id: selectedNodeId } });
      setNodes((current) => current.map((node) => (node.id === selectedNodeId ? { ...node, data: { ...node.data, label: `${component.tag}: ${selectedPart.part_number}` } } : node)));
      setComponents(await api.listComponents(selectedDiagram.id));
      setSelectedComponentId(component.id);
      setGraphDirty(true);
    }, "component");
  }

  function generateBom() {
    if (!selectedDiagram) return;
    void runAction("Generated BoM.", async () => {
      setBom(await api.generateBom(selectedDiagram.id));
    });
  }

  function inspectImpact() {
    const objectType = selectedComponent ? "component" : "part";
    const objectId = selectedComponent?.id ?? selectedPart?.id;
    if (!objectId) return;
    void runAction("Loaded impact.", async () => {
      setImpact(await api.getImpact(objectType, objectId));
    });
  }

  const projectOptions = projects.map((project) => ({ value: project.id, label: project.name }));
  const systemOptions = systems.map((system) => ({ value: system.id, label: system.name }));

  return (
    <AppShell
      navItems={navItems}
      projectValue={selectedProjectId}
      projectOptions={projectOptions}
      onProjectChange={selectProject}
      systemValue={selectedSystemId}
      systemOptions={systemOptions}
      onSystemChange={selectSystem}
      busy={busy}
      message={message}
      error={error}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/dashboard"
          element={
            <PageLayout title="Dashboard" description="Project overview">
              <section className="grid">
                <SummaryCard title="Projects" value={projects.length} detail={selectedProject?.name ?? "None selected"} />
                <SummaryCard title="Systems" value={systems.length} detail={selectedSystem?.name ?? "None selected"} />
                <SummaryCard title="Diagrams" value={diagrams.length} detail={selectedDiagram?.name ?? "None open"} />
                <SummaryCard title="Catalog Parts" value={parts.length} detail={selectedPart?.part_number ?? "None selected"} />
                <SummaryCard title="Requirements" value={requirements.length} detail={selectedRequirement?.key ?? "None selected"} />
                <SummaryCard title="BoM" value={bom?.rows.length ?? 0} detail={bom ? `Snapshot rev ${bom.revision}` : "No snapshot"} />
              </section>
            </PageLayout>
          }
        />
        <Route
          path="/systems"
          element={
            <PageLayout title="Systems" description="Fluid systems in the active project">
              <section className="grid">
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
          }
        />
        <Route
          path="/diagrams"
          element={
            <PidEditorPage
              busy={busy}
              componentTag={componentTag}
              customSymbols={customSymbols}
              diagramName={diagramName}
              diagrams={diagrams}
              edges={edges}
              editorSettings={editorSettings}
              graphDirty={graphDirty}
              nodes={nodes}
              onCreateDiagram={submitDiagram}
              onDeleteDiagram={deleteDiagram}
              onDirty={() => setGraphDirty(true)}
              onEdgesChange={onEdgesChange}
              onNodesChange={onNodesChange}
              onPlaceComponent={placeComponent}
              onRenameDiagram={updateDiagram}
              onSave={saveGraph}
              parts={parts}
              selectedDiagram={selectedDiagram}
              selectedDiagramId={selectedDiagramId}
              selectedEdgeId={selectedEdgeId}
              selectedNodeId={selectedNodeId}
              selectedPart={selectedPart}
              setComponentTag={setComponentTag}
              setCustomSymbols={setCustomSymbols}
              setDiagramName={setDiagramName}
              setEdges={setEdges}
              setEditorSettings={setEditorSettings}
              setNodes={setNodes}
              setSelectedDiagramId={setSelectedDiagramId}
              setSelectedEdgeId={setSelectedEdgeId}
              setSelectedNodeId={setSelectedNodeId}
            />
          }
        />
        <Route
          path="/parts"
          element={
            <PartsCatalogPage
              busy={busy}
              formErrors={formErrors}
              parts={parts}
              selectedPartId={selectedPartId}
              onPartsUpdated={async () => setParts(await api.listParts())}
              onSelectPart={setSelectedPartId}
              runAction={runAction}
            />
          }
        />
        <Route
          path="/requirements"
          element={
            <RequirementsPage
              busy={busy}
              formErrors={formErrors}
              projectId={selectedProjectId}
              requirements={requirements}
              selectedRequirementId={selectedRequirementId}
              onRequirementsUpdated={async () => {
                if (!selectedProjectId) return;
                setRequirements(await api.listRequirements(selectedProjectId));
              }}
              onSelectRequirement={setSelectedRequirementId}
              runAction={runAction}
            />
          }
        />
        <Route
          path="/bom"
          element={
            <PageLayout title="BoM & Procurement" description="Snapshots and exports">
              <section className="grid">
                <Panel title="BoM Snapshot">
                  <button disabled={busy || !selectedDiagram} onClick={generateBom}>Generate BoM</button>
                  {bom ? <><p>Snapshot revision {bom.revision}, {bom.rows.length} row(s)</p><a href={bomCsvUrl(bom.id)}>Download CSV</a><DataTable rows={bom.rows} getKey={(_, index?: number) => String(index)} columns={[{ header: "Part", render: (row) => String(row.part_number ?? "Unresolved") }, { header: "Description", render: (row) => String(row.description ?? "") }, { header: "Qty", render: (row) => String(row.quantity ?? 0) }]} /></> : <p className="hint">Open a diagram and generate a BoM snapshot.</p>}
                </Panel>
              </section>
            </PageLayout>
          }
        />
        <Route
          path="/reviews"
          element={
            <PageLayout title="Reviews" description="Impact and approvals">
              <section className="grid">
                <Panel title="Change Impact">
                  <button disabled={!selectedPart && !selectedComponent} onClick={inspectImpact}>Inspect impact</button>
                  {impact && <div className="impact"><p>{impact.direct_links.length} trace links, {impact.affected_components.length} components, {impact.affected_bom_snapshots.length} BoM snapshots affected.</p></div>}
                </Panel>
                <PlaceholderPage title="Review Workflows" body="Design review packages, comments, decisions, and approval routing will live here." />
              </section>
            </PageLayout>
          }
        />
        <Route path="/safety" element={<PlaceholderPage title="Safety" body="Hazards, trapped-volume checks, relief scenarios, and FMEA/FHA workflows will be added after the navigation foundation." />} />
        <Route path="/certification" element={<PlaceholderPage title="Certification" body="Compliance packages, evidence status, and generated certification artifacts will live here." />} />
        <Route
          path="/settings"
          element={
            <PageLayout title="Settings" description="Project configuration">
              <section className="grid">
                <Panel title="Projects">
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
                <Panel title="Workspace Settings">
                  <p className="hint">Unit systems, templates, roles, and controlled vocabularies will live here.</p>
                </Panel>
              </section>
            </PageLayout>
          }
        />
      </Routes>
    </AppShell>
  );
}

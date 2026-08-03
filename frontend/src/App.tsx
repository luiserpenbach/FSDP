import { useCallback, useEffect, useMemo, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from "reactflow";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, bomCsvUrl, setUnauthorizedHandler } from "./api";
import { AppShell, type NavItem } from "./components/AppShell";
import { DataTable, FormError, Panel, Select, SummaryCard, TextArea, TextInput } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { PageLayout, PlaceholderPage } from "./pages/PageLayout";
import type { BomSnapshot, ChangeEvent as ChangeLogEvent, ComponentInstance, Diagram, FluidSystem, Impact, Part, Project, Requirement, User } from "./types";

type PidNodeData = {
  label: string;
  symbolType: string;
  rotation: number;
};

type OrthogonalEdgeData = {
  bendX?: number;
  bendY?: number;
  startX?: number;
  endX?: number;
};

const qualificationOptions = ["unqualified", "qualified", "preferred", "legacy", "restricted"].map((value) => ({ value, label: value }));
const certificationOptions = ["unreviewed", "in_review", "certified", "rejected"].map((value) => ({ value, label: value }));

const navItems: NavItem[] = [
  { path: "/dashboard", label: "Dashboard", description: "Project overview" },
  { path: "/systems", label: "Systems", description: "Projects and fluid systems" },
  { path: "/diagrams", label: "Diagrams", description: "P&ID workspace" },
  { path: "/parts", label: "Parts Catalog", description: "Internal and vendor parts" },
  { path: "/requirements", label: "Requirements", description: "Traceable requirements" },
  { path: "/bom", label: "BoM & Procurement", description: "Snapshots and exports" },
  { path: "/safety", label: "Safety", description: "Hazards and analyses" },
  { path: "/reviews", label: "Reviews", description: "Impact and approvals" },
  { path: "/certification", label: "Certification", description: "Evidence packages" },
  { path: "/settings", label: "Settings", description: "Project configuration" }
];

function makeNodeId(kind: string): string {
  return `${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

function buildGraphPayload(nodes: Node<PidNodeData>[], edges: Edge<OrthogonalEdgeData>[]) {
  return {
    graph: { nodes, edges },
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
  };
}

function normalizePidNode(node: Node): Node<PidNodeData> {
  const label = String(node.data?.label ?? node.id);
  return {
    ...node,
    type: "pidSymbol",
    style: {
      width: 130,
      height: 76,
      ...node.style
    },
    data: {
      label,
      symbolType: String(node.data?.symbolType ?? node.type ?? "component"),
      rotation: Number(node.data?.rotation ?? 0)
    }
  };
}

function normalizeOrthogonalEdge(edge: Edge): Edge<OrthogonalEdgeData> {
  const legacyBendX = typeof edge.data?.bendX === "number" ? edge.data.bendX : undefined;
  return {
    ...edge,
    type: "orthogonal",
    data: {
      ...edge.data,
      bendX: legacyBendX,
      bendY: typeof edge.data?.bendY === "number" ? edge.data.bendY : undefined,
      startX: typeof edge.data?.startX === "number" ? edge.data.startX : legacyBendX,
      endX: typeof edge.data?.endX === "number" ? edge.data.endX : legacyBendX
    }
  };
}

function PidSymbolNode({
  id,
  data,
  selected,
  onDirty
}: NodeProps<PidNodeData> & { onDirty: () => void }) {
  const { setNodes } = useReactFlow();

  function rotateSymbol() {
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                rotation: (Number(node.data?.rotation ?? 0) + 90) % 360
              }
            }
          : node
      )
    );
    onDirty();
  }

  return (
    <div className="pidSymbolNode">
      <NodeResizer isVisible={selected} minWidth={70} minHeight={44} onResizeEnd={onDirty} />
      <Handle type="target" position={Position.Left} />
      <Handle type="target" position={Position.Top} />
      <div className="pidSymbolBody" style={{ transform: `rotate(${data.rotation}deg)` }}>
        <span className={`pidGlyph ${data.symbolType}`}>{data.symbolType.slice(0, 1).toUpperCase()}</span>
      </div>
      <button className="rotateHandle" onClick={rotateSymbol} title="Rotate symbol 90 degrees" type="button">
        Rotate
      </button>
      <div className="pidSymbolLabel">{data.label}</div>
      <Handle type="source" position={Position.Right} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  selected,
  data,
  onDirty
}: EdgeProps<OrthogonalEdgeData> & { onDirty: () => void }) {
  const { screenToFlowPosition, setEdges } = useReactFlow();
  const deltaX = targetX - sourceX;
  const startX = typeof data?.startX === "number" ? data.startX : sourceX + deltaX / 3;
  const endX = typeof data?.endX === "number" ? data.endX : sourceX + (deltaX * 2) / 3;
  const bendY = typeof data?.bendY === "number" ? data.bendY : sourceY + (targetY - sourceY) / 2;
  const path = `M ${sourceX},${sourceY} L ${startX},${sourceY} L ${startX},${bendY} L ${endX},${bendY} L ${endX},${targetY} L ${targetX},${targetY}`;

  function beginDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    update: (position: { x: number; y: number }) => Partial<OrthogonalEdgeData>
  ) {
    event.preventDefault();
    event.stopPropagation();

    function drag(moveEvent: PointerEvent) {
      const position = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      setEdges((currentEdges) =>
        currentEdges.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  ...update(position)
                }
              }
            : edge
        )
      );
    }

    function stopDrag() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", stopDrag);
      onDirty();
    }

    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", stopDrag);
  }

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          stroke: selected ? "#1f5eff" : "#26364d",
          strokeWidth: selected ? 3 : 2.4
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="edgeBendHandle vertical"
          onPointerDown={(event) => beginDrag(event, (position) => ({ startX: position.x, bendX: undefined }))}
          style={{ transform: `translate(-50%, -50%) translate(${startX}px, ${(sourceY + bendY) / 2}px)` }}
          title="Drag to move first vertical line segment"
        />
        <div
          className="edgeBendHandle horizontal"
          onPointerDown={(event) => beginDrag(event, (position) => ({ bendY: position.y }))}
          style={{ transform: `translate(-50%, -50%) translate(${(startX + endX) / 2}px, ${bendY}px)` }}
          title="Drag to move horizontal line segment"
        />
        <div
          className="edgeBendHandle vertical"
          onPointerDown={(event) => beginDrag(event, (position) => ({ endX: position.x, bendX: undefined }))}
          style={{ transform: `translate(-50%, -50%) translate(${endX}px, ${(bendY + targetY) / 2}px)` }}
          title="Drag to move last vertical line segment"
        />
      </EdgeLabelRenderer>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  );
}

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  async function signOut() {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }

  if (checkingSession) {
    return (
      <div className="authScreen">
        <p className="hint">Checking session...</p>
      </div>
    );
  }
  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }
  return <WorkspaceApp user={user} onSignOut={() => void signOut()} />;
}

function WorkspaceApp({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [systems, setSystems] = useState<FluidSystem[]>([]);
  const [diagrams, setDiagrams] = useState<Diagram[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [components, setComponents] = useState<ComponentInstance[]>([]);
  const [bom, setBom] = useState<BomSnapshot | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [changes, setChanges] = useState<ChangeLogEvent[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [selectedDiagramId, setSelectedDiagramId] = useState("");
  const [selectedPartId, setSelectedPartId] = useState("");
  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [selectedComponentId, setSelectedComponentId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");

  const [projectForm, setProjectForm] = useState({ name: "Demo Propulsion System", owner: "Propulsion Engineering", description: "MVP digital-thread project for FSDP." });
  const [systemForm, setSystemForm] = useState({ name: "Helium Pressurization", fluid: "GHe", description: "Pressurization system MVP workspace." });
  const [diagramName, setDiagramName] = useState("MVP P&ID");
  const [partForm, setPartForm] = useState({ part_number: "VALVE-001", description: "Normally closed solenoid valve", part_type: "valve", manufacturer: "Internal Standard", material: "316L", pressure_rating_bar: "350", qualification_status: "unqualified", certification_status: "unreviewed" });
  const [componentTag, setComponentTag] = useState("V-1");
  const [requirementForm, setRequirementForm] = useState({ key: "FSDP-REQ-1", title: "Maintain pressure boundary compatibility", text: "All pressurized components shall be compatible with maximum expected operating pressure.", requirement_type: "safety", verification_method: "analysis" });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [error, setError] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [graphDirty, setGraphDirty] = useState(false);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<PidNodeData>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<OrthogonalEdgeData>([]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedSystem = systems.find((system) => system.id === selectedSystemId) ?? null;
  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const selectedComponent = components.find((component) => component.id === selectedComponentId) ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const nodeTypes = useMemo(
    () => ({
      pidSymbol: (props: NodeProps<PidNodeData>) => (
        <PidSymbolNode {...props} onDirty={() => setGraphDirty(true)} />
      )
    }),
    []
  );
  const edgeTypes = useMemo(
    () => ({
      orthogonal: (props: EdgeProps<OrthogonalEdgeData>) => (
        <OrthogonalEdge {...props} onDirty={() => setGraphDirty(true)} />
      )
    }),
    []
  );

  const graphPayload = useMemo(() => buildGraphPayload(nodes, edges), [edges, nodes]);

  useEffect(() => {
    void runAction("Loaded projects.", async () => {
      const next = await api.listProjects();
      setProjects(next);
      setSelectedProjectId((current) => current || next[0]?.id || "");
    });
    void runAction("Loaded parts.", async () => {
      const next = await api.listParts();
      setParts(next);
      setSelectedPartId((current) => current || next[0]?.id || "");
    });
    void runAction("Loaded change history.", async () => {
      setChanges(await api.listChanges());
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
      setSelectedRequirementId((current) => (nextRequirements.some((requirement) => requirement.id === current) ? current : nextRequirements[0]?.id || ""));
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
      setNodes([]);
      setEdges([]);
      setGraphDirty(false);
      return;
    }
    void runAction("Loaded saved diagram.", async () => {
      const diagram = await api.getDiagram(selectedDiagramId);
      setDiagramName(diagram.name);
      setNodes((diagram.graph.nodes ?? []).map(normalizePidNode));
      setEdges((diagram.graph.edges ?? []).map(normalizeOrthogonalEdge));
      setComponents(await api.listComponents(diagram.id));
      const snapshots = await api.listDiagramBoms(diagram.id);
      setBom(snapshots[0] ?? null);
      setGraphDirty(false);
    });
  }, [selectedDiagramId, setEdges, setNodes]);

  useEffect(() => {
    if (!graphDirty) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [graphDirty]);

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
    if (selectedPart) {
      setPartForm({
        part_number: selectedPart.part_number,
        description: selectedPart.description,
        part_type: selectedPart.part_type,
        manufacturer: selectedPart.manufacturer ?? "",
        material: selectedPart.material ?? "",
        pressure_rating_bar: String(selectedPart.pressure_rating_bar ?? ""),
        qualification_status: selectedPart.qualification_status,
        certification_status: selectedPart.certification_status
      });
    }
  }, [selectedPart]);

  useEffect(() => {
    if (selectedRequirement) {
      setRequirementForm({
        key: selectedRequirement.key,
        title: selectedRequirement.title,
        text: selectedRequirement.text,
        requirement_type: selectedRequirement.requirement_type,
        verification_method: selectedRequirement.verification_method ?? ""
      });
    }
  }, [selectedRequirement]);

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
      // Selection and initial-measurement changes are not edits.
      if (changes.some((change) => change.type === "position" || change.type === "add" || change.type === "remove")) {
        setGraphDirty(true);
      }
      onNodesChangeBase(changes);
    },
    [onNodesChangeBase]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((change) => change.type === "add" || change.type === "remove")) {
        setGraphDirty(true);
      }
      onEdgesChangeBase(changes);
    },
    [onEdgesChangeBase]
  );

  function onConnect(connection: Connection) {
    setGraphDirty(true);
    setEdges((current) => addEdge({ ...connection, type: "orthogonal", label: "New line" }, current));
  }

  function confirmDiscardUnsaved(): boolean {
    return !graphDirty || window.confirm("You have unsaved diagram changes. Discard them?");
  }

  function selectProject(id: string) {
    if (id === selectedProjectId) return;
    if (!confirmDiscardUnsaved()) return;
    setSelectedProjectId(id);
    setSelectedSystemId("");
    setSelectedDiagramId("");
    setBom(null);
    setImpact(null);
  }

  function selectSystem(id: string) {
    if (id === selectedSystemId) return;
    if (!confirmDiscardUnsaved()) return;
    setSelectedSystemId(id);
    setSelectedDiagramId("");
    setBom(null);
  }

  function openDiagram(id: string) {
    if (id === selectedDiagramId) return;
    if (!confirmDiscardUnsaved()) return;
    setSelectedDiagramId(id);
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

  function parsePressureRating(): number | null {
    const cleaned = partForm.pressure_rating_bar.trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Pressure rating must be a non-negative number (leave empty if unrated).");
    }
    return parsed;
  }

  function submitPart(event: FormEvent) {
    event.preventDefault();
    void runAction("Created part.", async () => {
      const part = await api.createPart({
        ...partForm,
        pressure_rating_bar: parsePressureRating(),
        source_type: "internal",
        qualification_status: partForm.qualification_status || "unqualified",
        certification_status: partForm.certification_status || "unreviewed"
      });
      setParts(await api.listParts());
      setSelectedPartId(part.id);
    }, "part");
  }

  function updatePart() {
    if (!selectedPart) return;
    void runAction("Updated part.", async () => {
      await api.updatePart(selectedPart.id, {
        ...partForm,
        pressure_rating_bar: parsePressureRating(),
        qualification_status: partForm.qualification_status || "unqualified",
        certification_status: partForm.certification_status || "unreviewed"
      });
      setParts(await api.listParts());
    }, "part");
  }

  function deletePart() {
    if (!selectedPart || !window.confirm(`Delete part "${selectedPart.part_number}"?`)) return;
    void runAction("Deleted part.", async () => {
      await api.deletePart(selectedPart.id);
      const next = await api.listParts();
      setParts(next);
      setSelectedPartId(next[0]?.id || "");
    });
  }

  function submitDiagram(event: FormEvent) {
    event.preventDefault();
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

  function addGraphNode(kind: string) {
    const id = makeNodeId(kind);
    setNodes((current) => [
      ...current,
      {
        id,
        type: "pidSymbol",
        position: { x: 120 + nodes.length * 35, y: 180 + nodes.length * 15 },
        style: { width: 120, height: 72 },
        data: { label: kind[0].toUpperCase() + kind.slice(1), symbolType: kind, rotation: 0 }
      }
    ]);
    setSelectedNodeId(id);
    setGraphDirty(true);
  }

  function placeComponent() {
    if (!selectedDiagram || !selectedPart || !selectedNode) return;
    void runAction("Placed component.", async () => {
      if (graphDirty) {
        throw new Error("Save the diagram first — parts can only be placed on saved nodes.");
      }
      const component = await api.createComponent(selectedDiagram.id, { tag: componentTag, part_id: selectedPart.id, quantity: 1, properties: { node_external_id: selectedNode.id } });
      const nextNodes = nodes.map((node) => (node.id === selectedNode.id ? { ...node, data: { ...node.data, label: `${component.tag}: ${selectedPart.part_number}` } } : node));
      setNodes(nextNodes);
      await api.updateDiagramGraph(selectedDiagram.id, buildGraphPayload(nextNodes, edges));
      setComponents(await api.listComponents(selectedDiagram.id));
      setSelectedComponentId(component.id);
      setDiagrams(await api.listDiagrams(selectedDiagram.system_id));
    }, "component");
  }

  function submitRequirement(event: FormEvent) {
    event.preventDefault();
    if (!selectedProject) return;
    void runAction("Created requirement.", async () => {
      const requirement = await api.createRequirement({ ...requirementForm, project_id: selectedProject.id, status: "draft" });
      setRequirements(await api.listRequirements(selectedProject.id));
      setSelectedRequirementId(requirement.id);
    }, "requirement");
  }

  function updateRequirement() {
    if (!selectedProject || !selectedRequirement) return;
    void runAction("Updated requirement.", async () => {
      await api.updateRequirement(selectedRequirement.id, requirementForm);
      setRequirements(await api.listRequirements(selectedProject.id));
    }, "requirement");
  }

  function deleteRequirement() {
    if (!selectedProject || !selectedRequirement || !window.confirm(`Delete requirement "${selectedRequirement.key}"?`)) return;
    void runAction("Deleted requirement.", async () => {
      await api.deleteRequirement(selectedRequirement.id);
      const next = await api.listRequirements(selectedProject.id);
      setRequirements(next);
      setSelectedRequirementId(next[0]?.id || "");
    });
  }

  function updateComponent() {
    if (!selectedComponent) return;
    void runAction("Updated component.", async () => {
      const updated = await api.updateComponent(selectedComponent.id, { tag: componentTag });
      setComponents((current) => current.map((component) => (component.id === updated.id ? updated : component)));
    }, "component");
  }

  function deleteComponent() {
    if (!selectedDiagram || !selectedComponent || !window.confirm(`Delete component "${selectedComponent.tag}"?`)) return;
    void runAction("Deleted component.", async () => {
      await api.deleteComponent(selectedComponent.id);
      const next = await api.listComponents(selectedDiagram.id);
      setComponents(next);
      setSelectedComponentId(next[0]?.id || "");
    });
  }

  function linkRequirementToComponent() {
    if (!selectedRequirement || !selectedComponent) return;
    void runAction("Linked requirement.", async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: selectedRequirement.id, target_type: "component", target_id: selectedComponent.id, link_type: "satisfied_by" });
    });
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

  function refreshChanges() {
    void runAction("Refreshed change history.", async () => {
      setChanges(await api.listChanges());
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
      userLabel={`${user.name} · ${user.role}`}
      onSignOut={onSignOut}
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
          }
        />
        <Route
          path="/diagrams"
          element={
            <PageLayout className="diagramPage" title="Diagrams" description="P&ID workspace">
              <section className="diagramLayout">
                <div className="workspace">
                  <div className="toolbar">
                    <form className="inlineForm" onSubmit={submitDiagram}>
                      <TextInput label="Diagram name" value={diagramName} onChange={setDiagramName} />
                      <button disabled={busy || !selectedSystem || !diagramName}>Create P&ID</button>
                    </form>
                    <Select label="Open diagram" value={selectedDiagramId} options={diagrams.map((diagram) => ({ value: diagram.id, label: `${diagram.name} rev ${diagram.revision}` }))} onChange={openDiagram} />
                    <button disabled={busy || !selectedDiagram || !diagramName} onClick={updateDiagram}>Rename</button>
                    <button className="danger" disabled={busy || !selectedDiagram} onClick={deleteDiagram}>Delete</button>
                    <button disabled={busy || !selectedDiagram || !graphDirty} onClick={saveGraph}>Save graph</button>
                    {selectedDiagram && <span className={graphDirty ? "dirtyBadge" : "cleanBadge"}>{graphDirty ? "Unsaved changes" : "Saved"}</span>}
                  </div>
                  <div className="nodePalette">
                    {["valve", "sensor", "regulator", "filter", "source", "sink"].map((kind) => (
                      <button key={kind} onClick={() => addGraphNode(kind)}>{kind}</button>
                    ))}
                  </div>
                  <div className="diagram">
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      onConnect={onConnect}
                      onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                      onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
                      fitView
                    >
                      <Background />
                      <Controls />
                    </ReactFlow>
                  </div>
                </div>
                <aside className="inspector">
                  <Panel title="Node Inspector">
                    <p><strong>Selected:</strong> {selectedNode?.id ?? "None"}</p>
                    <p><strong>Label:</strong> {String(selectedNode?.data?.label ?? "-")}</p>
                    <p><strong>Rotation:</strong> {String(selectedNode?.data?.rotation ?? 0)} degrees</p>
                    <p><strong>Size:</strong> {selectedNode ? `${String(selectedNode.style?.width ?? "auto")} x ${String(selectedNode.style?.height ?? "auto")}` : "-"}</p>
                    <p><strong>Position:</strong> {selectedNode ? `${Math.round(selectedNode.position.x)}, ${Math.round(selectedNode.position.y)}` : "-"}</p>
                    <TextInput label="Component tag" value={componentTag} onChange={setComponentTag} />
                    <FormError message={formErrors.component} />
                    <button disabled={busy || !selectedDiagram || !selectedPart || !selectedNode || !componentTag.trim()} onClick={placeComponent}>Place selected part</button>
                  </Panel>
                  <Panel title="Line Metadata">
                    <p><strong>Selected edge:</strong> {selectedEdge?.id ?? "None"}</p>
                    <p><strong>Label:</strong> {String(selectedEdge?.label ?? "-")}</p>
                    <p><strong>Start leg X:</strong> {String(selectedEdge?.data?.startX ?? selectedEdge?.data?.bendX ?? "auto")}</p>
                    <p><strong>Middle leg Y:</strong> {String(selectedEdge?.data?.bendY ?? "auto")}</p>
                    <p><strong>End leg X:</strong> {String(selectedEdge?.data?.endX ?? selectedEdge?.data?.bendX ?? "auto")}</p>
                    <p><strong>Lines:</strong> {edges.length}</p>
                  </Panel>
                  <Panel title="Diagrams">
                    <DataTable rows={diagrams} selectedKey={selectedDiagramId} getKey={(diagram) => diagram.id} onSelect={(diagram) => openDiagram(diagram.id)} columns={[{ header: "Name", render: (diagram) => diagram.name }, { header: "Rev", render: (diagram) => diagram.revision }]} />
                  </Panel>
                </aside>
              </section>
            </PageLayout>
          }
        />
        <Route
          path="/parts"
          element={
            <PageLayout title="Parts Catalog" description="Internal and vendor parts">
              <section className="grid">
                <Panel title="Part Editor">
                  <form onSubmit={submitPart}>
                    <TextInput label="Part number" value={partForm.part_number} onChange={(partNumber) => setPartForm({ ...partForm, part_number: partNumber })} />
                    <TextInput label="Description" value={partForm.description} onChange={(description) => setPartForm({ ...partForm, description })} />
                    <TextInput label="Type" value={partForm.part_type} onChange={(partType) => setPartForm({ ...partForm, part_type: partType })} />
                    <TextInput label="Manufacturer" value={partForm.manufacturer} onChange={(manufacturer) => setPartForm({ ...partForm, manufacturer })} />
                    <TextInput label="Material" value={partForm.material} onChange={(material) => setPartForm({ ...partForm, material })} />
                    <TextInput label="Pressure rating bar" value={partForm.pressure_rating_bar} onChange={(pressure) => setPartForm({ ...partForm, pressure_rating_bar: pressure })} />
                    <Select label="Qualification status" value={partForm.qualification_status} options={qualificationOptions} onChange={(qualificationStatus) => setPartForm({ ...partForm, qualification_status: qualificationStatus })} />
                    <Select label="Certification status" value={partForm.certification_status} options={certificationOptions} onChange={(certificationStatus) => setPartForm({ ...partForm, certification_status: certificationStatus })} />
                    <FormError message={formErrors.part} />
                    <button disabled={busy || !partForm.part_number || !partForm.description}>Add part</button>
                  </form>
                  <div className="buttonRow"><button disabled={!selectedPart} onClick={updatePart}>Update selected</button><button className="danger" disabled={!selectedPart} onClick={deletePart}>Delete selected</button></div>
                </Panel>
                <Panel title="Parts">
                  <DataTable rows={parts} selectedKey={selectedPartId} getKey={(part) => part.id} onSelect={(part) => setSelectedPartId(part.id)} columns={[{ header: "Part", render: (part) => part.part_number }, { header: "Type", render: (part) => part.part_type }, { header: "Material", render: (part) => part.material ?? "-" }, { header: "Pressure", render: (part) => part.pressure_rating_bar ?? "-" }]} />
                </Panel>
              </section>
            </PageLayout>
          }
        />
        <Route
          path="/requirements"
          element={
            <PageLayout title="Requirements" description="Traceable requirements">
              <section className="grid">
                <Panel title="Requirement Editor">
                  <form onSubmit={submitRequirement}>
                    <TextInput label="Key" value={requirementForm.key} onChange={(key) => setRequirementForm({ ...requirementForm, key })} />
                    <TextInput label="Title" value={requirementForm.title} onChange={(title) => setRequirementForm({ ...requirementForm, title })} />
                    <TextInput label="Type" value={requirementForm.requirement_type} onChange={(requirementType) => setRequirementForm({ ...requirementForm, requirement_type: requirementType })} />
                    <TextInput label="Verification" value={requirementForm.verification_method} onChange={(verificationMethod) => setRequirementForm({ ...requirementForm, verification_method: verificationMethod })} />
                    <TextArea label="Text" value={requirementForm.text} onChange={(text) => setRequirementForm({ ...requirementForm, text })} />
                    <FormError message={formErrors.requirement} />
                    <button disabled={busy || !selectedProject || !requirementForm.key}>Create requirement</button>
                  </form>
                  <div className="buttonRow"><button disabled={!selectedRequirement} onClick={updateRequirement}>Update selected</button><button className="danger" disabled={!selectedRequirement} onClick={deleteRequirement}>Delete selected</button></div>
                </Panel>
                <Panel title="Requirements">
                  <DataTable rows={requirements} selectedKey={selectedRequirementId} getKey={(requirement) => requirement.id} onSelect={(requirement) => setSelectedRequirementId(requirement.id)} columns={[{ header: "Key", render: (requirement) => requirement.key }, { header: "Title", render: (requirement) => requirement.title }, { header: "Type", render: (requirement) => requirement.requirement_type }]} />
                </Panel>
                <Panel title="Trace Links">
                  <Select label="Component" value={selectedComponentId} options={components.map((component) => ({ value: component.id, label: component.tag }))} onChange={setSelectedComponentId} />
                  <TextInput label="Component tag" value={componentTag} onChange={setComponentTag} />
                  <FormError message={formErrors.component} />
                  <div className="buttonRow"><button disabled={!selectedComponent} onClick={updateComponent}>Update component</button><button className="danger" disabled={!selectedComponent} onClick={deleteComponent}>Delete component</button></div>
                  <button disabled={!selectedRequirement || !selectedComponent} onClick={linkRequirementToComponent}>Link requirement to component</button>
                </Panel>
              </section>
            </PageLayout>
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
                <Panel title="Recent Changes">
                  <button disabled={busy} onClick={refreshChanges}>Refresh</button>
                  <DataTable
                    rows={changes}
                    getKey={(change) => change.id}
                    columns={[
                      { header: "Summary", render: (change) => change.summary },
                      { header: "Action", render: (change) => change.action },
                      { header: "Actor", render: (change) => change.actor ?? "-" },
                      { header: "When", render: (change) => new Date(change.created_at).toLocaleString() }
                    ]}
                  />
                </Panel>
                <PlaceholderPage title="Review Workflows" body="Design review packages, comments, decisions, and approval routing will live here." />
              </section>
            </PageLayout>
          }
        />
        <Route path="/safety" element={<PlaceholderPage title="Safety" body="Hazards, trapped-volume checks, relief scenarios, and FMEA/FHA workflows will be added after the navigation foundation." />} />
        <Route path="/certification" element={<PlaceholderPage title="Certification" body="Compliance packages, evidence status, and generated certification artifacts will live here." />} />
        <Route path="/settings" element={<PlaceholderPage title="Settings" body="Project settings, unit systems, templates, roles, and controlled vocabularies will live here." />} />
      </Routes>
    </AppShell>
  );
}

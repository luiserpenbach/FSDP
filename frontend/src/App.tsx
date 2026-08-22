import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { toPng } from "html-to-image";
import ReactFlow, {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  SelectionMode,
  addEdge,
  updateEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectStartParams,
  type ReactFlowInstance
} from "reactflow";
import { CustomSymbolsContext, PALETTE_SYMBOLS, SYMBOL_LABELS, customSymbolId } from "./components/PidSymbols";
import {
  CommentNode,
  JunctionNode,
  PidSymbolNode,
  SECTION_COLORS,
  SectionNode,
  TextNode
} from "./components/pid/nodes";
import {
  OrthogonalEdge,
  edgeMarker,
  hasStoredGeometry,
  junctionHandleToward,
  splitRoutePath,
  translateEdgeGeometry,
  type OrthogonalEdgeData
} from "./components/pid/OrthogonalEdge";
import {
  CanvasContextMenu,
  DEFAULT_SECTION_SIZE,
  DEFAULT_SYMBOL_SIZE,
  FloatingToolbar,
  JUNCTION_SIZE,
  PlacementGhost,
  SelectionToolbar,
  type ContextMenuState,
  type PlacementTool
} from "./components/pid/overlays";
import { removeNodesKeepingSectionContents } from "./components/pid/graphEdits";
import { EditorSettingsContext, type LabelMode } from "./components/pid/settings";
import { SymbolEditorModal } from "./components/pid/SymbolEditorModal";
import { PanelResizer, useStoredWidth } from "./components/resizable";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, bomCsvUrl, setUnauthorizedHandler } from "./api";
import { AppShell, type NavItem } from "./components/AppShell";
import { DataTable, FormError, Panel, Select, StatusPill, SummaryCard, TextArea, TextInput } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { CatalogSettingsPanel } from "./pages/CatalogSettingsPanel";
import { PageLayout, PlaceholderCard, PlaceholderPage } from "./pages/PageLayout";
import { PartsCatalog } from "./pages/PartsCatalog";
import type { BomDiff, BomReadiness, BomSnapshot, ChangeEvent as ChangeLogEvent, ComponentInstance, Diagram, FluidSystem, Impact, Part, PidSymbolDef, Project, ProjectBom, Requirement, TraceLink, User } from "./types";

/** Loose union of the data carried by the canvas node types. */
type CanvasNodeData = {
  label?: string;
  symbolType?: string;
  rotation?: number;
  hasComponent?: boolean;
  tag?: string;
  color?: string;
  text?: string;
  fontSize?: number;
  author?: string;
  created_at?: string;
};

type GraphSnapshot = {
  nodes: Node<CanvasNodeData>[];
  edges: Edge<OrthogonalEdgeData>[];
};

const TAG_PREFIXES: Record<string, string> = {
  valve: "V",
  check_valve: "CV",
  regulator: "PR",
  relief_valve: "RV",
  sensor: "PT",
  filter: "F",
  pump: "P",
  source: "TK",
  tank: "TK",
  sink: "IF"
};

function suggestTag(symbolType: string, components: ComponentInstance[]): string {
  const prefix = TAG_PREFIXES[symbolType] ?? "C";
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const used = components
    .map((component) => pattern.exec(component.tag)?.[1])
    .filter(Boolean)
    .map(Number);
  return `${prefix}-${used.length ? Math.max(...used) + 1 : 1}`;
}

function parseOptionalNumber(raw: string, field: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number (leave empty if unknown).`);
  }
  return parsed;
}

const roleOptions = ["engineer", "viewer", "admin"].map((value) => ({ value, label: value }));

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

const NODE_TYPE_TO_GRAPH_TYPE: Record<string, string> = {
  pidSection: "section",
  pidText: "text",
  pidComment: "comment",
  pidJunction: "junction"
};

function graphNodeType(node: Node<CanvasNodeData>): string {
  return NODE_TYPE_TO_GRAPH_TYPE[node.type ?? ""] ?? String(node.data?.symbolType ?? "component");
}

const JUNCTION_HANDLE_IDS = ["l", "r", "t", "b"];

function nodeCenter(node: Node<CanvasNodeData>, nodes: Node<CanvasNodeData>[]): { x: number; y: number } {
  const parent = node.parentNode ? nodes.find((entry) => entry.id === node.parentNode) : undefined;
  const offsetX = parent?.position.x ?? 0;
  const offsetY = parent?.position.y ?? 0;
  const width = Number(node.width ?? node.style?.width ?? 0);
  const height = Number(node.height ?? node.style?.height ?? 0);
  return { x: offsetX + node.position.x + width / 2, y: offsetY + node.position.y + height / 2 };
}

type ConnectionLike = {
  source: string | null;
  sourceHandle?: string | null;
  target: string | null;
  targetHandle?: string | null;
};

/**
 * Junction handles are four overlapping center anchors; pointer events pick
 * an arbitrary one, so every connection touching a junction is rewritten to
 * the handle whose direction matches the line's geometry.
 */
function withJunctionHandles<T extends ConnectionLike>(connection: T, nodes: Node<CanvasNodeData>[]): T {
  const source = connection.source ? nodes.find((node) => node.id === connection.source) : undefined;
  const target = connection.target ? nodes.find((node) => node.id === connection.target) : undefined;
  if (source?.type !== "pidJunction" && target?.type !== "pidJunction") return connection;
  const next = { ...connection };
  const sourceCenter = source ? nodeCenter(source, nodes) : null;
  const targetCenter = target ? nodeCenter(target, nodes) : null;
  if (source?.type === "pidJunction" && sourceCenter && targetCenter) {
    next.sourceHandle = junctionHandleToward(sourceCenter.x, sourceCenter.y, targetCenter.x, targetCenter.y);
  }
  if (target?.type === "pidJunction" && targetCenter && sourceCenter) {
    next.targetHandle = junctionHandleToward(targetCenter.x, targetCenter.y, sourceCenter.x, sourceCenter.y);
  }
  return next;
}

/** Migrate saved edges whose junction endpoints predate the directional handles. */
function fixJunctionEdgeHandles(
  nodes: Node<CanvasNodeData>[],
  edges: Edge<OrthogonalEdgeData>[]
): Edge<OrthogonalEdgeData>[] {
  return edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const needsSource = source?.type === "pidJunction" && !JUNCTION_HANDLE_IDS.includes(edge.sourceHandle ?? "");
    const needsTarget = target?.type === "pidJunction" && !JUNCTION_HANDLE_IDS.includes(edge.targetHandle ?? "");
    if (!needsSource && !needsTarget) return edge;
    const fixed = withJunctionHandles(edge, nodes);
    return {
      ...edge,
      sourceHandle: needsSource ? fixed.sourceHandle : edge.sourceHandle,
      targetHandle: needsTarget ? fixed.targetHandle : edge.targetHandle
    };
  });
}

function buildGraphPayload(nodes: Node<CanvasNodeData>[], edges: Edge<OrthogonalEdgeData>[]) {
  return {
    // Selection is view state, not document state — JSON.stringify drops the
    // undefined so saved graphs never resurrect a selected (elevated) element.
    graph: {
      nodes: nodes.map((node) => ({ ...node, selected: undefined })),
      edges: edges.map((edge) => ({ ...edge, selected: undefined }))
    },
    nodes: nodes.map((node) => ({
      external_id: node.id,
      node_type: graphNodeType(node),
      label: String(node.data?.label ?? node.data?.text ?? node.id),
      position: node.position,
      properties: { ...(node.data ?? {}), style: node.style ?? {}, parentNode: node.parentNode ?? null }
    })),
    edges: edges.map((edge) => ({
      external_id: edge.id,
      source_node_id: edge.source,
      target_node_id: edge.target,
      fluid: edge.data?.fluid ?? null,
      pressure_bar: edge.data?.pressure_bar ?? null,
      temperature_c: edge.data?.temperature_c ?? null,
      diameter_mm: edge.data?.diameter_mm ?? null,
      material: edge.data?.material ?? null,
      flow_direction: "forward",
      properties: { label: edge.label, ...(edge.data ?? {}) }
    }))
  };
}

/** Parent (section) nodes must come before their children in React Flow's node array. */
function sortSectionsFirst(nodes: Node<CanvasNodeData>[]): Node<CanvasNodeData>[] {
  return [...nodes].sort(
    (a, b) => (a.type === "pidSection" ? 0 : 1) - (b.type === "pidSection" ? 0 : 1)
  );
}

function normalizeGraphNode(node: Node): Node<CanvasNodeData> {
  const data = (node.data ?? {}) as CanvasNodeData;
  // A node saved mid-selection must not come back selected: React Flow
  // elevates selected nodes, and a resurrected selected section would sit
  // above every symbol and swallow their clicks.
  const base = { ...node, selected: false };
  if (node.type === "pidSection") {
    return {
      ...base,
      zIndex: -1,
      style: { width: 320, height: 220, ...node.style },
      data: { label: String(data.label ?? "Section"), color: data.color }
    };
  }
  if (node.type === "pidText") {
    return { ...base, data: { text: String(data.text ?? ""), fontSize: data.fontSize, color: data.color } };
  }
  if (node.type === "pidComment") {
    return { ...base, data: { text: String(data.text ?? ""), author: data.author, created_at: data.created_at } };
  }
  if (node.type === "pidJunction") {
    const style = { width: JUNCTION_SIZE, height: JUNCTION_SIZE, ...node.style };
    // Junctions from before the draggable-ring rework were 14px boxes.
    if (style.width === 14 && style.height === 14) {
      style.width = JUNCTION_SIZE;
      style.height = JUNCTION_SIZE;
    }
    return { ...base, style, data: {} };
  }
  // Symbols placed before the size reduction keep the old 112x84 default;
  // scale those down, but leave user-resized nodes alone.
  const style = { width: DEFAULT_SYMBOL_SIZE.width, height: DEFAULT_SYMBOL_SIZE.height, ...node.style };
  if (style.width === 112 && style.height === 84) {
    style.width = DEFAULT_SYMBOL_SIZE.width;
    style.height = DEFAULT_SYMBOL_SIZE.height;
  }
  return {
    ...base,
    type: "pidSymbol",
    style,
    data: {
      label: String(data.label ?? node.id),
      symbolType: String(data.symbolType ?? node.type ?? "component"),
      rotation: Number(data.rotation ?? 0),
      tag: data.tag,
      color: data.color
    }
  };
}

function normalizeOrthogonalEdge(edge: Edge): Edge<OrthogonalEdgeData> {
  const legacyBendX = typeof edge.data?.bendX === "number" ? edge.data.bendX : undefined;
  return {
    ...edge,
    selected: false,
    type: "orthogonal",
    markerEnd: edgeMarker(edge.data),
    data: {
      ...edge.data,
      bendX: legacyBendX,
      bendY: typeof edge.data?.bendY === "number" ? edge.data.bendY : undefined,
      startX: typeof edge.data?.startX === "number" ? edge.data.startX : legacyBendX,
      endX: typeof edge.data?.endX === "number" ? edge.data.endX : legacyBendX
    }
  };
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
  const [bomSnapshots, setBomSnapshots] = useState<BomSnapshot[]>([]);
  const [selectedBomId, setSelectedBomId] = useState("");
  const [bomReadiness, setBomReadiness] = useState<BomReadiness | null>(null);
  const [diffAgainstId, setDiffAgainstId] = useState("");
  const [bomDiff, setBomDiff] = useState<BomDiff | null>(null);
  const [projectBoms, setProjectBoms] = useState<ProjectBom[]>([]);
  const [traceLinks, setTraceLinks] = useState<TraceLink[]>([]);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [changes, setChanges] = useState<ChangeLogEvent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [userForm, setUserForm] = useState({ email: "", name: "", password: "", role: "engineer" });

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
  const [componentTag, setComponentTag] = useState("V-1");
  const [requirementForm, setRequirementForm] = useState({ key: "FSDP-REQ-1", title: "Maintain pressure boundary compatibility", text: "All pressurized components shall be compatible with maximum expected operating pressure.", requirement_type: "safety", verification_method: "analysis" });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [error, setError] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [graphDirty, setGraphDirty] = useState(false);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CanvasNodeData>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<OrthogonalEdgeData>([]);
  const [nodeLabelDraft, setNodeLabelDraft] = useState("");
  const [edgeForm, setEdgeForm] = useState({ label: "", fluid: "", pressure_bar: "", temperature_c: "", diameter_mm: "", material: "" });
  const [historyVersion, setHistoryVersion] = useState(0);

  const [customSymbols, setCustomSymbols] = useState<PidSymbolDef[]>([]);
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem("fsdp.showGrid") !== "0");
  const [showComments, setShowComments] = useState(true);
  const [gridSize, setGridSize] = useState(() => {
    const stored = Number(localStorage.getItem("fsdp.gridSize"));
    return [2, 5, 10, 20].includes(stored) ? stored : 5;
  });
  const [labelMode, setLabelMode] = useState<LabelMode>(() =>
    localStorage.getItem("fsdp.labelMode") === "name" ? "name" : "tag"
  );
  const [placementTool, setPlacementTool] = useState<PlacementTool | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [symbolEditorOpen, setSymbolEditorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useStoredWidth("fsdp.inspectorWidth", 300, 240, 560);

  const nodesRef = useRef<Node<CanvasNodeData>[]>(nodes);
  const edgesRef = useRef<Edge<OrthogonalEdgeData>[]>(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const historyRef = useRef<{ past: GraphSnapshot[]; future: GraphSnapshot[] }>({ past: [], future: [] });
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const diagramContainerRef = useRef<HTMLDivElement | null>(null);
  const edgeLabelHistoryRef = useRef<string | null>(null);
  const dragPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const connectStartRef = useRef<OnConnectStartParams | null>(null);
  const connectCompletedRef = useRef(false);
  const edgeUpdateSucceededRef = useRef(false);
  // Invalidate in-flight project/system list responses when selection changes so a
  // slower prior request cannot rewrite systems/diagrams (and selected ids) for the
  // wrong parent — which would then wipe the open canvas via the diagram load effect.
  const projectLoadGeneration = useRef(0);
  const systemLoadGeneration = useRef(0);
  // Invalidate in-flight diagram loads when the selection changes so a slower
  // response cannot overwrite the newly selected diagram's canvas/components.
  const diagramLoadGeneration = useRef(0);
  const selectedDiagramIdRef = useRef(selectedDiagramId);
  selectedDiagramIdRef.current = selectedDiagramId;
  const busyCountRef = useRef(0);
  // Bumped on every local edit so an in-flight save cannot clear dirty after
  // newer canvas changes that were not included in the saved payload.
  const graphDirtyGeneration = useRef(0);
  const markGraphDirty = useCallback(() => {
    graphDirtyGeneration.current += 1;
    setGraphDirty(true);
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedSystem = systems.find((system) => system.id === selectedSystemId) ?? null;
  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const selectedComponent = components.find((component) => component.id === selectedComponentId) ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const bom = bomSnapshots.find((snapshot) => snapshot.id === selectedBomId) ?? null;
  const canUndo = historyVersion >= 0 && historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  const isAdmin = user.role === "admin";

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
      projectLoadGeneration.current += 1;
      setSystems([]);
      setRequirements([]);
      setProjectBoms([]);
      return;
    }
    const projectId = selectedProjectId;
    const generation = ++projectLoadGeneration.current;
    void runAction("Loaded project details.", async () => {
      const [nextSystems, nextRequirements, nextProjectBoms] = await Promise.all([
        api.listSystems(projectId),
        api.listRequirements(projectId),
        api.listProjectBoms(projectId)
      ]);
      if (generation !== projectLoadGeneration.current) return;
      setSystems(nextSystems);
      setRequirements(nextRequirements);
      setProjectBoms(nextProjectBoms);
      setSelectedSystemId((current) => (nextSystems.some((system) => system.id === current) ? current : nextSystems[0]?.id || ""));
      setSelectedRequirementId((current) => (nextRequirements.some((requirement) => requirement.id === current) ? current : nextRequirements[0]?.id || ""));
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedSystemId) {
      systemLoadGeneration.current += 1;
      setDiagrams([]);
      setSelectedDiagramId("");
      return;
    }
    const systemId = selectedSystemId;
    const generation = ++systemLoadGeneration.current;
    void runAction("Loaded system diagrams.", async () => {
      const next = await api.listDiagrams(systemId);
      if (generation !== systemLoadGeneration.current) return;
      setDiagrams(next);
      setSelectedDiagramId((current) => (next.some((diagram) => diagram.id === current) ? current : next[0]?.id || ""));
    });
  }, [selectedSystemId]);

  useEffect(() => {
    historyRef.current = { past: [], future: [] };
    setHistoryVersion((version) => version + 1);
    const generation = ++diagramLoadGeneration.current;
    if (!selectedDiagramId) {
      setComponents([]);
      setBomSnapshots([]);
      setSelectedBomId("");
      setNodes([]);
      setEdges([]);
      setGraphDirty(false);
      return;
    }
    const diagramId = selectedDiagramId;
    void runAction("Loaded saved diagram.", async () => {
      const diagram = await api.getDiagram(diagramId);
      if (generation !== diagramLoadGeneration.current) return;
      setDiagramName(diagram.name);
      const graphNodes = sortSectionsFirst((diagram.graph.nodes ?? []).map(normalizeGraphNode));
      setNodes(graphNodes);
      setEdges(fixJunctionEdgeHandles(graphNodes, (diagram.graph.edges ?? []).map(normalizeOrthogonalEdge)));
      const nextComponents = await api.listComponents(diagram.id);
      if (generation !== diagramLoadGeneration.current) return;
      setComponents(nextComponents);
      const snapshots = await api.listDiagramBoms(diagram.id);
      if (generation !== diagramLoadGeneration.current) return;
      setBomSnapshots(snapshots);
      setSelectedBomId(snapshots[0]?.id ?? "");
      setGraphDirty(false);
    });
  }, [selectedDiagramId, setEdges, setNodes]);

  useEffect(() => {
    setBomDiff(null);
    setDiffAgainstId("");
    if (!selectedBomId) {
      setBomReadiness(null);
      return;
    }
    api
      .getBomReadiness(selectedBomId)
      .then(setBomReadiness)
      .catch(() => setBomReadiness(null));
  }, [selectedBomId]);

  useEffect(() => {
    if (!selectedRequirementId) {
      setTraceLinks([]);
      return;
    }
    api
      .listTraceLinks("requirement", selectedRequirementId)
      .then(setTraceLinks)
      .catch(() => setTraceLinks([]));
  }, [selectedRequirementId]);

  // Mark nodes that have a placed component with a badge.
  useEffect(() => {
    const bound = new Set(
      components
        .map((component) => (component.properties as Record<string, unknown> | undefined)?.node_external_id)
        .filter((value): value is string => typeof value === "string")
    );
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const hasComponent = bound.has(node.id);
        if (Boolean(node.data?.hasComponent) === hasComponent) return node;
        changed = true;
        return { ...node, data: { ...node.data, hasComponent } };
      });
      return changed ? next : current;
    });
  }, [components, setNodes]);

  useEffect(() => {
    if (selectedEdge) {
      setEdgeForm({
        label: String(selectedEdge.label ?? ""),
        fluid: selectedEdge.data?.fluid ?? "",
        pressure_bar: selectedEdge.data?.pressure_bar != null ? String(selectedEdge.data.pressure_bar) : "",
        temperature_c: selectedEdge.data?.temperature_c != null ? String(selectedEdge.data.temperature_c) : "",
        diameter_mm: selectedEdge.data?.diameter_mm != null ? String(selectedEdge.data.diameter_mm) : "",
        material: selectedEdge.data?.material ?? ""
      });
    }
  }, [selectedEdgeId, selectedEdge?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedNode) {
      setNodeLabelDraft(String(selectedNode.data?.label ?? ""));
    }
  }, [selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isAdmin) {
      api.listUsers().then(setUsers).catch(() => setUsers([]));
    }
  }, [isAdmin]);

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
    busyCountRef.current += 1;
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
      busyCountRef.current = Math.max(0, busyCountRef.current - 1);
      if (busyCountRef.current === 0) setBusy(false);
    }
  }

  const recordHistory = useCallback(() => {
    const history = historyRef.current;
    history.past.push({ nodes: nodesRef.current, edges: edgesRef.current });
    if (history.past.length > 50) history.past.shift();
    history.future = [];
    setHistoryVersion((version) => version + 1);
  }, []);

  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push({ nodes: nodesRef.current, edges: edgesRef.current });
    setNodes(previous.nodes);
    setEdges(previous.edges);
    markGraphDirty();
    setHistoryVersion((version) => version + 1);
  }, [markGraphDirty, setEdges, setNodes]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next) return;
    history.past.push({ nodes: nodesRef.current, edges: edgesRef.current });
    setNodes(next.nodes);
    setEdges(next.edges);
    markGraphDirty();
    setHistoryVersion((version) => version + 1);
  }, [markGraphDirty, setEdges, setNodes]);

  const nodeTypes = useMemo(
    () => ({
      pidSymbol: (props: NodeProps<CanvasNodeData>) => (
        <PidSymbolNode
          {...(props as unknown as Parameters<typeof PidSymbolNode>[0])}
          onDirty={markGraphDirty}
          onHistory={recordHistory}
        />
      ),
      pidSection: (props: NodeProps<CanvasNodeData>) => (
        <SectionNode
          {...(props as unknown as Parameters<typeof SectionNode>[0])}
          onDirty={markGraphDirty}
          onHistory={recordHistory}
        />
      ),
      pidText: (props: NodeProps<CanvasNodeData>) => (
        <TextNode
          {...(props as unknown as Parameters<typeof TextNode>[0])}
          onDirty={markGraphDirty}
          onHistory={recordHistory}
        />
      ),
      pidComment: (props: NodeProps<CanvasNodeData>) => (
        <CommentNode
          {...(props as unknown as Parameters<typeof CommentNode>[0])}
          onDirty={markGraphDirty}
          onHistory={recordHistory}
        />
      ),
      pidJunction: (props: NodeProps<CanvasNodeData>) => (
        <JunctionNode {...(props as unknown as Parameters<typeof JunctionNode>[0])} />
      )
    }),
    [markGraphDirty, recordHistory]
  );
  const edgeTypes = useMemo(
    () => ({
      orthogonal: (props: EdgeProps<OrthogonalEdgeData>) => (
        <OrthogonalEdge {...props} onDirty={markGraphDirty} onHistory={recordHistory} gridSize={gridSize} />
      )
    }),
    [markGraphDirty, recordHistory, gridSize]
  );

  const customSymbolsById = useMemo(
    () => Object.fromEntries(customSymbols.map((symbol) => [symbol.id, symbol])),
    [customSymbols]
  );

  const displayNodes = useMemo(
    () =>
      showComments
        ? nodes
        : nodes.map((node) => (node.type === "pidComment" ? { ...node, hidden: true } : node)),
    [nodes, showComments]
  );

  const refreshSymbols = useCallback(() => {
    api
      .listSymbols()
      .then((list) => setCustomSymbols(Array.isArray(list) ? list : []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshSymbols();
  }, [refreshSymbols]);

  useEffect(() => {
    edgeLabelHistoryRef.current = null;
  }, [selectedEdgeId]);

  function toggleGrid() {
    setShowGrid((current) => {
      localStorage.setItem("fsdp.showGrid", current ? "0" : "1");
      return !current;
    });
  }

  const placeElement = useCallback(
    (tool: PlacementTool, rawFlowX: number, rawFlowY: number, parent?: Node<CanvasNodeData>) => {
      recordHistory();
      const flowX = Math.round(rawFlowX / gridSize) * gridSize;
      const flowY = Math.round(rawFlowY / gridSize) * gridSize;
      let node: Node<CanvasNodeData>;
      if (tool.kind === "symbol" && tool.symbolType === "junction") {
        node = {
          id: makeNodeId("junction"),
          type: "pidJunction",
          position: { x: flowX - JUNCTION_SIZE / 2, y: flowY - JUNCTION_SIZE / 2 },
          style: { width: JUNCTION_SIZE, height: JUNCTION_SIZE },
          data: {}
        };
      } else if (tool.kind === "symbol") {
        const customId = customSymbolId(tool.symbolType);
        const label = customId
          ? customSymbolsById[customId]?.name ?? "Symbol"
          : SYMBOL_LABELS[tool.symbolType] ?? tool.symbolType;
        node = {
          id: makeNodeId(customId ? "custom" : tool.symbolType),
          type: "pidSymbol",
          position: { x: flowX - DEFAULT_SYMBOL_SIZE.width / 2, y: flowY - DEFAULT_SYMBOL_SIZE.height / 2 },
          style: { width: DEFAULT_SYMBOL_SIZE.width, height: DEFAULT_SYMBOL_SIZE.height },
          data: { label, symbolType: tool.symbolType, rotation: 0 }
        };
      } else if (tool.kind === "section") {
        node = {
          id: makeNodeId("section"),
          type: "pidSection",
          position: { x: flowX - DEFAULT_SECTION_SIZE.width / 2, y: flowY - DEFAULT_SECTION_SIZE.height / 2 },
          style: { ...DEFAULT_SECTION_SIZE },
          zIndex: -1,
          data: { label: "Section", color: SECTION_COLORS[0] }
        };
      } else if (tool.kind === "text") {
        node = {
          id: makeNodeId("text"),
          type: "pidText",
          position: { x: flowX - 60, y: flowY - 14 },
          data: { text: "", fontSize: 14 }
        };
      } else {
        node = {
          id: makeNodeId("comment"),
          type: "pidComment",
          position: { x: flowX - 14, y: flowY - 14 },
          data: { text: "", author: user.name, created_at: new Date().toISOString() }
        };
      }
      // Placing onto a section makes the element part of it (sections don't nest).
      if (parent && tool.kind !== "section") {
        node = {
          ...node,
          parentNode: parent.id,
          position: {
            x: node.position.x - parent.position.x,
            y: node.position.y - parent.position.y
          }
        };
      }
      const placed = { ...node, selected: true };
      setNodes((current) =>
        sortSectionsFirst([...current.map((entry) => ({ ...entry, selected: false })), placed])
      );
      setSelectedNodeId(node.id);
      setSelectedEdgeId("");
      if (tool.kind === "comment") setShowComments(true);
      markGraphDirty();
    },
    [customSymbolsById, gridSize, markGraphDirty, recordHistory, setNodes, user.name]
  );

  function changeGridSize(next: number) {
    setGridSize(next);
    localStorage.setItem("fsdp.gridSize", String(next));
  }

  function changeLabelMode(next: LabelMode) {
    setLabelMode(next);
    localStorage.setItem("fsdp.labelMode", next);
  }

  const deleteNodeById = useCallback(
    (id: string) => {
      recordHistory();
      const next = removeNodesKeepingSectionContents(nodesRef.current, edgesRef.current, [id]);
      setNodes(next.nodes);
      setEdges(next.edges);
      setSelectedNodeId((current) => (current === id ? "" : current));
      markGraphDirty();
    },
    [markGraphDirty, recordHistory, setEdges, setNodes]
  );

  const deleteEdgeById = useCallback(
    (id: string) => {
      recordHistory();
      setEdges((current) => current.filter((edge) => edge.id !== id));
      setSelectedEdgeId((current) => (current === id ? "" : current));
      markGraphDirty();
    },
    [markGraphDirty, recordHistory, setEdges]
  );

  // Own Delete/Backspace handling so sections keep their contents. React Flow's
  // default deleteKeyCode cascades through parentNode and wipes every child.
  const deleteSelection = useCallback(() => {
    const selectedNodeIds = nodesRef.current.filter((node) => node.selected).map((node) => node.id);
    const selectedEdgeIds = edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id);
    if (!selectedNodeIds.length && !selectedEdgeIds.length) return false;
    recordHistory();
    const next = removeNodesKeepingSectionContents(
      nodesRef.current,
      edgesRef.current,
      selectedNodeIds,
      selectedEdgeIds
    );
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId("");
    setSelectedEdgeId("");
    markGraphDirty();
    return true;
  }, [recordHistory, setEdges, setNodes]);

  const rotateNodeById = useCallback(
    (id: string) => {
      recordHistory();
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, rotation: (Number(node.data?.rotation ?? 0) + 90) % 360 } }
            : node
        )
      );
      markGraphDirty();
    },
    [recordHistory, setNodes]
  );

  const duplicateNodeById = useCallback(
    (id: string) => {
      const source = nodesRef.current.find((node) => node.id === id);
      if (!source) return;
      recordHistory();
      const copy: Node<CanvasNodeData> = {
        ...source,
        id: makeNodeId(source.type === "pidSymbol" ? String(source.data?.symbolType ?? "component") : "node"),
        position: { x: source.position.x + 24, y: source.position.y + 24 },
        data: { ...source.data, hasComponent: false },
        selected: true
      };
      setNodes((current) =>
        sortSectionsFirst([...current.map((entry) => ({ ...entry, selected: false })), copy])
      );
      setSelectedNodeId(copy.id);
      markGraphDirty();
    },
    [recordHistory, setNodes]
  );

  const updateNodeDataById = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      recordHistory();
      setNodes((current) =>
        current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node))
      );
      markGraphDirty();
    },
    [recordHistory, setNodes]
  );

  const updateEdgeFromToolbar = useCallback(
    (id: string, patch: Partial<OrthogonalEdgeData>, label?: string) => {
      if (label !== undefined) {
        // Record one history entry per label-editing burst, not per keystroke.
        if (edgeLabelHistoryRef.current !== id) {
          recordHistory();
          edgeLabelHistoryRef.current = id;
        }
      } else {
        recordHistory();
      }
      setEdges((current) =>
        current.map((edge) => {
          if (edge.id !== id) return edge;
          const data = { ...edge.data, ...patch };
          return {
            ...edge,
            ...(label !== undefined ? { label: label || undefined } : {}),
            data,
            markerEnd: edgeMarker(data)
          };
        })
      );
      markGraphDirty();
    },
    [recordHistory, setEdges]
  );

  const handleNodeDragStart = useCallback(
    (_event: unknown, node: Node<CanvasNodeData>, draggedNodes?: Node<CanvasNodeData>[]) => {
      recordHistory();
      dragPositionsRef.current = {};
      (draggedNodes?.length ? draggedNodes : [node]).forEach((entry) => {
        dragPositionsRef.current[entry.id] = { ...entry.position };
      });
    },
    [recordHistory]
  );

  // Hand-routed lines whose two endpoints move together (a dragged section's
  // contents, or a multi-selection) are translated along, so the routing
  // keeps its shape. Lines with a stationary endpoint keep their absolute
  // waypoints (draw.io behavior).
  const handleNodeDrag = useCallback(
    (_event: unknown, node: Node<CanvasNodeData>, draggedNodes?: Node<CanvasNodeData>[]) => {
      const dragged = draggedNodes?.length ? draggedNodes : [node];
      const previous = dragPositionsRef.current[node.id];
      dragged.forEach((entry) => {
        dragPositionsRef.current[entry.id] = { ...entry.position };
      });
      if (!previous) return;
      const deltaX = node.position.x - previous.x;
      const deltaY = node.position.y - previous.y;
      if (!deltaX && !deltaY) return;
      const movingIds = new Set(dragged.map((entry) => entry.id));
      nodesRef.current.forEach((entry) => {
        if (entry.parentNode && movingIds.has(entry.parentNode)) movingIds.add(entry.id);
      });
      setEdges((current) => {
        let changed = false;
        const next = current.map((edge) => {
          if (!movingIds.has(edge.source) || !movingIds.has(edge.target) || !hasStoredGeometry(edge.data)) {
            return edge;
          }
          const data = translateEdgeGeometry(edge.data, deltaX, deltaY);
          if (data === edge.data) return edge;
          changed = true;
          return { ...edge, data };
        });
        return changed ? next : current;
      });
    },
    [setEdges]
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, draggedNode: Node<CanvasNodeData>, draggedNodes?: Node<CanvasNodeData>[]) => {
      const dragged = draggedNodes?.length ? draggedNodes : [draggedNode];
      setNodes((current) => {
        const sections = current.filter((node) => node.type === "pidSection");
        let changed = false;
        const next = current.map((node) => {
          if (node.type === "pidSection") return node;
          const draggedVersion = dragged.find((entry) => entry.id === node.id);
          if (!draggedVersion) return node;
          const absolute = draggedVersion.positionAbsolute ?? draggedVersion.position;
          const centerX = absolute.x + (draggedVersion.width ?? 0) / 2;
          const centerY = absolute.y + (draggedVersion.height ?? 0) / 2;
          const hit = sections.find((section) => {
            const width = section.width ?? Number(section.style?.width ?? 0);
            const height = section.height ?? Number(section.style?.height ?? 0);
            return (
              centerX >= section.position.x &&
              centerX <= section.position.x + width &&
              centerY >= section.position.y &&
              centerY <= section.position.y + height
            );
          });
          if ((node.parentNode ?? undefined) === hit?.id) return node;
          changed = true;
          if (hit) {
            return {
              ...node,
              parentNode: hit.id,
              position: { x: absolute.x - hit.position.x, y: absolute.y - hit.position.y }
            };
          }
          return { ...node, parentNode: undefined, position: absolute };
        });
        return changed ? sortSectionsFirst(next) : current;
      });
    },
    [setNodes]
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, kind: ContextMenuState["kind"], targetId?: string) => {
      event.preventDefault();
      const container = diagramContainerRef.current?.getBoundingClientRect();
      if (!container) return;
      const flow = rfInstanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
      setContextMenu({
        x: Math.min(event.clientX - container.left, container.width - 200),
        y: Math.min(event.clientY - container.top, container.height - 180),
        flowX: flow.x,
        flowY: flow.y,
        kind,
        targetId
      });
    },
    []
  );

  function handlePaneClick(event: ReactMouseEvent) {
    setContextMenu(null);
    if (placementTool && rfInstanceRef.current) {
      const position = rfInstanceRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      placeElement(placementTool, position.x, position.y);
      setPlacementTool(null);
      return;
    }
    setSelectedNodeId("");
    setSelectedEdgeId("");
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPlacementTool(null);
        setContextMenu(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (deleteSelection()) event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [deleteSelection, redo, undo]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Selection and initial-measurement changes are not edits.
      if (changes.some((change) => change.type === "remove")) {
        recordHistory();
      }
      if (changes.some((change) => change.type === "position" || change.type === "add" || change.type === "remove")) {
        markGraphDirty();
      }
      onNodesChangeBase(changes);
    },
    [markGraphDirty, onNodesChangeBase, recordHistory]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((change) => change.type === "remove")) {
        recordHistory();
      }
      if (changes.some((change) => change.type === "add" || change.type === "remove")) {
        markGraphDirty();
      }
      onEdgesChangeBase(changes);
    },
    [markGraphDirty, onEdgesChangeBase, recordHistory]
  );

  function onConnect(connection: Connection) {
    connectCompletedRef.current = true;
    recordHistory();
    markGraphDirty();
    setEdges((current) =>
      addEdge(
        {
          ...withJunctionHandles(connection, nodesRef.current),
          type: "orthogonal",
          markerEnd: edgeMarker(undefined)
        },
        current
      )
    );
  }

  function handleConnectStart(_event: unknown, params: OnConnectStartParams) {
    connectStartRef.current = params;
    connectCompletedRef.current = false;
  }

  // Dropping a connection onto an existing line joins them: a junction node
  // is placed at the nearest point of that line, the line is split in two
  // through it, and the dragged connection attaches to the junction.
  function handleConnectEnd(event: MouseEvent | TouchEvent) {
    const start = connectStartRef.current;
    connectStartRef.current = null;
    if (connectCompletedRef.current || !start?.nodeId) return;
    const startNodeId = start.nodeId;
    const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!pointer) return;
    const element = document.elementFromPoint(pointer.clientX, pointer.clientY);
    const edgeGroup = element?.closest?.(".react-flow__edge");
    if (!edgeGroup) return;
    const edgeId = (edgeGroup.getAttribute("data-testid") ?? "").replace("rf__edge-", "");
    const targetEdge = edgesRef.current.find((edge) => edge.id === edgeId);
    if (!targetEdge || targetEdge.source === start.nodeId || targetEdge.target === start.nodeId) return;
    const pathElement = edgeGroup.querySelector<SVGPathElement>(".react-flow__edge-path");
    const dropPoint = rfInstanceRef.current?.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    if (!pathElement || !dropPoint) return;

    // Split the rendered route at the drop point, keeping each half's
    // original corners so joining a line never changes its path.
    const split = splitRoutePath(pathElement.getAttribute("d") ?? "", dropPoint);
    if (!split || split.distance > 40) return;

    recordHistory();
    const junctionId = makeNodeId("junction");
    const center = split.point;
    setNodes((current) =>
      sortSectionsFirst([
        ...current,
        {
          id: junctionId,
          type: "pidJunction",
          position: { x: center.x - JUNCTION_SIZE / 2, y: center.y - JUNCTION_SIZE / 2 },
          style: { width: JUNCTION_SIZE, height: JUNCTION_SIZE },
          data: {}
        }
      ])
    );
    const carried: OrthogonalEdgeData = {
      ...targetEdge.data,
      waypoints: undefined,
      startX: undefined,
      endX: undefined,
      bendX: undefined,
      bendY: undefined
    };
    const upstreamData = { ...carried, showArrow: false };
    // Attach each of the three lines to the junction handle facing its far end.
    const nodesNow = nodesRef.current;
    const centerOfNode = (nodeId: string) => {
      const node = nodesNow.find((entry) => entry.id === nodeId);
      return node ? nodeCenter(node, nodesNow) : center;
    };
    const towards = (nodeId: string) => {
      const other = centerOfNode(nodeId);
      return junctionHandleToward(center.x, center.y, other.x, other.y);
    };
    setEdges((current) => [
      ...current.filter((edge) => edge.id !== targetEdge.id),
      {
        id: makeNodeId("line"),
        source: targetEdge.source,
        sourceHandle: targetEdge.sourceHandle,
        target: junctionId,
        targetHandle: towards(targetEdge.source),
        type: "orthogonal",
        data: { ...upstreamData, waypoints: split.upstream },
        markerEnd: edgeMarker(upstreamData)
      },
      {
        id: makeNodeId("line"),
        source: junctionId,
        sourceHandle: towards(targetEdge.target),
        target: targetEdge.target,
        targetHandle: targetEdge.targetHandle,
        type: "orthogonal",
        label: targetEdge.label,
        data: { ...carried, waypoints: split.downstream },
        markerEnd: edgeMarker(carried)
      },
      {
        id: makeNodeId("line"),
        source: startNodeId,
        sourceHandle: start.handleId ?? undefined,
        target: junctionId,
        targetHandle: towards(startNodeId),
        type: "orthogonal",
        data: {},
        markerEnd: edgeMarker(undefined)
      }
    ]);
    markGraphDirty();
    setMessage("Lines joined with a junction.");
  }

  // Dragging a line end off its port: reconnect on a valid drop, remove the
  // line when dropped on empty canvas.
  function handleEdgeUpdateStart() {
    edgeUpdateSucceededRef.current = false;
  }

  function handleEdgeUpdate(oldEdge: Edge<OrthogonalEdgeData>, connection: Connection) {
    edgeUpdateSucceededRef.current = true;
    recordHistory();
    setEdges((current) =>
      updateEdge(oldEdge, withJunctionHandles(connection, nodesRef.current), current, { shouldReplaceId: false })
    );
    markGraphDirty();
  }

  function handleEdgeUpdateEnd(_event: unknown, edge: Edge<OrthogonalEdgeData>) {
    if (!edgeUpdateSucceededRef.current) {
      recordHistory();
      setEdges((current) => current.filter((entry) => entry.id !== edge.id));
      setSelectedEdgeId((current) => (current === edge.id ? "" : current));
      markGraphDirty();
      setMessage("Line detached.");
    }
    edgeUpdateSucceededRef.current = true;
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
    setImpact(null);
  }

  function selectSystem(id: string) {
    if (id === selectedSystemId) return;
    if (!confirmDiscardUnsaved()) return;
    setSelectedSystemId(id);
    setSelectedDiagramId("");
  }

  function openDiagram(id: string) {
    if (id === selectedDiagramId) return;
    if (!confirmDiscardUnsaved()) return;
    setSelectedDiagramId(id);
  }

  function submitProject(event: FormEvent) {
    event.preventDefault();
    // Creating a project rewrites the selected project/system/diagram chain and
    // unloads the open canvas. Ask before discarding unsaved P&ID edits.
    if (!confirmDiscardUnsaved()) return;
    void runAction("Created project.", async () => {
      const project = await api.createProject(projectForm);
      setProjects(await api.listProjects());
      setSelectedProjectId(project.id);
      setSelectedSystemId("");
      setSelectedDiagramId("");
      setImpact(null);
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
    // Creating a system switches the open system and clears the diagram canvas.
    // Ask before discarding unsaved P&ID edits.
    if (!confirmDiscardUnsaved()) return;
    void runAction("Created system.", async () => {
      const system = await api.createSystem(selectedProject.id, systemForm);
      setSystems(await api.listSystems(selectedProject.id));
      setSelectedSystemId(system.id);
      setSelectedDiagramId("");
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

  function submitDiagram(event: FormEvent) {
    event.preventDefault();
    if (!selectedSystem) return;
    // Creating a diagram switches the open canvas onto it. Refuse to silently
    // discard unsaved edits from the current diagram, and never copy the open
    // canvas into the new one — the API creates an empty graph by design.
    if (!confirmDiscardUnsaved()) return;
    void runAction("Created diagram.", async () => {
      const created = await api.createDiagram(selectedSystem.id, { name: diagramName });
      setDiagrams(await api.listDiagrams(selectedSystem.id));
      setSelectedDiagramId(created.id);
    }, "diagram");
  }

  function saveGraph() {
    if (!selectedDiagram) return;
    const diagramId = selectedDiagram.id;
    const systemId = selectedDiagram.system_id;
    const payload = graphPayload;
    const generationAtSave = graphDirtyGeneration.current;
    void runAction("Saved graph.", async () => {
      await api.updateDiagramGraph(diagramId, payload);
      if (selectedDiagramIdRef.current !== diagramId) return;
      // Mid-save canvas edits bump the generation; keep dirty so discard
      // guards and the badge still protect those unsaved changes.
      if (graphDirtyGeneration.current === generationAtSave) {
        setGraphDirty(false);
      }
      setDiagrams(await api.listDiagrams(systemId));
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

  function applyNodeLabel() {
    if (!selectedNode) return;
    const label = nodeLabelDraft.trim();
    if (!label || label === selectedNode.data?.label) return;
    recordHistory();
    setNodes((current) =>
      current.map((node) => (node.id === selectedNode.id ? { ...node, data: { ...node.data, label } } : node))
    );
    markGraphDirty();
    setMessage("Renamed node — save the graph to persist.");
  }

  function applyEdgeMetadata() {
    if (!selectedEdge) return;
    void runAction("Updated line metadata — save the graph to persist.", async () => {
      const data: Partial<OrthogonalEdgeData> = {
        fluid: edgeForm.fluid.trim() || null,
        material: edgeForm.material.trim() || null,
        pressure_bar: parseOptionalNumber(edgeForm.pressure_bar, "Pressure"),
        temperature_c: parseOptionalNumber(edgeForm.temperature_c, "Temperature"),
        diameter_mm: parseOptionalNumber(edgeForm.diameter_mm, "Diameter")
      };
      recordHistory();
      setEdges((current) =>
        current.map((edge) =>
          edge.id === selectedEdge.id
            ? { ...edge, label: edgeForm.label.trim() || undefined, data: { ...edge.data, ...data } }
            : edge
        )
      );
      markGraphDirty();
    }, "edge");
  }

  async function exportDiagramPng() {
    const canvas = document.querySelector<HTMLElement>(".react-flow");
    if (!canvas || !selectedDiagram) return;
    void runAction("Exported diagram PNG.", async () => {
      const dataUrl = await toPng(canvas, {
        backgroundColor: "#fbfcfe",
        pixelRatio: 2,
        filter: (element) => {
          const classes = (element as HTMLElement).classList;
          if (!classes) return true;
          return (
            !classes.contains("react-flow__minimap") &&
            !classes.contains("react-flow__controls") &&
            !classes.contains("react-flow__attribution") &&
            !classes.contains("floatingToolbar") &&
            !classes.contains("selectionToolbar") &&
            !classes.contains("canvasContextMenu")
          );
        }
      });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${selectedDiagram.name.replaceAll(/[^A-Za-z0-9._-]+/g, "-")}-rev${selectedDiagram.revision}.png`;
      link.click();
    });
  }


  function placeComponent() {
    if (!selectedDiagram || !selectedPart || !selectedNode || selectedNode.type !== "pidSymbol") return;
    const diagramId = selectedDiagram.id;
    const systemId = selectedDiagram.system_id;
    const part = selectedPart;
    const node = selectedNode;
    const tag = componentTag;
    const snapshotNodes = nodes;
    const snapshotEdges = edges;
    void runAction("Placed component.", async () => {
      if (graphDirty) {
        throw new Error("Save the diagram first — parts can only be placed on saved nodes.");
      }
      const component = await api.createComponent(diagramId, {
        tag,
        part_id: part.id,
        quantity: 1,
        properties: { node_external_id: node.id }
      });
      // Keep the descriptive label; the tag is carried separately so the
      // caption setting can switch between them.
      const nextNodes = snapshotNodes.map((entry) =>
        entry.id === node.id ? { ...entry, data: { ...entry.data, tag: component.tag } } : entry
      );
      // Always finish API writes for the diagram that received the part, even if
      // the user switched selection mid-request; only skip local UI updates.
      await api.updateDiagramGraph(diagramId, buildGraphPayload(nextNodes, snapshotEdges));
      const nextComponents = await api.listComponents(diagramId);
      if (selectedDiagramIdRef.current !== diagramId) return;
      setNodes(nextNodes);
      setComponents(nextComponents);
      setSelectedComponentId(component.id);
      setDiagrams(await api.listDiagrams(systemId));
      setComponentTag(suggestTag(String(node.data?.symbolType ?? "component"), nextComponents));
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
    const diagramId = selectedDiagram.id;
    const componentId = selectedComponent.id;
    void runAction("Deleted component.", async () => {
      await api.deleteComponent(componentId);
      if (selectedDiagramIdRef.current !== diagramId) return;
      const next = await api.listComponents(diagramId);
      if (selectedDiagramIdRef.current !== diagramId) return;
      setComponents(next);
      setSelectedComponentId(next[0]?.id || "");
    });
  }

  function linkRequirementToComponent() {
    if (!selectedRequirement || !selectedComponent) return;
    void runAction("Linked requirement.", async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: selectedRequirement.id, target_type: "component", target_id: selectedComponent.id, link_type: "satisfied_by" });
      setTraceLinks(await api.listTraceLinks("requirement", selectedRequirement.id));
    }, "traceLink");
  }

  function submitUser(event: FormEvent) {
    event.preventDefault();
    void runAction("Created user.", async () => {
      await api.createUser(userForm);
      setUsers(await api.listUsers());
      setUserForm({ email: "", name: "", password: "", role: "engineer" });
    }, "user");
  }

  function updateUserAccount(userId: string, changes: { role?: string; is_active?: boolean }) {
    void runAction("Updated user.", async () => {
      await api.updateUser(userId, changes);
      setUsers(await api.listUsers());
    }, "user");
  }

  function generateBom() {
    if (!selectedDiagram) return;
    void runAction("Generated BoM snapshot.", async () => {
      const snapshot = await api.generateBom(selectedDiagram.id);
      const snapshots = await api.listDiagramBoms(selectedDiagram.id);
      setBomSnapshots(snapshots);
      setSelectedBomId(snapshot.id);
      setProjectBoms(selectedProjectId ? await api.listProjectBoms(selectedProjectId) : []);
    });
  }

  function setBomStatus(status: string) {
    if (!bom) return;
    void runAction(`BoM revision ${bom.revision} marked ${status}.`, async () => {
      const updated = await api.setBomStatus(bom.id, status);
      setBomSnapshots((current) => current.map((snapshot) => (snapshot.id === updated.id ? updated : snapshot)));
      setProjectBoms(selectedProjectId ? await api.listProjectBoms(selectedProjectId) : []);
    });
  }

  function runBomDiff() {
    if (!bom || !diffAgainstId) return;
    void runAction("Compared BoM revisions.", async () => {
      setBomDiff(await api.getBomDiff(bom.id, diffAgainstId));
    });
  }

  function removeTraceLink(linkId: string) {
    if (!selectedRequirement) return;
    void runAction("Removed trace link.", async () => {
      await api.deleteTraceLink(linkId);
      setTraceLinks(await api.listTraceLinks("requirement", selectedRequirement.id));
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

  const symbolNodeSelected = selectedNode?.type === "pidSymbol";
  const resizableNodeSelected = symbolNodeSelected || selectedNode?.type === "pidSection";
  const selectedNodeWidth = Math.round(selectedNode?.width ?? Number(selectedNode?.style?.width ?? 0)) || 0;
  const selectedNodeHeight = Math.round(selectedNode?.height ?? Number(selectedNode?.style?.height ?? 0)) || 0;
  const editorSettings = useMemo(() => ({ labelMode }), [labelMode]);

  function commitNodeSize(dimension: "width" | "height", raw: string) {
    if (!selectedNode) return;
    const parsed = Math.round(Number(raw));
    if (!Number.isFinite(parsed) || parsed < 16 || parsed > 4000) return;
    const current = dimension === "width" ? selectedNodeWidth : selectedNodeHeight;
    if (parsed === current) return;
    recordHistory();
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNode.id
          ? { ...node, [dimension]: parsed, style: { ...node.style, [dimension]: parsed } }
          : node
      )
    );
    markGraphDirty();
  }
  const toolbarParent = selectedNode?.parentNode
    ? nodes.find((node) => node.id === selectedNode.parentNode) ?? null
    : null;
  const edgeSource = selectedEdge ? nodes.find((node) => node.id === selectedEdge.source) : undefined;
  const edgeTarget = selectedEdge ? nodes.find((node) => node.id === selectedEdge.target) : undefined;
  const withAbsolutePosition = (node: Node<CanvasNodeData>): Node<CanvasNodeData> => {
    const parent = node.parentNode ? nodes.find((entry) => entry.id === node.parentNode) : undefined;
    return parent
      ? { ...node, position: { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } }
      : node;
  };
  const toolbarEdgeEndpoints =
    edgeSource && edgeTarget
      ? ([withAbsolutePosition(edgeSource), withAbsolutePosition(edgeTarget)] as [Node, Node])
      : null;

  return (
    <CustomSymbolsContext.Provider value={customSymbolsById}>
    <EditorSettingsContext.Provider value={editorSettings}>
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
              <section
                className="diagramLayout"
                style={{ gridTemplateColumns: `minmax(0, 1fr) auto ${inspectorWidth}px` }}
              >
                <div className="workspace">
                  <div className="toolbar">
                    <form className="inlineForm" onSubmit={submitDiagram}>
                      <TextInput label="Diagram name" value={diagramName} onChange={setDiagramName} />
                      <button disabled={busy || !selectedSystem || !diagramName}>Create P&ID</button>
                    </form>
                    <Select label="Open diagram" value={selectedDiagramId} options={diagrams.map((diagram) => ({ value: diagram.id, label: `${diagram.name} rev ${diagram.revision}` }))} onChange={openDiagram} />
                    <button disabled={busy || !selectedDiagram || !diagramName} onClick={updateDiagram}>Rename</button>
                    <button className="danger" disabled={busy || !selectedDiagram} onClick={deleteDiagram}>Delete</button>
                    <button disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
                    <button disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">Redo</button>
                    <button disabled={busy || !selectedDiagram} onClick={() => void exportDiagramPng()}>Export PNG</button>
                    <button className="primary" disabled={busy || !selectedDiagram || !graphDirty} onClick={saveGraph}>Save graph</button>
                    {selectedDiagram && <span className={graphDirty ? "dirtyBadge" : "cleanBadge"}>{graphDirty ? "Unsaved changes" : "Saved"}</span>}
                  </div>
                  <div className={placementTool ? "diagram placing" : "diagram"} ref={diagramContainerRef}>
                    <ReactFlow
                      nodes={displayNodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      onInit={(instance) => {
                        rfInstanceRef.current = instance;
                      }}
                      connectionMode={ConnectionMode.Loose}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      onConnect={onConnect}
                      onConnectStart={handleConnectStart}
                      onConnectEnd={handleConnectEnd}
                      edgesUpdatable
                      edgeUpdaterRadius={12}
                      onEdgeUpdateStart={handleEdgeUpdateStart}
                      onEdgeUpdate={handleEdgeUpdate}
                      onEdgeUpdateEnd={handleEdgeUpdateEnd}
                      onNodeClick={(event, node) => {
                        // Clicking a section with an armed tool places into it.
                        if (placementTool && node.type === "pidSection" && rfInstanceRef.current) {
                          const position = rfInstanceRef.current.screenToFlowPosition({
                            x: event.clientX,
                            y: event.clientY
                          });
                          placeElement(placementTool, position.x, position.y, node as Node<CanvasNodeData>);
                          setPlacementTool(null);
                          return;
                        }
                        setSelectedNodeId(node.id);
                        setSelectedEdgeId("");
                        if (node.type === "pidSymbol" && !node.data?.hasComponent) {
                          setComponentTag(suggestTag(String(node.data?.symbolType ?? "component"), components));
                        }
                      }}
                      onEdgeClick={(_, edge) => {
                        setSelectedEdgeId(edge.id);
                        setSelectedNodeId("");
                      }}
                      onSelectionChange={({ nodes: selectionNodes, edges: selectionEdges }) => {
                        setSelectedNodeId(selectionNodes.length === 1 ? selectionNodes[0].id : "");
                        setSelectedEdgeId(
                          !selectionNodes.length && selectionEdges.length === 1 ? selectionEdges[0].id : ""
                        );
                      }}
                      onPaneClick={handlePaneClick}
                      onPaneContextMenu={(event) => openContextMenu(event, "pane")}
                      onNodeContextMenu={(event, node) => {
                        setSelectedNodeId(node.id);
                        openContextMenu(event, "node", node.id);
                      }}
                      onEdgeContextMenu={(event, edge) => {
                        setSelectedEdgeId(edge.id);
                        openContextMenu(event, "edge", edge.id);
                      }}
                      onNodeDragStart={handleNodeDragStart}
                      onNodeDrag={handleNodeDrag}
                      onNodeDragStop={handleNodeDragStop}
                      elevateNodesOnSelect={false}
                      // Handled in window keydown via deleteSelection so
                      // deleting a section does not cascade to its children.
                      deleteKeyCode={null}
                      // Left-drag rubber-bands a selection; panning moves to
                      // the middle and right mouse buttons.
                      selectionOnDrag
                      selectionMode={SelectionMode.Partial}
                      panOnDrag={[1, 2]}
                      snapToGrid
                      snapGrid={[gridSize, gridSize]}
                      fitView
                    >
                      {showGrid && (
                        <Background
                          color="#c3cede"
                          gap={gridSize <= 5 ? gridSize * 4 : gridSize * 2}
                          size={1.6}
                          variant={BackgroundVariant.Dots}
                        />
                      )}
                      {placementTool && <PlacementGhost tool={placementTool} gridSize={gridSize} />}
                      <MiniMap
                        maskColor="rgba(238, 241, 245, 0.7)"
                        nodeColor="#c8d4e4"
                        nodeStrokeColor="#41536b"
                        pannable
                        zoomable
                      />
                      <Controls />
                      <SelectionToolbar
                        node={selectedNode ?? null}
                        parent={toolbarParent}
                        edge={selectedNode ? null : selectedEdge ?? null}
                        edgeEndpoints={toolbarEdgeEndpoints}
                        onUpdateNodeData={updateNodeDataById}
                        onUpdateEdge={updateEdgeFromToolbar}
                        onRotateNode={rotateNodeById}
                        onDuplicateNode={duplicateNodeById}
                        onDeleteNode={deleteNodeById}
                        onDeleteEdge={deleteEdgeById}
                      />
                    </ReactFlow>
                    {contextMenu && (
                      <CanvasContextMenu
                        menu={contextMenu}
                        showGrid={showGrid}
                        showComments={showComments}
                        nodeType={contextMenu.targetId ? nodes.find((node) => node.id === contextMenu.targetId)?.type : undefined}
                        onToggleGrid={toggleGrid}
                        onToggleComments={() => setShowComments((current) => !current)}
                        onAddElement={placeElement}
                        onRotateNode={rotateNodeById}
                        onDuplicateNode={duplicateNodeById}
                        onDeleteNode={deleteNodeById}
                        onDeleteEdge={deleteEdgeById}
                        onClose={() => setContextMenu(null)}
                      />
                    )}
                    <FloatingToolbar
                      activeTool={placementTool}
                      builtinSymbols={PALETTE_SYMBOLS}
                      customSymbols={customSymbols}
                      onArmTool={setPlacementTool}
                      onOpenSymbolEditor={() => setSymbolEditorOpen(true)}
                    />
                  </div>
                </div>
                <PanelResizer width={inspectorWidth} onResize={setInspectorWidth} direction={-1} label="Resize inspector panel" />
                <aside className="inspector" style={{ width: inspectorWidth }}>
                  {!selectedNode && !selectedEdge && (
                    <Panel title="Canvas">
                      <Select
                        label="Snap grid"
                        value={String(gridSize)}
                        options={[2, 5, 10, 20].map((value) => ({ value: String(value), label: `${value} px` }))}
                        onChange={(value) => changeGridSize(Number(value))}
                      />
                      <Select
                        label="Symbol caption"
                        value={labelMode}
                        options={[
                          { value: "tag", label: "Component tag" },
                          { value: "name", label: "Name" }
                        ]}
                        onChange={(value) => changeLabelMode(value === "name" ? "name" : "tag")}
                      />
                      <label className="checkRow">
                        <input type="checkbox" checked={showGrid} onChange={toggleGrid} />
                        <span>Show grid</span>
                      </label>
                      <label className="checkRow">
                        <input type="checkbox" checked={showComments} onChange={() => setShowComments((current) => !current)} />
                        <span>Show comments</span>
                      </label>
                    </Panel>
                  )}
                  <Panel title="Node Inspector">
                    <p><strong>Selected:</strong> {selectedNode ? <span className="mono">{symbolNodeSelected ? String(selectedNode.data?.symbolType ?? "node") : String(selectedNode.type ?? "node").replace("pid", "").toLowerCase()}</span> : "None"}{selectedNode?.data?.hasComponent ? <span className="pill pill-good" style={{ marginLeft: 6 }}>part placed</span> : null}</p>
                    <TextInput label="Node label" value={nodeLabelDraft} onChange={setNodeLabelDraft} />
                    <button disabled={busy || !symbolNodeSelected || !nodeLabelDraft.trim()} onClick={applyNodeLabel}>Rename node</button>
                    {resizableNodeSelected && (
                      <div className="sizeRow">
                        <label>
                          Width px
                          <input
                            key={`w-${selectedNode?.id}-${selectedNodeWidth}`}
                            type="number"
                            min={16}
                            defaultValue={selectedNodeWidth}
                            onBlur={(event) => commitNodeSize("width", event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                            }}
                          />
                        </label>
                        <label>
                          Height px
                          <input
                            key={`h-${selectedNode?.id}-${selectedNodeHeight}`}
                            type="number"
                            min={16}
                            defaultValue={selectedNodeHeight}
                            onBlur={(event) => commitNodeSize("height", event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                            }}
                          />
                        </label>
                      </div>
                    )}
                    <TextInput label="Component tag" value={componentTag} onChange={setComponentTag} />
                    <FormError message={formErrors.component} />
                    <button className="primary" disabled={busy || !selectedDiagram || !selectedPart || !symbolNodeSelected || !componentTag.trim()} onClick={placeComponent}>Place selected part</button>
                    <p className="hint">Placing uses the selected catalog part ({selectedPart?.part_number ?? "none selected"}).</p>
                  </Panel>
                  <Panel title="Line Metadata">
                    {selectedEdge ? (
                      <>
                        <TextInput label="Label" value={edgeForm.label} onChange={(label) => setEdgeForm({ ...edgeForm, label })} />
                        <TextInput label="Fluid" value={edgeForm.fluid} onChange={(fluid) => setEdgeForm({ ...edgeForm, fluid })} />
                        <TextInput label="Pressure bar" value={edgeForm.pressure_bar} onChange={(pressure) => setEdgeForm({ ...edgeForm, pressure_bar: pressure })} />
                        <TextInput label="Temperature C" value={edgeForm.temperature_c} onChange={(temperature) => setEdgeForm({ ...edgeForm, temperature_c: temperature })} />
                        <TextInput label="Diameter mm" value={edgeForm.diameter_mm} onChange={(diameter) => setEdgeForm({ ...edgeForm, diameter_mm: diameter })} />
                        <TextInput label="Material" value={edgeForm.material} onChange={(material) => setEdgeForm({ ...edgeForm, material })} />
                        <FormError message={formErrors.edge} />
                        <button className="primary" disabled={busy} onClick={applyEdgeMetadata}>Apply to line</button>
                      </>
                    ) : (
                      <p className="hint">Select a line on the canvas to edit its label and engineering data ({edges.length} line{edges.length === 1 ? "" : "s"}).</p>
                    )}
                  </Panel>
                  <Panel title="Diagrams">
                    <DataTable rows={diagrams} selectedKey={selectedDiagramId} getKey={(diagram) => diagram.id} onSelect={(diagram) => openDiagram(diagram.id)} columns={[{ header: "Name", render: (diagram) => diagram.name }, { header: "Rev", render: (diagram) => diagram.revision }]} />
                  </Panel>
                </aside>
              </section>
              <SymbolEditorModal
                open={symbolEditorOpen}
                symbols={customSymbols}
                onClose={() => setSymbolEditorOpen(false)}
                onChanged={refreshSymbols}
              />
            </PageLayout>
          }
        />
        <Route
          path="/parts"
          element={
            <PageLayout title="Parts Catalog" description="Org-wide hardware library">
              <PartsCatalog
                parts={parts}
                selectedPartId={selectedPartId}
                projectId={selectedProjectId || undefined}
                onSelectPart={setSelectedPartId}
                onPartsChanged={setParts}
              />
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
                  <DataTable rows={requirements} selectedKey={selectedRequirementId} getKey={(requirement) => requirement.id} onSelect={(requirement) => setSelectedRequirementId(requirement.id)} columns={[{ header: "Key", render: (requirement) => <span className="mono">{requirement.key}</span> }, { header: "Title", render: (requirement) => requirement.title }, { header: "Type", render: (requirement) => requirement.requirement_type }, { header: "Status", render: (requirement) => <StatusPill value={requirement.status} /> }]} />
                </Panel>
                <Panel title="Trace Links">
                  <Select label="Component" value={selectedComponentId} options={components.map((component) => ({ value: component.id, label: component.tag }))} onChange={setSelectedComponentId} />
                  <TextInput label="Component tag" value={componentTag} onChange={setComponentTag} />
                  <FormError message={formErrors.component} />
                  <div className="buttonRow"><button disabled={!selectedComponent} onClick={updateComponent}>Update component</button><button className="danger" disabled={!selectedComponent} onClick={deleteComponent}>Delete component</button></div>
                  <button className="primary" disabled={!selectedRequirement || !selectedComponent} onClick={linkRequirementToComponent}>Link requirement to component</button>
                  <FormError message={formErrors.traceLink} />
                  {selectedRequirement && (
                    traceLinks.length
                      ? <DataTable rows={traceLinks} getKey={(link) => link.id} columns={[{ header: "Link", render: (link) => <span className="mono">{link.link_type}</span> }, { header: "Target", render: (link) => <span className="mono">{components.find((component) => component.id === link.target_id)?.tag ?? `${link.target_type} ${link.target_id.slice(0, 8)}`}</span> }, { header: "", render: (link) => <button className="danger" disabled={busy} onClick={() => removeTraceLink(link.id)}>Remove</button> }]} />
                      : <p className="hint">No trace links for {selectedRequirement.key} yet.</p>
                  )}
                </Panel>
              </section>
            </PageLayout>
          }
        />
        <Route
          path="/bom"
          element={
            <PageLayout title="BoM & Procurement" description="Snapshots, readiness, and exports">
              <section className="grid">
                <Panel title="Snapshots">
                  <button className="primary" disabled={busy || !selectedDiagram} onClick={generateBom}>Generate BoM</button>
                  {bom && (bom.status === "released"
                    ? <button disabled={busy} onClick={() => setBomStatus("draft")}>Reopen as draft</button>
                    : <button disabled={busy} onClick={() => setBomStatus("released")}>Release</button>)}
                  {selectedDiagram
                    ? <DataTable rows={bomSnapshots} selectedKey={selectedBomId} getKey={(snapshot) => snapshot.id} onSelect={(snapshot) => setSelectedBomId(snapshot.id)} columns={[{ header: "Rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span> }, { header: "Status", render: (snapshot) => <StatusPill value={snapshot.status} /> }, { header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span> }, { header: "Created", render: (snapshot) => <span className="mono">{snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : "—"}</span> }]} />
                    : <p className="hint">Open a diagram on the Diagrams page first.</p>}
                </Panel>
                <Panel title="Selected Snapshot">
                  {bom ? (
                    <>
                      <p className="snapshotMeta">Revision <span className="mono">{bom.revision}</span> · {bom.rows.length} row(s) · <StatusPill value={bom.status} /></p>
                      <a className="downloadLink" href={bomCsvUrl(bom.id)}>Download CSV</a>
                      <DataTable rows={bom.rows} getKey={(_, index?: number) => String(index)} columns={[{ header: "Part", render: (row) => <span className="mono">{String(row.part_number ?? "Unresolved")}</span> }, { header: "Description", render: (row) => String(row.description ?? "") }, { header: "Material", render: (row) => String(row.material ?? "—") }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />
                    </>
                  ) : <p className="hint">Generate or select a snapshot.</p>}
                </Panel>
                <Panel title="Procurement Readiness">
                  {bomReadiness ? (
                    bomReadiness.ready
                      ? <p className="snapshotMeta"><span className="pill pill-good">ready</span> All {bomReadiness.row_count} row(s) reference qualified parts with complete data.</p>
                      : (
                        <>
                          <p className="snapshotMeta"><span className="pill pill-warn">{bomReadiness.issue_count} issue(s)</span> in {bomReadiness.row_count} row(s)</p>
                          <DataTable rows={bomReadiness.issues} getKey={(_, index?: number) => String(index)} columns={[{ header: "Part", render: (issue) => <span className="mono">{issue.part_number ?? "Unresolved"}</span> }, { header: "Tags", render: (issue) => <span className="mono">{issue.component_tags.join(", ") || "—"}</span> }, { header: "Warnings", render: (issue) => issue.warnings.join(" ") }]} />
                        </>
                      )
                  ) : <p className="hint">Select a snapshot to check procurement readiness.</p>}
                </Panel>
                <Panel title="Compare Revisions">
                  {bom && bomSnapshots.length > 1 ? (
                    <>
                      <Select label={`Compare rev ${bom.revision} against`} value={diffAgainstId} options={bomSnapshots.filter((snapshot) => snapshot.id !== bom.id).map((snapshot) => ({ value: snapshot.id, label: `rev ${snapshot.revision}` }))} onChange={setDiffAgainstId} />
                      <button disabled={busy || !diffAgainstId} onClick={runBomDiff}>Compare</button>
                      {bomDiff && (
                        <>
                          <p className="snapshotMeta"><span className="pill pill-good">{bomDiff.added.length} added</span><span className="pill pill-bad">{bomDiff.removed.length} removed</span><span className="pill pill-info">{bomDiff.changed.length} qty changed</span></p>
                          {bomDiff.added.length > 0 && <DataTable rows={bomDiff.added} getKey={(_, index?: number) => `a${index}`} columns={[{ header: "Added", render: (row) => <span className="mono">{String(row.part_number ?? row.description ?? "?")}</span> }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />}
                          {bomDiff.removed.length > 0 && <DataTable rows={bomDiff.removed} getKey={(_, index?: number) => `r${index}`} columns={[{ header: "Removed", render: (row) => <span className="mono">{String(row.part_number ?? row.description ?? "?")}</span> }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />}
                          {bomDiff.changed.length > 0 && <DataTable rows={bomDiff.changed} getKey={(_, index?: number) => `c${index}`} columns={[{ header: "Part", render: (row) => <span className="mono">{row.part_number ?? "?"}</span> }, { header: "Qty", render: (row) => <span className="mono">{row.from_quantity} → {row.to_quantity}</span> }]} />}
                        </>
                      )}
                    </>
                  ) : <p className="hint">Generate at least two snapshots of a diagram to compare revisions.</p>}
                </Panel>
                <Panel title="Project BoM History">
                  {projectBoms.length ? (
                    <DataTable rows={projectBoms} getKey={(snapshot) => snapshot.id} columns={[{ header: "Diagram", render: (snapshot) => snapshot.diagram_name }, { header: "Rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span> }, { header: "Status", render: (snapshot) => <StatusPill value={snapshot.status} /> }, { header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span> }, { header: "Created", render: (snapshot) => <span className="mono">{snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : "—"}</span> }]} />
                  ) : <p className="hint">No snapshots in this project yet.</p>}
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
                      { header: "Summary", render: (change) => <span className="clamp" title={change.summary}>{change.summary}</span> },
                      { header: "Action", render: (change) => <StatusPill value={change.action} /> },
                      { header: "Actor", render: (change) => <span className="mono">{change.actor ?? "—"}</span> },
                      { header: "When", render: (change) => <span className="mono">{new Date(change.created_at).toLocaleString()}</span> }
                    ]}
                  />
                </Panel>
                <PlaceholderCard title="Review Workflows" body="Design review packages, comments, decisions, and approval routing will live here." />
              </section>
            </PageLayout>
          }
        />
        <Route path="/safety" element={<PlaceholderPage title="Safety" body="Hazards, trapped-volume checks, relief scenarios, and FMEA/FHA workflows will be added after the navigation foundation." />} />
        <Route path="/certification" element={<PlaceholderPage title="Certification" body="Compliance packages, evidence status, and generated certification artifacts will live here." />} />
        <Route
          path="/settings"
          element={
            <PageLayout title="Settings" description="Accounts and configuration">
              <section className="grid">
                {isAdmin ? (
                  <>
                    <Panel title="Create User">
                      <form onSubmit={submitUser}>
                        <TextInput label="Email" value={userForm.email} onChange={(email) => setUserForm({ ...userForm, email })} />
                        <TextInput label="Name" value={userForm.name} onChange={(name) => setUserForm({ ...userForm, name })} />
                        <TextInput label="Password" type="password" value={userForm.password} onChange={(password) => setUserForm({ ...userForm, password })} />
                        <Select label="Role" value={userForm.role} options={roleOptions} onChange={(role) => setUserForm({ ...userForm, role })} />
                        <FormError message={formErrors.user} />
                        <button disabled={busy || !userForm.email || !userForm.name || userForm.password.length < 8}>Create user</button>
                      </form>
                      <p className="hint">Passwords need at least 8 characters. Viewers are read-only.</p>
                    </Panel>
                    <Panel title="Users">
                      <DataTable
                        rows={users}
                        getKey={(account) => account.id}
                        columns={[
                          { header: "Email", render: (account) => <span className="mono">{account.email}</span> },
                          { header: "Name", render: (account) => account.name },
                          { header: "Role", render: (account) => <StatusPill value={account.role} /> },
                          { header: "Status", render: (account) => <StatusPill value={account.is_active ? "active" : "inactive"} /> },
                          {
                            header: "",
                            render: (account) => (
                              <span className="rowActions">
                                <select value={account.role} onChange={(event) => updateUserAccount(account.id, { role: event.target.value })} disabled={busy || account.id === user.id}>
                                  {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                                {account.is_active
                                  ? <button className="danger" disabled={busy || account.id === user.id} onClick={() => updateUserAccount(account.id, { is_active: false })}>Deactivate</button>
                                  : <button disabled={busy} onClick={() => updateUserAccount(account.id, { is_active: true })}>Activate</button>}
                              </span>
                            )
                          }
                        ]}
                      />
                    </Panel>
                  </>
                ) : (
                  <Panel title="Accounts">
                    <p className="hint">You are signed in as {user.email} ({user.role}). Ask an administrator to manage accounts.</p>
                  </Panel>
                )}
                <CatalogSettingsPanel
                  project={selectedProject}
                  isAdmin={isAdmin}
                  onProjectUpdated={(updated) => {
                    setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)));
                  }}
                />
              </section>
            </PageLayout>
          }
        />
      </Routes>
    </AppShell>
    </EditorSettingsContext.Provider>
    </CustomSymbolsContext.Provider>
  );
}

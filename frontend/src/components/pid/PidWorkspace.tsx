import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from "reactflow";
import type { Diagram, Part } from "../../types";
import {
  alignNodes,
  allSymbols,
  applyNetPropsToEdges,
  arrayDuplicateSelection,
  canRedo,
  canUndo,
  cleanupJunctions,
  commit,
  createHistory,
  createNet,
  distributeNodes,
  documentToGraph,
  documentToSvg,
  downloadSvg,
  ensureUniqueTag,
  gridSizeInPixels,
  hitTestEdge,
  interactiveWalk,
  lineClassById,
  makeTerminalNode,
  moveSegmentPoints,
  nearestPortAt,
  nextLineTag,
  nodeSize,
  nudgeNodes,
  orthogonalPath,
  polylineMidpoint,
  portWorldPosition,
  printSvg,
  redo,
  reattachOrthogonal,
  resolveWaypoints,
  routeOrthogonal,
  runDrc,
  shoveEdges,
  snapPoint,
  snapToMagnets,
  symbolObstacles,
  teeOntoEdge,
  undo,
  type AlignMode,
  type DistributeAxis,
  type DrcIssue,
  type EditorMode,
  type GridVariant,
  type HistoryState,
  type LineClassId,
  type PidDocument,
  type PidEdgeData,
  type PidNodeData,
  type PidSymbolDefinition,
  type Point
} from "../../pid-cad";
import { SymbolArtwork } from "./SymbolArtwork";
import { SymbolStudio } from "./SymbolStudio";

type FlowRect = { x: number; y: number; width: number; height: number };

function clientRect(a: { x: number; y: number }, b: { x: number; y: number }): FlowRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function rectsIntersect(a: FlowRect, b: FlowRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function pointInRect(point: Point, rect: FlowRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function segmentHitsRect(a: Point, b: Point, rect: FlowRect): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const bounds: FlowRect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(1, Math.abs(a.x - b.x)),
    height: Math.max(1, Math.abs(a.y - b.y))
  };
  if (Math.abs(a.x - b.x) < 0.5) {
    bounds.x -= 0.5;
    bounds.width = 1;
  }
  if (Math.abs(a.y - b.y) < 0.5) {
    bounds.y -= 0.5;
    bounds.height = 1;
  }
  return rectsIntersect(bounds, rect);
}

function nodesInMarquee(nodes: Node<PidNodeData>[], rect: FlowRect): string[] {
  return nodes
    .filter((node) => {
      const size = nodeSize(node);
      return rectsIntersect({ x: node.position.x, y: node.position.y, width: size.width, height: size.height }, rect);
    })
    .map((node) => node.id);
}

function edgesInMarquee(
  edges: Edge<PidEdgeData>[],
  nodes: Node<PidNodeData>[],
  symbols: PidSymbolDefinition[],
  rect: FlowRect
): string[] {
  return edges
    .filter((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      if (!source || !target) return false;
      const start = portWorldPosition(source, edge.sourceHandle, symbols, 100);
      const end = portWorldPosition(target, edge.targetHandle, symbols, 0);
      const points = resolveWaypoints(start, end, edge.data?.waypoints);
      for (let i = 0; i < points.length - 1; i += 1) {
        if (segmentHitsRect(points[i], points[i + 1], rect)) return true;
      }
      return false;
    })
    .map((edge) => edge.id);
}

export type PidWorkspaceProps = {
  busy: boolean;
  diagramName: string;
  diagrams: Diagram[];
  document: PidDocument;
  graphDirty: boolean;
  history: HistoryState;
  parts: Part[];
  selectedDiagram: Diagram | null;
  selectedDiagramId: string;
  selectedPartId: string;
  componentTag: string;
  setComponentTag: (value: string) => void;
  setDiagramName: (value: string) => void;
  setDocument: (doc: PidDocument, options?: { merge?: boolean }) => void;
  setHistory: (history: HistoryState) => void;
  setSelectedDiagramId: (value: string) => void;
  setSelectedPartId: (value: string) => void;
  onCreateDiagram: () => void;
  onDeleteDiagram: () => void;
  onDirty: () => void;
  onPlaceComponent: (nodeId: string, partId: string) => void;
  onRenameDiagram: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

function SymbolNode({ data, selected, symbols }: NodeProps<PidNodeData> & { symbols: PidSymbolDefinition[] }) {
  if (data.kind === "junction") {
    return (
      <div className={`pidJunction ${selected ? "isSelected" : ""}`} title="Junction">
        <Handle className="pidPort pidPortHidden" id="center" position={Position.Left} style={{ left: "50%", top: "50%" }} type="source" />
        <span className={`pidJunctionDot ${data.junctionKind ?? "tee"}`} />
      </div>
    );
  }
  if (data.kind === "terminal") {
    return (
      <div className={`pidTerminal ${selected ? "isSelected" : ""}`} title="Terminal">
        <Handle className="pidPort pidPortHidden" id="center" position={Position.Left} style={{ left: "50%", top: "50%" }} type="source" />
        <span className="pidTerminalDot" />
      </div>
    );
  }
  const symbol = symbols.find((item) => item.id === data.symbolType) ?? symbols[0];
  const angle = ((data.rotation ?? 0) * Math.PI) / 180;
  const scaleX = data.mirrorX ? -1 : 1;
  const scaleY = data.mirrorY ? -1 : 1;
  return (
    <div className={`pidCadSymbol ${selected ? "isSelected" : ""} ${data.locked ? "isLocked" : ""}`}>
      <div
        className="pidSymbolRotator"
        style={{ transform: `rotate(${data.rotation}deg) scale(${scaleX}, ${scaleY})` }}
      >
        <SymbolArtwork symbol={symbol} />
      </div>
      {symbol.ports.map((port) => {
        let px = port.x;
        let py = port.y;
        if (data.mirrorX) px = 100 - px;
        if (data.mirrorY) py = 100 - py;
        const offsetX = px - 50;
        const offsetY = py - 50;
        const x = 50 + offsetX * Math.cos(angle) - offsetY * Math.sin(angle);
        const y = 50 + offsetX * Math.sin(angle) + offsetY * Math.cos(angle);
        const dx = x - 50;
        const dy = y - 50;
        const handlePos =
          Math.abs(dx) >= Math.abs(dy)
            ? dx >= 0
              ? Position.Right
              : Position.Left
            : dy >= 0
              ? Position.Bottom
              : Position.Top;
        return (
          <Handle
            className="pidPort"
            id={port.id}
            key={port.id}
            position={handlePos}
            style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}
            title={port.name}
            type="source"
          />
        );
      })}
      <span className="pidCadLabel">{data.label}</span>
    </div>
  );
}

function PidLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  data,
  markerEnd,
  onSegmentCommit
}: EdgeProps<PidEdgeData> & {
  onSegmentCommit: (edgeId: string, oldPoints: Point[], newPoints: Point[], segmentIndex: number, merge?: boolean) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const legacyFirstX = data?.startX ?? data?.bendX;
  const legacyLastX = data?.endX ?? data?.bendX;
  const legacyWaypoints =
    legacyFirstX !== undefined && legacyLastX !== undefined && data?.bendY !== undefined
      ? [
          { x: legacyFirstX, y: sourceY },
          { x: legacyFirstX, y: data.bendY },
          { x: legacyLastX, y: data.bendY },
          { x: legacyLastX, y: targetY }
        ]
      : undefined;
  const points = resolveWaypoints(
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    data?.waypoints ?? legacyWaypoints
  );
  const color = data?.color ?? "#243248";
  const thickness = data?.thickness ?? 2;
  const tagPos = polylineMidpoint(points);

  function beginSegmentDrag(event: ReactPointerEvent<HTMLButtonElement>, segmentIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    if (data?.locked) return;
    // Freeze endpoints from the displayed polyline so remounts / RF port jitter cannot break the drag.
    const origin = points.map((p) => ({ ...p }));
    const endSource = { ...origin[0] };
    const endTarget = { ...origin[origin.length - 1] };
    let latest = origin;
    let first = true;

    function move(moveEvent: PointerEvent) {
      const position = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      latest = moveSegmentPoints(endSource, endTarget, latest.slice(1, -1), segmentIndex, position);
      onSegmentCommit(id, origin, latest, segmentIndex, !first);
      first = false;
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onSegmentCommit(id, origin, latest, segmentIndex, true);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={orthogonalPath(points)} style={{ stroke: color, strokeWidth: thickness }} />
      {data?.tag && (
        <EdgeLabelRenderer>
          <div
            className="pidLineTag nodrag nopan"
            style={{
              left: `${tagPos.x}px`,
              top: `${tagPos.y - 12}px`,
              position: "absolute",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none"
            }}
          >
            {data.tag}
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && !data?.locked && (
        <EdgeLabelRenderer>
          {points.slice(0, -1).map((point, index) => {
            const next = points[index + 1];
            const horizontal = Math.abs(point.y - next.y) < 0.5;
            const length = Math.hypot(next.x - point.x, next.y - point.y);
            if (length < 12) return null;
            return (
              <button
                aria-label={`Move ${horizontal ? "horizontal" : "vertical"} segment`}
                className={`pidSegmentHandle nodrag nopan${horizontal ? " horizontal" : " vertical"}`}
                data-edge={id}
                key={`${id}-seg-${index}`}
                onPointerDown={(event) => beginSegmentDrag(event, index)}
                style={{ left: `${(point.x + next.x) / 2}px`, top: `${(point.y + next.y) / 2}px` }}
                type="button"
              />
            );
          })}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function RoutePreview({ points }: { points: Point[] }) {
  const { x, y, zoom } = useViewport();
  if (points.length < 2) return null;
  return (
    <svg
      className="pidRoutePreview"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 6
      }}
    >
      <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
        <path
          d={orthogonalPath(points)}
          fill="none"
          stroke="#1f5eff"
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          strokeWidth={2 / zoom}
        />
      </g>
    </svg>
  );
}

function PidWorkspaceInner(props: PidWorkspaceProps) {
  const doc = props.document;
  const symbols = allSymbols(doc);
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;
  const [mode, setMode] = useState<EditorMode>("select");
  const [activeLineClass, setActiveLineClass] = useState<LineClassId>("process");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [editingSymbol, setEditingSymbol] = useState<PidSymbolDefinition | null | "new">(null);
  const [drcIssues, setDrcIssues] = useState<DrcIssue[]>([]);
  const [showDrc, setShowDrc] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [routeDraft, setRouteDraft] = useState<{
    from: { nodeId: string; portId: string };
    committed: Point[];
    preview: Point[];
  } | null>(null);
  const [clipboard, setClipboard] = useState<{ nodes: Node<PidNodeData>[]; edges: Edge<PidEdgeData>[] } | null>(null);
  const [contextMenu, setContextMenu] = useState<
    | { kind: "edge"; edgeId: string; x: number; y: number }
    | { kind: "node"; nodeId: string; x: number; y: number }
    | null
  >(null);
  /** Right-drag marquee selection (client coords relative to canvas). */
  const [marquee, setMarquee] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
    additive: boolean;
  } | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const marqueeActiveRef = useRef(false);
  const marqueeRef = useRef<{
    start: { x: number; y: number };
    current: { x: number; y: number };
    additive: boolean;
  } | null>(null);
  const suppressContextMenuRef = useRef(false);
  /** Positions while dragging — kept local so we do not rewrite history every pointer frame. */
  const [dragNodes, setDragNodes] = useState<Node<PidNodeData>[] | null>(null);
  const [dragEdges, setDragEdges] = useState<Edge<PidEdgeData>[] | null>(null);
  const dragNodesRef = useRef<Node<PidNodeData>[] | null>(null);
  const dragEdgesRef = useRef<Edge<PidEdgeData>[] | null>(null);
  const nodeIdPrefix = useId().replaceAll(":", "");
  const nodeCounter = useRef(0);
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow();
  const gridPixels = gridSizeInPixels(doc.settings);
  const hiddenLineClasses = doc.settings.hiddenLineClasses ?? [];
  const hiddenClassSet = useMemo(() => new Set(hiddenLineClasses), [hiddenLineClasses]);
  const displayNodes = dragNodes ?? doc.nodes;
  const displayEdges = dragEdges ?? doc.edges;
  const selectedEdge = displayEdges.find((edge) => edge.id === selectedEdgeIds[0]);
  const selectedEdges = displayEdges.filter((edge) => selectedEdgeIds.includes(edge.id));
  const selectedNode = displayNodes.find(
    (node) => node.id === selectedNodeIds[0] && node.data.kind !== "junction" && node.data.kind !== "terminal"
  );

  const applyDoc = useCallback(
    (next: PidDocument, merge = false) => {
      props.setDocument(next, { merge });
      props.onDirty();
    },
    [props]
  );

  const applyDocRef = useRef(applyDoc);
  applyDocRef.current = applyDoc;
  const docRef = useRef(doc);
  docRef.current = doc;
  dragNodesRef.current = dragNodes;
  dragEdgesRef.current = dragEdges;

  /** Always use the latest committed doc + any in-flight drag positions. */
  function liveNodes(): Node<PidNodeData>[] {
    return dragNodesRef.current ?? docRef.current.nodes;
  }

  function liveDoc(): PidDocument {
    return {
      ...docRef.current,
      nodes: liveNodes(),
      edges: dragEdgesRef.current ?? docRef.current.edges
    };
  }

  function commitLive(updater: (current: PidDocument) => PidDocument, merge = false) {
    const next = updater(liveDoc());
    dragNodesRef.current = null;
    dragEdgesRef.current = null;
    setDragNodes(null);
    setDragEdges(null);
    applyDocRef.current(next, merge);
  }

  const routeEdge = useCallback(
    (edge: Edge<PidEdgeData>, nodes: Node<PidNodeData>[], previousNodes?: Node<PidNodeData>[], reattachOnly = false) => {
      if (edge.data?.locked) return edge;
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      if (!source || !target) return edge;
      const start = portWorldPosition(source, edge.sourceHandle, symbolsRef.current, 100);
      const end = portWorldPosition(target, edge.targetHandle, symbolsRef.current, 0);

      // Manual routes, or live-drag / post-move reattach: keep the run shape with H/V stubs.
      if (edge.data?.routing === "manual" || reattachOnly || (edge.data?.waypoints?.length ?? 0) > 0) {
        const prevSource = previousNodes?.find((node) => node.id === edge.source);
        const prevTarget = previousNodes?.find((node) => node.id === edge.target);
        const previous =
          prevSource && prevTarget
            ? {
                source: portWorldPosition(prevSource, edge.sourceHandle, symbolsRef.current, 100),
                target: portWorldPosition(prevTarget, edge.targetHandle, symbolsRef.current, 0)
              }
            : undefined;
        const points = reattachOrthogonal(start, end, edge.data?.waypoints, previous);
        return {
          ...edge,
          data: {
            ...edge.data,
            // Reattach always becomes editable manual geometry (KiCad-style).
            routing: "manual" as const,
            waypoints: points.slice(1, -1)
          }
        };
      }

      const obstacles = symbolObstacles(nodes, [source.id, target.id]);
      const cls = lineClassById(docRef.current, edge.data?.lineClass);
      const step = Math.max(8, gridSizeInPixels(docRef.current.settings));
      const points = routeOrthogonal(start, end, obstacles, step, cls.clearance);
      return { ...edge, data: { ...edge.data, routing: "auto" as const, waypoints: points.slice(1, -1) } };
    },
    []
  );

  const routeTouched = useCallback(
    (next: PidDocument, movedNodeIds: string[], previousNodes?: Node<PidNodeData>[], reattachOnly = false) => {
      const moved = new Set(movedNodeIds);
      return {
        ...next,
        edges: next.edges.map((edge) => {
          if (!moved.has(edge.source) && !moved.has(edge.target)) return edge;
          return routeEdge(edge, next.nodes, previousNodes, reattachOnly);
        })
      };
    },
    [routeEdge]
  );

  // Stable type maps — recreating these remounts every node/edge and causes flicker.
  const nodeTypes = useMemo(
    () => ({
      pidSymbol: (nodeProps: NodeProps<PidNodeData>) => (
        <SymbolNode {...nodeProps} symbols={symbolsRef.current} />
      )
    }),
    []
  );

  const onSegmentCommitRef = useRef<
    (edgeId: string, oldPoints: Point[], newPoints: Point[], segmentIndex: number, merge?: boolean) => void
  >(() => undefined);

  const onSegmentCommit = useCallback(
    (edgeId: string, oldPoints: Point[], newPoints: Point[], segmentIndex: number, merge = false) => {
      // Always commit against the document edges — never a stale node-drag overlay.
      const current = {
        ...docRef.current,
        nodes: dragNodesRef.current ?? docRef.current.nodes
      };
      let nextEdges = current.edges.map((edge) => {
        if (edge.id !== edgeId) return edge;
        return {
          ...edge,
          data: {
            ...edge.data,
            routing: "manual" as const,
            waypoints: newPoints.slice(1, -1)
          }
        };
      });
      nextEdges = shoveEdges(nextEdges, edgeId, oldPoints, newPoints, segmentIndex);
      dragEdgesRef.current = null;
      setDragEdges(null);
      applyDocRef.current({ ...current, edges: nextEdges }, merge);
    },
    []
  );
  onSegmentCommitRef.current = onSegmentCommit;

  const edgeTypes = useMemo(
    () => ({
      pidLine: (edgeProps: EdgeProps<PidEdgeData>) => (
        <PidLine
          {...edgeProps}
          onSegmentCommit={(edgeId, oldPoints, newPoints, segmentIndex, merge) =>
            onSegmentCommitRef.current(edgeId, oldPoints, newPoints, segmentIndex, merge)
          }
        />
      )
    }),
    []
  );

  const rfNodes = useMemo(
    () =>
      displayNodes.map((node) => ({
        ...node,
        selected: selectedNodeIds.includes(node.id),
        draggable: !node.data.locked && mode === "select"
      })),
    [displayNodes, selectedNodeIds, mode]
  );

  const rfEdges = useMemo(
    () =>
      displayEdges
        .filter((edge) => !hiddenClassSet.has(edge.data?.lineClass as LineClassId))
        .map((edge) => ({
          ...edge,
          selected: selectedEdgeIds.includes(edge.id)
        })),
    [displayEdges, hiddenClassSet, selectedEdgeIds]
  );

  // Drop local drag overlay when the document catches up (undo/redo/load/drag-commit).
  useEffect(() => {
    dragNodesRef.current = null;
    dragEdgesRef.current = null;
    setDragNodes(null);
    setDragEdges(null);
  }, [doc]);

  function addSymbol(symbol: PidSymbolDefinition) {
    nodeCounter.current += 1;
    const id = `${symbol.id}-${nodeIdPrefix}-${nodeCounter.current}`;
    commitLive((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        {
          id,
          type: "pidSymbol",
          position: { x: 160 + current.nodes.length * 16, y: 120 + current.nodes.length * 12 },
          style: { height: 100, width: 100 },
          data: {
            label: symbol.name,
            rotation: 0,
            symbolType: symbol.id,
            kind: "symbol",
            ...(symbol.id === "off_page_from" ? { offPageSide: "from" as const } : {}),
            ...(symbol.id === "off_page_to" ? { offPageSide: "to" as const } : {})
          }
        }
      ]
    }));
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setMode("select");
  }

  function connect(connection: Connection) {
    if (!connection.source || !connection.target) return;
    commitLive((current) => {
      const { doc: withNet, net } = createNet(current, activeLineClass);
      const cls = lineClassById(withNet, activeLineClass);
      const edge: Edge<PidEdgeData> = {
        id: `line-${Date.now()}`,
        type: "pidLine",
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        label: net.tag,
        data: {
          ...net.props,
          color: cls.color,
          thickness: cls.thickness,
          routing: "auto",
          lineClass: activeLineClass,
          netId: net.id,
          tag: net.tag
        }
      };
      const routed = routeEdge(edge, withNet.nodes);
      setSelectedEdgeIds([edge.id]);
      setSelectedNodeIds([]);
      return { ...withNet, edges: [...withNet.edges, routed] };
    });
  }

  function deleteIds(nodeIds: string[], edgeIds: string[]) {
    const nodeSet = new Set(nodeIds);
    const edgeSet = new Set(edgeIds);
    commitLive((current) =>
      cleanupJunctions({
        ...current,
        nodes: current.nodes.filter((node) => !nodeSet.has(node.id) || node.data.locked),
        edges: current.edges.filter(
          (edge) => !edgeSet.has(edge.id) && !nodeSet.has(edge.source) && !nodeSet.has(edge.target) && !edge.data?.locked
        ),
        junctions: current.junctions.filter((j) => !nodeSet.has(j.id))
      })
    );
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setContextMenu(null);
  }

  function deleteSelection() {
    deleteIds(selectedNodeIds, selectedEdgeIds);
  }

  function mintUniqueEdgeCopies(
    current: PidDocument,
    edges: Edge<PidEdgeData>[]
  ): { nets: PidDocument["nets"]; edges: Edge<PidEdgeData>[] } {
    let nets = [...current.nets];
    const minted: Edge<PidEdgeData>[] = [];
    for (const edge of edges) {
      const lineClass = edge.data?.lineClass ?? "process";
      const scratch = { nets, edges: [...current.edges, ...minted] };
      const tag = nextLineTag(scratch, lineClass);
      const netId = `net-${Date.now()}-${Math.floor(Math.random() * 10000)}-${minted.length}`;
      nets = [
        ...nets,
        {
          id: netId,
          tag,
          lineClass,
          props: {
            fluid: edge.data?.fluid ?? "TBD",
            pressure_bar: edge.data?.pressure_bar ?? null,
            temperature_c: edge.data?.temperature_c ?? null,
            diameter_mm: edge.data?.diameter_mm ?? null,
            material: edge.data?.material ?? "",
            flow_direction: edge.data?.flow_direction ?? "forward"
          }
        }
      ];
      minted.push({
        ...edge,
        label: tag,
        data: { ...edge.data, netId, tag, routing: edge.data?.routing ?? "manual" }
      });
    }
    return { nets, edges: minted };
  }

  function duplicateSelection() {
    const nodeSet = new Set(selectedNodeIds.filter((id) => liveNodes().find((n) => n.id === id)?.data.kind !== "junction"));
    if (!nodeSet.size) return;
    commitLive((current) => {
      const idMap = new Map<string, string>();
      const newNodes = current.nodes
        .filter((n) => nodeSet.has(n.id))
        .map((node) => {
          nodeCounter.current += 1;
          const id = `${node.data.symbolType}-${nodeIdPrefix}-dup-${nodeCounter.current}`;
          idMap.set(node.id, id);
          return {
            ...node,
            id,
            position: { x: node.position.x + 32, y: node.position.y + 32 },
            selected: true
          };
        });
      const clonedEdges = current.edges
        .filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target))
        .map((edge) => ({
          ...edge,
          id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: idMap.get(edge.source)!,
          target: idMap.get(edge.target)!
        }));
      const { nets, edges: newEdges } = mintUniqueEdgeCopies(current, clonedEdges);
      setSelectedNodeIds(newNodes.map((n) => n.id));
      setSelectedEdgeIds(newEdges.map((edge) => edge.id));
      return {
        ...current,
        nets,
        nodes: [...current.nodes.map((n) => ({ ...n, selected: false })), ...newNodes],
        edges: [...current.edges, ...newEdges]
      };
    });
  }

  function copySelection() {
    const nodeSet = new Set(selectedNodeIds);
    setClipboard({
      nodes: doc.nodes.filter((n) => nodeSet.has(n.id) && n.data.kind !== "junction"),
      edges: doc.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
    });
  }

  function pasteClipboard() {
    if (!clipboard?.nodes.length) return;
    const idMap = new Map<string, string>();
    const newNodes = clipboard.nodes.map((node) => {
      nodeCounter.current += 1;
      const id = `${node.data.symbolType}-${nodeIdPrefix}-paste-${nodeCounter.current}`;
      idMap.set(node.id, id);
      return { ...node, id, position: { x: node.position.x + 48, y: node.position.y + 48 } };
    });
    const clonedEdges = clipboard.edges.map((edge) => ({
      ...edge,
      id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!
    }));
    const { nets, edges: newEdges } = mintUniqueEdgeCopies(doc, clonedEdges);
    applyDoc({ ...doc, nets, nodes: [...doc.nodes, ...newNodes], edges: [...doc.edges, ...newEdges] });
    setSelectedNodeIds(newNodes.map((n) => n.id));
    setSelectedEdgeIds(newEdges.map((edge) => edge.id));
  }

  function updateEdgeById(edgeId: string, patch: Partial<PidEdgeData>, base?: PidDocument) {
    const source = base ?? doc;
    const target = source.edges.find((edge) => edge.id === edgeId);
    if (!target) return base ?? undefined;
    const netId = target.data?.netId;
    const resolvedPatch = { ...patch };
    if (patch.tag !== undefined) {
      resolvedPatch.tag = ensureUniqueTag(
        source,
        String(patch.tag),
        patch.lineClass ?? target.data?.lineClass ?? "process",
        netId ? [netId] : []
      );
    }
    let edges = source.edges.map((edge) =>
      edge.id === edgeId || (netId && edge.data?.netId === netId)
        ? {
            ...edge,
            label: resolvedPatch.tag ?? edge.label,
            data: {
              ...edge.data,
              ...resolvedPatch,
              color: resolvedPatch.lineClass
                ? lineClassById(source, resolvedPatch.lineClass).color
                : resolvedPatch.color ?? edge.data?.color,
              thickness: resolvedPatch.lineClass
                ? lineClassById(source, resolvedPatch.lineClass).thickness
                : resolvedPatch.thickness ?? edge.data?.thickness
            }
          }
        : edge
    );
    let nets = source.nets;
    if (netId) {
      nets = source.nets.map((net) =>
        net.id === netId
          ? {
              ...net,
              tag: resolvedPatch.tag ?? net.tag,
              lineClass: resolvedPatch.lineClass ?? net.lineClass,
              props: {
                fluid: resolvedPatch.fluid ?? net.props.fluid,
                pressure_bar:
                  resolvedPatch.pressure_bar !== undefined ? resolvedPatch.pressure_bar : net.props.pressure_bar,
                temperature_c:
                  resolvedPatch.temperature_c !== undefined ? resolvedPatch.temperature_c : net.props.temperature_c,
                diameter_mm: resolvedPatch.diameter_mm !== undefined ? resolvedPatch.diameter_mm : net.props.diameter_mm,
                material: resolvedPatch.material ?? net.props.material,
                flow_direction: resolvedPatch.flow_direction ?? net.props.flow_direction
              }
            }
          : net
      );
      if (resolvedPatch.tag || resolvedPatch.fluid !== undefined) {
        edges = applyNetPropsToEdges(edges, netId, resolvedPatch);
      }
    }
    if (base) return { ...source, edges, nets };
    applyDoc({ ...source, edges, nets });
    return undefined;
  }

  function updateEdgesByIds(edgeIds: string[], patch: Partial<PidEdgeData>) {
    if (!edgeIds.length) return;
    let next = doc;
    for (const edgeId of edgeIds) {
      const updated = updateEdgeById(edgeId, patch, next);
      if (updated) next = updated;
    }
    if (next !== doc) applyDoc(next);
  }

  function updateSelectedEdge(patch: Partial<PidEdgeData>) {
    if (!selectedEdgeIds.length) return;
    updateEdgesByIds(selectedEdgeIds, patch);
  }

  function updateSelectedNode(patch: Partial<PidNodeData>) {
    if (!selectedNode) return;
    if (patch.rotation !== undefined || patch.mirrorX !== undefined || patch.mirrorY !== undefined) {
      const previous = doc.nodes;
      const nodes = doc.nodes.map((node) =>
        node.id === selectedNode.id ? { ...node, data: { ...node.data, ...patch } } : node
      );
      let next = { ...doc, nodes };
      next = routeTouched(next, [selectedNode.id], previous, true);
      applyDoc(next);
      return;
    }
    applyDoc({
      ...doc,
      nodes: doc.nodes.map((node) => (node.id === selectedNode.id ? { ...node, data: { ...node.data, ...patch } } : node))
    });
  }

  function rotateSelected(delta: 90 | -90) {
    if (!selectedNode) return;
    const rot = selectedNode.data.rotation ?? 0;
    updateSelectedNode({ rotation: ((rot + delta) % 360 + 360) % 360 });
  }

  function sharedEdgeValue<K extends keyof PidEdgeData>(key: K): PidEdgeData[K] | "" | undefined {
    if (!selectedEdges.length) return undefined;
    const first = selectedEdges[0].data?.[key];
    return selectedEdges.every((edge) => edge.data?.[key] === first) ? (first ?? "") : "";
  }

  function applyPositionDrags(
    base: Node<PidNodeData>[],
    positionDrags: Array<{ id: string; position: Point }>,
    selectedIds: string[]
  ): { nodes: Node<PidNodeData>[]; movedIds: string[] } {
    const selectedSet = new Set(selectedIds);
    const isGroupDrag = selectedIds.length > 1 && positionDrags.some((change) => selectedSet.has(change.id));
    const dragIds = new Set(positionDrags.map((change) => change.id));
    const anchorChange = positionDrags.find((change) => selectedSet.has(change.id));
    let dx = 0;
    let dy = 0;
    if (isGroupDrag && anchorChange) {
      const anchorBase = base.find((node) => node.id === anchorChange.id);
      if (anchorBase) {
        dx = anchorChange.position.x - anchorBase.position.x;
        dy = anchorChange.position.y - anchorBase.position.y;
      }
    }

    const movedIds = new Set<string>();
    const nodes = base.map((node) => {
      const change = positionDrags.find((item) => item.id === node.id);
      if (change && !node.data.locked) {
        movedIds.add(node.id);
        return { ...node, position: change.position };
      }
      if (isGroupDrag && selectedSet.has(node.id) && !node.data.locked && !dragIds.has(node.id) && (dx !== 0 || dy !== 0)) {
        movedIds.add(node.id);
        return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } };
      }
      return node;
    });

    return { nodes, movedIds: [...movedIds] };
  }

  function applyAlign(mode: AlignMode) {
    const ids = selectedNodeIds.filter((id) => {
      const node = liveNodes().find((item) => item.id === id);
      return node && !node.data.locked;
    });
    if (ids.length < 2) return;
    commitLive((current) => {
      const nodes = alignNodes(current.nodes, ids, mode);
      return routeTouched({ ...current, nodes }, ids, current.nodes);
    });
  }

  function applyDistribute(axis: DistributeAxis) {
    const ids = selectedNodeIds.filter((id) => {
      const node = liveNodes().find((item) => item.id === id);
      return node && !node.data.locked;
    });
    if (ids.length < 3) return;
    commitLive((current) => {
      const nodes = distributeNodes(current.nodes, ids, axis);
      return routeTouched({ ...current, nodes }, ids, current.nodes);
    });
  }

  function arraySelection() {
    const cols = Number(window.prompt("Array columns?", "2"));
    if (!Number.isFinite(cols) || cols < 1) return;
    const rows = Number(window.prompt("Array rows?", "2"));
    if (!Number.isFinite(rows) || rows < 1) return;
    const gap = Number(window.prompt("Gap between copies (px)?", "64"));
    if (!Number.isFinite(gap) || gap < 0) return;
    const ids = selectedNodeIds.filter((id) => liveNodes().find((n) => n.id === id)?.data.kind !== "junction");
    if (!ids.length) return;
    commitLive((current) => {
      const { nodes: newNodes, edges: clonedEdges } = arrayDuplicateSelection(current.nodes, current.edges, ids, {
        columns: cols,
        rows,
        gapX: gap,
        gapY: gap,
        idFactory: () => {
          nodeCounter.current += 1;
          return `${nodeIdPrefix}-array-${nodeCounter.current}`;
        }
      });
      const { nets, edges: newEdges } = mintUniqueEdgeCopies(current, clonedEdges);
      setSelectedNodeIds(newNodes.map((node) => node.id));
      setSelectedEdgeIds(newEdges.map((edge) => edge.id));
      return { ...current, nets, nodes: [...current.nodes, ...newNodes], edges: [...current.edges, ...newEdges] };
    });
  }

  function retagNets() {
    commitLive((current) => {
      let netsAcc = [...current.nets];
      const retagged: Record<string, string> = {};
      netsAcc = current.nets.map((net) => {
        if (net.tag && net.tag !== "LINE") return net;
        const tag = nextLineTag({ nets: netsAcc.filter((item) => item.id !== net.id), edges: current.edges }, net.lineClass);
        retagged[net.id] = tag;
        const updated = { ...net, tag };
        netsAcc = netsAcc.map((item) => (item.id === net.id ? updated : item));
        return updated;
      });
      const edges = current.edges.map((edge) => {
        const netId = edge.data?.netId;
        const tag = netId ? retagged[netId] : undefined;
        if (!tag) return edge;
        return { ...edge, label: tag, data: { ...edge.data, tag } };
      });
      return { ...current, nets: netsAcc, edges };
    });
  }

  function exportSvg() {
    downloadSvg(documentToSvg(liveDoc(), props.diagramName), props.diagramName || "diagram");
  }

  function printDiagram() {
    printSvg(documentToSvg(liveDoc(), props.diagramName), props.diagramName);
  }

  function toggleLineClassVisibility(lineClass: LineClassId) {
    commitLive((current) => {
      const hidden = new Set(current.settings.hiddenLineClasses ?? []);
      if (hidden.has(lineClass)) hidden.delete(lineClass);
      else hidden.add(lineClass);
      return { ...current, settings: { ...current.settings, hiddenLineClasses: [...hidden] } };
    });
  }

  function focusDrcIssue(issue: DrcIssue) {
    if (issue.nodeIds?.length) {
      setSelectedNodeIds(issue.nodeIds);
      setSelectedEdgeIds([]);
      const nodes = getNodes().filter((node) => issue.nodeIds!.includes(node.id));
      fitView(nodes.length ? { nodes, padding: 0.3, duration: 300 } : { padding: 0.3, duration: 300 });
      return;
    }
    if (issue.edgeIds?.length) {
      setSelectedEdgeIds(issue.edgeIds);
      setSelectedNodeIds([]);
      const nodeIds = new Set<string>();
      for (const edgeId of issue.edgeIds) {
        const edge = doc.edges.find((item) => item.id === edgeId);
        if (edge) {
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
      const nodes = getNodes().filter((node) => nodeIds.has(node.id));
      fitView(nodes.length ? { nodes, padding: 0.3, duration: 300 } : { padding: 0.3, duration: 300 });
    }
  }

  function onNodesChange(changes: NodeChange[]) {
    const positionDrags = changes.filter(
      (change): change is NodeChange & { type: "position"; position: { x: number; y: number }; dragging?: boolean } =>
        change.type === "position" && Boolean(change.position)
    );

    // Live drag: update local positions + reattach connected routes (no history).
    if (positionDrags.some((change) => change.dragging)) {
      const previousNodes = docRef.current.nodes;
      const base = dragNodesRef.current ?? previousNodes;
      const dragPayload = positionDrags.map((change) => ({ id: change.id, position: change.position }));
      const { nodes: nextNodes, movedIds } = applyPositionDrags(base, dragPayload, selectedNodeIds);
      const routed = routeTouched({ ...docRef.current, nodes: nextNodes }, movedIds, previousNodes, true);
      dragNodesRef.current = nextNodes;
      dragEdgesRef.current = routed.edges;
      setDragNodes(nextNodes);
      setDragEdges(routed.edges);
      return;
    }

    // Drag finished — commit from ref (avoids stale closure wiping positions).
    if (positionDrags.some((change) => change.dragging === false)) {
      const previousNodes = docRef.current.nodes;
      const base = dragNodesRef.current ?? previousNodes;
      const dragPayload = positionDrags.map((change) => ({ id: change.id, position: change.position }));
      const { nodes, movedIds } = applyPositionDrags(base, dragPayload, selectedNodeIds);
      if (!movedIds.length) {
        dragNodesRef.current = null;
        dragEdgesRef.current = null;
        setDragNodes(null);
        setDragEdges(null);
        return;
      }
      const current = { ...docRef.current, nodes, edges: dragEdgesRef.current ?? docRef.current.edges };
      // Always reattach (never full A*) so segment edits stay and remain editable.
      const next = routeTouched(current, movedIds, previousNodes, true);
      const junctions = next.junctions.map((junction) => {
        const node = next.nodes.find((item) => item.id === junction.id);
        return node ? { ...junction, position: { x: node.position.x + 6, y: node.position.y + 6 } } : junction;
      });
      dragNodesRef.current = null;
      dragEdgesRef.current = null;
      setDragNodes(null);
      setDragEdges(null);
      applyDocRef.current({ ...next, junctions }, false);
      return;
    }

    // Dimensions / remove
    let nodes = liveNodes();
    let dirty = false;
    for (const change of changes) {
      if (change.type === "remove") {
        nodes = nodes.filter((node) => node.id !== change.id);
        dirty = true;
      } else if (change.type === "dimensions" && change.dimensions) {
        nodes = nodes.map((node) =>
          node.id === change.id ? { ...node, width: change.dimensions!.width, height: change.dimensions!.height } : node
        );
        dirty = true;
      }
    }
    if (dirty) commitLive((current) => cleanupJunctions({ ...current, nodes }), false);
  }

  function canvasLocalPoint(clientX: number, clientY: number) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return { x: clientX, y: clientY };
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }

  function finishMarquee(
    start: { x: number; y: number },
    current: { x: number; y: number },
    additive: boolean
  ) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const size = clientRect(start, current);
    if (size.width < 4 && size.height < 4) return;

    suppressContextMenuRef.current = true;
    const flowA = screenToFlowPosition({ x: start.x + bounds.left, y: start.y + bounds.top });
    const flowB = screenToFlowPosition({ x: current.x + bounds.left, y: current.y + bounds.top });
    const flowRect = clientRect(flowA, flowB);
    const nodeIds = nodesInMarquee(liveNodes(), flowRect);
    const edgeIds = edgesInMarquee(liveDoc().edges, liveNodes(), symbolsRef.current, flowRect);

    if (additive) {
      setSelectedNodeIds((currentIds) => Array.from(new Set([...currentIds, ...nodeIds])));
      setSelectedEdgeIds((currentIds) => Array.from(new Set([...currentIds, ...edgeIds])));
    } else {
      setSelectedNodeIds(nodeIds);
      setSelectedEdgeIds(edgeIds);
    }
    setContextMenu(null);
  }

  function onCanvasPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (mode !== "select" || event.button !== 2) return;
    const target = event.target as Element | null;
    if (target?.closest(".react-flow__node, .react-flow__edge, .pidContextMenu, .pidSegmentHandle, .react-flow__controls, .react-flow__minimap")) {
      return;
    }

    event.preventDefault();
    const start = canvasLocalPoint(event.clientX, event.clientY);
    const next = { start, current: start, additive: event.ctrlKey || event.metaKey };
    marqueeActiveRef.current = true;
    marqueeRef.current = next;
    suppressContextMenuRef.current = false;
    setMarquee(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerMove(event: React.PointerEvent<HTMLElement>) {
    if (!marqueeActiveRef.current || !marqueeRef.current) return;
    const current = canvasLocalPoint(event.clientX, event.clientY);
    const next = { ...marqueeRef.current, current };
    marqueeRef.current = next;
    setMarquee(next);
  }

  function onCanvasPointerUp(event: React.PointerEvent<HTMLElement>) {
    if (!marqueeActiveRef.current) return;
    marqueeActiveRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const active = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (active) finishMarquee(active.start, active.current, active.additive);
  }

  function onCanvasContextMenu(event: React.MouseEvent<HTMLElement>) {
    if (suppressContextMenuRef.current) {
      event.preventDefault();
      suppressContextMenuRef.current = false;
      return;
    }
    event.preventDefault();
  }

  function beginRouteFromPort(nodeId: string, portId: string) {
    const node = displayNodes.find((n) => n.id === nodeId);
    if (!node) return;
    const start = portWorldPosition(node, portId, symbols, 50);
    setRouteDraft({ from: { nodeId, portId }, committed: [start], preview: [start] });
    setMode("route");
  }

  function resolveRouteCursor(clientX: number, clientY: number): Point {
    const raw = screenToFlowPosition({ x: clientX, y: clientY });
    let cursor = doc.settings.snapToGrid ? snapPoint(raw, gridPixels) : raw;
    const magnets: Point[] = [];
    for (const node of displayNodes) {
      if (routeDraft && node.id === routeDraft.from.nodeId) continue;
      if (node.data.kind === "junction" || node.data.kind === "terminal") {
        const size = nodeSize(node);
        magnets.push({ x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 });
        continue;
      }
      const def = symbols.find((s) => s.id === node.data.symbolType);
      for (const port of def?.ports ?? []) {
        magnets.push(portWorldPosition(node, port.id, symbols, 50));
      }
    }
    for (const edge of displayEdges) {
      for (const point of edge.data?.waypoints ?? []) {
        magnets.push(point);
      }
    }
    return snapToMagnets(cursor, magnets, 14);
  }

  function startRouteAtCursor(cursor: Point) {
    const hit = nearestPortAt(displayNodes, symbols, cursor, 28);
    if (hit) {
      beginRouteFromPort(hit.nodeId, hit.portId);
      return;
    }
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    commitLive((current) => ({
      ...current,
      nodes: [...current.nodes, makeTerminalNode(id, cursor)]
    }));
    setRouteDraft({ from: { nodeId: id, portId: "center" }, committed: [cursor], preview: [cursor] });
    setMode("route");
  }

  function finishRouteTo(targetNodeId: string, targetPortId: string, endPoint: Point) {
    if (!routeDraft) return;
    const points = interactiveWalk(routeDraft.committed, endPoint, doc.settings.routeMode);
    const draft = routeDraft;
    commitLive((current) => {
      const { doc: withNet, net } = createNet(current, activeLineClass);
      const cls = lineClassById(withNet, activeLineClass);
      const edge: Edge<PidEdgeData> = {
        id: `line-${Date.now()}`,
        type: "pidLine",
        source: draft.from.nodeId,
        target: targetNodeId,
        sourceHandle: draft.from.portId,
        targetHandle: targetPortId,
        label: net.tag,
        data: {
          ...net.props,
          color: cls.color,
          thickness: cls.thickness,
          routing: "manual",
          lineClass: activeLineClass,
          netId: net.id,
          tag: net.tag,
          waypoints: points.slice(1, -1)
        }
      };
      setSelectedEdgeIds([edge.id]);
      return { ...withNet, edges: [...withNet.edges, edge] };
    });
    setRouteDraft(null);
    setMode("select");
  }

  function finishRouteOnCanvas(cursor: Point) {
    if (!routeDraft) return;
    const lastPreview = routeDraft.preview.at(-1);
    const endPoint =
      lastPreview && Math.hypot(lastPreview.x - cursor.x, lastPreview.y - cursor.y) < 20 ? lastPreview : cursor;
    const points = interactiveWalk(routeDraft.committed, endPoint, doc.settings.routeMode);
    const draft = routeDraft;
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    commitLive((current) => {
      const { doc: withNet, net } = createNet(current, activeLineClass);
      const cls = lineClassById(withNet, activeLineClass);
      const terminal = makeTerminalNode(termId, endPoint);
      const edge: Edge<PidEdgeData> = {
        id: `line-${Date.now()}`,
        type: "pidLine",
        source: draft.from.nodeId,
        target: termId,
        sourceHandle: draft.from.portId,
        targetHandle: "center",
        label: net.tag,
        data: {
          ...net.props,
          color: cls.color,
          thickness: cls.thickness,
          routing: "manual",
          lineClass: activeLineClass,
          netId: net.id,
          tag: net.tag,
          waypoints: points.slice(1, -1)
        }
      };
      setSelectedEdgeIds([edge.id]);
      return { ...withNet, nodes: [...withNet.nodes, terminal], edges: [...withNet.edges, edge] };
    });
    setRouteDraft(null);
    setMode("select");
  }

  function handlePaneClick(event: React.MouseEvent) {
    setContextMenu(null);
    if (mode !== "route") {
      if (!event.ctrlKey && !event.metaKey) {
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
      }
      return;
    }

    const cursor = resolveRouteCursor(event.clientX, event.clientY);

    if (!routeDraft) {
      startRouteAtCursor(cursor);
      return;
    }

    const hit = hitTestEdge(
      doc.edges,
      (edge) => {
        const source = displayNodes.find((n) => n.id === edge.source);
        const target = displayNodes.find((n) => n.id === edge.target);
        if (!source || !target) return [];
        return resolveWaypoints(
          portWorldPosition(source, edge.sourceHandle, symbols, 100),
          portWorldPosition(target, edge.targetHandle, symbols, 0),
          edge.data?.waypoints
        );
      },
      cursor,
      12
    );

    if (hit && hit.edge.source !== routeDraft.from.nodeId) {
      const preview = interactiveWalk(routeDraft.committed, hit.point, doc.settings.routeMode);
      commitLive((current) => cleanupJunctions(teeOntoEdge(current, hit.edge.id, hit.point, routeDraft.from, preview)));
      setRouteDraft(null);
      setMode("select");
      return;
    }

    const portHit = nearestPortAt(
      displayNodes.filter((n) => n.id !== routeDraft.from.nodeId),
      symbols,
      cursor,
      28
    );
    if (portHit) {
      finishRouteTo(portHit.nodeId, portHit.portId, portHit.point);
      return;
    }

    if (event.detail === 2 || event.shiftKey) {
      finishRouteOnCanvas(cursor);
      return;
    }

    const nextCommitted = interactiveWalk(routeDraft.committed, cursor, doc.settings.routeMode);
    setRouteDraft({ ...routeDraft, committed: nextCommitted, preview: nextCommitted });
  }

  function handlePaneMouseMove(event: React.MouseEvent) {
    if (!routeDraft) return;
    const cursor = resolveRouteCursor(event.clientX, event.clientY);
    setRouteDraft({
      ...routeDraft,
      preview: interactiveWalk(routeDraft.committed, cursor, doc.settings.routeMode)
    });
  }

  function runChecks() {
    const issues = runDrc(doc);
    setDrcIssues(issues);
    setShowDrc(true);
  }

  function routeAllAuto() {
    commitLive((current) => ({
      ...current,
      edges: current.edges.map((edge) => {
        if (edge.data?.locked) return edge;
        return routeEdge({ ...edge, data: { ...edge.data, routing: "auto" } }, current.nodes);
      })
    }));
  }

  function routeSelected() {
    if (!selectedEdgeIds.length) return;
    const set = new Set(selectedEdgeIds);
    commitLive((current) => ({
      ...current,
      edges: current.edges.map((edge) => {
        if (!set.has(edge.id) || edge.data?.locked) return edge;
        return routeEdge({ ...edge, data: { ...edge.data, routing: "auto" } }, current.nodes);
      })
    }));
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        if (props.selectedDiagram && props.graphDirty) props.onSave();
      } else if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) props.onRedo();
        else props.onUndo();
      } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        props.onRedo();
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "d") {
        event.preventDefault();
        arraySelection();
      } else if ((event.ctrlKey || event.metaKey) && key === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if ((event.ctrlKey || event.metaKey) && key === "a") {
        event.preventDefault();
        setSelectedNodeIds(doc.nodes.filter((node) => node.data.kind !== "junction").map((node) => node.id));
        setSelectedEdgeIds([]);
      } else if ((event.ctrlKey || event.metaKey) && key === "e") {
        event.preventDefault();
        exportSvg();
      } else if ((event.ctrlKey || event.metaKey) && key === "p") {
        event.preventDefault();
        printDiagram();
      } else if ((event.ctrlKey || event.metaKey) && key === "c") {
        event.preventDefault();
        copySelection();
      } else if ((event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault();
        pasteClipboard();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if (event.key === "Escape") {
        if (routeDraft) {
          const fromId = routeDraft.from.nodeId;
          const fromNode = doc.nodes.find((n) => n.id === fromId);
          const hasEdge = doc.edges.some((e) => e.source === fromId || e.target === fromId);
          if (fromNode?.data.kind === "terminal" && !hasEdge) {
            commitLive((current) => ({
              ...current,
              nodes: current.nodes.filter((n) => n.id !== fromId)
            }));
          }
          setRouteDraft(null);
        } else {
          setSelectedNodeIds([]);
          setSelectedEdgeIds([]);
          setContextMenu(null);
          setMode("select");
        }
      } else if (event.key === "Enter" && routeDraft) {
        event.preventDefault();
        const last = routeDraft.preview.at(-1);
        if (last) finishRouteOnCanvas(last);
      } else if (event.key === "?" || event.key === "F1") {
        event.preventDefault();
        setShowShortcuts((current) => !current);
      } else if (key === "r" && !event.ctrlKey) {
        setMode("route");
        if (selectedNodeIds.length && !routeDraft) {
          const node = liveNodes().find((n) => n.id === selectedNodeIds[0]);
          if (node) {
            const size = nodeSize(node);
            const center = { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
            const hit = nearestPortAt([node], symbolsRef.current, center, 999);
            if (hit) beginRouteFromPort(hit.nodeId, hit.portId);
            else if (node.data.kind === "terminal" || node.data.kind === "junction") {
              beginRouteFromPort(node.id, "center");
            } else {
              const def = symbolsRef.current.find((s) => s.id === node.data.symbolType);
              if (def?.ports[0]) beginRouteFromPort(node.id, def.ports[0].id);
            }
          }
        }
      } else if (key === "v" && !event.ctrlKey) {
        setRouteDraft(null);
        setMode("select");
      } else if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
        selectedNodeIds.length > 0
      ) {
        event.preventDefault();
        const step = event.shiftKey ? gridPixels * 4 : doc.settings.snapToGrid ? gridPixels : 8;
        const delta =
          event.key === "ArrowLeft"
            ? { x: -step, y: 0 }
            : event.key === "ArrowRight"
              ? { x: step, y: 0 }
              : event.key === "ArrowUp"
                ? { x: 0, y: -step }
                : { x: 0, y: step };
        const ids = selectedNodeIds.filter((id) => {
          const node = liveNodes().find((item) => item.id === id);
          return node && !node.data.locked;
        });
        if (!ids.length) return;
        commitLive((current) => {
          const nodes = nudgeNodes(current.nodes, ids, delta);
          return routeTouched({ ...current, nodes }, ids, current.nodes);
        });
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });

  const categories = useMemo(() => {
    const map = new Map<string, PidSymbolDefinition[]>();
    for (const symbol of symbols.filter((s) => s.id !== "junction")) {
      const cat = symbol.category ?? "other";
      const list = map.get(cat) ?? [];
      list.push(symbol);
      map.set(cat, list);
    }
    return [...map.entries()];
  }, [symbols]);

  return (
    <div className="pidEditor">
      <header className="pidCommandBar">
        <div className="pidToolbarSection pidDocSection">
          <input aria-label="Diagram name" className="pidTitleInput" onChange={(event) => props.setDiagramName(event.target.value)} value={props.diagramName} />
          <select aria-label="Open diagram" className="pidCompactSelect" onChange={(event) => props.setSelectedDiagramId(event.target.value)} value={props.selectedDiagramId}>
            <option value="">No diagram</option>
            {props.diagrams.map((diagram) => (
              <option key={diagram.id} value={diagram.id}>
                {diagram.name} · r{diagram.revision}
              </option>
            ))}
          </select>
          <div className={`pidSaveState ${props.graphDirty ? "dirty" : ""}`}>
            <i />
            {props.graphDirty ? "Unsaved" : "Saved"}
          </div>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="File">
          <button disabled={props.busy || !props.selectedDiagramId || !props.graphDirty} onClick={props.onSave} type="button">
            Save
          </button>
          <button className="secondary" disabled={props.busy || !props.diagramName} onClick={props.onCreateDiagram} type="button">
            New
          </button>
          <button className="secondary" disabled={props.busy || !props.selectedDiagram} onClick={props.onRenameDiagram} type="button">
            Rename
          </button>
          <button className="secondary dangerGhost" disabled={props.busy || !props.selectedDiagram} onClick={props.onDeleteDiagram} type="button">
            Del
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Edit">
          <button className="secondary" disabled={!canUndo(props.history)} onClick={props.onUndo} type="button">
            Undo
          </button>
          <button className="secondary" disabled={!canRedo(props.history)} onClick={props.onRedo} type="button">
            Redo
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection pidModes" title="Tools">
          <button
            className={mode === "select" ? "active" : "secondary"}
            onClick={() => {
              setRouteDraft(null);
              setMode("select");
            }}
            type="button"
          >
            Select
          </button>
          <button className={mode === "route" ? "active" : "secondary"} onClick={() => setMode("route")} title="Interactive orthogonal router (R)" type="button">
            Route
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Routing">
          <button className="secondary" onClick={routeSelected} type="button">
            Route sel
          </button>
          <button className="secondary" onClick={routeAllAuto} type="button">
            Route all
          </button>
          <button className="secondary" onClick={runChecks} type="button">
            DRC
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Align">
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("left")} title="Align left" type="button">
            L
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("centerX")} title="Align center" type="button">
            C
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("right")} title="Align right" type="button">
            R
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("top")} title="Align top" type="button">
            T
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("centerY")} title="Align middle" type="button">
            M
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 2} onClick={() => applyAlign("bottom")} title="Align bottom" type="button">
            B
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 3} onClick={() => applyDistribute("horizontal")} title="Distribute horizontally" type="button">
            Dist H
          </button>
          <button className="secondary" disabled={selectedNodeIds.length < 3} onClick={() => applyDistribute("vertical")} title="Distribute vertically" type="button">
            Dist V
          </button>
          <button className="secondary" disabled={!selectedNodeIds.length} onClick={arraySelection} title="Array duplicate (Ctrl+Shift+D)" type="button">
            Array
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Export">
          <button className="secondary" onClick={exportSvg} title="Export SVG (Ctrl+E)" type="button">
            SVG
          </button>
          <button className="secondary" onClick={printDiagram} title="Print / PDF (Ctrl+P)" type="button">
            Print
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Library">
          <button className="secondary" onClick={() => setEditingSymbol("new")} type="button">
            Symbol
          </button>
          <button className="secondary" onClick={() => fitView({ padding: 0.15 })} type="button">
            Fit
          </button>
        </div>

        <div className="pidToolbarDivider" />

        <div className="pidToolbarSection" title="Canvas grid">
          <button
            className={doc.settings.gridVisible ? "active" : "secondary"}
            onClick={() =>
              commitLive((current) => ({
                ...current,
                settings: { ...current.settings, gridVisible: !current.settings.gridVisible }
              }))
            }
            title="Toggle background grid"
            type="button"
          >
            Grid
          </button>
          <select
            aria-label="Grid style"
            className="pidCompactSelect"
            disabled={!doc.settings.gridVisible}
            onChange={(event) =>
              commitLive((current) => ({
                ...current,
                settings: {
                  ...current.settings,
                  gridVisible: true,
                  gridVariant: event.target.value as GridVariant
                }
              }))
            }
            title="Grid style"
            value={doc.settings.gridVariant ?? "dots"}
          >
            <option value="dots">Points</option>
            <option value="lines">Lines</option>
            <option value="cross">Cross</option>
          </select>
        </div>
      </header>

      <div className="pidEditorBody">
        <aside className="pidPalette">
          <div className="pidPanelTitle">
            <span>Library</span>
            <small>{symbols.length - 1}</small>
          </div>
          <div className="pidLineClassList">
            <span className="pidSectionLabel">Line class</span>
            {doc.lineClasses.map((cls) => (
              <button
                className={`pidLineClassBtn ${activeLineClass === cls.id ? "active" : ""} ${hiddenClassSet.has(cls.id) ? "isHidden" : ""}`}
                key={cls.id}
                onClick={() => setActiveLineClass(cls.id)}
                style={{ borderLeftColor: cls.color }}
                type="button"
              >
                {cls.name}
              </button>
            ))}
          </div>
          {categories.map(([category, items]) => (
            <div key={category}>
              <span className="pidSectionLabel">{category}</span>
              <div className="pidSymbolList">
                {items.map((symbol) => (
                  <div className="pidPaletteItem" key={symbol.id}>
                    <button onClick={() => addSymbol(symbol)} title={`Place ${symbol.name}`} type="button">
                      <SymbolArtwork symbol={symbol} />
                      <span>{symbol.name}</span>
                    </button>
                    {!symbol.builtIn && (
                      <button className="pidEditSymbol" onClick={() => setEditingSymbol(symbol)} title="Edit symbol" type="button">
                        •••
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </aside>

        <main
          className="pidCanvas"
          onContextMenu={onCanvasContextMenu}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          ref={canvasRef}
        >
          <ReactFlow
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: "pidLine", interactionWidth: 24 }}
            edges={rfEdges}
            edgeTypes={edgeTypes}
            minZoom={0.15}
            multiSelectionKeyCode="Control"
            nodeTypes={nodeTypes}
            nodes={rfNodes}
            onConnect={mode === "select" ? connect : undefined}
            onEdgeClick={(event, edge) => {
              if (event.ctrlKey || event.metaKey) {
                setSelectedEdgeIds((current) =>
                  current.includes(edge.id) ? current.filter((id) => id !== edge.id) : [...current, edge.id]
                );
              } else {
                setSelectedEdgeIds([edge.id]);
              }
              setSelectedNodeIds([]);
            }}
            onEdgeDoubleClick={(_, edge) => {
              setSelectedEdgeIds([edge.id]);
              setSelectedNodeIds([]);
              const next = window.prompt("Line tag", String(edge.data?.tag ?? edge.label ?? ""));
              if (next == null) return;
              updateEdgeById(edge.id, { tag: next });
            }}
            onEdgeContextMenu={(event, edge) => {
              if (suppressContextMenuRef.current) {
                event.preventDefault();
                return;
              }
              event.preventDefault();
              setSelectedEdgeIds([edge.id]);
              setSelectedNodeIds([]);
              setContextMenu({ kind: "edge", edgeId: edge.id, x: event.clientX, y: event.clientY });
            }}
            onEdgesChange={() => undefined}
            onNodeContextMenu={(event, node) => {
              if (suppressContextMenuRef.current) {
                event.preventDefault();
                return;
              }
              event.preventDefault();
              if (node.data.kind === "junction" || node.data.kind === "terminal") return;
              setSelectedNodeIds([node.id]);
              setSelectedEdgeIds([]);
              setContextMenu({ kind: "node", nodeId: node.id, x: event.clientX, y: event.clientY });
            }}
            onNodeDoubleClick={(_, node) => {
              if (node.data.kind === "junction" || node.data.kind === "terminal") return;
              setSelectedNodeIds([node.id]);
              setSelectedEdgeIds([]);
              const next = window.prompt("Symbol name", node.data.label ?? "");
              if (next == null) return;
              applyDoc({
                ...doc,
                nodes: doc.nodes.map((item) =>
                  item.id === node.id ? { ...item, data: { ...item.data, label: next.trim() } } : item
                )
              });
            }}
            onNodeClick={(event, node) => {
              if (mode === "route") {
                const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
                if (routeDraft) {
                  if (node.id !== routeDraft.from.nodeId) {
                    const hit = nearestPortAt([node], symbols, flow, 80);
                    if (hit) {
                      finishRouteTo(hit.nodeId, hit.portId, hit.point);
                    } else {
                      const def = symbols.find((s) => s.id === node.data.symbolType);
                      const portId = def?.ports[0]?.id ?? "center";
                      finishRouteTo(node.id, portId, portWorldPosition(node, portId, symbols, 50));
                    }
                  }
                  return;
                }
                const hit = nearestPortAt([node], symbols, flow, 80);
                const def = symbols.find((s) => s.id === node.data.symbolType);
                beginRouteFromPort(node.id, hit?.portId ?? def?.ports[0]?.id ?? "center");
                return;
              }
              if (event.ctrlKey || event.metaKey) {
                setSelectedNodeIds((current) =>
                  current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]
                );
              } else {
                setSelectedNodeIds([node.id]);
              }
              setSelectedEdgeIds([]);
            }}
            onNodesChange={onNodesChange}
            onPaneClick={handlePaneClick}
            onPaneMouseMove={handlePaneMouseMove}
            panOnDrag={mode === "select"}
            selectionKeyCode={null}
            selectionMode={SelectionMode.Partial}
            selectionOnDrag={false}
            snapGrid={[gridPixels, gridPixels]}
            snapToGrid={doc.settings.snapToGrid}
          >
            {doc.settings.gridVisible && (
              <Background
                color="#b0bcc8"
                gap={Math.max(12, gridPixels)}
                lineWidth={1}
                size={doc.settings.gridVariant === "cross" ? 6 : doc.settings.gridVariant === "dots" ? 2.5 : 1}
                style={{ backgroundColor: "#f8fafc" }}
                variant={
                  (doc.settings.gridVariant ?? "dots") === "lines"
                    ? BackgroundVariant.Lines
                    : (doc.settings.gridVariant ?? "dots") === "cross"
                      ? BackgroundVariant.Cross
                      : BackgroundVariant.Dots
                }
              />
            )}
            <Controls showInteractive={false} />
            <MiniMap maskColor="rgba(244, 247, 251, .78)" nodeColor="#60738f" pannable zoomable />
            {routeDraft && <RoutePreview points={routeDraft.preview} />}
          </ReactFlow>
          {marquee && (
            <div
              className="pidMarquee"
              style={{
                left: Math.min(marquee.start.x, marquee.current.x),
                top: Math.min(marquee.start.y, marquee.current.y),
                width: Math.abs(marquee.current.x - marquee.start.x),
                height: Math.abs(marquee.current.y - marquee.start.y)
              }}
            />
          )}
          <div className="pidCanvasStatus">
            <span>{doc.nodes.filter((n) => n.data.kind !== "junction").length} symbols</span>
            <span>{doc.edges.length} lines</span>
            <span>{doc.nets.length} nets</span>
            <span>{mode === "route" ? "Routing… click ports / lines" : "Select · RMB drag · ? help"}</span>
            <span>
              {doc.settings.gridSize} {doc.settings.unit}
            </span>
          </div>
        </main>

        <aside className="pidInspector">
          <div className="pidPanelTitle">
            <span>Properties</span>
            <small>
              {selectedEdgeIds.length > 1 && !selectedNode
                ? `${selectedEdgeIds.length} lines`
                : selectedEdge
                  ? "Net / Line"
                  : selectedNode
                    ? "Symbol"
                    : "Canvas"}
            </small>
          </div>
          {selectedEdgeIds.length > 1 && !selectedNode ? (
            <div className="pidInspectorContent">
              <p className="pidHelp">{selectedEdgeIds.length} lines selected — edits apply to all.</p>
              <label>
                Tag
                <input
                  onChange={(event) => updateSelectedEdge({ tag: event.target.value })}
                  placeholder={sharedEdgeValue("tag") === "" ? "Mixed" : undefined}
                  value={sharedEdgeValue("tag") ?? ""}
                />
              </label>
              <label>
                Line class
                <select
                  onChange={(event) => updateSelectedEdge({ lineClass: event.target.value as LineClassId })}
                  value={String(sharedEdgeValue("lineClass") ?? "process")}
                >
                  {doc.lineClasses.map((cls) => (
                    <option key={cls.id} value={cls.id}>
                      {cls.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fluid
                <input
                  onChange={(event) => updateSelectedEdge({ fluid: event.target.value })}
                  placeholder={sharedEdgeValue("fluid") === "" ? "Mixed" : undefined}
                  value={sharedEdgeValue("fluid") ?? ""}
                />
              </label>
              <label>
                Material
                <input
                  onChange={(event) => updateSelectedEdge({ material: event.target.value })}
                  placeholder={sharedEdgeValue("material") === "" ? "Mixed" : undefined}
                  value={sharedEdgeValue("material") ?? ""}
                />
              </label>
              <button className="secondary" onClick={routeSelected} type="button">
                Auto-route selected
              </button>
              <button className="danger secondary" onClick={deleteSelection} type="button">
                Delete lines
              </button>
            </div>
          ) : selectedEdge ? (
            <div className="pidInspectorContent">
              <label>
                Tag
                <input onChange={(event) => updateSelectedEdge({ tag: event.target.value })} value={selectedEdge.data?.tag ?? ""} />
              </label>
              <label>
                Line class
                <select
                  onChange={(event) => updateSelectedEdge({ lineClass: event.target.value as LineClassId })}
                  value={selectedEdge.data?.lineClass ?? "process"}
                >
                  {doc.lineClasses.map((cls) => (
                    <option key={cls.id} value={cls.id}>
                      {cls.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fluid
                <input onChange={(event) => updateSelectedEdge({ fluid: event.target.value })} value={selectedEdge.data?.fluid ?? ""} />
              </label>
              <label>
                Pressure (bar)
                <input
                  onChange={(event) =>
                    updateSelectedEdge({ pressure_bar: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  type="number"
                  value={selectedEdge.data?.pressure_bar ?? ""}
                />
              </label>
              <label>
                Temperature (°C)
                <input
                  onChange={(event) =>
                    updateSelectedEdge({ temperature_c: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  type="number"
                  value={selectedEdge.data?.temperature_c ?? ""}
                />
              </label>
              <label>
                Diameter (mm)
                <input
                  onChange={(event) =>
                    updateSelectedEdge({ diameter_mm: event.target.value === "" ? null : Number(event.target.value) })
                  }
                  type="number"
                  value={selectedEdge.data?.diameter_mm ?? ""}
                />
              </label>
              <label>
                Material
                <input onChange={(event) => updateSelectedEdge({ material: event.target.value })} value={selectedEdge.data?.material ?? ""} />
              </label>
              <label>
                Flow
                <select
                  onChange={(event) =>
                    updateSelectedEdge({ flow_direction: event.target.value as PidEdgeData["flow_direction"] })
                  }
                  value={selectedEdge.data?.flow_direction ?? "forward"}
                >
                  <option value="forward">Forward</option>
                  <option value="reverse">Reverse</option>
                  <option value="bidirectional">Bidirectional</option>
                </select>
              </label>
              <label className="pidToggle">
                <input
                  checked={Boolean(selectedEdge.data?.locked)}
                  onChange={(event) => updateSelectedEdge({ locked: event.target.checked, routing: event.target.checked ? "manual" : selectedEdge.data?.routing })}
                  type="checkbox"
                />
                Lock route (no shove)
              </label>
              <button className="secondary" onClick={routeSelected} type="button">
                Auto-route this line
              </button>
              <button className="danger secondary" onClick={deleteSelection} type="button">
                Delete line
              </button>
            </div>
          ) : selectedNode ? (
            <div className="pidInspectorContent">
              <label>
                Label
                <input onChange={(event) => updateSelectedNode({ label: event.target.value })} value={selectedNode.data.label} />
              </label>
              <label>
                Rotation
                <div className="buttonRow pidRotationRow">
                  <button className="secondary" onClick={() => rotateSelected(-90)} type="button">
                    ⟲ -90°
                  </button>
                  <span className="pidRotationValue">{selectedNode.data.rotation ?? 0}°</span>
                  <button className="secondary" onClick={() => rotateSelected(90)} type="button">
                    ⟳ +90°
                  </button>
                </div>
              </label>
              <div className="buttonRow">
                <button className="secondary" onClick={() => updateSelectedNode({ mirrorX: !selectedNode.data.mirrorX })} type="button">
                  Mirror H
                </button>
                <button className="secondary" onClick={() => updateSelectedNode({ mirrorY: !selectedNode.data.mirrorY })} type="button">
                  Mirror V
                </button>
              </div>
              <label className="pidToggle">
                <input
                  checked={Boolean(selectedNode.data.locked)}
                  onChange={(event) => updateSelectedNode({ locked: event.target.checked })}
                  type="checkbox"
                />
                Lock symbol
              </label>
              {(selectedNode.data.symbolType === "off_page_from" || selectedNode.data.symbolType === "off_page_to") && (
                <>
                  <label>
                    Off-page reference
                    <input
                      onChange={(event) => updateSelectedNode({ offPageRef: event.target.value })}
                      value={selectedNode.data.offPageRef ?? ""}
                    />
                  </label>
                  <label>
                    Side
                    <select
                      onChange={(event) => updateSelectedNode({ offPageSide: event.target.value as "from" | "to" })}
                      value={selectedNode.data.offPageSide ?? (selectedNode.data.symbolType === "off_page_to" ? "to" : "from")}
                    >
                      <option value="from">From (outgoing)</option>
                      <option value="to">To (incoming)</option>
                    </select>
                  </label>
                </>
              )}
              <label>
                Component tag
                <input onChange={(event) => props.setComponentTag(event.target.value)} value={props.componentTag} />
              </label>
              <label>
                Catalog part
                <select onChange={(event) => props.setSelectedPartId(event.target.value)} value={props.selectedPartId}>
                  <option value="">Select part…</option>
                  {props.parts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.part_number} · {part.description}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={props.busy || !props.selectedDiagram || !props.selectedPartId}
                onClick={() => props.onPlaceComponent(selectedNode.id, props.selectedPartId)}
                type="button"
              >
                Assign part
              </button>
              {mode === "route" && (
                <button
                  className="secondary"
                  onClick={() => {
                    const size = nodeSize(selectedNode);
                    const center = {
                      x: selectedNode.position.x + size.width / 2,
                      y: selectedNode.position.y + size.height / 2
                    };
                    const hit = nearestPortAt([selectedNode], symbols, center, 999);
                    if (hit) beginRouteFromPort(hit.nodeId, hit.portId);
                  }}
                  type="button"
                >
                  Start route from port
                </button>
              )}
              <button className="danger secondary" onClick={deleteSelection} type="button">
                Delete symbol
              </button>
            </div>
          ) : (
            <div className="pidInspectorContent">
              <label className="pidToggle">
                <input
                  checked={doc.settings.gridVisible}
                  onChange={(event) =>
                    commitLive((current) => ({
                      ...current,
                      settings: { ...current.settings, gridVisible: event.target.checked }
                    }))
                  }
                  type="checkbox"
                />
                Show grid
              </label>
              <label>
                Grid style
                <select
                  disabled={!doc.settings.gridVisible}
                  onChange={(event) =>
                    commitLive((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        gridVisible: true,
                        gridVariant: event.target.value as GridVariant
                      }
                    }))
                  }
                  value={doc.settings.gridVariant ?? "dots"}
                >
                  <option value="dots">Points</option>
                  <option value="lines">Lines</option>
                  <option value="cross">Cross</option>
                </select>
              </label>
              <label className="pidToggle">
                <input
                  checked={doc.settings.snapToGrid}
                  onChange={(event) =>
                    commitLive((current) => ({
                      ...current,
                      settings: { ...current.settings, snapToGrid: event.target.checked }
                    }))
                  }
                  type="checkbox"
                />
                Snap to grid
              </label>
              <label className="pidToggle">
                <input
                  checked={doc.settings.autoLineTags}
                  onChange={(event) => applyDoc({ ...doc, settings: { ...doc.settings, autoLineTags: event.target.checked } })}
                  type="checkbox"
                />
                Auto line tags
              </label>
              <button className="secondary" onClick={retagNets} type="button">
                Retag nets
              </button>
              <div className="pidLayerList">
                <span className="pidSectionLabel">Line layers</span>
                {doc.lineClasses.map((cls) => (
                  <label className="pidToggle" key={cls.id}>
                    <input
                      checked={!hiddenClassSet.has(cls.id)}
                      onChange={() => toggleLineClassVisibility(cls.id)}
                      type="checkbox"
                    />
                    <span style={{ borderLeft: `3px solid ${cls.color}`, paddingLeft: 6 }}>{cls.name}</span>
                  </label>
                ))}
              </div>
              <label>
                Route mode
                <select
                  onChange={(event) =>
                    applyDoc({
                      ...doc,
                      settings: { ...doc.settings, routeMode: event.target.value as "orthogonal" | "45deg" }
                    })
                  }
                  value={doc.settings.routeMode}
                >
                  <option value="orthogonal">Orthogonal 90°</option>
                  <option value="45deg">45° / 90°</option>
                </select>
              </label>
              <label>
                Units
                <select
                  onChange={(event) =>
                    applyDoc({ ...doc, settings: { ...doc.settings, unit: event.target.value as "px" | "mm" } })
                  }
                  value={doc.settings.unit}
                >
                  <option value="mm">Millimetres (mm)</option>
                  <option value="px">Pixels (px)</option>
                </select>
              </label>
              <label>
                Grid spacing
                <input
                  min=".25"
                  onChange={(event) =>
                    applyDoc({ ...doc, settings: { ...doc.settings, gridSize: Number(event.target.value) } })
                  }
                  step=".25"
                  type="number"
                  value={doc.settings.gridSize}
                />
              </label>
              <p className="pidHelp">
                R route · click empty canvas to start/end · Shift+click or Enter finishes · Esc cancel · ? shortcuts
              </p>
              <button className="secondary" onClick={() => fitView({ padding: 0.2 })} type="button">
                Fit view
              </button>
            </div>
          )}

          {showDrc && (
            <div className="pidDrcPanel">
              <div className="pidPanelTitle">
                <span>DRC</span>
                <small>
                  {drcIssues.filter((i) => i.severity === "error").length} err ·{" "}
                  {drcIssues.filter((i) => i.severity === "warning").length} warn
                </small>
                <button className="pidDrcClose secondary" onClick={() => setShowDrc(false)} type="button">
                  ×
                </button>
              </div>
              <ul className="pidDrcList">
                {drcIssues.length === 0 && <li className="pidHelp">No issues found.</li>}
                {drcIssues.map((issue) => (
                  <li key={issue.id}>
                    <button
                      className={`pidDrcItem ${issue.severity}`}
                      onClick={() => focusDrcIssue(issue)}
                      type="button"
                    >
                      <strong>{issue.code}</strong>
                      <span>{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {contextMenu && (
        <div className="pidContextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.kind === "edge" ? (
            <>
              <strong>Process line</strong>
              {doc.lineClasses.map((cls) => (
                <button
                  key={cls.id}
                  onClick={() => {
                    updateEdgeById(contextMenu.edgeId, { lineClass: cls.id });
                    setSelectedEdgeIds([contextMenu.edgeId]);
                    setContextMenu(null);
                  }}
                  type="button"
                >
                  {cls.name}
                </button>
              ))}
              <button
                className="danger secondary"
                onClick={() => deleteIds([], [contextMenu.edgeId])}
                type="button"
              >
                Delete line
              </button>
            </>
          ) : (
            <>
              <strong>Symbol</strong>
              <button
                className="danger secondary"
                onClick={() => deleteIds([contextMenu.nodeId], [])}
                type="button"
              >
                Delete symbol
              </button>
            </>
          )}
        </div>
      )}

      {showShortcuts && (
        <div className="pidShortcutsOverlay" onClick={() => setShowShortcuts(false)} role="presentation">
          <div className="pidShortcutsSheet" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="pidPanelTitle">
              <span>Keyboard shortcuts</span>
              <button className="secondary" onClick={() => setShowShortcuts(false)} type="button">
                Close
              </button>
            </div>
            <ul>
              <li><kbd>V</kbd> Select tool</li>
              <li><kbd>R</kbd> Route (starts at selected symbol’s nearest port)</li>
              <li><kbd>Enter</kbd> / <kbd>Shift+click</kbd> Finish free route on canvas</li>
              <li><kbd>Esc</kbd> Cancel route / clear selection</li>
              <li><kbd>?</kbd> / <kbd>F1</kbd> Toggle this help</li>
              <li><kbd>Double-click</kbd> Rename symbol / line tag</li>
              <li><kbd>Ctrl+A</kbd> Select all symbols</li>
              <li><kbd>Arrows</kbd> Nudge selection (Shift = 4× grid)</li>
              <li><kbd>Ctrl+D</kbd> Duplicate</li>
              <li><kbd>Ctrl+Shift+D</kbd> Array duplicate</li>
              <li><kbd>Ctrl+C</kbd> / <kbd>Ctrl+V</kbd> Copy / paste</li>
              <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> Undo / redo</li>
              <li><kbd>Ctrl+S</kbd> Save</li>
              <li><kbd>Ctrl+E</kbd> Export SVG</li>
              <li><kbd>Ctrl+P</kbd> Print / PDF</li>
              <li><kbd>Delete</kbd> Delete selection</li>
            </ul>
          </div>
        </div>
      )}

      {editingSymbol && (
        <SymbolStudio
          initial={editingSymbol === "new" ? undefined : editingSymbol}
          onCancel={() => setEditingSymbol(null)}
          onSave={(symbol) => {
            applyDoc({
              ...doc,
              symbols: [...doc.symbols.filter((item) => item.id !== symbol.id), symbol]
            });
            setEditingSymbol(null);
          }}
        />
      )}
    </div>
  );
}

export function PidEditorPage(props: PidWorkspaceProps) {
  return (
    <ReactFlowProvider>
      <PidWorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}

// Re-export helpers used by App
export { createHistory, commit, undo, redo, documentToGraph, canUndo, canRedo };

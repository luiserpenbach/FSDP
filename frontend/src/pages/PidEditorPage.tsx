import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction
} from "react";
import ReactFlow, {
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from "reactflow";
import type { Diagram, Part } from "../types";
import {
  BUILT_IN_SYMBOLS,
  gridSizeInPixels,
  orthogonalPath,
  routeOrthogonal,
  type PidEdgeData,
  type PidEditorSettings,
  type PidNodeData,
  type PidSymbolDefinition,
  type Point,
  type Rect,
  type SymbolPort,
  type SymbolPrimitive
} from "../utils/pidEditor";

type Props = {
  busy: boolean;
  diagramName: string;
  diagrams: Diagram[];
  edges: Edge<PidEdgeData>[];
  graphDirty: boolean;
  nodes: Node<PidNodeData>[];
  parts: Part[];
  selectedDiagram: Diagram | null;
  selectedDiagramId: string;
  selectedEdgeId: string;
  selectedNodeId: string;
  selectedPart: Part | null;
  componentTag: string;
  editorSettings: PidEditorSettings;
  customSymbols: PidSymbolDefinition[];
  setComponentTag: (value: string) => void;
  setCustomSymbols: Dispatch<SetStateAction<PidSymbolDefinition[]>>;
  setDiagramName: (value: string) => void;
  setEdges: Dispatch<SetStateAction<Edge<PidEdgeData>[]>>;
  setEditorSettings: Dispatch<SetStateAction<PidEditorSettings>>;
  setNodes: Dispatch<SetStateAction<Node<PidNodeData>[]>>;
  setSelectedDiagramId: (value: string) => void;
  setSelectedEdgeId: (value: string) => void;
  setSelectedNodeId: (value: string) => void;
  onCreateDiagram: () => void;
  onDeleteDiagram: () => void;
  onDirty: () => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onPlaceComponent: () => void;
  onRenameDiagram: () => void;
  onSave: () => void;
};

const LINE_COLORS = ["#243248", "#1f5eff", "#0e7a53", "#c24135", "#a45b13", "#7451b9"];
const LINE_WIDTHS = [1, 1.5, 2, 3, 4, 6];

function SymbolArtwork({ symbol }: { symbol: PidSymbolDefinition }) {
  return (
    <svg aria-label={symbol.name} className="pidSymbolSvg" viewBox="0 0 100 100">
      {symbol.primitives.map((primitive) => {
        const common = {
          fill: "none",
          key: primitive.id,
          stroke: "currentColor",
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
          strokeWidth: primitive.strokeWidth ?? 3
        };
        if (primitive.kind === "line") return <line {...common} x1={primitive.x1} x2={primitive.x2} y1={primitive.y1} y2={primitive.y2} />;
        if (primitive.kind === "rect") return <rect {...common} height={primitive.height} width={primitive.width} x={primitive.x} y={primitive.y} />;
        return <circle {...common} cx={primitive.cx} cy={primitive.cy} r={primitive.r} />;
      })}
    </svg>
  );
}

function SymbolNode({
  data,
  selected,
  symbols
}: NodeProps<PidNodeData> & { symbols: PidSymbolDefinition[] }) {
  const symbol = symbols.find((item) => item.id === data.symbolType) ?? BUILT_IN_SYMBOLS[0];
  const angle = (data.rotation * Math.PI) / 180;
  return (
    <div className={`pidCadSymbol ${selected ? "isSelected" : ""}`}>
      <div className="pidSymbolRotator" style={{ transform: `rotate(${data.rotation}deg)` }}>
        <SymbolArtwork symbol={symbol} />
      </div>
      {symbol.ports.map((port) => {
        const offsetX = port.x - 50;
        const offsetY = port.y - 50;
        const x = 50 + offsetX * Math.cos(angle) - offsetY * Math.sin(angle);
        const y = 50 + offsetX * Math.sin(angle) + offsetY * Math.cos(angle);
        return (
          <Handle
            className="pidPort"
            id={port.id}
            key={port.id}
            position={Position.Left}
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

function resolvePoints(
  source: Point,
  target: Point,
  waypoints: Point[] | undefined
): Point[] {
  const resolved = (waypoints ?? []).map((point, index, items) => ({
    x: point.x,
    y: Number.isFinite(point.y) ? point.y : index < items.length / 2 ? source.y : target.y
  }));
  if (resolved.length === 0) {
    const middleX = (source.x + target.x) / 2;
    resolved.push({ x: middleX, y: source.y }, { x: middleX, y: target.y });
  }
  return [source, ...resolved, target];
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
  onDirty
}: EdgeProps<PidEdgeData> & { onDirty: () => void }) {
  const { screenToFlowPosition, setEdges } = useReactFlow();
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
  const points = resolvePoints(
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    data?.waypoints ?? legacyWaypoints
  );
  const color = data?.color ?? "#243248";
  const thickness = data?.thickness ?? 2;

  function beginSegmentDrag(event: ReactPointerEvent<HTMLButtonElement>, segmentIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    const horizontal = points[segmentIndex].y === points[segmentIndex + 1].y;

    function move(moveEvent: PointerEvent) {
      const position = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      setEdges((current) =>
        current.map((edge) => {
          if (edge.id !== id) return edge;
          const currentData = (edge.data ?? {}) as PidEdgeData;
          const next = resolvePoints(
            { x: sourceX, y: sourceY },
            { x: targetX, y: targetY },
            currentData.waypoints
          );
          if (horizontal) {
            next[segmentIndex] = { ...next[segmentIndex], y: position.y };
            next[segmentIndex + 1] = { ...next[segmentIndex + 1], y: position.y };
          } else {
            next[segmentIndex] = { ...next[segmentIndex], x: position.x };
            next[segmentIndex + 1] = { ...next[segmentIndex + 1], x: position.x };
          }
          return {
            ...edge,
            data: { ...currentData, routing: "manual", waypoints: next.slice(1, -1) }
          };
        })
      );
    }

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onDirty();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={orthogonalPath(points)}
        style={{ stroke: color, strokeWidth: thickness }}
      />
      {selected && (
        <EdgeLabelRenderer>
          {points.slice(0, -1).map((point, index) => {
            const next = points[index + 1];
            if (index === 0 || index === points.length - 2) return null;
            const horizontal = point.y === next.y;
            return (
              <button
                aria-label={`Move ${horizontal ? "horizontal" : "vertical"} line segment`}
                className={`pidSegmentHandle ${horizontal ? "horizontal" : "vertical"} nodrag nopan`}
                key={`${index}-${point.x}-${point.y}`}
                onPointerDown={(event) => beginSegmentDrag(event, index)}
                style={{
                  left: `${(point.x + next.x) / 2}px`,
                  top: `${(point.y + next.y) / 2}px`
                }}
                type="button"
              />
            );
          })}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

type SymbolEditorProps = {
  initial?: PidSymbolDefinition;
  onCancel: () => void;
  onSave: (symbol: PidSymbolDefinition) => void;
};

function SymbolEditor({ initial, onCancel, onSave }: SymbolEditorProps) {
  const [name, setName] = useState(initial?.name ?? "Custom symbol");
  const [primitives, setPrimitives] = useState<SymbolPrimitive[]>(initial?.primitives ?? []);
  const [ports, setPorts] = useState<SymbolPort[]>(initial?.ports ?? []);
  const [tool, setTool] = useState<"line" | "rect" | "circle" | "port" | "select">("line");
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const counter = useRef(0);

  function svgPoint(event: ReactPointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const snap = (value: number) => Math.round(value / 5) * 5;
    return {
      x: Math.max(0, Math.min(100, snap(((event.clientX - rect.left) / rect.width) * 100))),
      y: Math.max(0, Math.min(100, snap(((event.clientY - rect.top) / rect.height) * 100)))
    };
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.target !== event.currentTarget) return;
    const point = svgPoint(event);
    if (tool === "port") {
      const id = `port-${Date.now()}-${counter.current++}`;
      setPorts((current) => [...current, { id, name: `Port ${current.length + 1}`, ...point }]);
      setSelectedId(id);
      return;
    }
    if (tool !== "select") setDraftStart(point);
    else setSelectedId("");
  }

  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draftStart) return;
    const end = svgPoint(event);
    const id = `shape-${Date.now()}-${counter.current++}`;
    let primitive: SymbolPrimitive;
    if (tool === "line") {
      primitive = { id, kind: "line", x1: draftStart.x, y1: draftStart.y, x2: end.x, y2: end.y };
    } else if (tool === "rect") {
      primitive = {
        id,
        kind: "rect",
        x: Math.min(draftStart.x, end.x),
        y: Math.min(draftStart.y, end.y),
        width: Math.abs(end.x - draftStart.x),
        height: Math.abs(end.y - draftStart.y)
      };
    } else {
      primitive = {
        id,
        kind: "circle",
        cx: draftStart.x,
        cy: draftStart.y,
        r: Math.max(2, Math.hypot(end.x - draftStart.x, end.y - draftStart.y))
      };
    }
    setPrimitives((current) => [...current, primitive]);
    setSelectedId(id);
    setDraftStart(null);
  }

  function deleteSelected() {
    setPrimitives((current) => current.filter((item) => item.id !== selectedId));
    setPorts((current) => current.filter((item) => item.id !== selectedId));
    setSelectedId("");
  }

  function movePort(event: ReactPointerEvent<SVGCircleElement>, portId: string) {
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const update = (moveEvent: PointerEvent) => {
      const x = Math.max(0, Math.min(100, Math.round((((moveEvent.clientX - rect.left) / rect.width) * 100) / 5) * 5));
      const y = Math.max(0, Math.min(100, Math.round((((moveEvent.clientY - rect.top) / rect.height) * 100) / 5) * 5));
      setPorts((current) => current.map((port) => (port.id === portId ? { ...port, x, y } : port)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  }

  function movePrimitive(event: ReactPointerEvent<SVGElement>, primitiveId: string) {
    event.stopPropagation();
    setSelectedId(primitiveId);
    if (tool !== "select") return;
    const canvas = event.currentTarget.ownerSVGElement;
    const original = primitives.find((primitive) => primitive.id === primitiveId);
    if (!canvas || !original) return;
    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const update = (moveEvent: PointerEvent) => {
      const dx = Math.round((((moveEvent.clientX - startX) / rect.width) * 100) / 5) * 5;
      const dy = Math.round((((moveEvent.clientY - startY) / rect.height) * 100) / 5) * 5;
      setPrimitives((current) => current.map((primitive) => {
        if (primitive.id !== primitiveId) return primitive;
        if (original.kind === "line") {
          return { ...original, x1: original.x1 + dx, x2: original.x2 + dx, y1: original.y1 + dy, y2: original.y2 + dy };
        }
        if (original.kind === "rect") return { ...original, x: original.x + dx, y: original.y + dy };
        return { ...original, cx: original.cx + dx, cy: original.cy + dy };
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Delete") deleteSelected();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });

  return (
    <div aria-modal="true" className="pidModalBackdrop" role="dialog">
      <div className="pidSymbolEditor">
        <header>
          <div>
            <span className="pidEyebrow">Symbol studio</span>
            <h2>{initial ? "Edit symbol" : "Create symbol"}</h2>
          </div>
          <button className="pidIconButton" onClick={onCancel} title="Close" type="button">×</button>
        </header>
        <div className="pidSymbolEditorBody">
          <aside>
            <label>
              Symbol name
              <input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <div className="pidToolGrid">
              {(["select", "line", "rect", "circle", "port"] as const).map((item) => (
                <button className={tool === item ? "active" : ""} key={item} onClick={() => setTool(item)} type="button">{item}</button>
              ))}
            </div>
            <p className="pidHelp">Draw on the 5-unit grid. Ports become connection points on the P&amp;ID canvas.</p>
            <button disabled={!selectedId} onClick={deleteSelected} type="button">Delete selected</button>
            {ports.map((port) => (
              <label className="pidPortName" key={port.id}>
                <span>{port.x}, {port.y}</span>
                <input
                  onChange={(event) => setPorts((current) => current.map((item) => item.id === port.id ? { ...item, name: event.target.value } : item))}
                  value={port.name}
                />
              </label>
            ))}
          </aside>
          <div className="pidSymbolCanvas">
            <svg onPointerDown={pointerDown} onPointerUp={pointerUp} viewBox="0 0 100 100">
              <defs>
                <pattern height="5" id="symbolGrid" patternUnits="userSpaceOnUse" width="5">
                  <circle cx=".5" cy=".5" fill="#aab5c5" r=".35" />
                </pattern>
              </defs>
              <rect fill="url(#symbolGrid)" height="100" pointerEvents="none" width="100" />
              {primitives.map((primitive) => {
                const common = {
                  className: selectedId === primitive.id ? "selected" : "",
                  fill: "none",
                  key: primitive.id,
                  onPointerDown: (event: ReactPointerEvent<SVGElement>) => movePrimitive(event, primitive.id),
                  stroke: "#172235",
                  strokeWidth: primitive.strokeWidth ?? 2
                };
                if (primitive.kind === "line") return <line {...common} x1={primitive.x1} x2={primitive.x2} y1={primitive.y1} y2={primitive.y2} />;
                if (primitive.kind === "rect") return <rect {...common} height={primitive.height} width={primitive.width} x={primitive.x} y={primitive.y} />;
                return <circle {...common} cx={primitive.cx} cy={primitive.cy} r={primitive.r} />;
              })}
              {ports.map((port) => (
                <circle
                  className={`symbolEditorPort ${selectedId === port.id ? "selected" : ""}`}
                  cx={port.x}
                  cy={port.y}
                  key={port.id}
                  onPointerDown={(event) => {
                    setSelectedId(port.id);
                    movePort(event, port.id);
                  }}
                  r="2.8"
                />
              ))}
            </svg>
          </div>
        </div>
        <footer>
          <button className="secondary" onClick={onCancel} type="button">Cancel</button>
          <button
            disabled={!name.trim() || primitives.length === 0 || ports.length === 0}
            onClick={() => onSave({
              id: initial?.id ?? `custom-${Date.now()}`,
              name: name.trim(),
              ports,
              primitives
            })}
            type="button"
          >
            Save symbol
          </button>
        </footer>
      </div>
    </div>
  );
}

function PidEditorInner(props: Props) {
  const {
    busy, componentTag, customSymbols, diagramName, diagrams, edges, editorSettings,
    graphDirty, nodes, parts, selectedDiagram, selectedDiagramId, selectedEdgeId,
    selectedNodeId, selectedPart
  } = props;
  const [contextMenu, setContextMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const [editingSymbol, setEditingSymbol] = useState<PidSymbolDefinition | null | "new">(null);
  const nodeIdPrefix = useId().replaceAll(":", "");
  const nodeCounter = useRef(0);
  const allSymbols = useMemo(() => [...BUILT_IN_SYMBOLS, ...customSymbols], [customSymbols]);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const gridPixels = gridSizeInPixels(editorSettings);

  const nodeTypes = useMemo(
    () => ({
      pidSymbol: (nodeProps: NodeProps<PidNodeData>) => <SymbolNode {...nodeProps} symbols={allSymbols} />
    }),
    [allSymbols]
  );
  const edgeTypes = useMemo(
    () => ({
      pidLine: (edgeProps: EdgeProps<PidEdgeData>) => <PidLine {...edgeProps} onDirty={props.onDirty} />
    }),
    [props.onDirty]
  );

  const routeEdge = useCallback((edge: Edge<PidEdgeData>) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (!source || !target) return edge;
    const sourceWidth = Number(source.style?.width ?? source.width ?? 112);
    const sourceHeight = Number(source.style?.height ?? source.height ?? 86);
    const targetWidth = Number(target.style?.width ?? target.width ?? 112);
    const targetHeight = Number(target.style?.height ?? target.height ?? 86);
    const portPosition = (
      node: Node<PidNodeData>,
      width: number,
      height: number,
      portId: string | null | undefined,
      fallbackX: number
    ): Point => {
      const symbol = allSymbols.find((item) => item.id === node.data.symbolType);
      const port = symbol?.ports.find((item) => item.id === portId);
      const localX = ((port?.x ?? fallbackX) / 100) * width;
      const localY = ((port?.y ?? 50) / 100) * height;
      const angle = (node.data.rotation * Math.PI) / 180;
      const offsetX = localX - width / 2;
      const offsetY = localY - height / 2;
      return {
        x: node.position.x + width / 2 + offsetX * Math.cos(angle) - offsetY * Math.sin(angle),
        y: node.position.y + height / 2 + offsetX * Math.sin(angle) + offsetY * Math.cos(angle)
      };
    };
    const start = portPosition(source, sourceWidth, sourceHeight, edge.sourceHandle, 100);
    const end = portPosition(target, targetWidth, targetHeight, edge.targetHandle, 0);
    const obstacles: Rect[] = nodes
      .filter((node) => node.id !== source.id && node.id !== target.id)
      .map((node) => ({
        x: node.position.x,
        y: node.position.y,
        width: Number(node.style?.width ?? node.width ?? 112),
        height: Number(node.style?.height ?? node.height ?? 86)
      }));
    const points = routeOrthogonal(start, end, obstacles, Math.max(8, gridPixels));
    return { ...edge, data: { ...edge.data, routing: "auto" as const, waypoints: points.slice(1, -1) } };
  }, [allSymbols, gridPixels, nodes]);

  const routeAll = useCallback(() => {
    props.setEdges((current) => current.map(routeEdge));
    props.onDirty();
  }, [props, routeEdge]);

  function addSymbol(symbol: PidSymbolDefinition) {
    nodeCounter.current += 1;
    const id = `${symbol.id}-${nodeIdPrefix}-${nodeCounter.current}`;
    props.setNodes((current) => [
      ...current,
      {
        id,
        type: "pidSymbol",
        position: { x: 180 + current.length * 18, y: 140 + current.length * 14 },
        style: { height: 86, width: 112 },
        data: { label: symbol.name, rotation: 0, symbolType: symbol.id }
      }
    ]);
    props.setSelectedNodeId(id);
    props.onDirty();
  }

  function updateEdgeStyle(patch: Partial<PidEdgeData>) {
    const edgeId = contextMenu?.edgeId ?? selectedEdgeId;
    if (!edgeId) return;
    props.setEdges((current) => current.map((edge) => edge.id === edgeId ? { ...edge, data: { ...edge.data, ...patch } } : edge));
    props.setSelectedEdgeId(edgeId);
    props.onDirty();
  }

  function connect(connection: Connection) {
    const edge: Edge<PidEdgeData> = {
      ...connection,
      id: `line-${Date.now()}`,
      label: "Process line",
      source: connection.source!,
      target: connection.target!,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      type: "pidLine",
      data: { color: "#243248", thickness: 2, routing: "auto" }
    };
    props.setEdges((current) => [...current, routeEdge(edge)]);
    props.setSelectedEdgeId(edge.id);
    props.onDirty();
  }

  function deleteSelection() {
    if (selectedEdgeId) {
      props.setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      props.setSelectedEdgeId("");
    } else if (selectedNodeId) {
      props.setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      props.setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
      props.setSelectedNodeId("");
    }
    props.onDirty();
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (selectedDiagram && graphDirty) props.onSave();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });

  return (
    <div className="pidEditor">
      <header className="pidCommandBar">
        <div className="pidDocumentControl">
          <span className="pidEyebrow">P&amp;ID workspace</span>
          <input aria-label="Diagram name" onChange={(event) => props.setDiagramName(event.target.value)} value={diagramName} />
        </div>
        <select aria-label="Open diagram" onChange={(event) => props.setSelectedDiagramId(event.target.value)} value={selectedDiagramId}>
          <option value="">Select diagram</option>
          {diagrams.map((diagram) => <option key={diagram.id} value={diagram.id}>{diagram.name} · rev {diagram.revision}</option>)}
        </select>
        <div className="pidCommandGroup">
          <button disabled={busy || !selectedDiagram} onClick={props.onRenameDiagram} type="button">Rename</button>
          <button disabled={busy || !selectedDiagram || !graphDirty} onClick={props.onSave} type="button">Save</button>
          <button onClick={routeAll} title="Automatically route all process lines" type="button">Route all</button>
          <button onClick={() => setEditingSymbol("new")} type="button">New symbol</button>
        </div>
        <div className={`pidSaveState ${graphDirty ? "dirty" : ""}`}><i />{graphDirty ? "Unsaved" : "Saved"}</div>
        <div className="pidOverflow">
          <button disabled={busy || !selectedDiagram} onClick={props.onDeleteDiagram} type="button">Delete</button>
          <button disabled={busy || !diagramName} onClick={props.onCreateDiagram} type="button">Create</button>
        </div>
      </header>

      <div className="pidEditorBody">
        <aside className="pidPalette">
          <div className="pidPanelTitle"><span>Symbols</span><small>{allSymbols.length}</small></div>
          <div className="pidSymbolList">
            {allSymbols.map((symbol) => (
              <div className="pidPaletteItem" key={symbol.id}>
                <button onClick={() => addSymbol(symbol)} title={`Place ${symbol.name}`} type="button">
                  <SymbolArtwork symbol={symbol} />
                  <span>{symbol.name}</span>
                </button>
                {!symbol.builtIn && <button className="pidEditSymbol" onClick={() => setEditingSymbol(symbol)} title="Edit symbol" type="button">•••</button>}
              </div>
            ))}
          </div>
        </aside>

        <main className="pidCanvas" onContextMenu={(event) => event.preventDefault()}>
          <ReactFlow
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: "pidLine" }}
            edges={edges}
            edgeTypes={edgeTypes}
            fitView
            minZoom={0.15}
            nodeTypes={nodeTypes}
            nodes={nodes}
            onConnect={connect}
            onEdgeClick={(_, edge) => {
              props.setSelectedEdgeId(edge.id);
              props.setSelectedNodeId("");
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              props.setSelectedEdgeId(edge.id);
              setContextMenu({ edgeId: edge.id, x: event.clientX, y: event.clientY });
            }}
            onEdgesChange={props.onEdgesChange}
            onNodeClick={(_, node) => {
              props.setSelectedNodeId(node.id);
              props.setSelectedEdgeId("");
            }}
            onNodeDragStop={() => routeAll()}
            onNodesChange={props.onNodesChange}
            onPaneClick={() => {
              props.setSelectedEdgeId("");
              props.setSelectedNodeId("");
              setContextMenu(null);
            }}
            snapGrid={[gridPixels, gridPixels]}
            snapToGrid={editorSettings.snapToGrid}
          >
            {editorSettings.gridVisible && <Background color="#a9b5c6" gap={gridPixels} size={1} />}
            <Controls showInteractive={false} />
            <MiniMap maskColor="rgba(244, 247, 251, .78)" nodeColor="#60738f" pannable zoomable />
          </ReactFlow>
          <div className="pidCanvasStatus">
            <span>{nodes.length} symbols</span><span>{edges.length} lines</span>
            <span>{editorSettings.gridSize} {editorSettings.unit} grid</span>
          </div>
        </main>

        <aside className="pidInspector">
          <div className="pidPanelTitle"><span>Properties</span><small>{selectedEdge ? "Line" : selectedNode ? "Symbol" : "Canvas"}</small></div>
          {selectedEdge ? (
            <div className="pidInspectorContent">
              <label>Line color<input onChange={(event) => updateEdgeStyle({ color: event.target.value })} type="color" value={selectedEdge.data?.color ?? "#243248"} /></label>
              <label>Thickness
                <select onChange={(event) => updateEdgeStyle({ thickness: Number(event.target.value) })} value={selectedEdge.data?.thickness ?? 2}>
                  {LINE_WIDTHS.map((width) => <option key={width} value={width}>{width} px</option>)}
                </select>
              </label>
              <div className="pidLinePreview" style={{ borderTopColor: selectedEdge.data?.color, borderTopWidth: selectedEdge.data?.thickness }} />
              <button onClick={() => props.setEdges((current) => current.map((edge) => edge.id === selectedEdge.id ? routeEdge(edge) : edge))} type="button">Reset to auto-route</button>
              <button className="danger secondary" onClick={deleteSelection} type="button">Delete line</button>
            </div>
          ) : selectedNode ? (
            <div className="pidInspectorContent">
              <label>Label<input onChange={(event) => {
                props.setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, label: event.target.value } } : node));
                props.onDirty();
              }} value={selectedNode.data.label} /></label>
              <label>Rotation
                <select onChange={(event) => {
                  props.setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, rotation: Number(event.target.value) } } : node));
                  props.onDirty();
                }} value={selectedNode.data.rotation}>
                  {[0, 90, 180, 270].map((angle) => <option key={angle} value={angle}>{angle}°</option>)}
                </select>
              </label>
              <label>Component tag<input onChange={(event) => props.setComponentTag(event.target.value)} value={componentTag} /></label>
              <label>Catalog part
                <select disabled value={selectedPart?.id ?? ""}>
                  <option>{selectedPart ? `${selectedPart.part_number} · ${selectedPart.description}` : "Select a part in Parts Catalog"}</option>
                </select>
              </label>
              <button disabled={busy || !selectedDiagram || !selectedPart} onClick={props.onPlaceComponent} type="button">Assign selected part</button>
              <button className="danger secondary" onClick={deleteSelection} type="button">Delete symbol</button>
            </div>
          ) : (
            <div className="pidInspectorContent">
              <label className="pidToggle"><input checked={editorSettings.gridVisible} onChange={(event) => {
                props.setEditorSettings((current) => ({ ...current, gridVisible: event.target.checked }));
                props.onDirty();
              }} type="checkbox" />Show grid</label>
              <label className="pidToggle"><input checked={editorSettings.snapToGrid} onChange={(event) => {
                props.setEditorSettings((current) => ({ ...current, snapToGrid: event.target.checked }));
                props.onDirty();
              }} type="checkbox" />Snap to grid</label>
              <label>Units
                <select onChange={(event) => {
                  props.setEditorSettings((current) => ({ ...current, unit: event.target.value as "px" | "mm" }));
                  props.onDirty();
                }} value={editorSettings.unit}>
                  <option value="mm">Millimetres (mm)</option><option value="px">Pixels (px)</option>
                </select>
              </label>
              <label>Grid spacing<input min=".25" onChange={(event) => {
                props.setEditorSettings((current) => ({ ...current, gridSize: Number(event.target.value) }));
                props.onDirty();
              }} step=".25" type="number" value={editorSettings.gridSize} /></label>
              <p className="pidHelp">1 mm equals 96 / 25.4 CSS pixels. Diagram coordinates remain portable CSS pixels.</p>
              <select aria-label="Part catalog selection" disabled value={selectedPart?.id ?? ""}>
                <option>{parts.length} catalog parts available</option>
              </select>
            </div>
          )}
        </aside>
      </div>

      {contextMenu && (
        <div className="pidContextMenu" onContextMenu={(event) => event.preventDefault()} style={{ left: contextMenu.x, top: contextMenu.y }}>
          <strong>Process line</strong>
          <span>Color</span>
          <div className="pidSwatches">{LINE_COLORS.map((color) => <button key={color} onClick={() => updateEdgeStyle({ color })} style={{ background: color }} title={color} type="button" />)}</div>
          <span>Thickness</span>
          <div className="pidThicknesses">{LINE_WIDTHS.map((width) => <button key={width} onClick={() => updateEdgeStyle({ thickness: width })} type="button"><i style={{ borderTopWidth: width }} />{width}</button>)}</div>
          <button className="danger secondary" onClick={deleteSelection} type="button">Delete line</button>
        </div>
      )}
      {editingSymbol && (
        <SymbolEditor
          initial={editingSymbol === "new" ? undefined : editingSymbol}
          onCancel={() => setEditingSymbol(null)}
          onSave={(symbol) => {
            props.setCustomSymbols((current) => [...current.filter((item) => item.id !== symbol.id), symbol]);
            props.onDirty();
            setEditingSymbol(null);
          }}
        />
      )}
    </div>
  );
}

export function PidEditorPage(props: Props) {
  return <ReactFlowProvider><PidEditorInner {...props} /></ReactFlowProvider>;
}

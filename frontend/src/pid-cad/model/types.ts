import type { Edge, Node } from "reactflow";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type DiagramUnit = "px" | "mm";
export type GridVariant = "dots" | "lines" | "cross";

export type PidEditorSettings = {
  gridVisible: boolean;
  gridVariant: GridVariant;
  snapToGrid: boolean;
  unit: DiagramUnit;
  gridSize: number;
  autoLineTags: boolean;
  routeMode: "orthogonal" | "45deg";
  /** Line classes hidden on the canvas (layer visibility). */
  hiddenLineClasses: LineClassId[];
};

export type PortDirection = "in" | "out" | "bidir";

export type SymbolPrimitive =
  | { id: string; kind: "line"; x1: number; y1: number; x2: number; y2: number; strokeWidth?: number }
  | { id: string; kind: "polyline"; points: Point[]; strokeWidth?: number }
  | { id: string; kind: "rect"; x: number; y: number; width: number; height: number; strokeWidth?: number }
  | { id: string; kind: "circle"; cx: number; cy: number; r: number; strokeWidth?: number }
  | { id: string; kind: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number; strokeWidth?: number };

export type SymbolPort = {
  id: string;
  name: string;
  x: number;
  y: number;
  direction?: PortDirection;
  required?: boolean;
};

export type PidSymbolDefinition = {
  id: string;
  name: string;
  category?: string;
  primitives: SymbolPrimitive[];
  ports: SymbolPort[];
  builtIn?: boolean;
};

export type LineClassId = "process" | "instrument" | "pneumatic" | "hydraulic" | "vent" | "electrical";

export type LineClass = {
  id: LineClassId;
  name: string;
  color: string;
  thickness: number;
  clearance: number;
  allowConnect: LineClassId[];
};

export type EngineeringLineProps = {
  fluid: string;
  pressure_bar: number | null;
  temperature_c: number | null;
  diameter_mm: number | null;
  material: string;
  flow_direction: "forward" | "reverse" | "bidirectional";
};

export type PidNodeData = {
  label: string;
  symbolType: string;
  rotation: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  locked?: boolean;
  kind?: "symbol" | "junction" | "terminal";
  junctionKind?: "tee" | "cross" | "dot";
  netId?: string;
  /** Matching id for off-page / continuation connectors (e.g. "A1"). */
  offPageRef?: string;
  offPageSide?: "from" | "to";
};

export type PidEdgeData = {
  waypoints?: Point[];
  color?: string;
  thickness?: number;
  routing?: "auto" | "manual";
  locked?: boolean;
  lineClass?: LineClassId;
  netId?: string;
  tag?: string;
  fluid?: string;
  pressure_bar?: number | null;
  temperature_c?: number | null;
  diameter_mm?: number | null;
  material?: string;
  flow_direction?: "forward" | "reverse" | "bidirectional";
  startX?: number;
  endX?: number;
  bendX?: number;
  bendY?: number;
};

export type PidNet = {
  id: string;
  tag: string;
  lineClass: LineClassId;
  props: EngineeringLineProps;
};

export type PidJunction = {
  id: string;
  position: Point;
  kind: "tee" | "cross" | "dot";
  netId: string;
};

export type PidDocument = {
  version: 2;
  nodes: Node<PidNodeData>[];
  edges: Edge<PidEdgeData>[];
  nets: PidNet[];
  junctions: PidJunction[];
  lineClasses: LineClass[];
  symbols: PidSymbolDefinition[];
  settings: PidEditorSettings;
};

export type EditorMode = "select" | "route" | "place";

export type DrcSeverity = "error" | "warning";

export type DrcIssue = {
  id: string;
  severity: DrcSeverity;
  code: string;
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
};

export const DEFAULT_ENGINEERING: EngineeringLineProps = {
  fluid: "TBD",
  pressure_bar: null,
  temperature_c: null,
  diameter_mm: null,
  material: "",
  flow_direction: "forward"
};

export const DEFAULT_EDITOR_SETTINGS: PidEditorSettings = {
  gridVisible: true,
  gridVariant: "dots",
  snapToGrid: true,
  unit: "mm",
  gridSize: 5,
  autoLineTags: true,
  routeMode: "orthogonal",
  hiddenLineClasses: []
};

export const DEFAULT_LINE_CLASSES: LineClass[] = [
  {
    id: "process",
    name: "Process",
    color: "#243248",
    thickness: 2.5,
    clearance: 10,
    allowConnect: ["process", "vent", "hydraulic"]
  },
  {
    id: "instrument",
    name: "Instrument",
    color: "#1f5eff",
    thickness: 1.5,
    clearance: 8,
    allowConnect: ["instrument", "process", "pneumatic"]
  },
  {
    id: "pneumatic",
    name: "Pneumatic",
    color: "#0e7a53",
    thickness: 1.75,
    clearance: 8,
    allowConnect: ["pneumatic", "instrument"]
  },
  {
    id: "hydraulic",
    name: "Hydraulic",
    color: "#a45b13",
    thickness: 2.5,
    clearance: 12,
    allowConnect: ["hydraulic", "process"]
  },
  {
    id: "vent",
    name: "Vent / Drain",
    color: "#c24135",
    thickness: 1.5,
    clearance: 8,
    allowConnect: ["vent", "process"]
  },
  {
    id: "electrical",
    name: "Electrical / Signal",
    color: "#7451b9",
    thickness: 1.25,
    clearance: 6,
    allowConnect: ["electrical", "instrument"]
  }
];

export function gridSizeInPixels(settings: PidEditorSettings): number {
  const size = Math.max(0.25, Number(settings.gridSize) || 1);
  return settings.unit === "mm" ? size * (96 / 25.4) : size;
}

export function cloneDocument(doc: PidDocument): PidDocument {
  return structuredClone(doc);
}

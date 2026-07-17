import type { Edge, Node } from "reactflow";
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_ENGINEERING,
  DEFAULT_LINE_CLASSES,
  type EngineeringLineProps,
  type LineClassId,
  type PidDocument,
  type PidEdgeData,
  type PidJunction,
  type PidNet,
  type PidNodeData,
  type PidSymbolDefinition,
  type Point
} from "./types";
import { BUILT_IN_SYMBOLS } from "../symbols/library";

export function createEmptyDocument(customSymbols: PidSymbolDefinition[] = []): PidDocument {
  return {
    version: 2,
    nodes: [],
    edges: [],
    nets: [],
    junctions: [],
    lineClasses: DEFAULT_LINE_CLASSES.map((item) => ({ ...item })),
    symbols: customSymbols,
    settings: { ...DEFAULT_EDITOR_SETTINGS }
  };
}

export function createStarterDocument(): PidDocument {
  const doc = createEmptyDocument();
  doc.nodes = [
    {
      id: "source-1",
      type: "pidSymbol",
      position: { x: 40, y: 120 },
      style: { width: 100, height: 100 },
      data: { label: "Tank / Source", symbolType: "source", rotation: 0, kind: "symbol" }
    },
    {
      id: "valve-1",
      type: "pidSymbol",
      position: { x: 260, y: 120 },
      style: { width: 100, height: 100 },
      data: { label: "Gate valve", symbolType: "gate_valve", rotation: 0, kind: "symbol" }
    },
    {
      id: "sink-1",
      type: "pidSymbol",
      position: { x: 500, y: 120 },
      style: { width: 100, height: 100 },
      data: { label: "Equipment", symbolType: "sink", rotation: 0, kind: "symbol" }
    }
  ];
  const netA: PidNet = {
    id: "net-feed-a",
    tag: "P-101",
    lineClass: "process",
    props: { ...DEFAULT_ENGINEERING, fluid: "GHe" }
  };
  const netB: PidNet = {
    id: "net-feed-b",
    tag: "P-102",
    lineClass: "process",
    props: { ...DEFAULT_ENGINEERING, fluid: "GHe" }
  };
  doc.nets = [netA, netB];
  doc.edges = [
    {
      id: "line-1",
      type: "pidLine",
      source: "source-1",
      target: "valve-1",
      sourceHandle: "right",
      targetHandle: "left",
      label: netA.tag,
      data: {
        ...DEFAULT_ENGINEERING,
        fluid: "GHe",
        color: "#243248",
        thickness: 2.5,
        routing: "auto",
        lineClass: "process",
        netId: netA.id,
        tag: netA.tag
      }
    },
    {
      id: "line-2",
      type: "pidLine",
      source: "valve-1",
      target: "sink-1",
      sourceHandle: "right",
      targetHandle: "left",
      label: netB.tag,
      data: {
        ...DEFAULT_ENGINEERING,
        fluid: "GHe",
        color: "#243248",
        thickness: 2.5,
        routing: "auto",
        lineClass: "process",
        netId: netB.id,
        tag: netB.tag
      }
    }
  ];
  return doc;
}

/** All line tags currently used by nets or edges. */
export function collectUsedTags(doc: Pick<PidDocument, "nets" | "edges">, exceptNetIds: string[] = []): Set<string> {
  const skip = new Set(exceptNetIds);
  const used = new Set<string>();
  for (const net of doc.nets) {
    if (skip.has(net.id)) continue;
    if (net.tag) used.add(net.tag);
  }
  for (const edge of doc.edges) {
    if (edge.data?.netId && skip.has(edge.data.netId)) continue;
    const tag = edge.data?.tag ?? (typeof edge.label === "string" ? edge.label : "");
    if (tag) used.add(String(tag));
  }
  return used;
}

export function nextLineTag(
  netsOrDoc: PidNet[] | Pick<PidDocument, "nets" | "edges">,
  lineClass: LineClassId | string = "process",
  exceptNetIds: string[] = []
): string {
  const prefixes: Record<string, string> = {
    process: "P",
    instrument: "I",
    pneumatic: "A",
    hydraulic: "H",
    vent: "V",
    electrical: "E"
  };
  const resolved = prefixes[String(lineClass)] ?? (/^[A-Z]$/i.test(String(lineClass)) ? String(lineClass).toUpperCase() : "P");
  const used = Array.isArray(netsOrDoc)
    ? new Set(netsOrDoc.filter((net) => !exceptNetIds.includes(net.id)).map((net) => net.tag))
    : collectUsedTags(netsOrDoc, exceptNetIds);
  let n = 101;
  while (used.has(`${resolved}-${n}`)) n += 1;
  return `${resolved}-${n}`;
}

/** Return tag if unique, otherwise the next available tag for that class. */
export function ensureUniqueTag(
  doc: Pick<PidDocument, "nets" | "edges">,
  tag: string,
  lineClass: LineClassId | string = "process",
  exceptNetIds: string[] = []
): string {
  const trimmed = tag.trim();
  if (!trimmed) return nextLineTag(doc, lineClass, exceptNetIds);
  const used = collectUsedTags(doc, exceptNetIds);
  if (!used.has(trimmed)) return trimmed;
  return nextLineTag(doc, lineClass, exceptNetIds);
}

export function lineClassById(doc: PidDocument, id: LineClassId | undefined) {
  return doc.lineClasses.find((item) => item.id === id) ?? doc.lineClasses[0];
}

export function allSymbols(doc: PidDocument): PidSymbolDefinition[] {
  return [...BUILT_IN_SYMBOLS, ...doc.symbols];
}

export function nodeSize(node: Node): { width: number; height: number } {
  return {
    width: Number(node.style?.width ?? node.width ?? 100),
    height: Number(node.style?.height ?? node.height ?? 100)
  };
}

export function portWorldPosition(
  node: Node<PidNodeData>,
  portId: string | null | undefined,
  symbols: PidSymbolDefinition[],
  fallbackX = 50
): Point {
  const { width, height } = nodeSize(node);
  const symbol = symbols.find((item) => item.id === node.data.symbolType);
  const port = symbol?.ports.find((item) => item.id === portId);
  let localX = ((port?.x ?? fallbackX) / 100) * width;
  let localY = ((port?.y ?? 50) / 100) * height;
  if (node.data.mirrorX) localX = width - localX;
  if (node.data.mirrorY) localY = height - localY;
  const angle = ((node.data.rotation ?? 0) * Math.PI) / 180;
  const offsetX = localX - width / 2;
  const offsetY = localY - height / 2;
  return {
    x: node.position.x + width / 2 + offsetX * Math.cos(angle) - offsetY * Math.sin(angle),
    y: node.position.y + height / 2 + offsetX * Math.sin(angle) + offsetY * Math.cos(angle)
  };
}

export function symbolObstacles(
  nodes: Node<PidNodeData>[],
  excludeIds: string[] = []
): { x: number; y: number; width: number; height: number }[] {
  const exclude = new Set(excludeIds);
  return nodes
    .filter((node) => !exclude.has(node.id) && node.data.kind !== "junction" && node.data.kind !== "terminal")
    .map((node) => {
      const { width, height } = nodeSize(node);
      return { x: node.position.x, y: node.position.y, width, height };
    });
}

export function makeJunctionNode(junction: PidJunction): Node<PidNodeData> {
  return {
    id: junction.id,
    type: "pidSymbol",
    position: { x: junction.position.x - 6, y: junction.position.y - 6 },
    style: { width: 12, height: 12 },
    draggable: true,
    data: {
      label: "",
      symbolType: "junction",
      rotation: 0,
      kind: "junction",
      junctionKind: junction.kind,
      netId: junction.netId
    }
  };
}

/** Free route endpoint — draggable, 1-leg allowed, not cleaned up as an orphan junction. */
export function makeTerminalNode(id: string, position: Point, netId?: string): Node<PidNodeData> {
  return {
    id,
    type: "pidSymbol",
    position: { x: position.x - 6, y: position.y - 6 },
    style: { width: 12, height: 12 },
    draggable: true,
    data: {
      label: "",
      symbolType: "terminal",
      rotation: 0,
      kind: "terminal",
      netId
    }
  };
}

/** Nearest symbol port to a world-space cursor (for route start / finish). */
export function nearestPortAt(
  nodes: Node<PidNodeData>[],
  symbols: PidSymbolDefinition[],
  cursor: Point,
  threshold = 28
): { nodeId: string; portId: string; point: Point } | null {
  let best: { nodeId: string; portId: string; point: Point; dist: number } | null = null;
  for (const node of nodes) {
    if (node.data.kind === "junction" || node.data.kind === "terminal") {
      const point = {
        x: node.position.x + nodeSize(node).width / 2,
        y: node.position.y + nodeSize(node).height / 2
      };
      const dist = Math.hypot(cursor.x - point.x, cursor.y - point.y);
      if (dist <= threshold && (!best || dist < best.dist)) {
        best = { nodeId: node.id, portId: "center", point, dist };
      }
      continue;
    }
    const def = symbols.find((symbol) => symbol.id === node.data.symbolType);
    for (const port of def?.ports ?? []) {
      const point = portWorldPosition(node, port.id, symbols, 50);
      const dist = Math.hypot(cursor.x - point.x, cursor.y - point.y);
      if (dist <= threshold && (!best || dist < best.dist)) {
        best = { nodeId: node.id, portId: port.id, point, dist };
      }
    }
  }
  return best ? { nodeId: best.nodeId, portId: best.portId, point: best.point } : null;
}

export function engineeringFromEdge(data?: Partial<PidEdgeData>): EngineeringLineProps {
  return {
    fluid: data?.fluid ?? DEFAULT_ENGINEERING.fluid,
    pressure_bar: data?.pressure_bar ?? null,
    temperature_c: data?.temperature_c ?? null,
    diameter_mm: data?.diameter_mm ?? null,
    material: data?.material ?? "",
    flow_direction: data?.flow_direction ?? "forward"
  };
}

export function applyNetPropsToEdges(
  edges: Edge<PidEdgeData>[],
  netId: string,
  patch: Partial<PidEdgeData>
): Edge<PidEdgeData>[] {
  return edges.map((edge) =>
    edge.data?.netId === netId ? { ...edge, data: { ...edge.data, ...patch }, label: patch.tag ?? edge.label } : edge
  );
}

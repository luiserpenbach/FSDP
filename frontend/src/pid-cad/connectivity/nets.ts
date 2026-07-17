import type { Edge, Node } from "reactflow";
import {
  DEFAULT_ENGINEERING,
  type LineClassId,
  type PidDocument,
  type PidEdgeData,
  type PidJunction,
  type PidNet,
  type PidNodeData,
  type Point
} from "../model/types";
import { makeJunctionNode, nextLineTag, ensureUniqueTag } from "../model/document";
import { resolveWaypoints } from "../routing/orthogonal";

export type RouteEndpoint =
  | { kind: "port"; nodeId: string; portId: string }
  | { kind: "junction"; junctionId: string }
  | { kind: "point"; point: Point };

/**
 * Hit-test orthogonal edge polylines; return nearest edge within threshold.
 */
export function hitTestEdge(
  edges: Edge<PidEdgeData>[],
  pointLookup: (edge: Edge<PidEdgeData>) => Point[],
  cursor: Point,
  threshold = 10
): { edge: Edge<PidEdgeData>; point: Point; segmentIndex: number } | null {
  let best: { edge: Edge<PidEdgeData>; point: Point; segmentIndex: number; dist: number } | null = null;
  for (const edge of edges) {
    const points = pointLookup(edge);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const hit = closestOnSegment(a, b, cursor);
      if (hit.dist <= threshold && (!best || hit.dist < best.dist)) {
        best = { edge, point: hit.point, segmentIndex: i, dist: hit.dist };
      }
    }
  }
  return best ? { edge: best.edge, point: best.point, segmentIndex: best.segmentIndex } : null;
}

function closestOnSegment(a: Point, b: Point, p: Point): { point: Point; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}

export function createNet(
  doc: PidDocument,
  lineClass: LineClassId = "process",
  tag?: string
): { doc: PidDocument; net: PidNet } {
  const resolvedTag = tag
    ? ensureUniqueTag(doc, tag, lineClass)
    : doc.settings.autoLineTags
      ? nextLineTag(doc, lineClass)
      : ensureUniqueTag(doc, "LINE", lineClass);
  const net: PidNet = {
    id: `net-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    tag: resolvedTag,
    lineClass,
    props: { ...DEFAULT_ENGINEERING }
  };
  return { doc: { ...doc, nets: [...doc.nets, net] }, net };
}

/**
 * Split an existing edge at a point, insert a junction node, and attach a new branch.
 */
export function teeOntoEdge(
  doc: PidDocument,
  edgeId: string,
  teePoint: Point,
  from: { nodeId: string; portId: string },
  waypointsToTee: Point[]
): PidDocument {
  const edge = doc.edges.find((item) => item.id === edgeId);
  if (!edge) return doc;

  const netId = edge.data?.netId ?? `net-${Date.now()}`;
  let nets = doc.nets;
  if (!edge.data?.netId) {
    nets = [
      ...doc.nets,
      {
        id: netId,
        tag: String(edge.label ?? nextLineTag(doc, edge.data?.lineClass ?? "process")),
        lineClass: edge.data?.lineClass ?? "process",
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
  }

  const junctionId = `junc-${Date.now()}`;
  const junction: PidJunction = {
    id: junctionId,
    position: teePoint,
    kind: "tee",
    netId
  };

  const lineClass = doc.lineClasses.find((c) => c.id === (edge.data?.lineClass ?? "process")) ?? doc.lineClasses[0];
  const sharedData: PidEdgeData = {
    fluid: edge.data?.fluid ?? "TBD",
    pressure_bar: edge.data?.pressure_bar ?? null,
    temperature_c: edge.data?.temperature_c ?? null,
    diameter_mm: edge.data?.diameter_mm ?? null,
    material: edge.data?.material ?? "",
    flow_direction: edge.data?.flow_direction ?? "forward",
    color: lineClass.color,
    thickness: lineClass.thickness,
    locked: edge.data?.locked,
    netId,
    lineClass: lineClass.id,
    tag: nets.find((n) => n.id === netId)?.tag,
    routing: "manual"
  };

  const left: Edge<PidEdgeData> = {
    ...edge,
    id: `${edge.id}-a`,
    target: junctionId,
    targetHandle: "center",
    data: { ...sharedData, waypoints: [] }
  };
  const right: Edge<PidEdgeData> = {
    ...edge,
    id: `${edge.id}-b`,
    source: junctionId,
    sourceHandle: "center",
    data: { ...sharedData, waypoints: [] }
  };
  const branch: Edge<PidEdgeData> = {
    id: `line-${Date.now()}`,
    type: "pidLine",
    source: from.nodeId,
    target: junctionId,
    sourceHandle: from.portId,
    targetHandle: "center",
    label: sharedData.tag,
    data: {
      ...sharedData,
      routing: "manual",
      waypoints: waypointsToTee.slice(1, -1)
    }
  };

  const junctionNode = makeJunctionNode(junction);
  return {
    ...doc,
    nets,
    junctions: [...doc.junctions, junction],
    nodes: [...doc.nodes, junctionNode],
    edges: [...doc.edges.filter((item) => item.id !== edgeId), left, right, branch]
  };
}

export function connectedPortKeys(edges: Edge<PidEdgeData>[]): Set<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    if (edge.sourceHandle) keys.add(`${edge.source}:${edge.sourceHandle}`);
    if (edge.targetHandle) keys.add(`${edge.target}:${edge.targetHandle}`);
    // Junction center counts as connected
    keys.add(`${edge.source}:center`);
    keys.add(`${edge.target}:center`);
  }
  return keys;
}

export function edgeEndpointsForLookup(
  edge: Edge<PidEdgeData>,
  nodes: Node<PidNodeData>[],
  portPos: (node: Node<PidNodeData>, handle: string | null | undefined, fallback: number) => Point
): Point[] {
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  if (!source || !target) return [];
  const start = portPos(source, edge.sourceHandle, 100);
  const end = portPos(target, edge.targetHandle, 0);
  return resolveWaypoints(start, end, edge.data?.waypoints);
}

/**
 * Remove orphan junctions and collapse 2-leg junctions into a single edge.
 * Updates tee/cross kind from incident edge count.
 */
export function cleanupJunctions(doc: PidDocument): PidDocument {
  let nodes = [...doc.nodes];
  let edges = [...doc.edges];
  let junctions = [...doc.junctions];

  const incident = (junctionId: string) => edges.filter((edge) => edge.source === junctionId || edge.target === junctionId);

  for (const junction of [...junctions]) {
    const connected = incident(junction.id);
    if (connected.length === 0) {
      junctions = junctions.filter((item) => item.id !== junction.id);
      nodes = nodes.filter((node) => node.id !== junction.id);
      continue;
    }
    if (connected.length === 1) {
      // Dangling stub — drop the lone edge and junction.
      const lone = connected[0];
      edges = edges.filter((edge) => edge.id !== lone.id);
      junctions = junctions.filter((item) => item.id !== junction.id);
      nodes = nodes.filter((node) => node.id !== junction.id);
      continue;
    }
    if (connected.length === 2) {
      const [a, b] = connected;
      const otherA = a.source === junction.id ? a.target : a.source;
      const handleA = a.source === junction.id ? a.targetHandle : a.sourceHandle;
      const otherB = b.source === junction.id ? b.target : b.source;
      const handleB = b.source === junction.id ? b.targetHandle : b.sourceHandle;
      const merged: Edge<PidEdgeData> = {
        ...a,
        id: `line-merge-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        source: otherA,
        target: otherB,
        sourceHandle: handleA,
        targetHandle: handleB,
        data: {
          ...a.data,
          ...b.data,
          waypoints: [...(a.data?.waypoints ?? []), ...(b.data?.waypoints ?? [])],
          routing: "manual"
        }
      };
      edges = [...edges.filter((edge) => edge.id !== a.id && edge.id !== b.id), merged];
      junctions = junctions.filter((item) => item.id !== junction.id);
      nodes = nodes.filter((node) => node.id !== junction.id);
      continue;
    }
    const kind = connected.length >= 4 ? "cross" : "tee";
    junctions = junctions.map((item) => (item.id === junction.id ? { ...item, kind } : item));
    nodes = nodes.map((node) =>
      node.id === junction.id ? { ...node, data: { ...node.data, junctionKind: kind } } : node
    );
  }

  return { ...doc, nodes, edges, junctions };
}

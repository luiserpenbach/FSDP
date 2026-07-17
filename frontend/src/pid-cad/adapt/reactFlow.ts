import type { Edge, Node } from "reactflow";
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_ENGINEERING,
  DEFAULT_LINE_CLASSES,
  type PidDocument,
  type PidEdgeData,
  type PidEditorSettings,
  type PidJunction,
  type PidNet,
  type PidNodeData,
  type PidSymbolDefinition
} from "../model/types";
import { createStarterDocument, engineeringFromEdge, makeJunctionNode } from "../model/document";

export type LegacyGraph = {
  version?: number;
  nodes?: Node[];
  edges?: Edge[];
  editorSettings?: Partial<PidEditorSettings>;
  symbols?: PidSymbolDefinition[];
  nets?: PidNet[];
  junctions?: PidJunction[];
  lineClasses?: PidDocument["lineClasses"];
};

export function normalizeNode(node: Node): Node<PidNodeData> {
  const kind =
    node.data?.kind === "junction" || node.data?.symbolType === "junction"
      ? "junction"
      : node.data?.kind === "terminal" || node.data?.symbolType === "terminal"
        ? "terminal"
        : "symbol";
  return {
    ...node,
    type: "pidSymbol",
    style:
      kind === "junction" || kind === "terminal"
        ? { ...node.style, width: 12, height: 12 }
        : { ...node.style, width: 100, height: 100 },
    data: {
      label: String(node.data?.label ?? (kind === "junction" || kind === "terminal" ? "" : node.id)),
      symbolType: String(node.data?.symbolType ?? node.type ?? "valve"),
      rotation: Number(node.data?.rotation ?? 0),
      mirrorX: Boolean(node.data?.mirrorX),
      mirrorY: Boolean(node.data?.mirrorY),
      locked: Boolean(node.data?.locked),
      kind,
      junctionKind: node.data?.junctionKind,
      netId: node.data?.netId,
      offPageRef: node.data?.offPageRef ? String(node.data.offPageRef) : undefined,
      offPageSide: node.data?.offPageSide === "to" ? "to" : node.data?.offPageSide === "from" ? "from" : undefined
    }
  };
}

export function normalizeEdge(edge: Edge): Edge<PidEdgeData> {
  const data = (edge.data ?? {}) as PidEdgeData;
  const waypoints = Array.isArray(data.waypoints) ? data.waypoints : undefined;
  const hasLegacyRoute = data.startX !== undefined || data.bendX !== undefined || data.bendY !== undefined;
  const engineering = engineeringFromEdge(data);
  return {
    ...edge,
    type: "pidLine",
    data: {
      ...engineering,
      ...data,
      color: data.color ?? "#243248",
      thickness: data.thickness ?? 2,
      routing: data.routing ?? (waypoints || hasLegacyRoute ? "manual" : "auto"),
      lineClass: data.lineClass ?? "process",
      waypoints,
      locked: Boolean(data.locked),
      tag: data.tag ?? (typeof edge.label === "string" ? edge.label : undefined)
    }
  };
}

export function graphToDocument(graph: LegacyGraph | undefined | null): PidDocument {
  if (!graph || (!graph.nodes?.length && !graph.edges?.length && graph.version !== 2)) {
    return createStarterDocument();
  }

  const nodes = (graph.nodes ?? []).map(normalizeNode);
  const edges = (graph.edges ?? []).map(normalizeEdge);
  const junctions =
    graph.junctions ??
    nodes
      .filter((n) => n.data.kind === "junction")
      .map((n) => ({
        id: n.id,
        position: { x: n.position.x + 6, y: n.position.y + 6 },
        kind: (n.data.junctionKind ?? "tee") as PidJunction["kind"],
        netId: n.data.netId ?? ""
      }));

  let nets = graph.nets ?? [];
  if (nets.length === 0) {
    const byNet = new Map<string, Edge<PidEdgeData>[]>();
    for (const edge of edges) {
      const key = edge.data?.netId ?? edge.id;
      const list = byNet.get(key) ?? [];
      list.push(edge);
      byNet.set(key, list);
    }
    nets = [...byNet.entries()].map(([id, group]) => {
      const sample = group[0]?.data;
      return {
        id,
        tag: sample?.tag ?? String(group[0]?.label ?? id),
        lineClass: sample?.lineClass ?? "process",
        props: engineeringFromEdge(sample)
      };
    });
  }

  // Ensure junction nodes exist for declared junctions
  const nodeIds = new Set(nodes.map((n) => n.id));
  const withJunctions = [...nodes];
  for (const junction of junctions) {
    if (!nodeIds.has(junction.id)) {
      withJunctions.push(makeJunctionNode(junction));
    }
  }

  return {
    version: 2,
    nodes: withJunctions,
    edges,
    nets,
    junctions,
    lineClasses: graph.lineClasses?.length ? graph.lineClasses : DEFAULT_LINE_CLASSES.map((c) => ({ ...c })),
    symbols: graph.symbols ?? [],
    settings: { ...DEFAULT_EDITOR_SETTINGS, ...graph.editorSettings }
  };
}

export function documentToGraph(doc: PidDocument) {
  return {
    version: 2 as const,
    nodes: doc.nodes,
    edges: doc.edges,
    nets: doc.nets,
    junctions: doc.junctions,
    lineClasses: doc.lineClasses,
    editorSettings: doc.settings,
    symbols: doc.symbols
  };
}

export function documentToApiPayload(doc: PidDocument) {
  const graph = documentToGraph(doc);
  return {
    graph,
    nodes: doc.nodes.map((node) => ({
      external_id: node.id,
      node_type: String(node.data?.symbolType ?? (node.data?.kind === "junction" ? "junction" : "component")),
      label: String(node.data?.label ?? node.id),
      position: node.position,
      properties: { ...(node.data ?? {}), style: node.style ?? {} }
    })),
    edges: doc.edges.map((edge) => ({
      external_id: edge.id,
      source_node_id: edge.source,
      target_node_id: edge.target,
      fluid: edge.data?.fluid ?? DEFAULT_ENGINEERING.fluid,
      pressure_bar: edge.data?.pressure_bar ?? null,
      temperature_c: edge.data?.temperature_c ?? null,
      diameter_mm: edge.data?.diameter_mm ?? null,
      material: edge.data?.material || null,
      flow_direction: edge.data?.flow_direction ?? "forward",
      properties: {
        label: edge.label,
        netId: edge.data?.netId,
        tag: edge.data?.tag,
        lineClass: edge.data?.lineClass,
        waypoints: edge.data?.waypoints,
        routing: edge.data?.routing,
        color: edge.data?.color,
        thickness: edge.data?.thickness,
        locked: edge.data?.locked,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle
      }
    }))
  };
}

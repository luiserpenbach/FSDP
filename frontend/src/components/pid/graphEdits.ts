import type { Edge, Node } from "reactflow";

/** First section whose bounds contain the (absolute) flow point, if any. */
export function sectionContainingPoint<N extends Node>(
  nodes: N[],
  point: { x: number; y: number }
): N | undefined {
  return nodes.find((node) => {
    if (node.type !== "pidSection") return false;
    const width = node.width ?? Number(node.style?.width ?? 0);
    const height = node.height ?? Number(node.style?.height ?? 0);
    return (
      point.x >= node.position.x &&
      point.x <= node.position.x + width &&
      point.y >= node.position.y &&
      point.y <= node.position.y + height
    );
  });
}

/**
 * Parent a node to the section under its center, converting an absolute
 * top-left into section-relative coordinates. Used when placing join
 * junctions (and by drag-stop reparenting) so section moves keep contents.
 */
export function attachToSectionAtAbsolutePosition<N extends Node>(
  node: N,
  nodes: N[],
  absoluteTopLeft: { x: number; y: number },
  size: { width: number; height: number }
): N {
  const center = {
    x: absoluteTopLeft.x + size.width / 2,
    y: absoluteTopLeft.y + size.height / 2
  };
  const section = sectionContainingPoint(nodes, center);
  if (!section) {
    return { ...node, parentNode: undefined, position: absoluteTopLeft };
  }
  return {
    ...node,
    parentNode: section.id,
    position: {
      x: absoluteTopLeft.x - section.position.x,
      y: absoluteTopLeft.y - section.position.y
    }
  };
}

/**
 * Stamp a placed component tag onto a node in the current canvas list.
 * Callers must pass the live node array (e.g. nodesRef.current) — not a
 * snapshot frozen before an async createComponent — or mid-place edits are lost.
 */
export function applyComponentTagToNodes<N extends Node>(
  nodes: N[],
  nodeId: string,
  tag: string
): N[] {
  return nodes.map((entry) =>
    entry.id === nodeId
      ? { ...entry, data: { ...(entry.data as Record<string, unknown>), tag } }
      : entry
  );
}

/**
 * Choose which canvas to write after placeComponent's createComponent returns.
 * Live refs are correct only while still viewing the placed diagram; after a
 * mid-place diagram switch they belong to another canvas and must not be PUT
 * onto the diagram that received the component.
 */
export function resolvePlaceComponentGraphWrite<N extends Node, E extends Edge>(options: {
  placedDiagramId: string;
  currentDiagramId: string | null | undefined;
  liveNodes: N[];
  liveEdges: E[];
  serverNodes: N[];
  serverEdges: E[];
  nodeId: string;
  tag: string;
}): { nodes: N[]; edges: E[]; source: "live" | "server" } {
  const useLive = options.currentDiagramId === options.placedDiagramId;
  const nodes = applyComponentTagToNodes(
    useLive ? options.liveNodes : options.serverNodes,
    options.nodeId,
    options.tag
  );
  return {
    nodes,
    edges: useLive ? options.liveEdges : options.serverEdges,
    source: useLive ? "live" : "server"
  };
}

/**
 * Remove nodes by id without React Flow's parent cascade.
 * Sections release their children (absolute positions restored) so Delete
 * matches the toolbar/context-menu "Delete section (keep contents)" action.
 */
export function removeNodesKeepingSectionContents<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
  idsToRemove: Iterable<string>,
  edgeIdsToRemove: Iterable<string> = []
): { nodes: N[]; edges: E[] } {
  const removeIds = new Set(idsToRemove);
  const removeEdgeIds = new Set(edgeIdsToRemove);
  if (!removeIds.size && !removeEdgeIds.size) {
    return { nodes, edges };
  }

  const parentPositions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (removeIds.has(node.id)) {
      parentPositions.set(node.id, node.position);
    }
  }

  const nextNodes = nodes
    .filter((node) => !removeIds.has(node.id))
    .map((node) => {
      const parentId = node.parentNode;
      if (!parentId || !removeIds.has(parentId)) return node;
      const parentPos = parentPositions.get(parentId);
      if (!parentPos) {
        return { ...node, parentNode: undefined };
      }
      return {
        ...node,
        parentNode: undefined,
        position: {
          x: node.position.x + parentPos.x,
          y: node.position.y + parentPos.y
        }
      };
    });

  const nextEdges = edges.filter(
    (edge) =>
      !removeEdgeIds.has(edge.id) && !removeIds.has(edge.source) && !removeIds.has(edge.target)
  );

  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * Whether Save may PUT the live canvas for the current diagram selection.
 * `readyGeneration` is set only after getDiagram installs the graph; a failed
 * load leaves the empty placeholder bound to the diagram id and must not save.
 */
export function isDiagramGraphReadyToSave(
  loadGeneration: number,
  readyGeneration: number
): boolean {
  return readyGeneration === loadGeneration;
}


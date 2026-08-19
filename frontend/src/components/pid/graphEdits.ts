import type { Edge, Node } from "reactflow";

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

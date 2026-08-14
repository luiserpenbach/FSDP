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

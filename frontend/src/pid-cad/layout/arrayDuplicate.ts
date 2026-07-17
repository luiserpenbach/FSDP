import type { Edge, Node } from "reactflow";
import type { PidEdgeData, PidNodeData } from "../model/types";

export type ArrayOptions = {
  columns: number;
  rows: number;
  gapX: number;
  gapY: number;
  idFactory: () => string;
};

/**
 * Create a rectangular array of the selected subgraph (symbols + edges with both ends selected).
 * Returns new nodes/edges only (caller merges into document).
 */
export function arrayDuplicateSelection(
  nodes: Node<PidNodeData>[],
  edges: Edge<PidEdgeData>[],
  selectedIds: string[],
  options: ArrayOptions
): { nodes: Node<PidNodeData>[]; edges: Edge<PidEdgeData>[] } {
  const idSet = new Set(selectedIds.filter((id) => nodes.find((n) => n.id === id)?.data.kind !== "junction"));
  const sourceNodes = nodes.filter((node) => idSet.has(node.id));
  if (!sourceNodes.length) return { nodes: [], edges: [] };

  const sourceEdges = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target));
  const cols = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  const outNodes: Node<PidNodeData>[] = [];
  const outEdges: Edge<PidEdgeData>[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (row === 0 && col === 0) continue;
      const idMap = new Map<string, string>();
      const offsetX = col * options.gapX;
      const offsetY = row * options.gapY;
      for (const node of sourceNodes) {
        const id = options.idFactory();
        idMap.set(node.id, id);
        outNodes.push({
          ...node,
          id,
          position: { x: node.position.x + offsetX, y: node.position.y + offsetY },
          selected: true
        });
      }
      for (const edge of sourceEdges) {
        outEdges.push({
          ...edge,
          id: `line-${options.idFactory()}`,
          source: idMap.get(edge.source)!,
          target: idMap.get(edge.target)!,
          data: {
            ...edge.data,
            waypoints: edge.data?.waypoints?.map((point) => ({
              x: point.x + offsetX,
              y: point.y + offsetY
            }))
          }
        });
      }
    }
  }

  return { nodes: outNodes, edges: outEdges };
}

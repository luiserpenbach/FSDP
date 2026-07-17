import type { Node } from "reactflow";
import { nodeSize } from "../model/document";
import type { PidNodeData, Point } from "../model/types";

export type AlignMode = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
export type DistributeAxis = "horizontal" | "vertical";

function bounds(node: Node<PidNodeData>) {
  const size = nodeSize(node);
  return {
    left: node.position.x,
    right: node.position.x + size.width,
    top: node.position.y,
    bottom: node.position.y + size.height,
    cx: node.position.x + size.width / 2,
    cy: node.position.y + size.height / 2,
    width: size.width,
    height: size.height
  };
}

/** Align selected symbols (junctions ignored unless included in ids). */
export function alignNodes(
  nodes: Node<PidNodeData>[],
  ids: string[],
  mode: AlignMode
): Node<PidNodeData>[] {
  const idSet = new Set(ids);
  const targets = nodes.filter((node) => idSet.has(node.id) && !node.data.locked);
  if (targets.length < 2) return nodes;

  const boxes = targets.map(bounds);
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  return nodes.map((node) => {
    if (!idSet.has(node.id) || node.data.locked) return node;
    const box = bounds(node);
    let position: Point = { ...node.position };
    if (mode === "left") position = { x: left, y: node.position.y };
    if (mode === "right") position = { x: right - box.width, y: node.position.y };
    if (mode === "top") position = { x: node.position.x, y: top };
    if (mode === "bottom") position = { x: node.position.x, y: bottom - box.height };
    if (mode === "centerX") position = { x: centerX - box.width / 2, y: node.position.y };
    if (mode === "centerY") position = { x: node.position.x, y: centerY - box.height / 2 };
    return { ...node, position };
  });
}

/** Evenly distribute selected symbols along an axis (by center). */
export function distributeNodes(
  nodes: Node<PidNodeData>[],
  ids: string[],
  axis: DistributeAxis
): Node<PidNodeData>[] {
  const idSet = new Set(ids);
  const targets = nodes
    .filter((node) => idSet.has(node.id) && !node.data.locked)
    .sort((a, b) => (axis === "horizontal" ? a.position.x - b.position.x : a.position.y - b.position.y));
  if (targets.length < 3) return nodes;

  const first = bounds(targets[0]);
  const last = bounds(targets[targets.length - 1]);
  const start = axis === "horizontal" ? first.cx : first.cy;
  const end = axis === "horizontal" ? last.cx : last.cy;
  const step = (end - start) / (targets.length - 1);
  const nextPos = new Map<string, Point>();

  targets.forEach((node, index) => {
    const box = bounds(node);
    if (axis === "horizontal") {
      nextPos.set(node.id, { x: start + step * index - box.width / 2, y: node.position.y });
    } else {
      nextPos.set(node.id, { x: node.position.x, y: start + step * index - box.height / 2 });
    }
  });

  return nodes.map((node) => {
    const position = nextPos.get(node.id);
    return position ? { ...node, position } : node;
  });
}

/** Nudge selected nodes by a delta (arrow-key support). */
export function nudgeNodes(
  nodes: Node<PidNodeData>[],
  ids: string[],
  delta: Point
): Node<PidNodeData>[] {
  const idSet = new Set(ids);
  return nodes.map((node) => {
    if (!idSet.has(node.id) || node.data.locked) return node;
    return {
      ...node,
      position: { x: node.position.x + delta.x, y: node.position.y + delta.y }
    };
  });
}

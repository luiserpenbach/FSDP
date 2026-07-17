import type { Edge } from "reactflow";
import type { PidEdgeData, Point } from "../model/types";
import { simplify } from "./orthogonal";

/**
 * Push-and-shove: when a manual segment moves, shift intersecting auto-routed
 * segments of other nets by the same delta (soft fail for locked/manual).
 */
export function shoveEdges(
  edges: Edge<PidEdgeData>[],
  movedEdgeId: string,
  oldPoints: Point[],
  newPoints: Point[],
  segmentIndex: number
): Edge<PidEdgeData>[] {
  const oldA = oldPoints[segmentIndex];
  const oldB = oldPoints[segmentIndex + 1];
  const newA = newPoints[segmentIndex];
  const newB = newPoints[segmentIndex + 1];
  if (!oldA || !oldB || !newA || !newB) return edges;

  const horizontal = Math.abs(oldA.y - oldB.y) < 0.5;
  const delta = horizontal ? newA.y - oldA.y : newA.x - oldA.x;
  if (Math.abs(delta) < 0.5) return edges;

  const moved = edges.find((edge) => edge.id === movedEdgeId);
  const movedNet = moved?.data?.netId;

  return edges.map((edge) => {
    if (edge.id === movedEdgeId) return edge;
    if (edge.data?.routing === "manual" || edge.data?.locked) return edge;
    if (movedNet && edge.data?.netId === movedNet) return edge;

    const data = edge.data ?? {};
    const wps = [...(data.waypoints ?? [])];
    if (wps.length < 2) return edge;
    let changed = false;
    for (let i = 0; i < wps.length - 1; i += 1) {
      const a = wps[i];
      const b = wps[i + 1];
      const segH = Math.abs(a.y - b.y) < 0.5;
      if (segH !== horizontal) continue;
      if (horizontal) {
        if (Math.abs(a.y - oldA.y) > 14) continue;
        const overlap =
          Math.max(Math.min(a.x, b.x), Math.min(oldA.x, oldB.x)) <
          Math.min(Math.max(a.x, b.x), Math.max(oldA.x, oldB.x));
        if (!overlap) continue;
        wps[i] = { ...a, y: a.y + delta };
        wps[i + 1] = { ...b, y: b.y + delta };
        changed = true;
      } else {
        if (Math.abs(a.x - oldA.x) > 14) continue;
        const overlap =
          Math.max(Math.min(a.y, b.y), Math.min(oldA.y, oldB.y)) <
          Math.min(Math.max(a.y, b.y), Math.max(oldA.y, oldB.y));
        if (!overlap) continue;
        wps[i] = { ...a, x: a.x + delta };
        wps[i + 1] = { ...b, x: b.x + delta };
        changed = true;
      }
    }
    if (!changed) return edge;
    return {
      ...edge,
      data: {
        ...data,
        waypoints: simplify(wps),
        routing: "auto" as const
      }
    };
  }) as Edge<PidEdgeData>[];
}

/** Concatenate endpoints + waypoints without inventing corners (segment edits). */
function rawPolyline(source: Point, target: Point, waypoints: Point[] | undefined): Point[] {
  const middle = (waypoints ?? []).map((point) => ({ x: point.x, y: point.y }));
  if (!middle.length) return [source, target];
  return [source, ...middle, target];
}

/**
 * KiCad-style orthogonal segment move.
 * Endpoint-adjacent drags rebuild a single stub+run (no nested S-bends).
 */
export function moveSegmentPoints(
  source: Point,
  target: Point,
  waypoints: Point[] | undefined,
  segmentIndex: number,
  position: Point
): Point[] {
  const points = rawPolyline(source, target, waypoints);
  if (segmentIndex < 0 || segmentIndex >= points.length - 1) return points;

  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  const horizontal = Math.abs(a.y - b.y) < 0.5;
  const isFirst = segmentIndex === 0;
  const isLast = segmentIndex === points.length - 2;

  // Interior segment: translate the whole run.
  if (!isFirst && !isLast) {
    const next = points.map((p) => ({ ...p }));
    if (horizontal) {
      next[segmentIndex] = { ...next[segmentIndex], y: position.y };
      next[segmentIndex + 1] = { ...next[segmentIndex + 1], y: position.y };
    } else {
      next[segmentIndex] = { ...next[segmentIndex], x: position.x };
      next[segmentIndex + 1] = { ...next[segmentIndex + 1], x: position.x };
    }
    return simplify(next);
  }

  // First segment: keep source fixed; rebuild one stub → join at points[2] (or target).
  if (isFirst) {
    const join = points.length >= 3 ? points[2] : target;
    const rest = points.length >= 3 ? points.slice(2) : [target];
    if (horizontal) {
      const y = position.y;
      return simplify([source, { x: source.x, y }, { x: join.x, y }, ...rest]);
    }
    const x = position.x;
    return simplify([source, { x, y: source.y }, { x, y: join.y }, ...rest]);
  }

  // Last segment: keep target fixed; rebuild one stub from points[n-3] (or source).
  const join = points.length >= 3 ? points[points.length - 3] : source;
  const head = points.length >= 3 ? points.slice(0, -2) : [source];
  if (horizontal) {
    const y = position.y;
    return simplify([...head, { x: join.x, y: join.y }, { x: join.x, y }, { x: target.x, y }, target]);
  }
  const x = position.x;
  return simplify([...head, { x: join.x, y: join.y }, { x, y: join.y }, { x, y: target.y }, target]);
}

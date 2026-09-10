/**
 * Cursor snapping: ports first, then existing line segments, then the grid.
 */
import { closestPointOnSegment, distance, snapPoint, snapValue } from "./geometry";
import type { IndexedPort } from "./connectivity";
import type { LineItem, Point, SchematicDocument } from "./types";

export type SnapResult =
  | { kind: "port"; point: Point; itemId: string; portId: string }
  | { kind: "segment"; point: Point; lineId: string; segmentIndex: number }
  | { kind: "vertex"; point: Point; lineId: string; index: number }
  | { kind: "grid"; point: Point };

export type SnapOptions = {
  grid: number;
  /** Snap radius in mm for ports and vertices. */
  portRadius: number;
  /** Snap radius in mm for line segments. */
  segmentRadius: number;
  /** Items to ignore (e.g. the line being drawn). */
  excludeIds?: Set<string>;
  snapToPorts?: boolean;
  snapToLines?: boolean;
};

export function snapCursor(doc: SchematicDocument, ports: IndexedPort[], raw: Point, options: SnapOptions): SnapResult {
  const exclude = options.excludeIds ?? new Set<string>();
  if (options.snapToPorts !== false) {
    let best: { port: IndexedPort; d: number } | null = null;
    for (const port of ports) {
      if (exclude.has(port.itemId)) continue;
      const d = distance(port.position, raw);
      if (d <= options.portRadius && (!best || d < best.d)) best = { port, d };
    }
    if (best) return { kind: "port", point: best.port.position, itemId: best.port.itemId, portId: best.port.id };
  }
  if (options.snapToLines !== false) {
    let bestVertex: { line: LineItem; index: number; d: number } | null = null;
    let bestSegment: { line: LineItem; index: number; point: Point; d: number } | null = null;
    for (const item of doc.items) {
      if (item.kind !== "line" || exclude.has(item.id)) continue;
      item.points.forEach((vertex, index) => {
        const d = distance(vertex, raw);
        if (d <= options.portRadius && (!bestVertex || d < bestVertex.d)) bestVertex = { line: item, index, d };
      });
      for (let index = 0; index < item.points.length - 1; index += 1) {
        const a = item.points[index];
        const b = item.points[index + 1];
        const hit = closestPointOnSegment(raw, a, b);
        if (hit.distance <= options.segmentRadius && (!bestSegment || hit.distance < bestSegment.d)) {
          // Keep the along-axis coordinate on grid so tees land on grid too.
          const point =
            a.x === b.x
              ? { x: a.x, y: clamp(snapValue(hit.point.y, options.grid), Math.min(a.y, b.y), Math.max(a.y, b.y)) }
              : { x: clamp(snapValue(hit.point.x, options.grid), Math.min(a.x, b.x), Math.max(a.x, b.x)), y: a.y };
          bestSegment = { line: item, index, point, d: hit.distance };
        }
      }
    }
    if (bestVertex) {
      const v = bestVertex as { line: LineItem; index: number };
      return { kind: "vertex", point: v.line.points[v.index], lineId: v.line.id, index: v.index };
    }
    if (bestSegment) {
      const s = bestSegment as { line: LineItem; index: number; point: Point };
      return { kind: "segment", point: s.point, lineId: s.line.id, segmentIndex: s.index };
    }
  }
  return { kind: "grid", point: snapPoint(raw, options.grid) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

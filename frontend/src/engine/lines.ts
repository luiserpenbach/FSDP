/**
 * Line helpers: positions along a polyline, crossings between unconnected
 * lines (drawn as hops), from/to descriptions, and legend entries.
 */
import { EPSILON, polylineLength } from "./geometry";
import type { Connectivity } from "./connectivity";
import type { EquipmentItem, Item, LineItem, LineType, Point, SchematicDocument, SymbolItem } from "./types";

export type PointAlong = { point: Point; direction: Point; segmentIndex: number };

/** Point at fraction `t` (0..1) of the polyline's length, with the unit travel direction there. */
export function pointAlong(points: Point[], t: number): PointAlong | null {
  if (points.length < 2) return null;
  const total = polylineLength(points);
  const target = Math.max(0, Math.min(1, t)) * total;
  let travelled = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    if (travelled + length >= target - EPSILON || index === points.length - 2) {
      const along = Math.min(length, Math.max(0, target - travelled));
      return { point: { x: a.x + direction.x * along, y: a.y + direction.y * along }, direction, segmentIndex: index };
    }
    travelled += length;
  }
  return null;
}

/** Fraction along the polyline closest to `point` (for placing annotations by click). */
export function fractionAlong(points: Point[], point: Point): number {
  const total = polylineLength(points);
  if (total === 0) return 0;
  let best = 0;
  let bestDistance = Infinity;
  let travelled = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)));
    const closest = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(point.x - closest.x, point.y - closest.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = (travelled + t * length) / total;
    }
    travelled += length;
  }
  return Math.round(best * 1000) / 1000;
}

/**
 * Crossing points between lines that are not connected there. Hops are drawn
 * on the horizontal segment; keyed by the line that carries the hop.
 *
 * Vertical segments are sorted by x so each horizontal segment only visits the
 * verticals inside its x-span (instead of every line pair). Output order
 * matches the pairwise scan: lines in input order, then for each line its hops
 * ordered by (crossing line, horizontal segment, vertical segment).
 */
export function computeCrossings(lines: LineItem[]): Map<string, Point[]> {
  // Vertical segments, sorted by x, in flat typed arrays.
  const found: Array<{ line: number; segment: number; x: number; y0: number; y1: number }> = [];
  lines.forEach((line, lineIndex) => {
    for (let u = 0; u < line.points.length - 1; u += 1) {
      const v0 = line.points[u];
      const v1 = line.points[u + 1];
      // A non-finite x can never lie strictly inside a horizontal run; keeping it out keeps the sort sane.
      if (v0.x !== v1.x || !Number.isFinite(v0.x)) continue;
      found.push({ line: lineIndex, segment: u, x: v0.x, y0: Math.min(v0.y, v1.y), y1: Math.max(v0.y, v1.y) });
    }
  });
  found.sort((a, b) => a.x - b.x);
  const count = found.length;
  const vx = new Float64Array(count);
  const vy0 = new Float64Array(count);
  const vy1 = new Float64Array(count);
  const vLine = new Int32Array(count);
  const vSegment = new Int32Array(count);
  found.forEach((vertical, k) => {
    vx[k] = vertical.x;
    vy0[k] = vertical.y0;
    vy1[k] = vertical.y1;
    vLine[k] = vertical.line;
    vSegment[k] = vertical.segment;
  });

  // Hops are collected as numeric sort keys of (crossing line, horizontal segment, vertical segment).
  const span = lines.reduce((max, line) => Math.max(max, line.points.length), 1);
  const result = new Map<string, Point[]>();
  const keys: number[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const horizontal = lines[lineIndex];
    keys.length = 0;
    for (let s = 0; s < horizontal.points.length - 1; s += 1) {
      const h0 = horizontal.points[s];
      const h1 = horizontal.points[s + 1];
      if (h0.y !== h1.y) continue;
      const low = Math.min(h0.x, h1.x) + EPSILON;
      const high = Math.max(h0.x, h1.x) - EPSILON;
      const y = h0.y;
      // First vertical strictly right of the run's start.
      let k = 0;
      let end = count;
      while (k < end) {
        const mid = (k + end) >>> 1;
        if (vx[mid] > low) end = mid;
        else k = mid + 1;
      }
      // Strictly interior on both segments: touching ends are tees, not crossings.
      for (; k < count && vx[k] < high; k += 1) {
        if (vLine[k] !== lineIndex && y > vy0[k] + EPSILON && y < vy1[k] - EPSILON) keys.push((vLine[k] * span + s) * span + vSegment[k]);
      }
    }
    if (!keys.length) continue;
    const sorted = new Float64Array(keys).sort();
    const hops: Point[] = new Array(sorted.length);
    for (let index = 0; index < sorted.length; index += 1) {
      const key = sorted[index];
      const u = key % span;
      const s = Math.floor(key / span) % span;
      const other = Math.floor(key / (span * span));
      hops[index] = { x: lines[other].points[u].x, y: horizontal.points[s].y };
    }
    const existing = result.get(horizontal.id);
    if (existing) existing.push(...hops);
    else result.set(horizontal.id, hops);
  }
  return result;
}

function itemTag(item: Item | undefined): string {
  if (!item) return "";
  if (item.kind === "symbol") return item.tag ?? item.label ?? "";
  if (item.kind === "equipment") return item.tag ?? item.name;
  return "";
}

/** "From" and "to" descriptions from what the line's ends touch. */
export function lineEndpoints(doc: SchematicDocument, connectivity: Connectivity, line: LineItem): { from: string; to: string } {
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const describe = (end: 0 | 1): string => {
    const lineEnd = connectivity.lineEnds.find((entry) => entry.lineId === line.id && entry.end === end);
    if (!lineEnd) return "";
    for (const attachment of lineEnd.attachments) {
      if (attachment.kind === "port") {
        const item = byId.get(attachment.itemId) as SymbolItem | EquipmentItem | undefined;
        const tag = itemTag(item);
        if (tag) return `${tag}${attachment.portId !== "in" && attachment.portId !== "out" ? ` (${attachment.portId})` : ""}`;
      }
    }
    for (const attachment of lineEnd.attachments) {
      if (attachment.kind === "line" || attachment.kind === "line-end") {
        const other = byId.get(attachment.lineId);
        if (other && other.kind === "line" && other.lineNumber) return `line ${other.lineNumber}`;
        return "tee";
      }
    }
    return "";
  };
  return { from: describe(0), to: describe(1) };
}

export type LineLegendEntry = { lineType: LineType; service?: string; count: number };

/** Distinct (line type, service) pairs on the sheet, most used first. */
export function lineLegendEntries(doc: SchematicDocument): LineLegendEntry[] {
  const counts = new Map<string, LineLegendEntry>();
  for (const item of doc.items) {
    if (item.kind !== "line") continue;
    const service = item.service?.trim() || undefined;
    const key = `${item.lineType}|${service ?? ""}`;
    const entry = counts.get(key) ?? { lineType: item.lineType, service, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.lineType.localeCompare(b.lineType));
}

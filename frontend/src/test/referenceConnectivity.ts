/**
 * Brute-force reference implementations of connectivity and crossings, kept
 * verbatim from before the spatial-index speed-up. Test-only: property tests
 * compare the fast engine against these on randomized documents.
 */
import {
  indexPorts,
  portMapKey,
  portsByPosition,
  type Connectivity,
  type LineEnd,
  type LineEndAttachment,
  type Net,
  type PortRef
} from "../engine/connectivity";
import { EPSILON, closestPointOnSegment, pointKey, pointsEqual } from "../engine/geometry";
import type { SymbolRegistry } from "../engine/library";
import type { LineItem, Point, SchematicDocument } from "../engine/types";

class UnionFind {
  private parent = new Map<string, string>();

  find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    if (!this.parent.has(key)) this.parent.set(key, key);
    // Path compression.
    let cursor = key;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

function lineKey(id: string): string {
  return `line:${id}`;
}

function portKeyOf(port: PortRef): string {
  return `port:${portMapKey(port.itemId, port.portId)}`;
}

export function referenceCrossings(lines: LineItem[]): Map<string, Point[]> {
  const result = new Map<string, Point[]>();
  const bounds = lines.map((line) => {
    const xs = line.points.map((point) => point.x);
    const ys = line.points.map((point) => point.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = 0; j < lines.length; j += 1) {
      if (i === j) continue;
      const a = bounds[i];
      const b = bounds[j];
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
      const horizontal = lines[i];
      const vertical = lines[j];
      for (let s = 0; s < horizontal.points.length - 1; s += 1) {
        const h0 = horizontal.points[s];
        const h1 = horizontal.points[s + 1];
        if (h0.y !== h1.y) continue;
        const hx0 = Math.min(h0.x, h1.x);
        const hx1 = Math.max(h0.x, h1.x);
        for (let u = 0; u < vertical.points.length - 1; u += 1) {
          const v0 = vertical.points[u];
          const v1 = vertical.points[u + 1];
          if (v0.x !== v1.x) continue;
          const vy0 = Math.min(v0.y, v1.y);
          const vy1 = Math.max(v0.y, v1.y);
          // Strictly interior on both segments: touching ends are tees, not crossings.
          if (v0.x > hx0 + EPSILON && v0.x < hx1 - EPSILON && h0.y > vy0 + EPSILON && h0.y < vy1 - EPSILON) {
            const bucket = result.get(horizontal.id) ?? [];
            bucket.push({ x: v0.x, y: h0.y });
            result.set(horizontal.id, bucket);
          }
        }
      }
    }
  }
  return result;
}

/** Where a point sits on a line: at an end, on a segment interior, or off it. */
function locateOnLine(line: LineItem, point: Point, tolerance = EPSILON):
  | { kind: "end"; end: 0 | 1 }
  | { kind: "segment"; segmentIndex: number }
  | null {
  const points = line.points;
  if (points.length === 0) return null;
  if (pointsEqual(points[0], point, tolerance)) return { kind: "end", end: 0 };
  if (pointsEqual(points[points.length - 1], point, tolerance)) return { kind: "end", end: 1 };
  for (let index = 0; index < points.length - 1; index += 1) {
    const hit = closestPointOnSegment(point, points[index], points[index + 1]);
    if (hit.distance <= tolerance) return { kind: "segment", segmentIndex: index };
  }
  return null;
}

export function referenceConnectivity(doc: SchematicDocument, registry: SymbolRegistry): Connectivity {
  const lines = doc.items.filter((item): item is LineItem => item.kind === "line" && item.points.length >= 2);
  const ports = indexPorts(doc, registry);
  const portIndex = portsByPosition(ports);
  const unionFind = new UnionFind();
  const lineEnds: LineEnd[] = [];
  const usedPorts = new Set<string>();

  for (const line of lines) unionFind.find(lineKey(line.id));

  for (const line of lines) {
    const ends: Array<{ end: 0 | 1; position: Point }> = [
      { end: 0, position: line.points[0] },
      { end: 1, position: line.points[line.points.length - 1] }
    ];
    for (const { end, position } of ends) {
      const attachments: LineEndAttachment[] = [];
      for (const port of portIndex.get(pointKey(position)) ?? []) {
        attachments.push({ kind: "port", itemId: port.itemId, portId: port.id });
        unionFind.union(lineKey(line.id), portKeyOf({ itemId: port.itemId, portId: port.id }));
        usedPorts.add(portMapKey(port.itemId, port.id));
      }
      for (const other of lines) {
        if (other.id === line.id) continue;
        const location = locateOnLine(other, position);
        if (!location) continue;
        attachments.push(
          location.kind === "end"
            ? { kind: "line-end", lineId: other.id, end: location.end }
            : { kind: "line", lineId: other.id, segmentIndex: location.segmentIndex }
        );
        unionFind.union(lineKey(line.id), lineKey(other.id));
      }
      lineEnds.push({ lineId: line.id, end, position, attachments });
    }
  }

  // Group into nets.
  const netMembers = new Map<string, { lineIds: string[]; ports: PortRef[] }>();
  for (const line of lines) {
    const root = unionFind.find(lineKey(line.id));
    const members = netMembers.get(root) ?? { lineIds: [], ports: [] };
    members.lineIds.push(line.id);
    netMembers.set(root, members);
  }
  for (const port of ports) {
    const key = portMapKey(port.itemId, port.id);
    if (!usedPorts.has(key)) continue;
    const root = unionFind.find(`port:${key}`);
    const members = netMembers.get(root) ?? { lineIds: [], ports: [] };
    members.ports.push({ itemId: port.itemId, portId: port.id });
    netMembers.set(root, members);
  }

  const nets: Net[] = [];
  const lineNet = new Map<string, string>();
  const portNet = new Map<string, string>();
  let counter = 0;
  for (const members of netMembers.values()) {
    counter += 1;
    const id = `N${counter}`;
    nets.push({ id, lineIds: members.lineIds, ports: members.ports });
    members.lineIds.forEach((lineId) => lineNet.set(lineId, id));
    members.ports.forEach((port) => portNet.set(portMapKey(port.itemId, port.portId), id));
  }

  // Junction dots: count arms meeting at each line-end position.
  const arms = new Map<string, { position: Point; count: number }>();
  for (const end of lineEnds) {
    const key = pointKey(end.position);
    const entry = arms.get(key) ?? { position: end.position, count: 0 };
    entry.count += 1;
    for (const attachment of end.attachments) {
      if (attachment.kind === "line") entry.count += 2;
    }
    arms.set(key, entry);
  }
  // Two ends sharing a point each counted the other's "line-end" attachment
  // implicitly via their own count, so a plain end-to-end join is 2 arms.
  // A line end on a segment interior is 1 (own) + 2 (through segment) = 3.
  const junctions = [...arms.values()].filter((entry) => entry.count >= 3).map((entry) => entry.position);

  const danglingEnds = lineEnds.filter((end) => end.attachments.length === 0);
  const openPorts = ports.filter((port) => !usedPorts.has(portMapKey(port.itemId, port.id)));

  const crossings = referenceCrossings(lines);

  return { nets, junctions, lineNet, portNet, lineEnds, danglingEnds, openPorts, crossings };
}

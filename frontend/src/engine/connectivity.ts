/**
 * Connectivity derived from geometry (KiCad model).
 *
 * A line end connects to a port when it sits on it, and to another line when
 * it sits on that line (its end or the interior of a segment). Nets are the
 * connected components of that relation. Junction dots are derived: a point
 * where three or more line arms meet.
 */
import { EPSILON, closestPointOnSegment, pointKey, pointsEqual } from "./geometry";
import { type SymbolRegistry, type WorldPort } from "./library";
import { computeCrossings } from "./lines";
import type { EquipmentItem, LineItem, Point, SchematicDocument, SymbolItem } from "./types";

export type PortRef = { itemId: string; portId: string };

export type IndexedPort = WorldPort & { itemId: string };

export type LineEndAttachment =
  | { kind: "port"; itemId: string; portId: string }
  | { kind: "line"; lineId: string; segmentIndex: number }
  | { kind: "line-end"; lineId: string; end: 0 | 1 };

export type LineEnd = {
  lineId: string;
  end: 0 | 1;
  position: Point;
  attachments: LineEndAttachment[];
};

export type Net = {
  id: string;
  lineIds: string[];
  ports: PortRef[];
};

export type Connectivity = {
  nets: Net[];
  /** Junction dots to draw. */
  junctions: Point[];
  lineNet: Map<string, string>;
  /** Keyed by `${itemId}:${portId}`. */
  portNet: Map<string, string>;
  lineEnds: LineEnd[];
  /** Line ends attached to nothing. */
  danglingEnds: LineEnd[];
  /** Ports with no line attached. */
  openPorts: IndexedPort[];
  /** Hop points per line id where it crosses an unconnected line. */
  crossings: Map<string, Point[]>;
};

/** Nozzles of an equipment boundary as ports in sheet coordinates. */
export function equipmentPorts(item: EquipmentItem): WorldPort[] {
  return (item.nozzles ?? []).map((nozzle) => ({
    id: nozzle.id,
    position: { x: item.position.x + nozzle.x, y: item.position.y + nozzle.y },
    side: nozzle.side,
    kind: "nozzle" as const,
    size: nozzle.size
  }));
}

export function portMapKey(itemId: string, portId: string): string {
  return `${itemId}:${portId}`;
}

/** Every port of every symbol on the sheet, in sheet coordinates. */
export function indexPorts(doc: SchematicDocument, registry: SymbolRegistry): IndexedPort[] {
  const ports: IndexedPort[] = [];
  for (const item of doc.items) {
    if (item.kind === "symbol") {
      for (const port of registry.portsOf(item as SymbolItem)) ports.push({ ...port, itemId: item.id });
    } else if (item.kind === "equipment") {
      for (const port of equipmentPorts(item)) ports.push({ ...port, itemId: item.id });
    }
  }
  return ports;
}

/** Ports grouped by their (rounded) position. */
export function portsByPosition(ports: IndexedPort[]): Map<string, IndexedPort[]> {
  const map = new Map<string, IndexedPort[]>();
  for (const port of ports) {
    const key = pointKey(port.position);
    const bucket = map.get(key);
    if (bucket) bucket.push(port);
    else map.set(key, [port]);
  }
  return map;
}

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

/** Where a point sits on a line: at an end, on a segment interior, or off it. */
export function locateOnLine(line: LineItem, point: Point, tolerance = EPSILON):
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

export function computeConnectivity(doc: SchematicDocument, registry: SymbolRegistry): Connectivity {
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

  const crossings = computeCrossings(lines);

  return { nets, junctions, lineNet, portNet, lineEnds, danglingEnds, openPorts, crossings };
}

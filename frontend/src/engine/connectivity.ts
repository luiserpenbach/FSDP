/**
 * Connectivity derived from geometry (KiCad model).
 *
 * A line end connects to a port when it sits on it, and to another line when
 * it sits on that line (its end or the interior of a segment). Nets are the
 * connected components of that relation. Junction dots are derived: a point
 * where three or more line arms meet.
 */
import { EPSILON, pointKey, pointsEqual } from "./geometry";
import { type SymbolRegistry, type WorldPort } from "./library";
import { computeCrossings } from "./lines";
import { SegmentIndex } from "./segmentIndex";
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

/** Union-find over dense integer node ids. */
class UnionFind {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let index = 0; index < size; index += 1) this.parent[index] = index;
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression.
    let cursor = node;
    while (cursor !== root) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
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
    // Same arithmetic as `closestPointOnSegment`, without allocating (this is the connectivity hot loop).
    const a = points[index];
    const b = points[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
    }
    if (Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)) <= tolerance) return { kind: "segment", segmentIndex: index };
  }
  return null;
}

export function computeConnectivity(doc: SchematicDocument, registry: SymbolRegistry): Connectivity {
  const lines = doc.items.filter((item): item is LineItem => item.kind === "line" && item.points.length >= 2);
  const ports = indexPorts(doc, registry);
  const portIndex = portsByPosition(ports);
  const lineEnds: LineEnd[] = [];
  const usedPorts = new Set<string>();

  // Union-find nodes: one per distinct line id, then one per distinct port key.
  const nodeOf = new Map<string, number>();
  const node = (key: string): number => {
    let id = nodeOf.get(key);
    if (id === undefined) {
      id = nodeOf.size;
      nodeOf.set(key, id);
    }
    return id;
  };
  const lineNodes = lines.map((line) => node(`line:${line.id}`));
  const portKeys = ports.map((port) => portMapKey(port.itemId, port.id));
  const portNodes = portKeys.map((key) => node(`port:${key}`));
  const portNodeOf = new Map<IndexedPort, number>();
  ports.forEach((port, index) => portNodeOf.set(port, portNodes[index]));
  const unionFind = new UnionFind(nodeOf.size);

  const segments = new SegmentIndex(lines);

  lines.forEach((line, lineIndex) => {
    const self = lineNodes[lineIndex];
    const ends: Array<{ end: 0 | 1; position: Point }> = [
      { end: 0, position: line.points[0] },
      { end: 1, position: line.points[line.points.length - 1] }
    ];
    for (const { end, position } of ends) {
      const attachments: LineEndAttachment[] = [];
      for (const port of portIndex.get(pointKey(position)) ?? []) {
        attachments.push({ kind: "port", itemId: port.itemId, portId: port.id });
        unionFind.union(self, portNodeOf.get(port)!);
        usedPorts.add(portMapKey(port.itemId, port.id));
      }
      // Only lines with a segment near this end can touch it; candidates come back in document order.
      for (const otherIndex of segments.near(position)) {
        const other = lines[otherIndex];
        if (other.id === line.id) continue;
        const location = locateOnLine(other, position);
        if (!location) continue;
        attachments.push(
          location.kind === "end"
            ? { kind: "line-end", lineId: other.id, end: location.end }
            : { kind: "line", lineId: other.id, segmentIndex: location.segmentIndex }
        );
        unionFind.union(self, lineNodes[otherIndex]);
      }
      lineEnds.push({ lineId: line.id, end, position, attachments });
    }
  });

  // Group into nets.
  const netMembers = new Map<number, { lineIds: string[]; ports: PortRef[] }>();
  lines.forEach((line, lineIndex) => {
    const root = unionFind.find(lineNodes[lineIndex]);
    const members = netMembers.get(root) ?? { lineIds: [], ports: [] };
    members.lineIds.push(line.id);
    netMembers.set(root, members);
  });
  ports.forEach((port, index) => {
    if (!usedPorts.has(portKeys[index])) return;
    const root = unionFind.find(portNodes[index]);
    const members = netMembers.get(root) ?? { lineIds: [], ports: [] };
    members.ports.push({ itemId: port.itemId, portId: port.id });
    netMembers.set(root, members);
  });

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

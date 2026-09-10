/**
 * Higher-level edit builders that turn user intent into commands, keeping
 * connectivity intact: moving or rotating a symbol drags the ends of attached
 * lines with it (KiCad's rubber-band behaviour).
 */
import { translateItem, type Command } from "./commands";
import {
  add,
  isAxisAligned,
  normalizeRotation,
  orthogonalize,
  pointKey,
  rectContainsRect,
  simplifyPolyline
} from "./geometry";
import { locateOnLine } from "./connectivity";
import { symbolPorts, type SymbolRegistry } from "./library";
import { itemBounds } from "./spatial";
import type { Item, LineItem, Point, Rotation, SchematicDocument, SymbolItem } from "./types";

/** Move a line end to `target`, adjusting the neighbouring vertex to stay orthogonal. */
export function retargetLineEnd(points: Point[], end: 0 | 1, target: Point): Point[] {
  const next = [...points];
  if (next.length < 2) return next;
  const endIndex = end === 0 ? 0 : next.length - 1;
  const adjacentIndex = end === 0 ? 1 : next.length - 2;
  const oldEnd = next[endIndex];
  const adjacent = next[adjacentIndex];
  next[endIndex] = target;
  if (next.length === 2) {
    if (isAxisAligned(target, adjacent)) return next;
    // Bend next to the moved end so the original run keeps its axis.
    const horizontalRun = oldEnd.y === adjacent.y;
    const corner = horizontalRun ? { x: target.x, y: adjacent.y } : { x: adjacent.x, y: target.y };
    return simplifyPolyline(end === 0 ? [target, corner, adjacent] : [adjacent, corner, target]);
  }
  // Slide the adjacent vertex along the segment's axis so the run stays straight.
  const verticalSegment = oldEnd.x === adjacent.x;
  next[adjacentIndex] = verticalSegment ? { x: target.x, y: adjacent.y } : { x: adjacent.x, y: target.y };
  if (!isAxisAligned(next[adjacentIndex], target)) {
    // Both coordinates changed: fall back to inserting a corner.
    return orthogonalize(next);
  }
  return simplifyPolyline(next);
}

/**
 * Given a map of old port position → new port position, re-attach the ends
 * of every line (not in `skip`) that sat on an old position.
 */
export function retargetAttachedLines(
  doc: SchematicDocument,
  portMoves: Map<string, Point>,
  skip: Set<string>
): Command[] {
  const commands: Command[] = [];
  const changed = new Map<string, { before: Point[]; after: Point[] }>();
  for (const item of doc.items) {
    if (item.kind !== "line" || skip.has(item.id) || item.points.length < 2) continue;
    let points = item.points;
    const startTarget = portMoves.get(pointKey(points[0]));
    if (startTarget) points = retargetLineEnd(points, 0, startTarget);
    const endTarget = portMoves.get(pointKey(points[points.length - 1]));
    if (endTarget) points = retargetLineEnd(points, 1, endTarget);
    if (points !== item.points) {
      commands.push({ type: "set-points", id: item.id, points });
      changed.set(item.id, { before: item.points, after: points });
    }
  }
  commands.push(...followTees(doc, changed, new Set([...skip, ...changed.keys()])));
  return commands;
}

/**
 * Line ends that tee onto a segment of a line whose vertices changed are
 * re-projected onto the moved segment (one pass, no cascading).
 */
function followTees(
  doc: SchematicDocument,
  changed: Map<string, { before: Point[]; after: Point[] }>,
  skip: Set<string>
): Command[] {
  if (!changed.size) return [];
  const commands: Command[] = [];
  for (const item of doc.items) {
    if (item.kind !== "line" || skip.has(item.id) || item.points.length < 2) continue;
    let points = item.points;
    for (const end of [0, 1] as const) {
      const position = end === 0 ? points[0] : points[points.length - 1];
      for (const { before, after } of changed.values()) {
        const location = locateOnLine({ ...item, points: before }, position);
        if (!location || location.kind !== "segment") continue;
        const a = after[location.segmentIndex];
        const b = after[location.segmentIndex + 1];
        if (!a || !b) continue;
        const target = a.y === b.y
          ? { x: Math.min(Math.max(position.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y }
          : { x: a.x, y: Math.min(Math.max(position.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)) };
        if (target.x !== position.x || target.y !== position.y) points = retargetLineEnd(points, end, target);
        break;
      }
    }
    if (points !== item.points) commands.push({ type: "set-points", id: item.id, points });
  }
  return commands;
}

function portMovesFor(doc: SchematicDocument, registry: SymbolRegistry, before: SymbolItem, after: SymbolItem): Map<string, Point> {
  const definition = registry.resolve(before.symbol);
  const oldPorts = symbolPorts(before, definition);
  const newPorts = symbolPorts(after, definition);
  const moves = new Map<string, Point>();
  oldPorts.forEach((port, index) => moves.set(pointKey(port.position), newPorts[index].position));
  void doc;
  return moves;
}

/** Move items by `delta`; lines attached to moved symbols follow. */
export function moveItemsCommand(doc: SchematicDocument, registry: SymbolRegistry, ids: string[], delta: Point): Command {
  const moved = new Set(ids);
  const portMoves = new Map<string, Point>();
  for (const item of doc.items) {
    if (!moved.has(item.id) || item.kind !== "symbol") continue;
    const after = translateItem(item, delta) as SymbolItem;
    for (const [key, target] of portMovesFor(doc, registry, item, after)) portMoves.set(key, target);
  }
  const commands: Command[] = [{ type: "move", ids, delta }];
  commands.push(...retargetAttachedLines(doc, portMoves, moved));
  return { type: "batch", commands, label: "Move" };
}

/** Rotate symbols by `by` degrees; attached lines re-attach to the rotated ports. */
export function rotateItemsCommand(doc: SchematicDocument, registry: SymbolRegistry, ids: string[], by = 90): Command {
  const selected = new Set(ids);
  const commands: Command[] = [];
  const portMoves = new Map<string, Point>();
  for (const item of doc.items) {
    if (!selected.has(item.id)) continue;
    if (item.kind === "symbol") {
      const rotation: Rotation = normalizeRotation(item.rotation + by);
      const after = { ...item, rotation };
      for (const [key, target] of portMovesFor(doc, registry, item, after)) portMoves.set(key, target);
      commands.push({ type: "update", id: item.id, patch: { rotation } });
    } else if (item.kind === "label") {
      commands.push({ type: "update", id: item.id, patch: { rotation: normalizeRotation(item.rotation + by) } });
    }
  }
  commands.push(...retargetAttachedLines(doc, portMoves, selected));
  return { type: "batch", commands, label: "Rotate" };
}

export function mirrorItemsCommand(doc: SchematicDocument, registry: SymbolRegistry, ids: string[]): Command {
  const selected = new Set(ids);
  const commands: Command[] = [];
  const portMoves = new Map<string, Point>();
  for (const item of doc.items) {
    if (!selected.has(item.id) || item.kind !== "symbol") continue;
    const after = { ...item, mirror: !item.mirror };
    for (const [key, target] of portMovesFor(doc, registry, item, after)) portMoves.set(key, target);
    commands.push({ type: "update", id: item.id, patch: { mirror: !item.mirror } });
  }
  commands.push(...retargetAttachedLines(doc, portMoves, selected));
  return { type: "batch", commands, label: "Mirror" };
}

/** Equipment boundaries carry the items drawn inside them when moved. */
export function expandSelectionForEquipment(doc: SchematicDocument, registry: SymbolRegistry, ids: string[]): string[] {
  const result = new Set(ids);
  for (const item of doc.items) {
    if (!result.has(item.id) || item.kind !== "equipment") continue;
    const outer = itemBounds(item, registry);
    for (const candidate of doc.items) {
      if (candidate.id === item.id || result.has(candidate.id)) continue;
      if (rectContainsRect(outer, itemBounds(candidate, registry))) result.add(candidate.id);
    }
  }
  return [...result];
}

export function duplicateItems(doc: SchematicDocument, ids: string[], offset: Point, makeId: () => string): Item[] {
  const selected = new Set(ids);
  return doc.items
    .filter((item) => selected.has(item.id))
    .map((item) => {
      const copy = translateItem(item, offset);
      if (copy.kind === "symbol") return { ...copy, id: makeId(), tag: undefined, componentId: undefined };
      return { ...copy, id: makeId() };
    });
}

export function lineWithPoints(line: LineItem, points: Point[]): LineItem {
  return { ...line, points: simplifyPolyline(points) };
}

export { add as translatePoint };

/**
 * Move segment `index` of a polyline perpendicular to itself to `coordinate`
 * (the y of a horizontal segment, the x of a vertical one). End segments grow
 * a new corner so attached ends stay put (draw.io style).
 */
export function dragSegment(points: Point[], index: number, coordinate: number): Point[] {
  if (points.length < 2 || index < 0 || index >= points.length - 1) return points;
  const next = points.map((point) => ({ ...point }));
  let segment = index;
  if (segment === 0) {
    next.splice(1, 0, { ...next[0] });
    segment = 1;
  }
  if (segment === next.length - 2) {
    next.splice(next.length - 1, 0, { ...next[next.length - 1] });
  }
  const horizontal = next[segment].y === next[segment + 1].y;
  if (horizontal) {
    next[segment] = { x: next[segment].x, y: coordinate };
    next[segment + 1] = { x: next[segment + 1].x, y: coordinate };
  } else {
    next[segment] = { x: coordinate, y: next[segment].y };
    next[segment + 1] = { x: coordinate, y: next[segment + 1].y };
  }
  return simplifyPolyline(next);
}

/** Next free tag for a prefix, e.g. "HV-3" when HV-1 and HV-2 exist. */
export function suggestTag(doc: SchematicDocument, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}[-\\s]?(\\d+)$`);
  let highest = 0;
  for (const item of doc.items) {
    const tag = item.kind === "symbol" || item.kind === "equipment" ? item.tag : undefined;
    const match = tag ? pattern.exec(tag) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

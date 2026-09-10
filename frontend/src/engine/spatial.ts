/**
 * Item bounds, a uniform-grid spatial index, and hit testing.
 */
import {
  closestPointOnSegment,
  distance,
  expandRect,
  polylineBounds,
  rectContains,
  rectContainsRect,
  rectsIntersect
} from "./geometry";
import { type SymbolRegistry } from "./library";
import type { Item, LabelItem, Point, Rect, SchematicDocument } from "./types";

/** Rough text extent: average glyph advance ≈ 0.6 em for the bundled sans font. */
export function labelBounds(item: LabelItem): Rect {
  const width = Math.max(item.fontSize, item.text.length * item.fontSize * 0.6);
  const height = item.fontSize * 1.2;
  const swap = item.rotation === 90 || item.rotation === 270;
  const w = swap ? height : width;
  const h = swap ? width : height;
  let x = item.position.x;
  if (!swap) {
    if (item.anchor === "middle") x -= w / 2;
    else if (item.anchor === "end") x -= w;
  } else {
    x -= w / 2;
  }
  return { x, y: item.position.y - (swap ? h / 2 : h * 0.8), width: w, height: h };
}

export const NOTE_SIZE_MM = 6;

export function itemBounds(item: Item, registry: SymbolRegistry): Rect {
  switch (item.kind) {
    case "symbol":
      return registry.boundsOf(item);
    case "line":
      return expandRect(polylineBounds(item.points), (item.strokeWidth ?? 0.5) / 2);
    case "equipment":
      return { x: item.position.x, y: item.position.y, width: item.size.width, height: item.size.height };
    case "label":
      return labelBounds(item);
    case "note":
      return { x: item.position.x, y: item.position.y - NOTE_SIZE_MM, width: NOTE_SIZE_MM, height: NOTE_SIZE_MM };
  }
}

export class SpatialIndex {
  private readonly cells = new Map<string, Item[]>();
  private readonly bounds = new Map<string, Rect>();

  constructor(
    readonly doc: SchematicDocument,
    readonly registry: SymbolRegistry,
    readonly cellSize = 50
  ) {
    for (const item of doc.items) {
      const rect = itemBounds(item, registry);
      this.bounds.set(item.id, rect);
      for (const key of this.cellKeys(rect)) {
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  private cellKeys(rect: Rect): string[] {
    const keys: string[] = [];
    const minX = Math.floor(rect.x / this.cellSize);
    const maxX = Math.floor((rect.x + rect.width) / this.cellSize);
    const minY = Math.floor(rect.y / this.cellSize);
    const maxY = Math.floor((rect.y + rect.height) / this.cellSize);
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) keys.push(`${x}:${y}`);
    return keys;
  }

  boundsOf(id: string): Rect | undefined {
    return this.bounds.get(id);
  }

  /** Items whose bounds intersect `rect`, in document order. */
  query(rect: Rect): Item[] {
    const seen = new Set<string>();
    const result: Item[] = [];
    for (const key of this.cellKeys(rect)) {
      for (const item of this.cells.get(key) ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (rectsIntersect(this.bounds.get(item.id)!, rect)) result.push(item);
      }
    }
    return result.sort((a, b) => this.doc.items.indexOf(a) - this.doc.items.indexOf(b));
  }

  /** Items fully inside `rect` (window selection). */
  queryContained(rect: Rect): Item[] {
    return this.query(rect).filter((item) => rectContainsRect(rect, this.bounds.get(item.id)!));
  }
}

export type Hit =
  | { item: Item; part: { type: "body" } }
  | { item: Item; part: { type: "port"; portId: string; position: Point } }
  | { item: Item; part: { type: "segment"; index: number } }
  | { item: Item; part: { type: "vertex"; index: number } };

const KIND_PRIORITY: Record<Item["kind"], number> = {
  note: 0,
  label: 1,
  symbol: 2,
  line: 3,
  equipment: 4
};

/**
 * Topmost item under `point`. Ports win over bodies, small items over large,
 * and lines are hit on their segments only (not their bounding box).
 * Equipment is hit on its boundary so the empty inside stays clickable.
 */
export function hitTest(index: SpatialIndex, point: Point, tolerance: number): Hit | null {
  const candidates = index.query({ x: point.x - tolerance, y: point.y - tolerance, width: tolerance * 2, height: tolerance * 2 });
  let best: { hit: Hit; score: number } | null = null;
  const consider = (hit: Hit, score: number) => {
    if (!best || score < best.score) best = { hit, score };
  };
  for (const item of candidates) {
    const layer = index.doc.layers.find((entry) => entry.id === item.layer);
    if (layer?.hidden || layer?.locked || item.locked) continue;
    const rect = index.boundsOf(item.id)!;
    const area = rect.width * rect.height;
    const base = KIND_PRIORITY[item.kind] * 1e6;
    switch (item.kind) {
      case "symbol": {
        for (const port of index.registry.portsOf(item)) {
          if (distance(port.position, point) <= tolerance) {
            consider({ item, part: { type: "port", portId: port.id, position: port.position } }, -1 + distance(port.position, point));
          }
        }
        if (rectContains(rect, point, tolerance)) consider({ item, part: { type: "body" } }, base + area);
        break;
      }
      case "line": {
        item.points.forEach((vertex, vertexIndex) => {
          if (distance(vertex, point) <= tolerance) consider({ item, part: { type: "vertex", index: vertexIndex } }, base - 1);
        });
        for (let segment = 0; segment < item.points.length - 1; segment += 1) {
          const hit = closestPointOnSegment(point, item.points[segment], item.points[segment + 1]);
          if (hit.distance <= tolerance) consider({ item, part: { type: "segment", index: segment } }, base + hit.distance);
        }
        break;
      }
      case "equipment": {
        const inner = expandRect(rect, -tolerance);
        const onBorder = rectContains(rect, point, tolerance) && !(inner.width > 0 && inner.height > 0 && rectContains(inner, point));
        const onLabel = rectContains({ x: rect.x, y: rect.y - 6, width: Math.max(20, item.name.length * 2.2), height: 6 }, point, tolerance);
        if (onBorder || onLabel) consider({ item, part: { type: "body" } }, base + area);
        break;
      }
      default:
        if (rectContains(rect, point, tolerance)) consider({ item, part: { type: "body" } }, base + area);
    }
  }
  return best ? (best as { hit: Hit }).hit : null;
}

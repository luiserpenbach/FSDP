import type { Point, Rect, Rotation, Side } from "./types";

/** Coordinates closer than this (mm) are treated as coincident. */
export const EPSILON = 0.01;

export function near(a: number, b: number, tolerance = EPSILON): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function pointsEqual(a: Point, b: Point, tolerance = EPSILON): boolean {
  return near(a.x, b.x, tolerance) && near(a.y, b.y, tolerance);
}

export function pointKey(point: Point, precision = 2): string {
  return `${point.x.toFixed(precision)},${point.y.toFixed(precision)}`;
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function snapValue(value: number, grid: number): number {
  if (grid <= 0) return value;
  return round(Math.round(value / grid) * grid);
}

export function snapPoint(point: Point, grid: number): Point {
  return { x: snapValue(point.x, grid), y: snapValue(point.y, grid) };
}

/** Round to 1/100 mm so JSON stays tidy and comparisons are stable. */
export function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

export function roundPoint(point: Point): Point {
  return { x: round(point.x), y: round(point.y) };
}

export function normalizeRotation(value: number): Rotation {
  const steps = Math.round(((value % 360) + 360) % 360 / 90) % 4;
  return ([0, 90, 180, 270] as const)[steps];
}

/** Rotate an offset around the origin, clockwise in screen space (y down). */
export function rotateOffset(point: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 90:
      return { x: -point.y, y: point.x };
    case 180:
      return { x: -point.x, y: -point.y };
    case 270:
      return { x: point.y, y: -point.x };
    default:
      return point;
  }
}

const SIDE_ORDER: Side[] = ["right", "bottom", "left", "top"];

export function rotateSide(side: Side, rotation: Rotation): Side {
  const steps = rotation / 90;
  return SIDE_ORDER[(SIDE_ORDER.indexOf(side) + steps) % 4];
}

export function mirrorSide(side: Side): Side {
  if (side === "left") return "right";
  if (side === "right") return "left";
  return side;
}

export function oppositeSide(side: Side): Side {
  switch (side) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    default:
      return "top";
  }
}

export function sideVector(side: Side): Point {
  switch (side) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 1 };
  }
}

export function isHorizontalSide(side: Side): boolean {
  return side === "left" || side === "right";
}

/** Which way to face from `from` to head toward `to`. */
export function dominantSide(from: Point, to: Point): Side {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/* ---------- Rectangles ---------- */

export function rectContains(rect: Rect, point: Point, pad = 0): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectUnion(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function expandRect(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/* ---------- Segments ---------- */

export function isAxisAligned(a: Point, b: Point): boolean {
  return near(a.x, b.x) || near(a.y, b.y);
}

/** Distance from a point to a segment, and the closest point on it. */
export function closestPointOnSegment(point: Point, a: Point, b: Point): { point: Point; distance: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  const closest = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: closest, distance: distance(point, closest), t };
}

/** True when `point` lies on the open interior of segment ab (not at its ends). */
export function pointOnSegmentInterior(point: Point, a: Point, b: Point, tolerance = EPSILON): boolean {
  const hit = closestPointOnSegment(point, a, b);
  if (hit.distance > tolerance) return false;
  return !pointsEqual(point, a, tolerance) && !pointsEqual(point, b, tolerance);
}

/** Drop repeated points and interior points that sit on a straight run. */
export function simplifyPolyline(points: Point[]): Point[] {
  const cleaned: Point[] = [];
  for (const point of points) {
    if (!cleaned.length || !pointsEqual(cleaned[cleaned.length - 1], point)) cleaned.push(roundPoint(point));
  }
  if (cleaned.length < 3) return cleaned;
  const result: Point[] = [cleaned[0]];
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const previous = result[result.length - 1];
    const current = cleaned[index];
    const next = cleaned[index + 1];
    const collinearX = near(previous.x, current.x) && near(current.x, next.x);
    const collinearY = near(previous.y, current.y) && near(current.y, next.y);
    if (!collinearX && !collinearY) result.push(current);
  }
  result.push(cleaned[cleaned.length - 1]);
  return result;
}

/**
 * Insert corners so every consecutive pair is axis-aligned. Diagonal runs
 * bend horizontally first unless `verticalFirst` is set.
 */
export function orthogonalize(points: Point[], verticalFirst = false): Point[] {
  if (points.length < 2) return points.map(roundPoint);
  const result: Point[] = [roundPoint(points[0])];
  for (let index = 1; index < points.length; index += 1) {
    const previous = result[result.length - 1];
    const next = roundPoint(points[index]);
    if (!isAxisAligned(previous, next)) {
      result.push(verticalFirst ? { x: previous.x, y: next.y } : { x: next.x, y: previous.y });
    }
    result.push(next);
  }
  return simplifyPolyline(result);
}

export function polylineBounds(points: Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

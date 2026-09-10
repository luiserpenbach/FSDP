/**
 * Orthogonal routing between two points that leave in known directions.
 * Ported from the React Flow edge (OrthogonalEdge.tsx) into mm paper space.
 */
import {
  dominantSide,
  isHorizontalSide,
  orthogonalize,
  sideVector,
  simplifyPolyline,
  snapValue
} from "./geometry";
import type { Point, Side } from "./types";

/** Straight run leaving a port before the first bend. */
export const ROUTE_STUB_MM = 5;

function stub(point: Point, side: Side, length: number): Point {
  const vector = sideVector(side);
  return { x: point.x + vector.x * length, y: point.y + vector.y * length };
}

/**
 * Route from `from` (leaving toward `fromSide`) to `to` (entering from
 * `toSide`). Unknown sides default to the dominant direction toward the far
 * end. Returns the full vertex list including both endpoints.
 */
export function routeBetween(
  from: Point,
  fromSide: Side | null,
  to: Point,
  toSide: Side | null,
  options: { grid?: number; stub?: number } = {}
): Point[] {
  const grid = options.grid ?? 0;
  const stubLength = options.stub ?? ROUTE_STUB_MM;
  const sideA = fromSide ?? dominantSide(from, to);
  const sideB = toSide ?? dominantSide(to, from);

  // Facing ports on one axis: a straight run.
  if (isHorizontalSide(sideA) && isHorizontalSide(sideB) && from.y === to.y) {
    const facing = (sideA === "right" && to.x > from.x) || (sideA === "left" && to.x < from.x);
    if (facing) return [from, to];
  }
  if (!isHorizontalSide(sideA) && !isHorizontalSide(sideB) && from.x === to.x) {
    const facing = (sideA === "bottom" && to.y > from.y) || (sideA === "top" && to.y < from.y);
    if (facing) return [from, to];
  }

  const exit = stub(from, sideA, stubLength);
  const entry = stub(to, sideB, stubLength);
  let corners: Point[];
  if (isHorizontalSide(sideA) && isHorizontalSide(sideB)) {
    const midX = snapValue((exit.x + entry.x) / 2, grid);
    corners = [
      { x: midX, y: exit.y },
      { x: midX, y: entry.y }
    ];
  } else if (!isHorizontalSide(sideA) && !isHorizontalSide(sideB)) {
    const midY = snapValue((exit.y + entry.y) / 2, grid);
    corners = [
      { x: exit.x, y: midY },
      { x: entry.x, y: midY }
    ];
  } else if (isHorizontalSide(sideA)) {
    corners = [{ x: entry.x, y: exit.y }];
  } else {
    corners = [{ x: exit.x, y: entry.y }];
  }
  return simplifyPolyline(orthogonalize([from, exit, ...corners, entry, to]));
}

/**
 * Preview polyline for the wire tool: from the last fixed vertex to the cursor
 * with a single bend, horizontal-first unless `verticalFirst`.
 */
export function previewSegment(from: Point, cursor: Point, verticalFirst: boolean): Point[] {
  return orthogonalize([from, cursor], verticalFirst);
}

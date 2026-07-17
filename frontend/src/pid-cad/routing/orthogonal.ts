import type { Point, Rect } from "../model/types";

function key(point: Point): string {
  return `${point.x}:${point.y}`;
}

export function simplify(points: Point[]): Point[] {
  const unique = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  );
  return unique.filter((point, index) => {
    if (index === 0 || index === unique.length - 1) return true;
    const before = unique[index - 1];
    const after = unique[index + 1];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

export function orthogonalPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function snapPoint(point: Point, cell: number): Point {
  const size = Math.max(1, cell);
  return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size };
}

/** Magnet-snap cursor to nearby ports or orthogonal edge points while routing. */
export function snapToMagnets(cursor: Point, magnets: Point[], threshold = 12): Point {
  let best: Point | null = null;
  let bestDist = threshold;
  for (const magnet of magnets) {
    const dist = Math.hypot(cursor.x - magnet.x, cursor.y - magnet.y);
    if (dist <= bestDist) {
      best = magnet;
      bestDist = dist;
    }
  }
  return best ?? cursor;
}

/** Build an orthogonal walk preview from committed points to the cursor (KiCad-style). */
export function interactiveWalk(committed: Point[], cursor: Point, mode: "orthogonal" | "45deg" = "orthogonal"): Point[] {
  if (committed.length === 0) return [cursor];
  const last = committed[committed.length - 1];
  if (mode === "45deg") {
    const dx = cursor.x - last.x;
    const dy = cursor.y - last.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx === 0 || ady === 0 || Math.abs(adx - ady) < 1) {
      return simplify([...committed, cursor]);
    }
    if (adx > ady) {
      return simplify([...committed, { x: last.x + Math.sign(dx) * (adx - ady), y: last.y }, cursor]);
    }
    return simplify([...committed, { x: last.x, y: last.y + Math.sign(dy) * (ady - adx) }, cursor]);
  }
  const preferHorizontal = Math.abs(cursor.x - last.x) >= Math.abs(cursor.y - last.y);
  if (preferHorizontal) {
    return simplify([...committed, { x: cursor.x, y: last.y }, cursor]);
  }
  return simplify([...committed, { x: last.x, y: cursor.y }, cursor]);
}

export function routeOrthogonal(
  source: Point,
  target: Point,
  obstacles: Rect[],
  step = 16,
  padding = 12
): Point[] {
  const cell = Math.max(4, step);
  const snap = (value: number) => Math.round(value / cell) * cell;
  const start = { x: snap(source.x), y: snap(source.y) };
  const goal = { x: snap(target.x), y: snap(target.y) };
  const minX = Math.min(start.x, goal.x, ...obstacles.map((item) => item.x)) - cell * 8;
  const maxX = Math.max(start.x, goal.x, ...obstacles.map((item) => item.x + item.width)) + cell * 8;
  const minY = Math.min(start.y, goal.y, ...obstacles.map((item) => item.y)) - cell * 8;
  const maxY = Math.max(start.y, goal.y, ...obstacles.map((item) => item.y + item.height)) + cell * 8;
  const blocked = (point: Point) =>
    obstacles.some(
      (item) =>
        point.x > item.x - padding &&
        point.x < item.x + item.width + padding &&
        point.y > item.y - padding &&
        point.y < item.y + item.height + padding
    );

  const open: Point[] = [start];
  const previous = new Map<string, string>();
  const points = new Map<string, Point>([[key(start), start]]);
  const cost = new Map<string, number>([[key(start), 0]]);
  const visited = new Set<string>();

  while (open.length > 0 && visited.size < 20_000) {
    open.sort((left, right) => {
      const leftCost = (cost.get(key(left)) ?? Infinity) + Math.abs(left.x - goal.x) + Math.abs(left.y - goal.y);
      const rightCost = (cost.get(key(right)) ?? Infinity) + Math.abs(right.x - goal.x) + Math.abs(right.y - goal.y);
      return leftCost - rightCost;
    });
    const current = open.shift()!;
    const currentKey = key(current);
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    if (current.x === goal.x && current.y === goal.y) {
      const result: Point[] = [goal];
      let cursor = currentKey;
      while (previous.has(cursor)) {
        cursor = previous.get(cursor)!;
        result.push(points.get(cursor)!);
      }
      result.reverse();
      return simplify([source, { x: start.x, y: source.y }, ...result, { x: goal.x, y: target.y }, target]);
    }
    const neighbors = [
      { x: current.x + cell, y: current.y },
      { x: current.x - cell, y: current.y },
      { x: current.x, y: current.y + cell },
      { x: current.x, y: current.y - cell }
    ];
    for (const neighbor of neighbors) {
      if (
        neighbor.x < minX ||
        neighbor.x > maxX ||
        neighbor.y < minY ||
        neighbor.y > maxY ||
        (blocked(neighbor) && key(neighbor) !== key(goal))
      ) {
        continue;
      }
      const neighborKey = key(neighbor);
      const nextCost = (cost.get(currentKey) ?? 0) + cell;
      if (nextCost >= (cost.get(neighborKey) ?? Infinity)) continue;
      cost.set(neighborKey, nextCost);
      previous.set(neighborKey, currentKey);
      points.set(neighborKey, neighbor);
      open.push(neighbor);
    }
  }

  const middleX = snap((source.x + target.x) / 2);
  return simplify([source, { x: middleX, y: source.y }, { x: middleX, y: target.y }, target]);
}

function almostAligned(a: Point, b: Point, epsilon = 0.5): boolean {
  return Math.abs(a.x - b.x) < epsilon || Math.abs(a.y - b.y) < epsilon;
}

/**
 * Insert corners so every segment is horizontal or vertical.
 * Prefers continuing the incoming direction (KiCad-style) to avoid flickering
 * when ports move relative to absolute waypoints.
 */
export function forceOrthogonal(points: Point[]): Point[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1];
    const curr = points[i];
    if (almostAligned(prev, curr)) {
      out.push({ ...curr });
      continue;
    }
    const before = out.length >= 2 ? out[out.length - 2] : null;
    let corner: Point;
    if (before && Math.abs(before.y - prev.y) < 0.5 && Math.abs(before.x - prev.x) >= 0.5) {
      // Arrived horizontally → leave vertically first.
      corner = { x: prev.x, y: curr.y };
    } else if (before && Math.abs(before.x - prev.x) < 0.5 && Math.abs(before.y - prev.y) >= 0.5) {
      // Arrived vertically → leave horizontally first.
      corner = { x: curr.x, y: prev.y };
    } else if (Math.abs(curr.x - prev.x) >= Math.abs(curr.y - prev.y)) {
      corner = { x: curr.x, y: prev.y };
    } else {
      corner = { x: prev.x, y: curr.y };
    }
    out.push(corner, { ...curr });
  }
  return simplify(out);
}

/**
 * Reattach a stored route to new port positions while keeping H/V segments.
 * When both ends share the same delta (multi-select move), translate the whole run.
 */
export function reattachOrthogonal(
  source: Point,
  target: Point,
  waypoints: Point[] | undefined,
  previous?: { source: Point; target: Point }
): Point[] {
  if (previous) {
    const dxS = source.x - previous.source.x;
    const dyS = source.y - previous.source.y;
    const dxT = target.x - previous.target.x;
    const dyT = target.y - previous.target.y;
    if (Math.abs(dxS - dxT) < 0.5 && Math.abs(dyS - dyT) < 0.5 && (Math.abs(dxS) > 0.5 || Math.abs(dyS) > 0.5)) {
      const old = resolveWaypointsRaw(previous.source, previous.target, waypoints);
      return simplify(old.map((point) => ({ x: point.x + dxS, y: point.y + dyS })));
    }
  }
  return forceOrthogonal(resolveWaypointsRaw(source, target, waypoints));
}

function resolveWaypointsRaw(source: Point, target: Point, waypoints: Point[] | undefined): Point[] {
  const resolved = (waypoints ?? []).map((point, index, items) => ({
    x: point.x,
    y: Number.isFinite(point.y) ? point.y : index < items.length / 2 ? source.y : target.y
  }));
  if (resolved.length === 0) {
    return interactiveWalk([source], target);
  }
  return [source, ...resolved, target];
}

export function resolveWaypoints(source: Point, target: Point, waypoints: Point[] | undefined): Point[] {
  return forceOrthogonal(resolveWaypointsRaw(source, target, waypoints));
}

/** Point at half the polyline path length (for line tags). */
export function polylineMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    lengths.push(len);
    total += len;
  }
  if (total < 1e-6) return { ...points[0] };
  let remaining = total / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    if (remaining <= lengths[i]) {
      const t = lengths[i] < 1e-6 ? 0 : remaining / lengths[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t
      };
    }
    remaining -= lengths[i];
  }
  return { ...points[points.length - 1] };
}

export function segmentClearanceOk(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  clearance: number
): boolean {
  // Axis-aligned segment distance approximation
  const aH = a.y === b.y;
  const cH = c.y === d.y;
  if (aH && cH) {
    if (Math.abs(a.y - c.y) >= clearance) return true;
    const aMin = Math.min(a.x, b.x);
    const aMax = Math.max(a.x, b.x);
    const cMin = Math.min(c.x, d.x);
    const cMax = Math.max(c.x, d.x);
    return aMax < cMin - clearance || cMax < aMin - clearance;
  }
  if (!aH && !cH) {
    if (Math.abs(a.x - c.x) >= clearance) return true;
    const aMin = Math.min(a.y, b.y);
    const aMax = Math.max(a.y, b.y);
    const cMin = Math.min(c.y, d.y);
    const cMax = Math.max(c.y, d.y);
    return aMax < cMin - clearance || cMax < aMin - clearance;
  }
  return true;
}

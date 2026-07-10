import type { Edge, Node } from "reactflow";

export type Point = { x: number; y: number };
export type DiagramUnit = "px" | "mm";

export type PidEditorSettings = {
  gridVisible: boolean;
  snapToGrid: boolean;
  unit: DiagramUnit;
  gridSize: number;
};

export type SymbolPrimitive =
  | { id: string; kind: "line"; x1: number; y1: number; x2: number; y2: number; strokeWidth?: number }
  | { id: string; kind: "rect"; x: number; y: number; width: number; height: number; strokeWidth?: number }
  | { id: string; kind: "circle"; cx: number; cy: number; r: number; strokeWidth?: number };

export type SymbolPort = {
  id: string;
  name: string;
  x: number;
  y: number;
};

export type PidSymbolDefinition = {
  id: string;
  name: string;
  primitives: SymbolPrimitive[];
  ports: SymbolPort[];
  builtIn?: boolean;
};

export type PidNodeData = {
  label: string;
  symbolType: string;
  rotation: number;
};

export type PidEdgeData = {
  waypoints?: Point[];
  color?: string;
  thickness?: number;
  routing?: "auto" | "manual";
  startX?: number;
  endX?: number;
  bendX?: number;
  bendY?: number;
};

export type Rect = { x: number; y: number; width: number; height: number };

export const DEFAULT_EDITOR_SETTINGS: PidEditorSettings = {
  gridVisible: true,
  snapToGrid: true,
  unit: "mm",
  gridSize: 5
};

const horizontalPorts: SymbolPort[] = [
  { id: "left", name: "Left", x: 0, y: 50 },
  { id: "right", name: "Right", x: 100, y: 50 }
];

export const BUILT_IN_SYMBOLS: PidSymbolDefinition[] = [
  {
    id: "valve",
    name: "Valve",
    builtIn: true,
    ports: horizontalPorts,
    primitives: [
      { id: "v1", kind: "line", x1: 10, y1: 20, x2: 50, y2: 50 },
      { id: "v2", kind: "line", x1: 10, y1: 80, x2: 50, y2: 50 },
      { id: "v3", kind: "line", x1: 90, y1: 20, x2: 50, y2: 50 },
      { id: "v4", kind: "line", x1: 90, y1: 80, x2: 50, y2: 50 },
      { id: "v5", kind: "line", x1: 10, y1: 20, x2: 10, y2: 80 },
      { id: "v6", kind: "line", x1: 90, y1: 20, x2: 90, y2: 80 },
      { id: "v7", kind: "line", x1: 0, y1: 50, x2: 10, y2: 50 },
      { id: "v8", kind: "line", x1: 90, y1: 50, x2: 100, y2: 50 }
    ]
  },
  {
    id: "sensor",
    name: "Instrument",
    builtIn: true,
    ports: [{ id: "bottom", name: "Process", x: 50, y: 100 }],
    primitives: [
      { id: "s1", kind: "circle", cx: 50, cy: 42, r: 30 },
      { id: "s2", kind: "line", x1: 50, y1: 72, x2: 50, y2: 100 },
      { id: "s3", kind: "line", x1: 31, y1: 42, x2: 69, y2: 42 }
    ]
  },
  {
    id: "regulator",
    name: "Regulator",
    builtIn: true,
    ports: horizontalPorts,
    primitives: [
      { id: "r1", kind: "line", x1: 8, y1: 50, x2: 28, y2: 50 },
      { id: "r2", kind: "rect", x: 28, y: 28, width: 44, height: 44 },
      { id: "r3", kind: "line", x1: 72, y1: 50, x2: 92, y2: 50 },
      { id: "r4", kind: "line", x1: 50, y1: 28, x2: 50, y2: 10 },
      { id: "r5", kind: "line", x1: 40, y1: 10, x2: 60, y2: 10 }
    ]
  },
  {
    id: "filter",
    name: "Filter",
    builtIn: true,
    ports: horizontalPorts,
    primitives: [
      { id: "f1", kind: "rect", x: 20, y: 20, width: 60, height: 60 },
      { id: "f2", kind: "line", x1: 20, y1: 80, x2: 80, y2: 20 },
      { id: "f3", kind: "line", x1: 0, y1: 50, x2: 20, y2: 50 },
      { id: "f4", kind: "line", x1: 80, y1: 50, x2: 100, y2: 50 }
    ]
  },
  {
    id: "source",
    name: "Tank / source",
    builtIn: true,
    ports: [{ id: "right", name: "Outlet", x: 100, y: 58 }],
    primitives: [
      { id: "t1", kind: "rect", x: 15, y: 14, width: 70, height: 70 },
      { id: "t2", kind: "line", x1: 15, y1: 58, x2: 85, y2: 58 },
      { id: "t3", kind: "line", x1: 85, y1: 58, x2: 100, y2: 58 }
    ]
  },
  {
    id: "sink",
    name: "Equipment / sink",
    builtIn: true,
    ports: [{ id: "left", name: "Inlet", x: 0, y: 50 }],
    primitives: [
      { id: "e1", kind: "circle", cx: 55, cy: 50, r: 35 },
      { id: "e2", kind: "line", x1: 0, y1: 50, x2: 20, y2: 50 },
      { id: "e3", kind: "line", x1: 42, y1: 35, x2: 68, y2: 50 },
      { id: "e4", kind: "line", x1: 68, y1: 50, x2: 42, y2: 65 }
    ]
  }
];

export function gridSizeInPixels(settings: PidEditorSettings): number {
  const size = Math.max(0.25, Number(settings.gridSize) || 1);
  return settings.unit === "mm" ? size * (96 / 25.4) : size;
}

export function normalizeNode(node: Node): Node<PidNodeData> {
  return {
    ...node,
    type: "pidSymbol",
    style: { width: 112, height: 86, ...node.style },
    data: {
      label: String(node.data?.label ?? node.id),
      symbolType: String(node.data?.symbolType ?? node.type ?? "valve"),
      rotation: Number(node.data?.rotation ?? 0)
    }
  };
}

export function normalizeEdge(edge: Edge): Edge<PidEdgeData> {
  const data = (edge.data ?? {}) as PidEdgeData;
  const waypoints = Array.isArray(data.waypoints) ? data.waypoints : undefined;
  const hasLegacyRoute = data.startX !== undefined || data.bendX !== undefined || data.bendY !== undefined;
  return {
    ...edge,
    type: "pidLine",
    data: {
      ...data,
      color: data.color ?? "#243248",
      thickness: data.thickness ?? 2,
      routing: data.routing ?? (waypoints || hasLegacyRoute ? "manual" : "auto"),
      waypoints
    }
  };
}

function key(point: Point): string {
  return `${point.x}:${point.y}`;
}

function simplify(points: Point[]): Point[] {
  const unique = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  return unique.filter((point, index) => {
    if (index === 0 || index === unique.length - 1) return true;
    const before = unique[index - 1];
    const after = unique[index + 1];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
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
      return simplify([
        source,
        { x: start.x, y: source.y },
        ...result,
        { x: goal.x, y: target.y },
        target
      ]);
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
      ) continue;
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

export function orthogonalPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

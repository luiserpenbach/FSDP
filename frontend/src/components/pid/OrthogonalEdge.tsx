/**
 * Orthogonal (pipe-run) edge with a draggable handle on every segment.
 *
 * Routing: the line leaves each port through a short perpendicular stub in
 * the direction the port faces (which follows symbol rotation), then runs an
 * orthogonal polyline through `data.waypoints`. While no waypoints are set,
 * corners are derived automatically (and keep following the nodes); the
 * first drag materializes them. Dragging any segment moves it perpendicular
 * to itself — segments next to a fixed stub grow a new corner, draw.io
 * style. Double-clicking a handle resets the whole line to automatic
 * routing. Junction nodes (pidJunction) connect with no stub, auto-oriented.
 *
 * Styling lives on edge.data (color, stroke style/width, arrow) so the hover
 * editor bar can restyle lines in place.
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { BaseEdge, EdgeLabelRenderer, MarkerType, Position, useReactFlow, type EdgeProps } from "reactflow";

export type EdgeStrokeStyle = "solid" | "dashed" | "dotted";

export type Point = { x: number; y: number };

export type OrthogonalEdgeData = {
  /** Orthogonal corner points, in flow coordinates. Present (even empty)
   *  once the user has routed the line by hand; absent = automatic. */
  waypoints?: Point[];
  /** Legacy three-parameter routing (pre-waypoints); still honored as the
   *  default route for saved diagrams. */
  bendX?: number;
  bendY?: number;
  startX?: number;
  endX?: number;
  color?: string;
  strokeStyle?: EdgeStrokeStyle;
  strokeWidth?: number;
  showArrow?: boolean;
  fluid?: string | null;
  pressure_bar?: number | null;
  temperature_c?: number | null;
  diameter_mm?: number | null;
  material?: string | null;
};

export const EDGE_DEFAULT_COLOR = "#41536b";
export const EDGE_COLORS = ["#41536b", "#2257c4", "#0f766e", "#b3261e", "#8a5b00", "#6d28d9"];
export const EDGE_WIDTHS = [1.2, 1.8, 2.8];
export const EDGE_DEFAULT_WIDTH = 1.8;
const BEND_RADIUS = 3;
const MIN_HANDLE_SEGMENT = 7;

export function edgeMarker(data: OrthogonalEdgeData | undefined) {
  if (data?.showArrow === false) return undefined;
  return {
    type: MarkerType.ArrowClosed,
    width: 13,
    height: 13,
    color: data?.color ?? EDGE_DEFAULT_COLOR
  };
}

const DASH_PATTERNS: Record<EdgeStrokeStyle, string | undefined> = {
  solid: undefined,
  dashed: "8 5",
  dotted: "2 5"
};

function snapTo(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

/** Orthogonal polyline with corners rounded to BEND_RADIUS (clamped to short segments). */
export function roundedOrthogonalPath(points: Point[]): string {
  const cleaned = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  );
  if (cleaned.length < 2) return "";
  let path = `M ${cleaned[0].x},${cleaned[0].y}`;
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const previous = cleaned[index - 1];
    const corner = cleaned[index];
    const next = cleaned[index + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(BEND_RADIUS, inLength / 2, outLength / 2);
    if (radius < 0.1) {
      path += ` L ${corner.x},${corner.y}`;
      continue;
    }
    const entry = {
      x: corner.x - ((corner.x - previous.x) / inLength) * radius,
      y: corner.y - ((corner.y - previous.y) / inLength) * radius
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) / outLength) * radius,
      y: corner.y + ((next.y - corner.y) / outLength) * radius
    };
    path += ` L ${entry.x},${entry.y} Q ${corner.x},${corner.y} ${exit.x},${exit.y}`;
  }
  const last = cleaned[cleaned.length - 1];
  return `${path} L ${last.x},${last.y}`;
}

/** Minimum straight run leaving a port before the first bend. */
export const ROUTE_STUB = 14;

function isHorizontal(position: Position): boolean {
  return position === Position.Left || position === Position.Right;
}

function stubPoint(x: number, y: number, position: Position, length: number): Point {
  switch (position) {
    case Position.Left:
      return { x: x - length, y };
    case Position.Right:
      return { x: x + length, y };
    case Position.Top:
      return { x, y: y - length };
    default:
      return { x, y: y + length };
  }
}

/** Which way an endpoint should face to head toward the far end. */
export function dominantDirection(fromX: number, fromY: number, toX: number, toY: number): Position {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? Position.Right : Position.Left;
  return deltaY >= 0 ? Position.Bottom : Position.Top;
}

/** Short straight run leaving a junction's center before the first bend. */
export const JUNCTION_STUB = 8;

const POSITION_TO_JUNCTION_HANDLE: Record<Position, "l" | "r" | "t" | "b"> = {
  [Position.Left]: "l",
  [Position.Right]: "r",
  [Position.Top]: "t",
  [Position.Bottom]: "b"
};

/** The junction handle whose direction points from the junction toward (toX, toY). */
export function junctionHandleToward(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): "l" | "r" | "t" | "b" {
  return POSITION_TO_JUNCTION_HANDLE[dominantDirection(fromX, fromY, toX, toY)];
}

/**
 * Default x for the vertical backbone segment nearest a port: a third of the
 * way toward the far end, but never behind the port's stub — a left-facing
 * port routes out to the left even when its partner sits to the right.
 */
function defaultBackboneX(portX: number, position: Position, towardX: number, stub: number): number {
  const natural = portX + (towardX - portX) / 3;
  if (isHorizontal(position) && stub > 0) {
    const sign = position === Position.Right ? 1 : -1;
    if ((natural - portX) * sign < stub) return portX + sign * stub;
  }
  return natural;
}

export type OrthogonalRoute = {
  /** Full structural point list: [source, exit, ...corners, entry, target].
   *  Consecutive points may coincide (zero-length stubs); rendering dedupes. */
  points: Point[];
  corners: Point[];
  exit: Point;
  entry: Point;
};

export function buildOrthogonalRoute({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  sourceStub = ROUTE_STUB,
  targetStub = ROUTE_STUB,
  data
}: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  sourceStub?: number;
  targetStub?: number;
  data?: OrthogonalEdgeData;
}): OrthogonalRoute {
  const exit = stubPoint(sourceX, sourceY, sourcePosition, sourceStub);
  const entry = stubPoint(targetX, targetY, targetPosition, targetStub);

  let corners: Point[];
  if (Array.isArray(data?.waypoints)) {
    corners = data.waypoints;
  } else {
    const startX =
      typeof data?.startX === "number"
        ? data.startX
        : defaultBackboneX(sourceX, sourcePosition, targetX, sourceStub);
    const endX =
      typeof data?.endX === "number"
        ? data.endX
        : defaultBackboneX(targetX, targetPosition, sourceX, targetStub);
    // Vertical ports pull the horizontal run to their stub level so the line
    // clears the symbol before turning; otherwise run midway between ports.
    const bendY =
      typeof data?.bendY === "number"
        ? data.bendY
        : !isHorizontal(sourcePosition)
          ? exit.y
          : !isHorizontal(targetPosition)
            ? entry.y
            : sourceY + (targetY - sourceY) / 2;
    corners = [
      { x: startX, y: exit.y },
      { x: startX, y: bendY },
      { x: endX, y: bendY },
      { x: endX, y: entry.y }
    ];
  }

  // Re-establish orthogonality where node movement broke it: insert an
  // L-connector along the port's axis at the ends, horizontal-first between
  // waypoints (only ever needed for hand-edited data).
  const chained: Point[] = [];
  let previous = exit;
  corners.forEach((corner, index) => {
    if (previous.x !== corner.x && previous.y !== corner.y) {
      if (index === 0 && !isHorizontal(sourcePosition)) chained.push({ x: previous.x, y: corner.y });
      else chained.push({ x: corner.x, y: previous.y });
    }
    chained.push(corner);
    previous = corner;
  });
  if (previous.x !== entry.x && previous.y !== entry.y) {
    if (isHorizontal(targetPosition)) chained.push({ x: previous.x, y: entry.y });
    else chained.push({ x: entry.x, y: previous.y });
  }

  return {
    points: [{ x: sourceX, y: sourceY }, exit, ...chained, entry, { x: targetX, y: targetY }],
    corners: chained,
    exit,
    entry
  };
}

/** Drop corners that no longer bend the line (duplicates and collinear middles). */
export function cleanupWaypoints(corners: Point[], exit: Point, entry: Point): Point[] {
  const chain = [exit, ...corners, entry];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < chain.length - 1; index += 1) {
      const [a, b, c] = [chain[index - 1], chain[index], chain[index + 1]];
      const duplicate = a.x === b.x && a.y === b.y;
      const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (duplicate || collinear) {
        chain.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return chain.slice(1, -1);
}

/** Shift a line's hand-placed geometry (used when a whole section moves). */
export function translateEdgeGeometry(
  data: OrthogonalEdgeData | undefined,
  deltaX: number,
  deltaY: number
): OrthogonalEdgeData | undefined {
  if (!data) return data;
  const next: OrthogonalEdgeData = { ...data };
  let changed = false;
  if (Array.isArray(data.waypoints)) {
    next.waypoints = data.waypoints.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY }));
    changed = true;
  }
  if (typeof data.startX === "number") {
    next.startX = data.startX + deltaX;
    changed = true;
  }
  if (typeof data.endX === "number") {
    next.endX = data.endX + deltaX;
    changed = true;
  }
  if (typeof data.bendX === "number") {
    next.bendX = data.bendX + deltaX;
    changed = true;
  }
  if (typeof data.bendY === "number") {
    next.bendY = data.bendY + deltaY;
    changed = true;
  }
  return changed ? next : data;
}

/** True when the line carries hand-placed geometry that should move with its nodes. */
export function hasStoredGeometry(data: OrthogonalEdgeData | undefined): boolean {
  return (
    Array.isArray(data?.waypoints) ||
    typeof data?.startX === "number" ||
    typeof data?.endX === "number" ||
    typeof data?.bendY === "number" ||
    typeof data?.bendX === "number"
  );
}

type EdgeCallbacks = {
  onDirty: () => void;
  onHistory: () => void;
  gridSize: number;
};

export function OrthogonalEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  selected,
  label,
  data,
  onDirty,
  onHistory,
  gridSize
}: EdgeProps<OrthogonalEdgeData> & EdgeCallbacks) {
  const { screenToFlowPosition, setEdges, setNodes, getNode } = useReactFlow();
  const [hovered, setHovered] = useState(false);

  // Junction endpoints anchor at the junction's center; the connected
  // handle's Position (one of four discrete directions) steers the exit, with
  // a short stub so the line clears the dot before bending.
  const sourceIsJunction = getNode(source)?.type === "pidJunction";
  const targetIsJunction = getNode(target)?.type === "pidJunction";
  const route = buildOrthogonalRoute({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    sourceStub: sourceIsJunction ? JUNCTION_STUB : ROUTE_STUB,
    targetStub: targetIsJunction ? JUNCTION_STUB : ROUTE_STUB,
    data
  });
  const { points, corners, exit, entry } = route;
  const path = roundedOrthogonalPath(points);

  const color = data?.color ?? EDGE_DEFAULT_COLOR;
  const baseWidth = data?.strokeWidth ?? EDGE_DEFAULT_WIDTH;
  const active = Boolean(selected) || hovered;

  // One handle per movable segment: everything between the two stubs.
  const lastIndex = points.length - 1;
  const handleSegments: Array<{ index: number; x: number; y: number; horizontal: boolean }> = [];
  for (let index = 1; index <= lastIndex - 2; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < MIN_HANDLE_SEGMENT) continue;
    handleSegments.push({
      index,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      horizontal: a.y === b.y
    });
  }

  function selectThisEdge() {
    setNodes((currentNodes) =>
      currentNodes.some((node) => node.selected)
        ? currentNodes.map((node) => (node.selected ? { ...node, selected: false } : node))
        : currentNodes
    );
    setEdges((currentEdges) =>
      currentEdges.map((edge) =>
        Boolean(edge.selected) === (edge.id === id) ? edge : { ...edge, selected: edge.id === id }
      )
    );
  }

  function beginSegmentDrag(event: ReactPointerEvent<SVGRectElement>, segmentIndex: number) {
    event.preventDefault();
    event.stopPropagation();
    onHistory();
    selectThisEdge();

    // Everything derives from the geometry captured at drag start, so
    // corner insertion stays deterministic while the pointer moves.
    const basePoints = points.map((point) => ({ ...point }));
    const baseCorners = corners.map((point) => ({ ...point }));
    const a = basePoints[segmentIndex];
    const b = basePoints[segmentIndex + 1];
    const horizontal = a.y === b.y;
    const aIsFixed = segmentIndex <= 1;
    const bIsFixed = segmentIndex + 1 >= basePoints.length - 2;

    function drag(moveEvent: PointerEvent) {
      const pointer = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      const value = horizontal ? snapTo(pointer.y, gridSize) : snapTo(pointer.x, gridSize);
      const moved = baseCorners.map((point) => ({ ...point }));
      // Corner j sits at structural index j + 2.
      if (!aIsFixed) {
        const cornerA = moved[segmentIndex - 2];
        if (horizontal) cornerA.y = value;
        else cornerA.x = value;
      }
      if (!bIsFixed) {
        const cornerB = moved[segmentIndex - 1];
        if (horizontal) cornerB.y = value;
        else cornerB.x = value;
      }
      // A segment touching a fixed stub grows a new corner at that end.
      if (aIsFixed) moved.unshift(horizontal ? { x: exit.x, y: value } : { x: value, y: exit.y });
      if (bIsFixed) moved.push(horizontal ? { x: entry.x, y: value } : { x: value, y: entry.y });
      setEdges((currentEdges) =>
        currentEdges.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  waypoints: moved,
                  startX: undefined,
                  endX: undefined,
                  bendX: undefined,
                  bendY: undefined
                }
              }
            : edge
        )
      );
    }

    function stopDrag() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", stopDrag);
      setEdges((currentEdges) =>
        currentEdges.map((edge) =>
          edge.id === id && Array.isArray(edge.data?.waypoints)
            ? { ...edge, data: { ...edge.data, waypoints: cleanupWaypoints(edge.data.waypoints, exit, entry) } }
            : edge
        )
      );
      onDirty();
    }

    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", stopDrag);
  }

  function resetRouting() {
    onHistory();
    setEdges((currentEdges) =>
      currentEdges.map((edge) =>
        edge.id === id
          ? {
              ...edge,
              data: {
                ...edge.data,
                waypoints: undefined,
                startX: undefined,
                endX: undefined,
                bendX: undefined,
                bendY: undefined
              }
            }
          : edge
      )
    );
    onDirty();
  }

  // Label sits above the longest segment so it stays on the line.
  let labelAnchor = { x: (exit.x + entry.x) / 2, y: (exit.y + entry.y) / 2 };
  let longest = 0;
  for (let index = 0; index < lastIndex; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) {
      longest = length;
      labelAnchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          stroke: selected ? "#2257c4" : color,
          strokeWidth: active ? baseWidth + 0.6 : baseWidth,
          strokeDasharray: DASH_PATTERNS[data?.strokeStyle ?? "solid"],
          transition: "stroke 0.12s ease, stroke-width 0.12s ease, filter 0.18s ease",
          filter: active ? "drop-shadow(0 0 3.5px rgba(34, 87, 196, 0.5))" : undefined
        }}
      />
      {/* Wide invisible path so hover triggers without pixel-hunting the line. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Bend handles live in the edge's own SVG group, positioned by
          attributes — nothing transform-based that could animate or drift. */}
      <g
        className={active ? "edgeHandles visible" : "edgeHandles"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {handleSegments.map((segment) => (
          <BendHandle
            key={segment.index}
            x={segment.x}
            y={segment.y}
            orientation={segment.horizontal ? "horizontal" : "vertical"}
            title="Drag to move this line segment · double-click to reset routing"
            onPointerDown={(event) => beginSegmentDrag(event, segment.index)}
            onDoubleClick={resetRouting}
          />
        ))}
      </g>
      <EdgeLabelRenderer>
        {label ? (
          <div
            className="edgeLabelChip"
            style={{ transform: `translate(-50%, -100%) translate(${labelAnchor.x}px, ${labelAnchor.y - 6}px)` }}
          >
            {String(label)}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

const BEND_HANDLE_SIZE = 9;

function BendHandle({
  x,
  y,
  orientation,
  title,
  onPointerDown,
  onDoubleClick
}: {
  x: number;
  y: number;
  orientation: "vertical" | "horizontal";
  title: string;
  onPointerDown: (event: ReactPointerEvent<SVGRectElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <rect
      className={`edgeBendHandle ${orientation}`}
      x={x - BEND_HANDLE_SIZE / 2}
      y={y - BEND_HANDLE_SIZE / 2}
      width={BEND_HANDLE_SIZE}
      height={BEND_HANDLE_SIZE}
      rx={2.5}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick();
      }}
    >
      <title>{title}</title>
    </rect>
  );
}

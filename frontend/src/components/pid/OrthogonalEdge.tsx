/**
 * Orthogonal (pipe-run) edge with draggable bend handles.
 *
 * Styling lives on edge.data (color, stroke style, arrow) so the hover
 * editor bar can restyle lines in place. Bend handles fade/scale in when the
 * line is hovered or selected, and the path glows on hover.
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { BaseEdge, EdgeLabelRenderer, MarkerType, useReactFlow, type EdgeProps } from "reactflow";

export type EdgeStrokeStyle = "solid" | "dashed" | "dotted";

export type OrthogonalEdgeData = {
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

const BEND_SNAP = 10;

function snap(value: number): number {
  return Math.round(value / BEND_SNAP) * BEND_SNAP;
}

export const EDGE_WIDTHS = [1.2, 1.8, 2.8];
export const EDGE_DEFAULT_WIDTH = 1.8;
const BEND_RADIUS = 3;

type Point = { x: number; y: number };

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

type EdgeCallbacks = {
  onDirty: () => void;
  onHistory: () => void;
};

export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  selected,
  label,
  data,
  onDirty,
  onHistory
}: EdgeProps<OrthogonalEdgeData> & EdgeCallbacks) {
  const { screenToFlowPosition, setEdges, setNodes } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const deltaX = targetX - sourceX;
  const startX = typeof data?.startX === "number" ? data.startX : sourceX + deltaX / 3;
  const endX = typeof data?.endX === "number" ? data.endX : sourceX + (deltaX * 2) / 3;
  const bendY = typeof data?.bendY === "number" ? data.bendY : sourceY + (targetY - sourceY) / 2;
  const path = roundedOrthogonalPath([
    { x: sourceX, y: sourceY },
    { x: startX, y: sourceY },
    { x: startX, y: bendY },
    { x: endX, y: bendY },
    { x: endX, y: targetY },
    { x: targetX, y: targetY }
  ]);

  const color = data?.color ?? EDGE_DEFAULT_COLOR;
  const baseWidth = data?.strokeWidth ?? EDGE_DEFAULT_WIDTH;
  const active = Boolean(selected) || hovered;

  function beginDrag(
    event: ReactPointerEvent<SVGRectElement>,
    update: (position: { x: number; y: number }) => Partial<OrthogonalEdgeData>
  ) {
    event.preventDefault();
    event.stopPropagation();
    onHistory();
    // Grabbing a bend handle acts on this line: select it (and only it) so
    // the hovering editor bar appears even for a click without a drag.
    setNodes((currentNodes) =>
      currentNodes.some((node) => node.selected)
        ? currentNodes.map((node) => (node.selected ? { ...node, selected: false } : node))
        : currentNodes
    );
    setEdges((currentEdges) =>
      currentEdges.map((edge) => (Boolean(edge.selected) === (edge.id === id) ? edge : { ...edge, selected: edge.id === id }))
    );

    function drag(moveEvent: PointerEvent) {
      const position = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      const snapped = { x: snap(position.x), y: snap(position.y) };
      setEdges((currentEdges) =>
        currentEdges.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  ...update(snapped)
                }
              }
            : edge
        )
      );
    }

    function stopDrag() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", stopDrag);
      onDirty();
    }

    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", stopDrag);
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
        <BendHandle
          x={startX}
          y={(sourceY + bendY) / 2}
          orientation="vertical"
          title="Drag to move first vertical line segment"
          onPointerDown={(event) => beginDrag(event, (position) => ({ startX: position.x, bendX: undefined }))}
        />
        <BendHandle
          x={(startX + endX) / 2}
          y={bendY}
          orientation="horizontal"
          title="Drag to move horizontal line segment"
          onPointerDown={(event) => beginDrag(event, (position) => ({ bendY: position.y }))}
        />
        <BendHandle
          x={endX}
          y={(bendY + targetY) / 2}
          orientation="vertical"
          title="Drag to move last vertical line segment"
          onPointerDown={(event) => beginDrag(event, (position) => ({ endX: position.x, bendX: undefined }))}
        />
      </g>
      <EdgeLabelRenderer>
        {label ? (
          <div
            className="edgeLabelChip"
            style={{ transform: `translate(-50%, -100%) translate(${(startX + endX) / 2}px, ${bendY - 6}px)` }}
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
  onPointerDown
}: {
  x: number;
  y: number;
  orientation: "vertical" | "horizontal";
  title: string;
  onPointerDown: (event: ReactPointerEvent<SVGRectElement>) => void;
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
    >
      <title>{title}</title>
    </rect>
  );
}

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
  const { screenToFlowPosition, setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const deltaX = targetX - sourceX;
  const startX = typeof data?.startX === "number" ? data.startX : sourceX + deltaX / 3;
  const endX = typeof data?.endX === "number" ? data.endX : sourceX + (deltaX * 2) / 3;
  const bendY = typeof data?.bendY === "number" ? data.bendY : sourceY + (targetY - sourceY) / 2;
  const path = `M ${sourceX},${sourceY} L ${startX},${sourceY} L ${startX},${bendY} L ${endX},${bendY} L ${endX},${targetY} L ${targetX},${targetY}`;

  const color = data?.color ?? EDGE_DEFAULT_COLOR;
  const active = Boolean(selected) || hovered;
  const handlesVisible = active ? "edgeBendHandle visible" : "edgeBendHandle";

  function beginDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    update: (position: { x: number; y: number }) => Partial<OrthogonalEdgeData>
  ) {
    event.preventDefault();
    event.stopPropagation();
    onHistory();

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
          strokeWidth: active ? 2.4 : 1.8,
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
      <EdgeLabelRenderer>
        {label ? (
          <div
            className="edgeLabelChip"
            style={{ transform: `translate(-50%, -100%) translate(${(startX + endX) / 2}px, ${bendY - 6}px)` }}
          >
            {String(label)}
          </div>
        ) : null}
        <div
          className={`${handlesVisible} vertical`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerDown={(event) => beginDrag(event, (position) => ({ startX: position.x, bendX: undefined }))}
          style={{ transform: `translate(-50%, -50%) translate(${startX}px, ${(sourceY + bendY) / 2}px)` }}
          title="Drag to move first vertical line segment"
        />
        <div
          className={`${handlesVisible} horizontal`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerDown={(event) => beginDrag(event, (position) => ({ bendY: position.y }))}
          style={{ transform: `translate(-50%, -50%) translate(${(startX + endX) / 2}px, ${bendY}px)` }}
          title="Drag to move horizontal line segment"
        />
        <div
          className={`${handlesVisible} vertical`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onPointerDown={(event) => beginDrag(event, (position) => ({ endX: position.x, bendX: undefined }))}
          style={{ transform: `translate(-50%, -50%) translate(${endX}px, ${(bendY + targetY) / 2}px)` }}
          title="Drag to move last vertical line segment"
        />
      </EdgeLabelRenderer>
    </>
  );
}

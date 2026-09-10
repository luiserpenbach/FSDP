/**
 * React host for the schematic engine: an SVG viewport in paper space (mm)
 * that renders items with the engine's own renderer and forwards pointer and
 * keyboard events to the Editor session.
 */
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ForwardedRef,
  type PointerEvent as ReactPointerEvent,
  forwardRef
} from "react";
import type { Editor, EditorSnapshot, Modifiers } from "../../engine/editor";
import type { DrawingContext } from "../../engine/frames";
import { type SymbolRegistry } from "../../engine/library";
import { renderFrame, renderItem, renderJunctions, pathFromPoints } from "../../engine/render";
import { frameRect, sheetSize } from "../../engine/sheet";
import { itemBounds } from "../../engine/spatial";
import type { Item, Point, Rect } from "../../engine/types";

export type Viewport = { x: number; y: number; zoom: number };

export type SchematicCanvasHandle = {
  fitToSheet: () => void;
  zoomBy: (factor: number) => void;
  viewport: () => Viewport;
};

export function useEditorSnapshot(editor: Editor): EditorSnapshot {
  const subscribe = useCallback((listener: () => void) => editor.subscribe(listener), [editor]);
  return useSyncExternalStore(subscribe, () => editor.snapshot, () => editor.snapshot);
}

const ItemView = memo(function ItemView({ item, registry, notes }: { item: Item; registry: SymbolRegistry; notes: boolean }) {
  return <g dangerouslySetInnerHTML={{ __html: renderItem(item, { registry, notes }) }} />;
});

function modifiers(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): Modifiers {
  return { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey };
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 60;

function SchematicCanvasInner(
  {
    editor,
    showGrid,
    context,
    onCursor,
    onViewport
  }: {
    editor: Editor;
    showGrid: boolean;
    /** Drawing/revision data for the title block and revision table. */
    context?: DrawingContext;
    onCursor?: (point: Point | null) => void;
    onViewport?: (viewport: Viewport) => void;
  },
  ref: ForwardedRef<SchematicCanvasHandle>
) {
  const snapshot = useEditorSnapshot(editor);
  const { doc, state, connectivity } = snapshot;
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 24, y: 24, zoom: 2 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Viewport } | null>(null);
  const spaceHeld = useRef(false);
  const sheetKey = `${doc.sheet.size}-${doc.sheet.orientation}`;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const fitToSheet = useCallback(() => {
    const paper = sheetSize(doc.sheet);
    const element = containerRef.current;
    const width = element?.clientWidth || size.width;
    const height = element?.clientHeight || size.height;
    const zoom = Math.max(MIN_ZOOM, Math.min((width - 48) / paper.width, (height - 48) / paper.height));
    setViewport({ x: (width - paper.width * zoom) / 2, y: (height - paper.height * zoom) / 2, zoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetKey, size.width, size.height]);

  const zoomAround = useCallback((factor: number, centre: { x: number; y: number }) => {
    setViewport((current) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      const scale = zoom / current.zoom;
      return { zoom, x: centre.x - (centre.x - current.x) * scale, y: centre.y - (centre.y - current.y) * scale };
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fitToSheet,
      zoomBy: (factor) => zoomAround(factor, { x: size.width / 2, y: size.height / 2 }),
      viewport: () => viewport
    }),
    [fitToSheet, zoomAround, size.width, size.height, viewport]
  );

  // Fit once the container has a size and whenever the sheet changes.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (size.width < 50 || size.height < 50) return;
    if (fittedFor.current === sheetKey) return;
    fittedFor.current = sheetKey;
    fitToSheet();
  }, [sheetKey, size.width, size.height, fitToSheet]);

  useEffect(() => {
    editor.setTolerance(6 / viewport.zoom);
    onViewport?.(viewport);
  }, [editor, viewport, onViewport]);

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const centre = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || !event.shiftKey) {
        zoomAround(Math.exp(-event.deltaY * 0.0015), centre);
      } else {
        setViewport((current) => ({ ...current, x: current.x - event.deltaY }));
      }
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [zoomAround]);

  const toSheet = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return { x: (clientX - left - viewport.x) / viewport.zoom, y: (clientY - top - viewport.y) / viewport.zoom };
    },
    [viewport]
  );

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    containerRef.current?.focus();
    const isPan = event.button === 1 || (event.button === 0 && spaceHeld.current);
    if (isPan) {
      panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: viewport };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    editor.pointerDown(toSheet(event.clientX, event.clientY), modifiers(event));
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      setViewport({ ...pan.origin, x: pan.origin.x + event.clientX - pan.startX, y: pan.origin.y + event.clientY - pan.startY });
      return;
    }
    const point = toSheet(event.clientX, event.clientY);
    editor.pointerMove(point, modifiers(event));
    onCursor?.(point);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }
    if (event.button !== 0) return;
    editor.pointerUp(toSheet(event.clientX, event.clientY), modifiers(event));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === " " && !state.wire) {
      spaceHeld.current = true;
      event.preventDefault();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && (event.key === "z" || event.key === "Z")) {
      if (event.shiftKey) editor.store.redo();
      else editor.store.undo();
      event.preventDefault();
      return;
    }
    if (ctrl && (event.key === "y" || event.key === "Y")) {
      editor.store.redo();
      event.preventDefault();
      return;
    }
    if (editor.key(event.key, modifiers(event))) event.preventDefault();
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === " ") spaceHeld.current = false;
  }

  const paper = sheetSize(doc.sheet);
  const frame = frameRect(doc.sheet);
  const registry = editor.registry;
  const selected = new Set(state.selection);
  const ghost = editor.ghostSymbol();
  const wirePreview = editor.wirePreview();
  const hidden = new Set(doc.layers.filter((layer) => layer.hidden).map((layer) => layer.id));
  const overlayStroke = 1.5 / viewport.zoom;
  const showPorts = state.tool === "wire" || state.tool === "place";
  const windowRect: Rect | null =
    state.drag?.kind === "window" && state.tool === "select"
      ? {
          x: Math.min(state.drag.origin.x, state.drag.current.x),
          y: Math.min(state.drag.origin.y, state.drag.current.y),
          width: Math.abs(state.drag.current.x - state.drag.origin.x),
          height: Math.abs(state.drag.current.y - state.drag.origin.y)
        }
      : null;
  const crossing = state.drag?.kind === "window" && state.drag.current.x < state.drag.origin.x;
  const cursorClass = state.tool === "select" ? (state.hover ? "canvasHover" : "") : "canvasCrosshair";

  return (
    <div
      ref={containerRef}
      className={`schematicCanvas ${cursorClass}`.trim()}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => onCursor?.(null)}
      onDoubleClick={(event) => editor.doubleClick(toSheet(event.clientX, event.clientY))}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(event) => event.preventDefault()}
      data-testid="schematic-canvas"
    >
      <svg className="schematicSvg" width="100%" height="100%">
        <defs>
          <pattern id="schematicGrid" width={state.grid} height={state.grid} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={Math.max(0.12, 0.7 / viewport.zoom)} fill="#9aa9bd" />
          </pattern>
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          <rect x={0} y={0} width={paper.width} height={paper.height} fill="#ffffff" stroke="#c7d0dc" strokeWidth={overlayStroke} />
          {showGrid && (
            <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} fill="url(#schematicGrid)" pointerEvents="none" />
          )}
          <g dangerouslySetInnerHTML={{ __html: renderFrame(doc, context) }} />
          <g className="items">
            {doc.items.map((item) =>
              hidden.has(item.layer) ? null : <ItemView key={item.id} item={item} registry={registry} notes />
            )}
          </g>
          <g dangerouslySetInnerHTML={{ __html: renderJunctions(connectivity) }} />

          {/* ---- overlays ---- */}
          <g className="overlays" pointerEvents="none">
            {showPorts &&
              doc.items.map((item) =>
                item.kind === "symbol"
                  ? registry.portsOf(item).map((port) => (
                      <circle
                        key={`${item.id}:${port.id}`}
                        cx={port.position.x}
                        cy={port.position.y}
                        r={0.9}
                        fill={port.kind === "signal" ? "#fff7ed" : "#eef4ff"}
                        stroke={port.kind === "signal" ? "#c2410c" : "#2257c4"}
                        strokeWidth={overlayStroke}
                        opacity={0.8}
                      />
                    ))
                  : null
              )}
            {connectivity.danglingEnds.map((end) => (
              <circle key={`${end.lineId}-${end.end}`} cx={end.position.x} cy={end.position.y} r={1.2} fill="none" stroke="#b3261e" strokeWidth={overlayStroke * 1.2} />
            ))}
            {state.hover && !selected.has(state.hover) && state.tool === "select" && (() => {
              const item = doc.items.find((entry) => entry.id === state.hover);
              if (!item) return null;
              const rect = itemBounds(item, registry);
              return <rect x={rect.x - 1} y={rect.y - 1} width={rect.width + 2} height={rect.height + 2} fill="none" stroke="#7da2d8" strokeWidth={overlayStroke} strokeDasharray={`${3 / viewport.zoom} ${2 / viewport.zoom}`} />;
            })()}
            {doc.items.map((item) => {
              if (!selected.has(item.id)) return null;
              const rect = itemBounds(item, registry);
              return (
                <g key={`sel-${item.id}`}>
                  <rect x={rect.x - 1} y={rect.y - 1} width={rect.width + 2} height={rect.height + 2} fill="rgba(34,87,196,0.06)" stroke="#2257c4" strokeWidth={overlayStroke} />
                  {item.kind === "line" &&
                    item.points.map((point, index) => (
                      <rect key={index} x={point.x - 1} y={point.y - 1} width={2} height={2} fill="#ffffff" stroke="#2257c4" strokeWidth={overlayStroke} />
                    ))}
                  {item.kind === "symbol" &&
                    registry.portsOf(item).map((port) => (
                      <circle key={port.id} cx={port.position.x} cy={port.position.y} r={0.9} fill="#ffffff" stroke="#2257c4" strokeWidth={overlayStroke} />
                    ))}
                </g>
              );
            })}
            {wirePreview.length >= 2 && (
              <path d={pathFromPoints(wirePreview)} fill="none" stroke="#2257c4" strokeWidth={0.5} strokeDasharray="1.5 1" strokeLinecap="round" />
            )}
            {state.snap && state.tool === "wire" && (
              <circle
                cx={state.snap.point.x}
                cy={state.snap.point.y}
                r={state.snap.kind === "grid" ? 0.6 : 1.4}
                fill="none"
                stroke={state.snap.kind === "port" ? "#0f766e" : state.snap.kind === "grid" ? "#7da2d8" : "#b45309"}
                strokeWidth={overlayStroke * 1.4}
              />
            )}
            {ghost && (
              <g opacity={0.55} dangerouslySetInnerHTML={{ __html: renderItem(ghost, { registry, notes: false }) }} />
            )}
            {windowRect && (
              <rect
                x={windowRect.x}
                y={windowRect.y}
                width={windowRect.width}
                height={windowRect.height}
                fill={crossing ? "rgba(15,118,110,0.08)" : "rgba(34,87,196,0.08)"}
                stroke={crossing ? "#0f766e" : "#2257c4"}
                strokeWidth={overlayStroke}
                strokeDasharray={crossing ? `${2 / viewport.zoom} ${2 / viewport.zoom}` : undefined}
              />
            )}
            {state.equipmentDraft && (
              <rect x={state.equipmentDraft.x} y={state.equipmentDraft.y} width={state.equipmentDraft.width} height={state.equipmentDraft.height} fill="rgba(34,87,196,0.05)" stroke="#2257c4" strokeWidth={overlayStroke} strokeDasharray="3 1.5" />
            )}
          </g>
        </g>
      </svg>
    </div>
  );
}

export const SchematicCanvas = forwardRef(SchematicCanvasInner);

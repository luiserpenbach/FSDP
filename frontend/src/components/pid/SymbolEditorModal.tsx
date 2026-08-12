/**
 * Symbol editor: create custom P&ID symbols from SVG markup and place
 * connection ports on them (KiCad-style pin placement).
 *
 * Workflow: import or paste SVG (or draw lines/rects/circles directly on the
 * grid with the toolbar) → click the preview in Ports mode to drop a port
 * exactly on the drawing → drag ports to fine-tune → save. Ports are stored
 * in viewBox coordinates alongside the sanitized SVG; drawn shapes are kept
 * as separate SVG element strings and merged with the imported base on save.
 */
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../../api";
import { parseViewBox } from "../PidSymbols";
import type { PidSymbolDef, SymbolPort, SymbolPortSide } from "../../types";

const DEFAULT_VIEWBOX = "0 0 64 40";
const EXAMPLE_SVG = [
  '<path d="M12 10 L32 20 L12 30 Z" />',
  '<path d="M52 10 L32 20 L52 30 Z" />',
  '<path d="M2 20 H12 M52 20 H62" />'
].join("\n");

/** Strip active content and return { viewBox, inner } from raw SVG text. */
export function importSvgMarkup(raw: string): { viewBox: string; inner: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("SVG markup is empty.");

  const source = trimmed.startsWith("<svg") || trimmed.includes("<svg")
    ? trimmed
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${DEFAULT_VIEWBOX}">${trimmed}</svg>`;
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("Could not parse SVG markup.");
  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("No <svg> element found.");

  svg.querySelectorAll("script, foreignObject, iframe, style").forEach((element) => element.remove());
  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && !value.startsWith("#"))) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  let viewBox = svg.getAttribute("viewBox");
  if (!viewBox) {
    const width = Number.parseFloat(svg.getAttribute("width") ?? "");
    const height = Number.parseFloat(svg.getAttribute("height") ?? "");
    viewBox = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? `0 0 ${width} ${height}`
      : DEFAULT_VIEWBOX;
  }
  const inner = svg.innerHTML.trim();
  if (!inner) throw new Error("SVG has no drawable content.");
  return { viewBox, inner };
}

export type DrawPoint = { x: number; y: number };

type ToolMode = "port" | "line" | "rect" | "circle";

/** Grid pitch (in viewBox units) that drawn coordinates snap to. */
const DRAW_GRID = 2;

const TOOL_MODES: Array<{ id: ToolMode; label: string; title: string }> = [
  { id: "port", label: "Ports", title: "Click to add connection ports" },
  { id: "line", label: "Line", title: "Click vertices; double-click or Enter to finish" },
  { id: "rect", label: "Rect", title: "Drag to draw a rectangle" },
  { id: "circle", label: "Circle", title: "Drag from the center to draw a circle" }
];

const TOOL_HINTS: Record<ToolMode, string> = {
  port: "Click the preview to add a connection port on the drawing; drag ports to adjust. Ports are where lines attach on the canvas.",
  line: "Click to place vertices; double-click or press Enter to finish the line, Escape to cancel.",
  rect: "Press and drag on the preview to draw a rectangle.",
  circle: "Press at the center and drag outward to draw a circle."
};

/** Snap a coordinate to the given grid pitch. */
export function snapToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

/**
 * Build an absolute move/line path from clicked vertices. Consecutive
 * duplicate points (e.g. left behind by a finishing double-click) are
 * dropped; returns null when fewer than two distinct points remain.
 */
export function linePath(points: DrawPoint[]): string | null {
  const distinct = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  );
  if (distinct.length < 2) return null;
  return distinct.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

/** Normalize a drag into a positive rect; null when either side is under 2 units. */
export function normalizedRect(
  a: DrawPoint,
  b: DrawPoint
): { x: number; y: number; width: number; height: number } | null {
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 2 || height < 2) return null;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
}

function circleRadius(center: DrawPoint, edge: DrawPoint): number {
  return Math.round(Math.hypot(edge.x - center.x, edge.y - center.y));
}

function nearestSide(x: number, y: number, viewBox: { x: number; y: number; width: number; height: number }): SymbolPortSide {
  const distances: Array<[SymbolPortSide, number]> = [
    ["left", x - viewBox.x],
    ["right", viewBox.x + viewBox.width - x],
    ["top", y - viewBox.y],
    ["bottom", viewBox.y + viewBox.height - y]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

const EMPTY_DRAFT = {
  id: null as string | null,
  name: "",
  viewBox: DEFAULT_VIEWBOX,
  svg: "",
  drawn: [] as string[],
  ports: [] as SymbolPort[]
};

export function SymbolEditorModal({
  open,
  symbols,
  onClose,
  onChanged
}: {
  open: boolean;
  symbols: PidSymbolDef[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [markupDraft, setMarkupDraft] = useState("");
  const [tool, setTool] = useState<ToolMode>("port");
  const [linePoints, setLinePoints] = useState<DrawPoint[]>([]);
  const [shapeDraft, setShapeDraft] = useState<{ start: DrawPoint; end: DrawPoint } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_DRAFT);
      setMarkupDraft("");
      setTool("port");
      setLinePoints([]);
      setShapeDraft(null);
      setError("");
    }
  }, [open]);

  // Finish (Enter) or cancel (Escape) the in-progress line from the keyboard.
  useEffect(() => {
    if (!open || linePoints.length === 0) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest("input, textarea")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        const path = linePath(linePoints);
        if (path) setDraft((current) => ({ ...current, drawn: [...current.drawn, `<path d="${path}" />`] }));
        setLinePoints([]);
      } else if (event.key === "Escape") {
        setLinePoints([]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, linePoints]);

  if (!open) return null;

  const viewBox = parseViewBox(draft.viewBox);
  const combinedSvg = [draft.svg, ...draft.drawn].filter(Boolean).join("\n");
  const shapeRect = shapeDraft && tool === "rect" ? normalizedRect(shapeDraft.start, shapeDraft.end) : null;
  const shapeR = shapeDraft && tool === "circle" ? circleRadius(shapeDraft.start, shapeDraft.end) : 0;

  function applyMarkup(raw: string) {
    try {
      const { viewBox: nextViewBox, inner } = importSvgMarkup(raw);
      setDraft((current) => ({ ...current, viewBox: nextViewBox, svg: inner }));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import SVG.");
    }
  }

  function loadSymbol(symbol: PidSymbolDef) {
    setDraft({ id: symbol.id, name: symbol.name, viewBox: symbol.view_box, svg: symbol.svg, drawn: [], ports: [...symbol.ports] });
    setMarkupDraft(symbol.svg);
    setLinePoints([]);
    setShapeDraft(null);
    setError("");
  }

  function uploadSvg(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      setMarkupDraft(text);
      applyMarkup(text);
    });
    event.target.value = "";
  }

  function previewCoords(clientX: number, clientY: number, grid = 1): { x: number; y: number } | null {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width;
    const y = viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height;
    return { x: snapToGrid(x, grid), y: snapToGrid(y, grid) };
  }

  function appendShape(element: string) {
    setDraft((current) => ({ ...current, drawn: [...current.drawn, element] }));
  }

  function selectTool(next: ToolMode) {
    setTool(next);
    setLinePoints([]);
    setShapeDraft(null);
  }

  function undoShape() {
    setDraft((current) => ({ ...current, drawn: current.drawn.slice(0, -1) }));
  }

  function addLinePoint(event: ReactPointerEvent<HTMLDivElement>) {
    const coords = previewCoords(event.clientX, event.clientY, DRAW_GRID);
    if (!coords) return;
    setLinePoints((current) => [...current, coords]);
  }

  function finishLine() {
    const path = linePath(linePoints);
    if (path) appendShape(`<path d="${path}" />`);
    setLinePoints([]);
  }

  function startShape(event: ReactPointerEvent<HTMLDivElement>, shapeTool: "rect" | "circle") {
    const pressed = previewCoords(event.clientX, event.clientY, DRAW_GRID);
    if (!pressed) return;
    const start: DrawPoint = pressed;
    setShapeDraft({ start, end: start });

    function move(moveEvent: PointerEvent) {
      const end = previewCoords(moveEvent.clientX, moveEvent.clientY, DRAW_GRID);
      if (end) setShapeDraft({ start, end });
    }

    function stop(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setShapeDraft(null);
      const end = previewCoords(upEvent.clientX, upEvent.clientY, DRAW_GRID) ?? start;
      if (shapeTool === "rect") {
        const rect = normalizedRect(start, end);
        if (rect) appendShape(`<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" />`);
      } else {
        const r = circleRadius(start, end);
        if (r >= 1) appendShape(`<circle cx="${start.x}" cy="${start.y}" r="${r}" />`);
      }
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function previewPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (tool === "port") {
      addPort(event);
      return;
    }
    event.preventDefault();
    if (tool === "line") addLinePoint(event);
    else startShape(event, tool);
  }

  function addPort(event: ReactPointerEvent<HTMLDivElement>) {
    if (!combinedSvg) return;
    const coords = previewCoords(event.clientX, event.clientY);
    if (!coords) return;
    setDraft((current) => {
      let index = current.ports.length + 1;
      while (current.ports.some((port) => port.id === `p${index}`)) index += 1;
      return {
        ...current,
        ports: [...current.ports, { id: `p${index}`, ...coords, side: nearestSide(coords.x, coords.y, viewBox) }]
      };
    });
  }

  function dragPort(event: ReactPointerEvent<HTMLButtonElement>, portId: string) {
    event.preventDefault();
    event.stopPropagation();

    function move(moveEvent: PointerEvent) {
      const coords = previewCoords(moveEvent.clientX, moveEvent.clientY);
      if (!coords) return;
      setDraft((current) => ({
        ...current,
        ports: current.ports.map((port) =>
          port.id === portId ? { ...port, ...coords, side: nearestSide(coords.x, coords.y, viewBox) } : port
        )
      }));
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function removePort(portId: string) {
    setDraft((current) => ({ ...current, ports: current.ports.filter((port) => port.id !== portId) }));
  }

  async function save() {
    if (!draft.name.trim() || !combinedSvg) return;
    setBusy(true);
    setError("");
    try {
      const body = { name: draft.name.trim(), view_box: draft.viewBox, svg: combinedSvg, ports: draft.ports };
      if (draft.id) await api.updateSymbol(draft.id, body);
      else await api.createSymbol(body);
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save symbol.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSymbol(symbol: PidSymbolDef) {
    if (!window.confirm(`Delete symbol "${symbol.name}"? Diagrams using it will fall back to a generic glyph.`)) return;
    setBusy(true);
    try {
      await api.deleteSymbol(symbol.id);
      if (draft.id === symbol.id) {
        setDraft(EMPTY_DRAFT);
        setMarkupDraft("");
      }
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete symbol.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBackdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal symbolEditor">
        <div className="modalHeader">
          <h2>Symbol editor</h2>
          <button className="modalClose" onClick={onClose} title="Close" type="button">&#215;</button>
        </div>
        <div className="symbolEditorBody">
          <aside className="symbolEditorList">
            <button
              className="primary"
              type="button"
              onClick={() => { setDraft(EMPTY_DRAFT); setMarkupDraft(""); setLinePoints([]); setShapeDraft(null); setError(""); }}
            >
              + New symbol
            </button>
            {symbols.length === 0 && <p className="hint">No custom symbols yet.</p>}
            {symbols.map((symbol) => (
              <div className={draft.id === symbol.id ? "symbolListRow selected" : "symbolListRow"} key={symbol.id}>
                <button className="symbolListName" type="button" onClick={() => loadSymbol(symbol)}>{symbol.name}</button>
                <button className="symbolListDelete" disabled={busy} title="Delete symbol" type="button" onClick={() => void removeSymbol(symbol)}>&#215;</button>
              </div>
            ))}
          </aside>
          <div className="symbolEditorMain">
            <div className="symbolEditorFields">
              <label>
                Name
                <input value={draft.name} placeholder="e.g. Cryo check valve" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label className="fileButton">
                Import SVG file
                <input type="file" accept=".svg,image/svg+xml" onChange={uploadSvg} />
              </label>
            </div>
            <label>
              SVG markup (viewBox {draft.viewBox})
              <textarea
                className="symbolMarkup"
                value={markupDraft}
                placeholder={`Paste SVG markup or path elements, e.g.\n${EXAMPLE_SVG}`}
                spellCheck={false}
                onChange={(event) => setMarkupDraft(event.target.value)}
                onBlur={() => markupDraft.trim() && applyMarkup(markupDraft)}
              />
            </label>
            <div className="symbolToolbar">
              {TOOL_MODES.map((mode) => (
                <button
                  key={mode.id}
                  className={tool === mode.id ? "symbolToolButton active" : "symbolToolButton"}
                  title={mode.title}
                  type="button"
                  onClick={() => selectTool(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
              <button
                className="symbolToolButton symbolToolUndo"
                disabled={draft.drawn.length === 0}
                title="Remove the last drawn shape"
                type="button"
                onClick={undoShape}
              >
                Undo shape
              </button>
            </div>
            <p className="hint">{TOOL_HINTS[tool]}</p>
            <div className="symbolPreviewWrap">
              <div
                className="symbolPreview"
                ref={previewRef}
                style={{ aspectRatio: `${viewBox.width} / ${viewBox.height}` }}
                onPointerDown={previewPointerDown}
                onDoubleClick={tool === "line" ? finishLine : undefined}
              >
                {combinedSvg ? (
                  <svg
                    viewBox={draft.viewBox}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    preserveAspectRatio="none"
                    dangerouslySetInnerHTML={{ __html: combinedSvg }}
                  />
                ) : (
                  <span className="symbolPreviewEmpty">Draw with the tools above, or import/paste SVG</span>
                )}
                {(linePoints.length > 0 || shapeRect !== null || shapeR >= 1) && (
                  <svg
                    className="symbolDrawOverlay"
                    viewBox={draft.viewBox}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    preserveAspectRatio="none"
                  >
                    {linePoints.length > 1 && (
                      <polyline points={linePoints.map((point) => `${point.x},${point.y}`).join(" ")} />
                    )}
                    {linePoints.map((point, index) => (
                      <circle key={index} cx={point.x} cy={point.y} r={1.4} fill="currentColor" stroke="none" strokeDasharray="none" />
                    ))}
                    {shapeRect && <rect x={shapeRect.x} y={shapeRect.y} width={shapeRect.width} height={shapeRect.height} />}
                    {shapeDraft && tool === "circle" && shapeR >= 1 && (
                      <circle cx={shapeDraft.start.x} cy={shapeDraft.start.y} r={shapeR} />
                    )}
                  </svg>
                )}
                {draft.ports.map((port) => (
                  <button
                    key={port.id}
                    className="symbolPortDot"
                    style={{
                      left: `${((port.x - viewBox.x) / viewBox.width) * 100}%`,
                      top: `${((port.y - viewBox.y) / viewBox.height) * 100}%`
                    }}
                    title={`${port.id} (${port.x}, ${port.y}) — drag to move`}
                    type="button"
                    onPointerDown={(event) => dragPort(event, port.id)}
                  >
                    <i>{port.id}</i>
                  </button>
                ))}
              </div>
            </div>
            {draft.ports.length > 0 && (
              <div className="symbolPortList">
                {draft.ports.map((port) => (
                  <span className="symbolPortRow" key={port.id}>
                    <span className="mono">{port.id}</span> ({port.x}, {port.y}) · {port.side}
                    <button type="button" title="Remove port" onClick={() => removePort(port.id)}>&#215;</button>
                  </span>
                ))}
              </div>
            )}
            {error && <p className="formError">{error}</p>}
            <div className="buttonRow modalActions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={busy || !draft.name.trim() || !combinedSvg}
                type="button"
                onClick={() => void save()}
              >
                {draft.id ? "Update symbol" : "Save symbol"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { renderPrimitive } from "./SymbolArtwork";
import type { PidSymbolDefinition, Point, PortDirection, SymbolPort, SymbolPrimitive } from "../../pid-cad";

type Tool = "select" | "line" | "polyline" | "rect" | "circle" | "arc" | "port";

type Props = {
  initial?: PidSymbolDefinition;
  onCancel: () => void;
  onSave: (symbol: PidSymbolDefinition) => void;
};

type StudioSnapshot = {
  name: string;
  primitives: SymbolPrimitive[];
  ports: SymbolPort[];
};

export function SymbolStudio({ initial, onCancel, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? "Custom symbol");
  const [primitives, setPrimitives] = useState<SymbolPrimitive[]>(initial?.primitives ?? []);
  const [ports, setPorts] = useState<SymbolPort[]>(initial?.ports ?? []);
  const [tool, setTool] = useState<Tool>("line");
  const [draftStart, setDraftStart] = useState<Point | null>(null);
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [past, setPast] = useState<StudioSnapshot[]>([]);
  const [future, setFuture] = useState<StudioSnapshot[]>([]);
  const counter = useRef(0);

  function snapshot(): StudioSnapshot {
    return { name, primitives, ports };
  }

  function pushHistory() {
    setPast((current) => [...current, snapshot()].slice(-50));
    setFuture([]);
  }

  function undo() {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setFuture((current) => [snapshot(), ...current]);
    setPast((current) => current.slice(0, -1));
    setName(previous.name);
    setPrimitives(previous.primitives);
    setPorts(previous.ports);
  }

  function redo() {
    if (future.length === 0) return;
    const [next, ...rest] = future;
    setPast((current) => [...current, snapshot()]);
    setFuture(rest);
    setName(next.name);
    setPrimitives(next.primitives);
    setPorts(next.ports);
  }

  function svgPoint(event: ReactPointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const snap = (value: number) => Math.round(value / 5) * 5;
    return {
      x: Math.max(0, Math.min(100, snap(((event.clientX - rect.left) / rect.width) * 100))),
      y: Math.max(0, Math.min(100, snap(((event.clientY - rect.top) / rect.height) * 100)))
    };
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.target !== event.currentTarget && (event.target as Element).tagName !== "rect") return;
    const point = svgPoint(event);
    if (tool === "port") {
      pushHistory();
      const id = `port-${Date.now()}-${counter.current++}`;
      setPorts((current) => [...current, { id, name: `Port ${current.length + 1}`, direction: "bidir", required: true, ...point }]);
      setSelectedId(id);
      return;
    }
    if (tool === "polyline") {
      setPolyPoints((current) => [...current, point]);
      return;
    }
    if (tool !== "select") setDraftStart(point);
    else setSelectedId("");
  }

  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draftStart || tool === "polyline" || tool === "port" || tool === "select") return;
    const end = svgPoint(event);
    const id = `shape-${Date.now()}-${counter.current++}`;
    let primitive: SymbolPrimitive;
    if (tool === "line") {
      primitive = { id, kind: "line", x1: draftStart.x, y1: draftStart.y, x2: end.x, y2: end.y };
    } else if (tool === "rect") {
      primitive = {
        id,
        kind: "rect",
        x: Math.min(draftStart.x, end.x),
        y: Math.min(draftStart.y, end.y),
        width: Math.max(2, Math.abs(end.x - draftStart.x)),
        height: Math.max(2, Math.abs(end.y - draftStart.y))
      };
    } else if (tool === "arc") {
      const r = Math.max(2, Math.hypot(end.x - draftStart.x, end.y - draftStart.y));
      primitive = { id, kind: "arc", cx: draftStart.x, cy: draftStart.y, r, startAngle: 200, endAngle: 340 };
    } else {
      primitive = {
        id,
        kind: "circle",
        cx: draftStart.x,
        cy: draftStart.y,
        r: Math.max(2, Math.hypot(end.x - draftStart.x, end.y - draftStart.y))
      };
    }
    pushHistory();
    setPrimitives((current) => [...current, primitive]);
    setSelectedId(id);
    setDraftStart(null);
  }

  function finishPolyline() {
    if (polyPoints.length < 2) {
      setPolyPoints([]);
      return;
    }
    pushHistory();
    const id = `shape-${Date.now()}-${counter.current++}`;
    setPrimitives((current) => [...current, { id, kind: "polyline", points: polyPoints }]);
    setSelectedId(id);
    setPolyPoints([]);
  }

  function deleteSelected() {
    if (!selectedId) return;
    pushHistory();
    setPrimitives((current) => current.filter((item) => item.id !== selectedId));
    setPorts((current) => current.filter((item) => item.id !== selectedId));
    setSelectedId("");
  }

  function movePort(event: ReactPointerEvent<SVGCircleElement>, portId: string) {
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pushHistory();
    const update = (moveEvent: PointerEvent) => {
      const x = Math.max(0, Math.min(100, Math.round((((moveEvent.clientX - rect.left) / rect.width) * 100) / 5) * 5));
      const y = Math.max(0, Math.min(100, Math.round((((moveEvent.clientY - rect.top) / rect.height) * 100) / 5) * 5));
      setPorts((current) => current.map((port) => (port.id === portId ? { ...port, x, y } : port)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  }

  function movePrimitive(event: ReactPointerEvent<SVGElement>, primitiveId: string) {
    event.stopPropagation();
    setSelectedId(primitiveId);
    if (tool !== "select") return;
    const canvas = event.currentTarget.ownerSVGElement;
    const original = primitives.find((primitive) => primitive.id === primitiveId);
    if (!canvas || !original) return;
    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    pushHistory();
    const update = (moveEvent: PointerEvent) => {
      const dx = Math.round((((moveEvent.clientX - startX) / rect.width) * 100) / 5) * 5;
      const dy = Math.round((((moveEvent.clientY - startY) / rect.height) * 100) / 5) * 5;
      setPrimitives((current) =>
        current.map((primitive) => {
          if (primitive.id !== primitiveId) return primitive;
          if (original.kind === "line") {
            return { ...original, x1: original.x1 + dx, x2: original.x2 + dx, y1: original.y1 + dy, y2: original.y2 + dy };
          }
          if (original.kind === "rect") return { ...original, x: original.x + dx, y: original.y + dy };
          if (original.kind === "polyline") {
            return { ...original, points: original.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
          }
          if (original.kind === "arc") return { ...original, cx: original.cx + dx, cy: original.cy + dy };
          return { ...original, cx: original.cx + dx, cy: original.cy + dy };
        })
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop);
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if (event.key === "Escape") {
        if (polyPoints.length) setPolyPoints([]);
        else onCancel();
      }
      if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
      if (event.key === "Enter" && tool === "polyline") finishPolyline();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });

  const selectedPort = ports.find((p) => p.id === selectedId);

  return (
    <div aria-modal="true" className="pidModalBackdrop" role="dialog">
      <div className="pidSymbolEditor pidSymbolStudio">
        <header>
          <div>
            <span className="pidEyebrow">CAD symbol designer</span>
            <h2>{initial ? "Edit symbol" : "Create symbol"}</h2>
          </div>
          <div className="pidCommandGroup">
            <button className="secondary" disabled={!past.length} onClick={undo} type="button">Undo</button>
            <button className="secondary" disabled={!future.length} onClick={redo} type="button">Redo</button>
            <button className="pidIconButton" onClick={onCancel} title="Close" type="button">×</button>
          </div>
        </header>
        <div className="pidSymbolEditorBody">
          <aside>
            <label>
              Symbol name
              <input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <div className="pidToolGrid">
              {(["select", "line", "polyline", "rect", "circle", "arc", "port"] as Tool[]).map((item) => (
                <button className={tool === item ? "active" : ""} key={item} onClick={() => setTool(item)} type="button">
                  {item}
                </button>
              ))}
            </div>
            {tool === "polyline" && (
              <button className="secondary" onClick={finishPolyline} type="button">Finish polyline (Enter)</button>
            )}
            <p className="pidHelp">5-unit grid · origin at center · ports become connection handles. Undo with Ctrl+Z.</p>
            <button disabled={!selectedId} onClick={deleteSelected} type="button">Delete selected</button>
            {selectedPort && (
              <div className="pidPortEditor">
                <label>
                  Port name
                  <input
                    onChange={(event) =>
                      setPorts((current) => current.map((item) => (item.id === selectedPort.id ? { ...item, name: event.target.value } : item)))
                    }
                    value={selectedPort.name}
                  />
                </label>
                <label>
                  Direction
                  <select
                    onChange={(event) =>
                      setPorts((current) =>
                        current.map((item) =>
                          item.id === selectedPort.id ? { ...item, direction: event.target.value as PortDirection } : item
                        )
                      )
                    }
                    value={selectedPort.direction ?? "bidir"}
                  >
                    <option value="in">In</option>
                    <option value="out">Out</option>
                    <option value="bidir">Bidirectional</option>
                  </select>
                </label>
                <label className="pidToggle">
                  <input
                    checked={selectedPort.required !== false}
                    onChange={(event) =>
                      setPorts((current) =>
                        current.map((item) => (item.id === selectedPort.id ? { ...item, required: event.target.checked } : item))
                      )
                    }
                    type="checkbox"
                  />
                  Required for DRC
                </label>
              </div>
            )}
            {ports.map((port) => (
              <button
                className={`pidPortChip ${selectedId === port.id ? "active" : ""}`}
                key={port.id}
                onClick={() => setSelectedId(port.id)}
                type="button"
              >
                {port.name} · {port.direction ?? "bidir"} · ({port.x},{port.y})
              </button>
            ))}
          </aside>
          <div className="pidSymbolCanvas">
            <svg onPointerDown={pointerDown} onPointerUp={pointerUp} viewBox="0 0 100 100">
              <defs>
                <pattern height="5" id="symbolGridCad" patternUnits="userSpaceOnUse" width="5">
                  <circle cx=".5" cy=".5" fill="#aab5c5" r=".35" />
                </pattern>
              </defs>
              <rect fill="url(#symbolGridCad)" height="100" width="100" />
              <line opacity=".25" stroke="#c24135" strokeWidth=".5" x1="50" x2="50" y1="0" y2="100" />
              <line opacity=".25" stroke="#c24135" strokeWidth=".5" x1="0" x2="100" y1="50" y2="50" />
              {primitives.map((primitive) => (
                <g
                  key={primitive.id}
                  onPointerDown={(event) => movePrimitive(event, primitive.id)}
                  style={{ cursor: tool === "select" ? "move" : "crosshair" }}
                >
                  {renderPrimitive(primitive, selectedId === primitive.id)}
                </g>
              ))}
              {polyPoints.length > 0 && (
                <polyline
                  fill="none"
                  points={polyPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                  stroke="#1f5eff"
                  strokeDasharray="2 2"
                  strokeWidth="2"
                />
              )}
              {ports.map((port) => (
                <circle
                  className={`symbolEditorPort ${selectedId === port.id ? "selected" : ""}`}
                  cx={port.x}
                  cy={port.y}
                  key={port.id}
                  onPointerDown={(event) => {
                    setSelectedId(port.id);
                    movePort(event, port.id);
                  }}
                  r="2.8"
                />
              ))}
            </svg>
          </div>
        </div>
        <footer>
          <button className="secondary" onClick={onCancel} type="button">Cancel</button>
          <button
            disabled={!name.trim() || primitives.length === 0 || ports.length === 0}
            onClick={() =>
              onSave({
                id: initial?.id ?? `custom-${Date.now()}`,
                name: name.trim(),
                category: "custom",
                ports,
                primitives
              })
            }
            type="button"
          >
            Save to library
          </button>
        </footer>
      </div>
    </div>
  );
}

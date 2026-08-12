/**
 * Symbol editor: create custom P&ID symbols from SVG markup and place
 * connection ports on them (KiCad-style pin placement).
 *
 * Workflow: import or paste SVG → preview renders it on a grid → click the
 * preview to drop a port exactly on the drawing → drag ports to fine-tune →
 * save. Ports are stored in viewBox coordinates alongside the sanitized SVG.
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

const EMPTY_DRAFT = { id: null as string | null, name: "", viewBox: DEFAULT_VIEWBOX, svg: "", ports: [] as SymbolPort[] };

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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(EMPTY_DRAFT);
      setMarkupDraft("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  const viewBox = parseViewBox(draft.viewBox);

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
    setDraft({ id: symbol.id, name: symbol.name, viewBox: symbol.view_box, svg: symbol.svg, ports: [...symbol.ports] });
    setMarkupDraft(symbol.svg);
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

  function previewCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width;
    const y = viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function addPort(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draft.svg) return;
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
    if (!draft.name.trim() || !draft.svg) return;
    setBusy(true);
    setError("");
    try {
      const body = { name: draft.name.trim(), view_box: draft.viewBox, svg: draft.svg, ports: draft.ports };
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
            <button className="primary" type="button" onClick={() => { setDraft(EMPTY_DRAFT); setMarkupDraft(""); setError(""); }}>
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
            <p className="hint">
              Click the preview to add a connection port on the drawing; drag ports to adjust. Ports are where lines attach on the canvas.
            </p>
            <div className="symbolPreviewWrap">
              <div
                className="symbolPreview"
                ref={previewRef}
                style={{ aspectRatio: `${viewBox.width} / ${viewBox.height}` }}
                onPointerDown={addPort}
              >
                {draft.svg ? (
                  <svg
                    viewBox={draft.viewBox}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    preserveAspectRatio="none"
                    dangerouslySetInnerHTML={{ __html: draft.svg }}
                  />
                ) : (
                  <span className="symbolPreviewEmpty">Import or paste SVG to start</span>
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
                disabled={busy || !draft.name.trim() || !draft.svg}
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

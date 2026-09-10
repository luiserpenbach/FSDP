/**
 * Drafting (preview): the new paper-space P&ID editor built on the schematic
 * engine. Opens a diagram's schematic document, or converts its legacy React
 * Flow graph on first open, and saves the document back to the API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { SchematicCanvas, useEditorSnapshot, type SchematicCanvasHandle, type Viewport } from "../components/schematic/SchematicCanvas";
import { convertLegacyGraph } from "../engine/convert";
import { Editor, type ToolId } from "../engine/editor";
import { polylineLength } from "../engine/geometry";
import { SymbolRegistry, refFor, symbolPorts } from "../engine/library";
import { LINE_TYPE_LABELS, renderDocumentSvg } from "../engine/render";
import { SHEET_SIZES, makeSheet, zoneAt } from "../engine/sheet";
import { DocumentStore } from "../engine/store";
import type { Item, LineType, Point, Rotation, SchematicDocument, SheetSizeId } from "../engine/types";
import type { Diagram, PidSymbolDef, User } from "../types";
import { PageLayout } from "./PageLayout";

type Props = {
  diagrams: Diagram[];
  initialDiagramId: string;
  customSymbols: PidSymbolDef[];
  user: User;
  canWrite: boolean;
  notify: (message: string, error?: boolean) => void;
};

const TOOLS: Array<{ id: ToolId; label: string; key: string }> = [
  { id: "select", label: "Select", key: "V" },
  { id: "wire", label: "Wire", key: "W" },
  { id: "label", label: "Text", key: "T" },
  { id: "equipment", label: "Equipment", key: "E" },
  { id: "note", label: "Note", key: "N" }
];

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

export function DraftingPage({ diagrams, initialDiagramId, customSymbols, user, canWrite, notify }: Props) {
  const [openId, setOpenId] = useState(initialDiagramId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(false);
  const [converted, setConverted] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef<SchematicCanvasHandle>(null);
  const registry = useMemo(() => SymbolRegistry.withBuiltins(customSymbols), [customSymbols]);
  const diagram = diagrams.find((entry) => entry.id === openId) ?? null;

  useEffect(() => {
    if (!diagrams.some((entry) => entry.id === openId)) setOpenId(diagrams[0]?.id ?? "");
  }, [diagrams, openId]);

  // Load (or convert) the document whenever the open diagram changes.
  useEffect(() => {
    let cancelled = false;
    if (!openId) {
      setEditor(null);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const schematic = await api.getSchematic(openId);
        let document: SchematicDocument;
        let wasConverted = false;
        if (schematic.document) {
          document = schematic.document as unknown as SchematicDocument;
        } else {
          const legacy = await api.getDiagram(openId);
          document = convertLegacyGraph(legacy.graph ?? {}, registry, { title: legacy.name });
          wasConverted = true;
        }
        if (cancelled) return;
        const store = new DocumentStore(document);
        if (wasConverted) store.markDirty();
        setEditor((previous) => {
          previous?.dispose();
          return new Editor(store, registry, { author: user.name });
        });
        setConverted(wasConverted);
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : "Could not open the drawing.", true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, registry]);

  useEffect(() => () => editor?.dispose(), [editor]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (editor?.store.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [editor]);

  const save = useCallback(async () => {
    if (!editor || !diagram) return;
    try {
      await api.saveSchematic(diagram.id, editor.store.doc);
      editor.store.markSaved();
      setConverted(false);
      notify(`Saved ${diagram.name}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Save failed.", true);
    }
  }, [editor, diagram, notify]);

  function exportSvg() {
    if (!editor || !diagram) return;
    const svg = renderDocumentSvg(editor.store.doc, registry, { standalone: true, background: "#ffffff" });
    downloadText(`${safeFilename(diagram.name)}-rev${diagram.revision}.svg`, svg, "image/svg+xml");
    notify("Exported SVG.");
  }

  function switchDiagram(nextId: string) {
    if (editor?.store.dirty && !window.confirm("Discard unsaved drafting changes?")) return;
    setOpenId(nextId);
  }

  return (
    <PageLayout className="draftingPage" title="Drafting" description="Paper-space P&ID editor (preview)">
      <div className="draftingLayout">
        <div className="draftingTop toolbar">
          <label>
            Drawing
            <select value={openId} onChange={(event) => switchDiagram(event.target.value)}>
              {diagrams.length === 0 && <option value="">No diagrams in this system</option>}
              {diagrams.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} rev {entry.revision}
                </option>
              ))}
            </select>
          </label>
          {editor && (
            <EditorToolbar
              editor={editor}
              registry={registry}
              canWrite={canWrite}
              showGrid={showGrid}
              onToggleGrid={() => setShowGrid((current) => !current)}
              onFit={() => canvasRef.current?.fitToSheet()}
              onZoom={(factor) => canvasRef.current?.zoomBy(factor)}
              onSave={() => void save()}
              onExportSvg={exportSvg}
            />
          )}
        </div>
        {converted && editor && (
          <p className="draftingNotice">
            Converted from the classic canvas. Symbols were snapped to the 2.5 mm grid and lines re-routed; save to keep this
            document.
          </p>
        )}
        <div className="draftingBody">
          {editor ? (
            <SchematicCanvas ref={canvasRef} editor={editor} showGrid={showGrid} onCursor={setCursor} onViewport={setViewport} />
          ) : (
            <div className="schematicCanvas schematicEmpty">
              <p className="hint">{loading ? "Opening drawing…" : "Create a P&ID on the Diagrams page, then open it here."}</p>
            </div>
          )}
          {editor && <Inspector editor={editor} registry={registry} canWrite={canWrite} />}
        </div>
        {editor && <StatusBar editor={editor} cursor={cursor} viewport={viewport} />}
      </div>
    </PageLayout>
  );
}

function EditorToolbar({
  editor,
  registry,
  canWrite,
  showGrid,
  onToggleGrid,
  onFit,
  onZoom,
  onSave,
  onExportSvg
}: {
  editor: Editor;
  registry: SymbolRegistry;
  canWrite: boolean;
  showGrid: boolean;
  onToggleGrid: () => void;
  onFit: () => void;
  onZoom: (factor: number) => void;
  onSave: () => void;
  onExportSvg: () => void;
}) {
  const { state, doc } = useEditorSnapshot(editor);
  const store = editor.store;
  const grouped = useMemo(() => {
    const groups = new Map<string, ReturnType<SymbolRegistry["list"]>>();
    for (const definition of registry.list()) {
      if (definition.key === "__missing__") continue;
      const bucket = groups.get(definition.category) ?? [];
      bucket.push(definition);
      groups.set(definition.category, bucket);
    }
    return [...groups.entries()];
  }, [registry]);
  const placingKey = state.tool === "place" && state.place ? `${state.place.symbol.library}/${state.place.symbol.key}` : "";

  return (
    <>
      <div className="toolGroup" role="group" aria-label="Tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={state.tool === tool.id ? "toolButton active" : "toolButton"}
            onClick={() => editor.setTool(tool.id)}
            title={`${tool.label} (${tool.key})`}
          >
            {tool.label}
          </button>
        ))}
      </div>
      <label>
        Place symbol
        <select
          value={placingKey}
          onChange={(event) => {
            const [library, key] = event.target.value.split("/");
            const definition = registry.list().find((entry) => entry.library === library && entry.key === key);
            if (definition) editor.startPlacing(refFor(definition));
          }}
        >
          <option value="">Choose…</option>
          {grouped.map(([category, definitions]) => (
            <optgroup key={category} label={category}>
              {definitions.map((definition) => (
                <option key={`${definition.library}/${definition.key}`} value={`${definition.library}/${definition.key}`}>
                  {definition.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Line type
        <select value={state.lineType} onChange={(event) => editor.setLineType(event.target.value as LineType)}>
          {(Object.keys(LINE_TYPE_LABELS) as LineType[]).map((type) => (
            <option key={type} value={type}>
              {LINE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sheet
        <select
          value={doc.sheet.size}
          onChange={(event) => store.dispatch({ type: "sheet", sheet: makeSheet(event.target.value as SheetSizeId, doc.sheet.orientation) })}
        >
          {(Object.keys(SHEET_SIZES) as SheetSizeId[]).map((size) => (
            <option key={size} value={size}>
              {SHEET_SIZES[size].label}
            </option>
          ))}
        </select>
      </label>
      <div className="toolGroup">
        <button type="button" disabled={!store.canUndo} onClick={() => store.undo()} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" disabled={!store.canRedo} onClick={() => store.redo()} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
        <button type="button" disabled={!state.selection.length && state.tool !== "place"} onClick={() => editor.rotateSelection()} title="Rotate (R)">
          Rotate
        </button>
        <button type="button" disabled={!state.selection.length && state.tool !== "place"} onClick={() => editor.mirrorSelection()} title="Mirror (X)">
          Mirror
        </button>
        <button type="button" disabled={!state.selection.length} onClick={() => editor.deleteSelection()} title="Delete (Del)">
          Delete
        </button>
      </div>
      <div className="toolGroup">
        <button type="button" onClick={onFit} title="Fit sheet">
          Fit
        </button>
        <button type="button" onClick={() => onZoom(1.25)} title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => onZoom(0.8)} title="Zoom out">
          −
        </button>
        <label className="checkRow">
          <input type="checkbox" checked={showGrid} onChange={onToggleGrid} />
          <span>Grid</span>
        </label>
        <select value={String(state.grid)} onChange={(event) => editor.setGrid(Number(event.target.value))} title="Snap grid">
          <option value="1.25">1.25 mm</option>
          <option value="2.5">2.5 mm</option>
          <option value="5">5 mm</option>
        </select>
      </div>
      <div className="toolGroup">
        <button type="button" onClick={onExportSvg}>
          Export SVG
        </button>
        <button type="button" className="primary" disabled={!canWrite || !store.dirty} onClick={onSave} title="Save (Ctrl+S)">
          {store.dirty ? "Save" : "Saved"}
        </button>
      </div>
    </>
  );
}

function Inspector({ editor, registry, canWrite }: { editor: Editor; registry: SymbolRegistry; canWrite: boolean }) {
  const { state, connectivity } = useEditorSnapshot(editor);
  const items = editor.selectedItems();
  const item: Item | undefined = items.length === 1 ? items[0] : undefined;
  const update = (patch: Record<string, unknown>) => {
    if (item && canWrite) editor.updateItem(item.id, patch);
  };

  return (
    <aside className="inspector draftingInspector">
      <article className="panel">
        <div className="panelHead">
          <h2>{item ? item.kind[0].toUpperCase() + item.kind.slice(1) : items.length ? `${items.length} items` : "Nothing selected"}</h2>
        </div>
        {!item && items.length === 0 && (
          <p className="hint">
            Click to select, drag to move. Shift-click adds. Drag left-to-right for a window, right-to-left for a crossing
            selection. Space + drag or middle mouse pans; wheel zooms.
          </p>
        )}
        {!item && items.length > 1 && (
          <p className="hint">Rotate (R), mirror (X), duplicate (Ctrl+D), or delete the selection.</p>
        )}
        {item?.kind === "symbol" && (
          <>
            <p>
              <strong>{registry.resolve(item.symbol).name}</strong> · {item.symbol.library}/{item.symbol.key} v{item.symbol.version}
            </p>
            <label>
              Tag
              <input value={item.tag ?? ""} onChange={(event) => update({ tag: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Label
              <input value={item.label ?? ""} onChange={(event) => update({ label: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Rotation
              <select value={String(item.rotation)} onChange={(event) => editor.rotateSelection(Number(event.target.value) - item.rotation)} disabled={!canWrite}>
                {ROTATIONS.map((rotation) => (
                  <option key={rotation} value={rotation}>
                    {rotation}°
                  </option>
                ))}
              </select>
            </label>
            <label className="checkRow">
              <input type="checkbox" checked={Boolean(item.mirror)} onChange={() => editor.mirrorSelection()} disabled={!canWrite} />
              <span>Mirrored</span>
            </label>
            <label>
              Position (mm)
              <input value={`${item.position.x}, ${item.position.y}`} readOnly />
            </label>
            <p>
              <strong>Ports</strong>
            </p>
            <ul className="portList">
              {symbolPorts(item, registry.resolve(item.symbol)).map((port) => {
                const net = connectivity.portNet.get(`${item.id}:${port.id}`);
                return (
                  <li key={port.id}>
                    <span className="mono">{port.id}</span> · {port.kind} · {net ? <span className="pill pill-good">{net}</span> : <span className="pill pill-warn">open</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {item?.kind === "line" && (
          <>
            <label>
              Line type
              <select
                value={item.lineType}
                onChange={(event) => update({ lineType: event.target.value, layer: event.target.value === "process" ? "process" : "signal" })}
                disabled={!canWrite}
              >
                {(Object.keys(LINE_TYPE_LABELS) as LineType[]).map((type) => (
                  <option key={type} value={type}>
                    {LINE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Line number
              <input value={item.lineNumber ?? ""} onChange={(event) => update({ lineNumber: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Service / fluid
              <input value={item.service ?? ""} onChange={(event) => update({ service: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Size
              <input value={item.size ?? ""} onChange={(event) => update({ size: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Spec
              <input value={item.spec ?? ""} onChange={(event) => update({ spec: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label className="checkRow">
              <input type="checkbox" checked={Boolean(item.showArrow)} onChange={(event) => update({ showArrow: event.target.checked })} disabled={!canWrite} />
              <span>Flow arrow at end</span>
            </label>
            <p>
              Length <span className="mono">{polylineLength(item.points).toFixed(1)} mm</span> · {item.points.length} vertices · net{" "}
              <span className="mono">{connectivity.lineNet.get(item.id) ?? "—"}</span>
            </p>
            <p className="hint">Drag a segment to slide it. Ends that sit on a port or another line are connected.</p>
          </>
        )}
        {item?.kind === "equipment" && (
          <>
            <label>
              Tag
              <input value={item.tag ?? ""} onChange={(event) => update({ tag: event.target.value || undefined })} disabled={!canWrite} />
            </label>
            <label>
              Name
              <input value={item.name} onChange={(event) => update({ name: event.target.value })} disabled={!canWrite} />
            </label>
            <label>
              Boundary
              <select value={item.boundary} onChange={(event) => update({ boundary: event.target.value })} disabled={!canWrite}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
              </select>
            </label>
            <p>
              <span className="mono">
                {item.size.width} × {item.size.height} mm
              </span>
            </p>
          </>
        )}
        {item?.kind === "label" && (
          <>
            <label>
              Text
              <textarea value={item.text} onChange={(event) => update({ text: event.target.value })} disabled={!canWrite} />
            </label>
            <label>
              Height (mm)
              <select value={String(item.fontSize)} onChange={(event) => update({ fontSize: Number(event.target.value) })} disabled={!canWrite}>
                {[1.8, 2.5, 3.5, 5, 7].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Anchor
              <select value={item.anchor} onChange={(event) => update({ anchor: event.target.value })} disabled={!canWrite}>
                <option value="start">Left</option>
                <option value="middle">Centre</option>
                <option value="end">Right</option>
              </select>
            </label>
          </>
        )}
        {item?.kind === "note" && (
          <>
            <label>
              Note
              <textarea value={item.text} onChange={(event) => update({ text: event.target.value })} disabled={!canWrite} />
            </label>
            <p className="hint">
              {item.author ?? "Unknown"} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}. Notes are never printed.
            </p>
          </>
        )}
      </article>
      <article className="panel">
        <div className="panelHead">
          <h2>Checks</h2>
        </div>
        <p>
          <strong>{connectivity.nets.length}</strong> nets · <strong>{connectivity.junctions.length}</strong> junctions
        </p>
        <p>
          {connectivity.danglingEnds.length ? (
            <span className="pill pill-warn">{connectivity.danglingEnds.length} dangling line end(s)</span>
          ) : (
            <span className="pill pill-good">no dangling lines</span>
          )}
        </p>
        <p>
          <span className="pill pill-muted">{connectivity.openPorts.length} open port(s)</span>
        </p>
        {state.tool === "wire" && (
          <p className="hint">Click a port or point to start, click to add corners, click a port or line to finish. Space flips the bend, Enter ends, Esc cancels.</p>
        )}
        {state.tool === "place" && <p className="hint">Click to place. R rotates, X mirrors, Esc stops placing.</p>}
      </article>
    </aside>
  );
}

function StatusBar({ editor, cursor, viewport }: { editor: Editor; cursor: Point | null; viewport: Viewport }) {
  const { doc, state } = useEditorSnapshot(editor);
  const zone = cursor ? zoneAt(doc.sheet, cursor) : null;
  return (
    <div className="draftingStatus">
      <span className="mono">{cursor ? `${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)} mm` : "—"}</span>
      <span className="mono">zone {zone ?? "—"}</span>
      <span className="mono">{Math.round(viewport.zoom * 100)}%</span>
      <span>grid {state.grid} mm</span>
      <span>
        {SHEET_SIZES[doc.sheet.size].label} · {doc.items.length} items
      </span>
      <span className="statusTool">{state.tool}</span>
      <span>{editor.store.dirty ? "Unsaved changes" : "Saved"}</span>
    </div>
  );
}

/**
 * Drafting: the paper-space P&ID editor built on the schematic engine.
 *
 * Works on controlled drawings (number, title, size, revisions) made of
 * sheets; each sheet holds a schematic document. Legacy diagrams can be
 * converted into a new drawing. Export renders the sheet with the shared
 * renderer and lets the server turn the SVG into PDF or PNG.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { LibraryPanel } from "../components/schematic/LibraryPanel";
import { SchematicCanvas, useEditorSnapshot, type SchematicCanvasHandle, type Viewport } from "../components/schematic/SchematicCanvas";
import { convertLegacyGraph } from "../engine/convert";
import { Editor, type ToolId } from "../engine/editor";
import { FRAME_TEMPLATE_LABELS, type DrawingContext, type FrameTemplateId } from "../engine/frames";
import { polylineLength } from "../engine/geometry";
import { SymbolRegistry } from "../engine/library";
import { LINE_TYPE_LABELS, renderDocumentSvg } from "../engine/render";
import { SHEET_SIZES, makeSheet, zoneAt } from "../engine/sheet";
import { DocumentStore } from "../engine/store";
import { DEFAULT_TAG_SCHEME, normalizeScheme, tagIssues, validateTag, type TagScheme } from "../engine/tags";
import type { Item, LineType, Point, Rotation, SchematicDocument, SheetSizeId, SymbolDef } from "../engine/types";
import type { Diagram, Drawing, DrawingRevision, FluidSystem, PidSymbolDef, User } from "../types";
import { PageLayout } from "./PageLayout";

type Props = {
  projectId: string;
  projectName: string;
  systems: FluidSystem[];
  /** Diagrams of the currently selected system (conversion sources). */
  diagrams: Diagram[];
  selectedSystemId: string;
  customSymbols: PidSymbolDef[];
  /** Reload custom symbols after their library metadata changes. */
  refreshSymbols?: () => void;
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

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function stringField(fields: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Bind drawing, sheet, and revision rows into the title block context. */
export function buildDrawingContext(
  drawing: Drawing,
  sheetNo: number,
  sheetTitle: string | null | undefined,
  projectName: string,
  systemName: string | undefined
): DrawingContext {
  const sizeLabel = SHEET_SIZES[drawing.size as SheetSizeId]?.label.replace("ISO ", "").replace("ANSI ", "") ?? drawing.size;
  return {
    number: drawing.number,
    title: drawing.title,
    projectName,
    systemName,
    company: stringField(drawing.fields, "company"),
    discipline: drawing.discipline,
    units: drawing.units,
    scale: stringField(drawing.fields, "scale") ?? "NO SCALE",
    status: drawing.status,
    sizeLabel,
    sheetNo,
    sheetCount: drawing.sheets.length,
    sheetTitle,
    revisions: drawing.revisions.map((revision) => ({
      label: revision.label,
      description: revision.description,
      date: revision.drawn_date ?? revision.created_at.slice(0, 10),
      by: revision.drawn_by,
      approvedBy: revision.approved_by,
      status: revision.status
    })),
    notes: drawing.notes ?? [],
    proprietaryNotice: stringField(drawing.fields, "proprietary_notice"),
    exportDate: todayIso(),
    fields: { checked_by: drawing.revisions[drawing.revisions.length - 1]?.checked_by ?? "" }
  };
}

/** Apply the drawing's frame template to a sheet document (no undo entry). */
function withFrameTemplate(document: SchematicDocument, template: string): SchematicDocument {
  const frameTemplate = (template as FrameTemplateId) ?? "basic";
  const kind = frameTemplate === "none" ? "none" : "basic";
  if (document.sheet.frame.template === frameTemplate && document.sheet.frame.kind === kind) return document;
  return { ...document, sheet: { ...document.sheet, frame: { ...document.sheet.frame, kind, template: frameTemplate } } };
}

/** Symbol families used on the sheet, for the generated legend. */
export function usedSymbols(document: SchematicDocument, registry: SymbolRegistry): Array<{ definition: SymbolDef; count: number }> {
  const counts = new Map<string, { definition: SymbolDef; count: number }>();
  for (const item of document.items) {
    if (item.kind !== "symbol") continue;
    const definition = registry.resolve(item.symbol);
    const key = `${definition.library}/${definition.key}`;
    const entry = counts.get(key) ?? { definition, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    const actuator = registry.actuatorOf(item);
    if (actuator) {
      const actuatorKey = `${actuator.library}/${actuator.key}`;
      const actuatorEntry = counts.get(actuatorKey) ?? { definition: actuator, count: 0 };
      actuatorEntry.count += 1;
      counts.set(actuatorKey, actuatorEntry);
    }
  }
  return [...counts.values()].sort((a, b) => a.definition.category.localeCompare(b.definition.category) || a.definition.name.localeCompare(b.definition.name));
}

export function legendFlags(drawing: Drawing | null): { symbols: boolean; letters: boolean } {
  const raw = stringField(drawing?.fields, "legends") ?? "";
  return { symbols: raw.includes("symbols"), letters: raw.includes("letters") };
}

/** Add the generated legend blocks the drawing asks for. */
export function withLegends(base: DrawingContext, document: SchematicDocument, registry: SymbolRegistry, scheme: TagScheme, flags: { symbols: boolean; letters: boolean }): DrawingContext {
  if (!flags.symbols && !flags.letters) return base;
  return {
    ...base,
    legends: {
      symbols: flags.symbols ? usedSymbols(document, registry) : undefined,
      letters: flags.letters ? { first: scheme.firstLetters, succeeding: scheme.succeedingLetters } : undefined
    }
  };
}

function DrawingCanvas({
  editor,
  registry,
  showGrid,
  baseContext,
  scheme,
  flags,
  canvasRef,
  onCursor,
  onViewport
}: {
  editor: Editor;
  registry: SymbolRegistry;
  showGrid: boolean;
  baseContext: DrawingContext | undefined;
  scheme: TagScheme;
  flags: { symbols: boolean; letters: boolean };
  canvasRef: React.RefObject<SchematicCanvasHandle | null>;
  onCursor: (point: Point | null) => void;
  onViewport: (viewport: Viewport) => void;
}) {
  const { doc } = useEditorSnapshot(editor);
  const context = useMemo(
    () => (baseContext ? withLegends(baseContext, doc, registry, scheme, flags) : undefined),
    [baseContext, doc, registry, scheme, flags]
  );
  return <SchematicCanvas ref={canvasRef} editor={editor} showGrid={showGrid} context={context} onCursor={onCursor} onViewport={onViewport} />;
}

export function DraftingPage({ projectId, projectName, systems, diagrams, selectedSystemId, customSymbols, refreshSymbols, user, canWrite, notify }: Props) {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingId, setDrawingId] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showDrawingPanel, setShowDrawingPanel] = useState(true);
  const [creating, setCreating] = useState<null | { mode: "new" | "convert" }>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [tagScheme, setTagScheme] = useState<TagScheme>(DEFAULT_TAG_SCHEME);
  const [showLibrary, setShowLibrary] = useState(true);
  const canvasRef = useRef<SchematicCanvasHandle>(null);
  const registry = useMemo(() => SymbolRegistry.withBuiltins(customSymbols), [customSymbols]);
  const flags = useMemo(() => legendFlags(drawings.find((entry) => entry.id === drawingId) ?? null), [drawings, drawingId]);
  const drawing = drawings.find((entry) => entry.id === drawingId) ?? null;
  const sheetSummary = drawing?.sheets.find((entry) => entry.id === sheetId) ?? null;
  const systemName = systems.find((system) => system.id === drawing?.system_id)?.name;

  const refreshDrawings = useCallback(
    async (selectId?: string) => {
      if (!projectId) {
        setDrawings([]);
        return [];
      }
      const list = await api.listDrawings(projectId);
      setDrawings(list);
      if (selectId) setDrawingId(selectId);
      return list;
    },
    [projectId]
  );

  // Load the project's drawings; keep the last opened one per project.
  useEffect(() => {
    let cancelled = false;
    setDrawingId("");
    setSheetId("");
    setEditor(null);
    if (!projectId) {
      setDrawings([]);
      return;
    }
    refreshDrawings()
      .then((list) => {
        if (cancelled) return;
        const remembered = localStorage.getItem(`fsdp.drafting.drawing.${projectId}`);
        const pick = list.find((entry) => entry.id === remembered) ?? list[0];
        setDrawingId(pick?.id ?? "");
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : "Could not load drawings.", true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Project tag scheme (defaults when none is stored).
  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setTagScheme(DEFAULT_TAG_SCHEME);
      return;
    }
    api
      .getTagScheme(projectId)
      .then((read) => {
        if (!cancelled) setTagScheme(normalizeScheme(read.scheme));
      })
      .catch(() => {
        if (!cancelled) setTagScheme(DEFAULT_TAG_SCHEME);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    editor?.setTagScheme(tagScheme);
  }, [editor, tagScheme]);

  // Select the first sheet of the current drawing.
  useEffect(() => {
    if (!drawing) {
      setSheetId("");
      return;
    }
    localStorage.setItem(`fsdp.drafting.drawing.${projectId}`, drawing.id);
    if (!drawing.sheets.some((sheet) => sheet.id === sheetId)) setSheetId(drawing.sheets[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing?.id, drawing?.sheets.length]);

  // Load the sheet document into an editor session.
  useEffect(() => {
    let cancelled = false;
    if (!sheetId) {
      setEditor(null);
      return;
    }
    setLoading(true);
    api
      .getSheet(sheetId)
      .then((sheet) => {
        if (cancelled) return;
        const document = withFrameTemplate(sheet.document as unknown as SchematicDocument, drawing?.frame_template ?? "basic");
        const store = new DocumentStore(document);
        setEditor((previous) => {
          previous?.dispose();
          return new Editor(store, registry, { author: user.name, tagScheme });
        });
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : "Could not open the sheet.", true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, registry]);

  // Keep the document's frame template in step with the drawing setting.
  useEffect(() => {
    if (!editor || !drawing) return;
    const next = withFrameTemplate(editor.store.doc, drawing.frame_template);
    if (next !== editor.store.doc) editor.store.dispatch({ type: "sheet", sheet: next.sheet });
  }, [editor, drawing]);

  useEffect(() => () => editor?.dispose(), [editor]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (editor?.store.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [editor]);

  const context = useMemo(
    () => (drawing && sheetSummary ? buildDrawingContext(drawing, sheetSummary.sheet_no, sheetSummary.title, projectName, systemName) : undefined),
    [drawing, sheetSummary, projectName, systemName]
  );

  const save = useCallback(async () => {
    if (!editor || !sheetId || !drawing) return;
    try {
      await api.updateSheet(sheetId, { document: editor.store.doc });
      editor.store.markSaved();
      notify(`Saved ${drawing.number} sheet ${sheetSummary?.sheet_no ?? 1}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Save failed.", true);
    }
  }, [editor, sheetId, drawing, sheetSummary, notify]);

  async function exportSheet(format: "pdf" | "png" | "svg") {
    if (!editor || !sheetId || !context) return;
    setExporting(true);
    try {
      const svg = renderDocumentSvg(editor.store.doc, registry, {
        standalone: true,
        background: "#ffffff",
        context: withLegends(context, editor.store.doc, registry, tagScheme, flags)
      });
      const { blob, filename } = await api.exportSheet(sheetId, { svg, format, dpi: 300 });
      downloadBlob(filename, blob);
      notify(`Exported ${filename}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Export failed.", true);
    } finally {
      setExporting(false);
    }
  }

  function confirmDiscard(): boolean {
    return !editor?.store.dirty || window.confirm("Discard unsaved drafting changes?");
  }

  function switchDrawing(nextId: string) {
    if (!confirmDiscard()) return;
    setDrawingId(nextId);
  }

  function switchSheet(nextId: string) {
    if (nextId === sheetId || !confirmDiscard()) return;
    setSheetId(nextId);
  }

  async function createDrawing(form: NewDrawingForm) {
    try {
      let firstSheet: { document?: unknown; source_diagram_id?: string | null } | undefined;
      let title = form.title;
      let systemId: string | null = form.systemId || null;
      if (form.mode === "convert") {
        const source = diagrams.find((entry) => entry.id === form.diagramId);
        if (!source) throw new Error("Choose a diagram to convert.");
        const stored = await api.getSchematic(source.id);
        const converted = stored.document
          ? (stored.document as unknown as SchematicDocument)
          : convertLegacyGraph((await api.getDiagram(source.id)).graph ?? {}, registry, { title: source.name });
        // The chosen paper size wins over the converter's best-fit guess.
        const document: SchematicDocument = {
          ...converted,
          sheet: { ...makeSheet(form.size as SheetSizeId, converted.sheet.orientation), frame: { ...makeSheet(form.size as SheetSizeId).frame, template: "fsdp-standard" } }
        };
        firstSheet = { document, source_diagram_id: source.id };
        title = form.title || source.name;
        systemId = source.system_id;
      }
      const created = await api.createDrawing(projectId, {
        title,
        number: form.number || undefined,
        system_id: systemId,
        size: form.size,
        units: form.units,
        frame_template: "fsdp-standard",
        fields: { company: form.company, scale: "NO SCALE" },
        first_sheet: firstSheet
      });
      await refreshDrawings(created.id);
      setCreating(null);
      notify(`Created drawing ${created.number}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not create the drawing.", true);
    }
  }

  async function addSheet() {
    if (!drawing) return;
    try {
      const sheet = await api.createSheet(drawing.id, {});
      await refreshDrawings(drawing.id);
      setSheetId(sheet.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not add a sheet.", true);
    }
  }

  async function removeSheet() {
    if (!drawing || !sheetSummary || drawing.sheets.length <= 1) return;
    if (!window.confirm(`Delete sheet ${sheetSummary.sheet_no} of ${drawing.number}?`)) return;
    try {
      await api.deleteSheet(sheetSummary.id);
      setSheetId("");
      await refreshDrawings(drawing.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete the sheet.", true);
    }
  }

  async function removeDrawing() {
    if (!drawing || !window.confirm(`Delete drawing ${drawing.number} and all of its sheets?`)) return;
    try {
      await api.deleteDrawing(drawing.id);
      setEditor(null);
      const list = await refreshDrawings();
      setDrawingId(list[0]?.id ?? "");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete the drawing.", true);
    }
  }

  async function updateCustomSymbol(symbolId: string, patch: { category?: string; legend?: string; tag_prefix?: string }) {
    try {
      await api.updateSymbol(symbolId, patch);
      refreshSymbols?.();
      notify("Saved symbol metadata.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update the symbol.", true);
    }
  }

  async function updateDrawing(patch: Parameters<typeof api.updateDrawing>[1]) {
    if (!drawing) return;
    try {
      const updated = await api.updateDrawing(drawing.id, patch);
      setDrawings((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      notify(`Updated drawing ${updated.number}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update the drawing.", true);
    }
  }

  async function addRevision(body: Parameters<typeof api.createRevision>[1]) {
    if (!drawing) return;
    try {
      await api.createRevision(drawing.id, body);
      await refreshDrawings(drawing.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not add the revision.", true);
    }
  }

  async function updateRevision(revisionId: string, body: Parameters<typeof api.updateRevision>[1]) {
    if (!drawing) return;
    try {
      await api.updateRevision(revisionId, body);
      await refreshDrawings(drawing.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update the revision.", true);
    }
  }

  return (
    <PageLayout className="draftingPage" title="Drafting" description="Paper-space P&ID drawings">
      <div className="draftingLayout">
        <div className="draftingTop toolbar">
          <label>
            Drawing
            <select value={drawingId} onChange={(event) => switchDrawing(event.target.value)} disabled={!drawings.length}>
              {drawings.length === 0 && <option value="">No drawings in this project</option>}
              {drawings.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.number} · {entry.title.split("\n")[0]}
                </option>
              ))}
            </select>
          </label>
          <div className="toolGroup">
            <button type="button" disabled={!canWrite || !projectId} onClick={() => setCreating({ mode: "new" })}>
              New drawing
            </button>
            <button type="button" disabled={!canWrite || !diagrams.length} onClick={() => setCreating({ mode: "convert" })} title="Create a drawing from a diagram on the Diagrams page">
              Convert diagram…
            </button>
          </div>
          {drawing && (
            <div className="sheetTabs" role="tablist" aria-label="Sheets">
              {drawing.sheets.map((sheet) => (
                <button
                  key={sheet.id}
                  type="button"
                  role="tab"
                  aria-selected={sheet.id === sheetId}
                  className={sheet.id === sheetId ? "sheetTab active" : "sheetTab"}
                  onClick={() => switchSheet(sheet.id)}
                  title={sheet.title ?? `Sheet ${sheet.sheet_no}`}
                >
                  {sheet.sheet_no}
                </button>
              ))}
              <button type="button" className="sheetTab" disabled={!canWrite} onClick={() => void addSheet()} title="Add sheet">
                +
              </button>
            </div>
          )}
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
              onExport={(format) => void exportSheet(format)}
              exporting={exporting}
              showLibrary={showLibrary}
              onToggleLibrary={() => setShowLibrary((current) => !current)}
            />
          )}
        </div>
        {creating && (
          <NewDrawingForm
            mode={creating.mode}
            systems={systems}
            diagrams={diagrams}
            defaultSystemId={selectedSystemId}
            defaultCompany={stringField(drawing?.fields, "company") ?? ""}
            onSubmit={(form) => void createDrawing(form)}
            onCancel={() => setCreating(null)}
          />
        )}
        <div className={showLibrary && editor ? "draftingBody withLibrary" : "draftingBody"}>
          {editor && showLibrary && (
            <LibraryPanelHost editor={editor} registry={registry} canWrite={canWrite} onUpdateCustom={(id, patch) => void updateCustomSymbol(id, patch)} />
          )}
          {editor ? (
            <DrawingCanvas
              editor={editor}
              registry={registry}
              showGrid={showGrid}
              baseContext={context}
              scheme={tagScheme}
              flags={flags}
              canvasRef={canvasRef}
              onCursor={setCursor}
              onViewport={setViewport}
            />
          ) : (
            <div className="schematicCanvas schematicEmpty">
              <p className="hint">
                {loading
                  ? "Opening sheet…"
                  : !projectId
                    ? "Select a project on the Systems page first."
                    : drawings.length
                      ? "Select a drawing."
                      : "Create a new drawing, or convert a diagram from the Diagrams page."}
              </p>
            </div>
          )}
          <div className="draftingSide">
            {drawing && (
              <DrawingPanel
                drawing={drawing}
                systems={systems}
                sheetCount={drawing.sheets.length}
                canWrite={canWrite}
                open={showDrawingPanel}
                onToggle={() => setShowDrawingPanel((current) => !current)}
                onUpdate={(patch) => void updateDrawing(patch)}
                onAddRevision={(body) => void addRevision(body)}
                onUpdateRevision={(id, body) => void updateRevision(id, body)}
                onDeleteSheet={drawing.sheets.length > 1 ? () => void removeSheet() : undefined}
                onDeleteDrawing={() => void removeDrawing()}
              />
            )}
            {editor && <Inspector editor={editor} registry={registry} canWrite={canWrite} />}
          </div>
        </div>
        {editor && <StatusBar editor={editor} cursor={cursor} viewport={viewport} />}
      </div>
    </PageLayout>
  );
}

function LibraryPanelHost({
  editor,
  registry,
  canWrite,
  onUpdateCustom
}: {
  editor: Editor;
  registry: SymbolRegistry;
  canWrite: boolean;
  onUpdateCustom: (symbolId: string, patch: { category?: string; legend?: string; tag_prefix?: string }) => void;
}) {
  const { state } = useEditorSnapshot(editor);
  const placing = state.tool === "place" && state.place ? state.place.symbol : null;
  return <LibraryPanel registry={registry} placing={placing} canWrite={canWrite} onPlace={(ref) => editor.startPlacing(ref)} onUpdateCustom={onUpdateCustom} />;
}

type NewDrawingForm = {
  mode: "new" | "convert";
  title: string;
  number: string;
  size: string;
  units: string;
  systemId: string;
  diagramId: string;
  company: string;
};

function NewDrawingForm({
  mode,
  systems,
  diagrams,
  defaultSystemId,
  defaultCompany,
  onSubmit,
  onCancel
}: {
  mode: "new" | "convert";
  systems: FluidSystem[];
  diagrams: Diagram[];
  defaultSystemId: string;
  defaultCompany: string;
  onSubmit: (form: NewDrawingForm) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<NewDrawingForm>({
    mode,
    title: "",
    number: "",
    size: "A3",
    units: "mm",
    systemId: defaultSystemId,
    diagramId: diagrams[0]?.id ?? "",
    company: defaultCompany
  });
  const update = (patch: Partial<NewDrawingForm>) => setForm((current) => ({ ...current, ...patch }));
  const canSubmit = mode === "convert" ? Boolean(form.diagramId) : Boolean(form.title.trim());
  return (
    <form
      className="draftingNewForm"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}
    >
      <strong>{mode === "convert" ? "Convert a diagram into a drawing" : "New drawing"}</strong>
      {mode === "convert" && (
        <label>
          Diagram
          <select value={form.diagramId} onChange={(event) => update({ diagramId: event.target.value })}>
            {diagrams.map((diagram) => (
              <option key={diagram.id} value={diagram.id}>
                {diagram.name} rev {diagram.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Title{mode === "convert" ? " (defaults to the diagram name)" : ""}
        <input value={form.title} onChange={(event) => update({ title: event.target.value })} placeholder="P&ID — HELIUM FILL" />
      </label>
      <label>
        Number (blank = generate)
        <input value={form.number} onChange={(event) => update({ number: event.target.value })} placeholder="AMB2-9003" />
      </label>
      <label>
        Size
        <select value={form.size} onChange={(event) => update({ size: event.target.value })}>
          {(Object.keys(SHEET_SIZES) as SheetSizeId[]).map((size) => (
            <option key={size} value={size}>
              {SHEET_SIZES[size].label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Units
        <select value={form.units} onChange={(event) => update({ units: event.target.value })}>
          <option value="mm">mm</option>
          <option value="in">in</option>
        </select>
      </label>
      {mode === "new" && (
        <label>
          System
          <select value={form.systemId} onChange={(event) => update({ systemId: event.target.value })}>
            <option value="">None</option>
            {systems.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Company (title block)
        <input value={form.company} onChange={(event) => update({ company: event.target.value })} />
      </label>
      <div className="toolGroup">
        <button type="submit" className="primary" disabled={!canSubmit}>
          {mode === "convert" ? "Convert" : "Create"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DrawingPanel({
  drawing,
  systems,
  sheetCount,
  canWrite,
  open,
  onToggle,
  onUpdate,
  onAddRevision,
  onUpdateRevision,
  onDeleteSheet,
  onDeleteDrawing
}: {
  drawing: Drawing;
  systems: FluidSystem[];
  sheetCount: number;
  canWrite: boolean;
  open: boolean;
  onToggle: () => void;
  onUpdate: (patch: Parameters<typeof api.updateDrawing>[1]) => void;
  onAddRevision: (body: Parameters<typeof api.createRevision>[1]) => void;
  onUpdateRevision: (id: string, body: Parameters<typeof api.updateRevision>[1]) => void;
  onDeleteSheet?: () => void;
  onDeleteDrawing: () => void;
}) {
  const [form, setForm] = useState({
    number: drawing.number,
    title: drawing.title,
    size: drawing.size,
    units: drawing.units,
    status: drawing.status,
    frame_template: drawing.frame_template,
    system_id: drawing.system_id ?? "",
    company: stringField(drawing.fields, "company") ?? "",
    scale: stringField(drawing.fields, "scale") ?? "NO SCALE",
    notes: (drawing.notes ?? []).join("\n"),
    legendSymbols: legendFlags(drawing).symbols,
    legendLetters: legendFlags(drawing).letters
  });
  const [revision, setRevision] = useState({ label: "", description: "", checked_by: "", approved_by: "" });
  useEffect(() => {
    setForm({
      number: drawing.number,
      title: drawing.title,
      size: drawing.size,
      units: drawing.units,
      status: drawing.status,
      frame_template: drawing.frame_template,
      system_id: drawing.system_id ?? "",
      company: stringField(drawing.fields, "company") ?? "",
      scale: stringField(drawing.fields, "scale") ?? "NO SCALE",
      notes: (drawing.notes ?? []).join("\n"),
      legendSymbols: legendFlags(drawing).symbols,
      legendLetters: legendFlags(drawing).letters
    });
  }, [drawing]);
  const update = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const dirty =
    form.number !== drawing.number ||
    form.title !== drawing.title ||
    form.size !== drawing.size ||
    form.units !== drawing.units ||
    form.status !== drawing.status ||
    form.frame_template !== drawing.frame_template ||
    form.system_id !== (drawing.system_id ?? "") ||
    form.company !== (stringField(drawing.fields, "company") ?? "") ||
    form.scale !== (stringField(drawing.fields, "scale") ?? "NO SCALE") ||
    form.notes !== (drawing.notes ?? []).join("\n") ||
    form.legendSymbols !== legendFlags(drawing).symbols ||
    form.legendLetters !== legendFlags(drawing).letters;

  function apply() {
    onUpdate({
      number: form.number.trim() || drawing.number,
      title: form.title.trim() || drawing.title,
      size: form.size,
      units: form.units,
      status: form.status,
      frame_template: form.frame_template,
      system_id: form.system_id || null,
      fields: {
        ...drawing.fields,
        company: form.company,
        scale: form.scale,
        legends: [form.legendSymbols ? "symbols" : "", form.legendLetters ? "letters" : ""].filter(Boolean).join(",")
      },
      notes: form.notes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    });
  }

  return (
    <article className="panel drawingPanel">
      <div className="panelHead">
        <h2>Drawing {drawing.number}</h2>
        <button type="button" className="linkButton" onClick={onToggle}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <>
          <label>
            Number
            <input value={form.number} onChange={(event) => update({ number: event.target.value })} disabled={!canWrite} />
          </label>
          <label>
            Title (up to 3 lines)
            <textarea value={form.title} onChange={(event) => update({ title: event.target.value })} disabled={!canWrite} rows={3} />
          </label>
          <div className="fieldRow">
            <label>
              Size
              <select value={form.size} onChange={(event) => update({ size: event.target.value })} disabled={!canWrite}>
                {(Object.keys(SHEET_SIZES) as SheetSizeId[]).map((size) => (
                  <option key={size} value={size}>
                    {SHEET_SIZES[size].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Units
              <select value={form.units} onChange={(event) => update({ units: event.target.value })} disabled={!canWrite}>
                <option value="mm">mm</option>
                <option value="in">in</option>
              </select>
            </label>
          </div>
          <label>
            Frame
            <select value={form.frame_template} onChange={(event) => update({ frame_template: event.target.value })} disabled={!canWrite}>
              {(Object.keys(FRAME_TEMPLATE_LABELS) as FrameTemplateId[]).map((id) => (
                <option key={id} value={id}>
                  {FRAME_TEMPLATE_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
          <label>
            System
            <select value={form.system_id} onChange={(event) => update({ system_id: event.target.value })} disabled={!canWrite}>
              <option value="">None</option>
              {systems.map((system) => (
                <option key={system.id} value={system.id}>
                  {system.name}
                </option>
              ))}
            </select>
          </label>
          <div className="fieldRow">
            <label>
              Company
              <input value={form.company} onChange={(event) => update({ company: event.target.value })} disabled={!canWrite} />
            </label>
            <label>
              Scale
              <input value={form.scale} onChange={(event) => update({ scale: event.target.value })} disabled={!canWrite} />
            </label>
          </div>
          <label>
            Status
            <select value={form.status} onChange={(event) => update({ status: event.target.value })} disabled={!canWrite}>
              <option value="working">Working</option>
              <option value="for_review">For review</option>
              <option value="released">Released</option>
            </select>
          </label>
          <label>
            General notes (one per line)
            <textarea value={form.notes} onChange={(event) => update({ notes: event.target.value })} disabled={!canWrite} rows={4} />
          </label>
          <div className="fieldRow">
            <label className="checkRow">
              <input type="checkbox" checked={form.legendSymbols} onChange={(event) => update({ legendSymbols: event.target.checked })} disabled={!canWrite} />
              <span>Symbol legend</span>
            </label>
            <label className="checkRow">
              <input type="checkbox" checked={form.legendLetters} onChange={(event) => update({ legendLetters: event.target.checked })} disabled={!canWrite} />
              <span>Instrument letter table</span>
            </label>
          </div>
          <div className="toolGroup">
            <button type="button" className="primary" disabled={!canWrite || !dirty} onClick={apply}>
              Apply
            </button>
            {onDeleteSheet && (
              <button type="button" disabled={!canWrite} onClick={onDeleteSheet}>
                Delete sheet
              </button>
            )}
            <button type="button" className="danger" disabled={!canWrite} onClick={onDeleteDrawing}>
              Delete drawing
            </button>
          </div>
          <p>
            <strong>Revisions</strong> · {sheetCount} sheet(s)
          </p>
          <table className="revisionTable">
            <thead>
              <tr>
                <th>Rev</th>
                <th>Description</th>
                <th>By</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {drawing.revisions.map((row: DrawingRevision) => (
                <tr key={row.id}>
                  <td className="mono">{row.label}</td>
                  <td>{row.description}</td>
                  <td>{row.drawn_by ?? ""}</td>
                  <td>
                    <input
                      value={row.approved_by ?? ""}
                      placeholder="—"
                      disabled={!canWrite}
                      onChange={(event) => onUpdateRevision(row.id, { approved_by: event.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canWrite && (
            <form
              className="revisionForm"
              onSubmit={(event) => {
                event.preventDefault();
                if (!revision.label.trim() || !revision.description.trim()) return;
                onAddRevision({
                  label: revision.label.trim(),
                  description: revision.description.trim(),
                  checked_by: revision.checked_by || null,
                  approved_by: revision.approved_by || null,
                  drawn_date: todayIso()
                });
                setRevision({ label: "", description: "", checked_by: "", approved_by: "" });
              }}
            >
              <input value={revision.label} onChange={(event) => setRevision({ ...revision, label: event.target.value })} placeholder="Rev" aria-label="Revision label" />
              <input value={revision.description} onChange={(event) => setRevision({ ...revision, description: event.target.value })} placeholder="Description" aria-label="Revision description" />
              <button type="submit" disabled={!revision.label.trim() || !revision.description.trim()}>
                Add revision
              </button>
            </form>
          )}
        </>
      )}
    </article>
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
  onExport,
  exporting,
  showLibrary,
  onToggleLibrary
}: {
  editor: Editor;
  registry: SymbolRegistry;
  canWrite: boolean;
  showGrid: boolean;
  onToggleGrid: () => void;
  onFit: () => void;
  onZoom: (factor: number) => void;
  onSave: () => void;
  onExport: (format: "pdf" | "png" | "svg") => void;
  exporting: boolean;
  showLibrary: boolean;
  onToggleLibrary: () => void;
}) {
  const { state, doc } = useEditorSnapshot(editor);
  const store = editor.store;
  const scheme = editor.tagScheme;
  void registry;

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
      <div className="toolGroup">
        <button type="button" className={showLibrary ? "toolButton active" : "toolButton"} onClick={onToggleLibrary} title="Show or hide the symbol library (P)">
          Library
        </button>
        {scheme.kind === "structured" && (
          <>
            <select
              value={state.tagContext.system ?? scheme.systems[0]?.digit ?? ""}
              onChange={(event) => editor.setTagContext({ system: event.target.value })}
              title="System digit for new tags"
              aria-label="Tag system"
            >
              {scheme.systems.map((entry) => (
                <option key={entry.digit} value={entry.digit}>
                  {entry.digit} · {entry.name}
                </option>
              ))}
            </select>
            <select
              value={state.tagContext.cls ?? scheme.classes[0]?.digit ?? ""}
              onChange={(event) => editor.setTagContext({ cls: event.target.value })}
              title="Class digit for new tags"
              aria-label="Tag class"
            >
              {scheme.classes.map((entry) => (
                <option key={entry.digit} value={entry.digit}>
                  {entry.digit} · {entry.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="button" disabled={!canWrite || !state.selection.length} onClick={() => editor.renumberSelection()} title="Re-sequence the selected tags in reading order">
          Renumber
        </button>
      </div>
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
        <button type="button" disabled={exporting} onClick={() => onExport("pdf")} title="Vector PDF at paper size">
          PDF
        </button>
        <button type="button" disabled={exporting} onClick={() => onExport("png")} title="PNG at 300 dpi">
          PNG
        </button>
        <button type="button" disabled={exporting} onClick={() => onExport("svg")} title="SVG at paper size">
          SVG
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
            {item.tag && !validateTag(item.tag, editor.tagScheme).ok && (
              <p className="formError">{validateTag(item.tag, editor.tagScheme).reason}</p>
            )}
            {registry.resolve(item.symbol).actuatorMount && (
              <label>
                Actuator
                <select
                  value={item.actuator ? `${item.actuator.library}/${item.actuator.key}` : ""}
                  onChange={(event) => {
                    const [library, key] = event.target.value.split("/");
                    const definition = registry.listActuators().find((entry) => entry.library === library && entry.key === key);
                    update({ actuator: definition ? { library: definition.library, key: definition.key, version: definition.version } : undefined });
                  }}
                  disabled={!canWrite}
                >
                  <option value="">None</option>
                  {registry.listActuators().map((definition) => (
                    <option key={definition.key} value={`${definition.library}/${definition.key}`}>
                      {definition.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
              {registry.portsOf(item).map((port) => {
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
        <TagChecks editor={editor} />
        {state.tool === "wire" && (
          <p className="hint">Click a port or point to start, click to add corners, click a port or line to finish. Space flips the bend, Enter ends, Esc cancels.</p>
        )}
        {state.tool === "place" && <p className="hint">Click to place. R rotates, X mirrors, Esc stops placing.</p>}
      </article>
    </aside>
  );
}

function TagChecks({ editor }: { editor: Editor }) {
  const { doc } = useEditorSnapshot(editor);
  const issues = useMemo(() => tagIssues(doc, editor.tagScheme), [doc, editor.tagScheme]);
  if (!issues.length) {
    return (
      <p>
        <span className="pill pill-good">tags follow the {editor.tagScheme.kind} scheme</span>
      </p>
    );
  }
  return (
    <div className="tagIssues">
      <p>
        <span className="pill pill-warn">{issues.length} tag issue(s)</span>
      </p>
      <ul>
        {issues.slice(0, 8).map((issue) => (
          <li key={`${issue.itemId}-${issue.issue}`}>
            <button type="button" className="linkButton" onClick={() => editor.select([issue.itemId])}>
              {issue.tag}
            </button>{" "}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
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

/**
 * Drafting: the paper-space P&ID editor built on the schematic engine.
 *
 * Works on controlled drawings (number, title, size, revisions) made of
 * sheets; each sheet holds a schematic document. Legacy diagrams can be
 * converted into a new drawing. Export renders the sheet with the shared
 * renderer and lets the server turn the SVG into PDF or PNG.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { AssignPartModal } from "../components/schematic/AssignPartModal";
import { DrcPanel, useDrc, type DrcInputs } from "../components/schematic/DrcPanel";
import { PanelResizer, useStoredWidth } from "../components/resizable";
import { LibraryPanel } from "../components/schematic/LibraryPanel";
import { ListsDrawer, type DrawerTab, type ListScope, type LocateTarget } from "../components/schematic/ListsDrawer";
import { SchematicCanvas, useEditorSnapshot, type SchematicCanvasHandle, type Viewport } from "../components/schematic/SchematicCanvas";
import { convertLegacyGraph } from "../engine/convert";
import { Editor, type AlignMode, type ToolId } from "../engine/editor";
import { FRAME_TEMPLATE_LABELS, type DrawingContext, type FrameTemplateId } from "../engine/frames";
import { polylineLength } from "../engine/geometry";
import { runDrc, type DrcResult, type DrcWaiver, type RequirementRef } from "../engine/drc";
import { renderFindingsSheet } from "../engine/drcSheet";
import { buildSheetIndex, lineLengthM } from "../engine/index";
import type { ListKind } from "../engine/lists";
import { partBadge, partWarnings } from "../engine/parts";
import { SymbolRegistry } from "../engine/library";
import { LINE_TYPE_LABELS, renderDocumentSvg, type PartBadge } from "../engine/render";
import { SHEET_SIZES, makeSheet, zoneAt } from "../engine/sheet";
import { DocumentStore } from "../engine/store";
import { DEFAULT_TAG_SCHEME, normalizeScheme, tagIssues, validateTag, type TagScheme } from "../engine/tags";
import { resolveConnectorTargets, type SheetDoc } from "../engine/connectors";
import { lineEndpoints, lineLegendEntries } from "../engine/lines";
import type { EquipmentItem, Item, LineAnnotation, LineItem, LineType, Nozzle, Point, Rotation, SchematicDocument, SheetSizeId, Side, SymbolDef, SymbolItem } from "../engine/types";
import type { BomReadiness, BomSnapshot, Diagram, Drawing, DrawingRevision, FluidSystem, LineClass, Part, PidSymbolDef, Requirement, User } from "../types";
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
  /** Catalog parts for assignment, badges, and list part numbers. */
  parts?: Part[];
  /** Project requirements; those with a constraint are checked by the DRC. */
  requirements?: Requirement[];
  user: User;
  canWrite: boolean;
  notify: (message: string, error?: boolean) => void;
};

const TOOLS: Array<{ id: ToolId; label: string; key: string }> = [
  { id: "select", label: "Select", key: "V" },
  { id: "wire", label: "Wire", key: "W" },
  { id: "label", label: "Text", key: "T" },
  { id: "equipment", label: "Equipment", key: "E" },
  { id: "note", label: "Note", key: "N" },
  { id: "measure", label: "Measure", key: "M" }
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
/** Point to centre the view on when locating an item. */
function itemAnchor(item: Item): Point {
  if (item.kind === "line") {
    const middle = Math.floor(item.points.length / 2);
    const a = item.points[Math.max(0, middle - 1)];
    const b = item.points[middle] ?? a;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (item.kind === "equipment") return { x: item.position.x + item.size.width / 2, y: item.position.y + item.size.height / 2 };
  return item.position;
}

/** Items the BoM counts that have no catalog part yet. */
const BOM_CATEGORIES = new Set(["valve", "regulator", "inline", "instrument", "equipment", "custom"]);
function unassignedItems(doc: SchematicDocument, registry: SymbolRegistry): Array<SymbolItem | EquipmentItem> {
  const result: Array<SymbolItem | EquipmentItem> = [];
  for (const item of doc.items) {
    if (item.kind === "symbol" && !item.partId && !item.dnp && registry.has(item.symbol) && BOM_CATEGORIES.has(registry.resolve(item.symbol).category)) result.push(item);
    if (item.kind === "equipment" && item.tag && !item.partId && !item.dnp) result.push(item);
  }
  return result;
}

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

export type LegendFlags = { symbols: boolean; letters: boolean; lines: boolean };

export function legendFlags(drawing: Drawing | null): LegendFlags {
  const raw = stringField(drawing?.fields, "legends") ?? "";
  return { symbols: raw.includes("symbols"), letters: raw.includes("letters"), lines: raw.includes("lines") };
}

/** Add the generated legend blocks the drawing asks for. */
export function withLegends(
  base: DrawingContext,
  document: SchematicDocument,
  registry: SymbolRegistry,
  scheme: TagScheme,
  flags: LegendFlags,
  connectorTargets?: Record<string, string>
): DrawingContext {
  const withTargets = connectorTargets ? { ...base, connectorTargets } : base;
  if (!flags.symbols && !flags.letters && !flags.lines) return withTargets;
  return {
    ...withTargets,
    legends: {
      symbols: flags.symbols ? usedSymbols(document, registry) : undefined,
      letters: flags.letters ? { first: scheme.firstLetters, succeeding: scheme.succeedingLetters } : undefined,
      lines: flags.lines ? lineLegendEntries(document) : undefined
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
  sheetNo,
  otherSheets,
  parts,
  canvasRef,
  onCursor,
  onViewport
}: {
  editor: Editor;
  registry: SymbolRegistry;
  showGrid: boolean;
  baseContext: DrawingContext | undefined;
  scheme: TagScheme;
  flags: LegendFlags;
  sheetNo: number;
  otherSheets: SheetDoc[];
  parts: Part[];
  canvasRef: React.RefObject<SchematicCanvasHandle | null>;
  onCursor: (point: Point | null) => void;
  onViewport: (viewport: Viewport) => void;
}) {
  const { doc } = useEditorSnapshot(editor);
  const connectorTargets = useMemo(() => resolveConnectorTargets({ sheetNo, doc }, otherSheets).targets, [doc, sheetNo, otherSheets]);
  const partBadges = useMemo(() => {
    const byId = new Map(parts.map((part) => [part.id, part]));
    const badges: Record<string, PartBadge> = {};
    for (const item of doc.items) {
      if ((item.kind === "symbol" || item.kind === "equipment") && item.partId) {
        const part = byId.get(item.partId);
        badges[item.id] = part ? partBadge(part) : { text: "missing part", tone: "bad" };
      }
    }
    return badges;
  }, [doc, parts]);
  const context = useMemo(
    () => (baseContext ? withLegends(baseContext, doc, registry, scheme, flags, connectorTargets) : undefined),
    [baseContext, doc, registry, scheme, flags, connectorTargets]
  );
  return <SchematicCanvas ref={canvasRef} editor={editor} showGrid={showGrid} context={context} connectorTargets={connectorTargets} partBadges={partBadges} onCursor={onCursor} onViewport={onViewport} />;
}

export function DraftingPage({ projectId, projectName, systems, diagrams, selectedSystemId, customSymbols, refreshSymbols, parts = [], requirements = [], user, canWrite, notify }: Props) {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingId, setDrawingId] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showDrawingPanel, setShowDrawingPanel] = useState(false);
  const [creating, setCreating] = useState<null | { mode: "new" | "convert" }>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [tagScheme, setTagScheme] = useState<TagScheme>(DEFAULT_TAG_SCHEME);
  const [lineClasses, setLineClasses] = useState<LineClass[]>([]);
  const [otherSheets, setOtherSheets] = useState<SheetDoc[]>([]);
  const [showLibrary, setShowLibrary] = useState(true);
  const [showLists, setShowLists] = useState(false);
  const [listTab, setListTab] = useState<DrawerTab>("instrument");
  const [bom, setBom] = useState<BomSnapshot | null>(null);
  const [bomReadiness, setBomReadiness] = useState<BomReadiness | null>(null);
  const [listsBusy, setListsBusy] = useState(false);
  const [waivers, setWaivers] = useState<DrcWaiver[]>([]);
  const [exportFindings, setExportFindings] = useState(false);
  const [libraryWidth, setLibraryWidth] = useStoredWidth("fsdp.draftingLibraryWidth", 248, 200, 420);
  const [sideWidth, setSideWidth] = useStoredWidth("fsdp.draftingSideWidth", 340, 280, 560);
  const pendingLocate = useRef<LocateTarget | null>(null);
  const canvasRef = useRef<SchematicCanvasHandle>(null);
  const registry = useMemo(() => SymbolRegistry.withBuiltins(customSymbols), [customSymbols]);
  const partMap = useMemo(() => new Map(parts.map((part) => [part.id, part])), [parts]);
  const requirementRefs = useMemo<RequirementRef[]>(
    () => requirements.map((requirement) => ({ id: requirement.id, key: requirement.key, title: requirement.title, constraint: requirement.constraint ?? null })),
    [requirements]
  );
  const drcInputs = useMemo<DrcInputs>(
    () => ({ registry, tagScheme, parts: partMap, requirements: requirementRefs, waivers }),
    [registry, tagScheme, partMap, requirementRefs, waivers]
  );
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

  // Open a drawing, sheet, and item named in the query string (locate from the FMEA grid).
  const location = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const targetDrawing = params.get("drawing");
    const targetSheet = params.get("sheet");
    const targetItem = params.get("item");
    if (!targetDrawing || !drawings.some((entry) => entry.id === targetDrawing)) return;
    if (targetSheet && targetItem) {
      pendingLocate.current = { drawingId: targetDrawing, sheetId: targetSheet, itemId: targetItem };
    }
    setDrawingId(targetDrawing);
    if (targetSheet) setSheetId(targetSheet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, drawings]);

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

  // Project line classes for the line inspector.
  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setLineClasses([]);
      return;
    }
    api
      .listLineClasses(projectId)
      .then((list) => {
        if (!cancelled) setLineClasses(list);
      })
      .catch(() => {
        if (!cancelled) setLineClasses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Stored DRC waivers of the open sheet.
  useEffect(() => {
    let cancelled = false;
    setWaivers([]);
    if (!sheetId) return;
    api
      .getSheetDrc(sheetId)
      .then((drc) => {
        if (!cancelled) setWaivers(drc.waivers.map((waiver) => ({ key: waiver.key, reason: waiver.reason, by: waiver.waived_by, at: waiver.created_at })));
      })
      .catch(() => {
        if (!cancelled) setWaivers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetId]);

  // Other sheets of the drawing, for off-page connector references.
  useEffect(() => {
    let cancelled = false;
    const others = drawing?.sheets.filter((entry) => entry.id !== sheetId) ?? [];
    if (!others.length) {
      setOtherSheets([]);
      return;
    }
    Promise.all(others.map((entry) => api.getSheet(entry.id).then((sheet) => ({ sheetNo: sheet.sheet_no, sheetId: sheet.id, doc: sheet.document as unknown as SchematicDocument }))))
      .then((docs) => {
        if (!cancelled) setOtherSheets(docs);
      })
      .catch(() => {
        if (!cancelled) setOtherSheets([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing?.id, drawing?.sheets.map((entry) => entry.id).join(","), sheetId]);

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

  const save = useCallback(async (): Promise<boolean> => {
    if (!editor || !sheetId || !drawing) return false;
    try {
      const sheetNo = sheetSummary?.sheet_no ?? 1;
      const connectorTargets = resolveConnectorTargets({ sheetNo, doc: editor.store.doc }, otherSheets).targets;
      // The index rows travel with the document so lists, BoM, and where-used read the saved state.
      const index = buildSheetIndex(editor.store.doc, registry, { connectivity: editor.connectivity, connectorTargets });
      // The DRC runs on save: open and waived findings plus requirement checks are stored with the sheet.
      const drc = runDrc({ doc: editor.store.doc, registry, connectivity: editor.connectivity, tagScheme, parts: partMap, requirements: requirementRefs, waivers });
      await api.updateSheet(sheetId, {
        document: editor.store.doc,
        index,
        drc: { findings: [...drc.findings, ...drc.waived].map(({ key, rule, severity, message, itemId, subject, zone, requirementId }) => ({ key, rule, severity, message, itemId, subject, zone, requirementId })), checks: drc.requirementChecks }
      });
      editor.store.markSaved();
      const drcSummary = drc.counts.error || drc.counts.warning ? `; DRC: ${drc.counts.error} error(s), ${drc.counts.warning} warning(s)` : "; DRC clean";
      notify(`Saved ${drawing.number} sheet ${sheetNo} (${index.items.length} items, ${index.lines.length} lines indexed${drcSummary}).`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Save failed.", true);
      return false;
    }
  }, [editor, sheetId, drawing, sheetSummary, otherSheets, registry, tagScheme, partMap, requirementRefs, waivers, notify]);

  async function waiveFinding(key: string, reason: string) {
    if (!sheetId) return;
    try {
      await api.waiveFinding(sheetId, key, reason);
      const drc = await api.getSheetDrc(sheetId);
      setWaivers(drc.waivers.map((waiver) => ({ key: waiver.key, reason: waiver.reason, by: waiver.waived_by, at: waiver.created_at })));
      notify("Finding waived.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not waive the finding.", true);
    }
  }

  async function unwaiveFinding(key: string) {
    if (!sheetId) return;
    try {
      await api.unwaiveFinding(sheetId, key);
      setWaivers((current) => current.filter((waiver) => waiver.key !== key));
      notify("Waiver removed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not remove the waiver.", true);
    }
  }

  function reportDrc(result: DrcResult) {
    const summary = `DRC: ${result.counts.error} error(s), ${result.counts.warning} warning(s), ${result.counts.info} info, ${result.counts.waived} waived.`;
    notify(summary, result.counts.error > 0);
  }

  /** Exports and the BoM read the saved index, so save a dirty sheet first. */
  async function ensureSaved(): Promise<boolean> {
    if (!editor?.store.dirty) return true;
    if (!canWrite) {
      notify("Unsaved changes are not in the stored index; a writer must save the sheet first.", true);
      return false;
    }
    return save();
  }

  async function exportList(scope: ListScope, kind: ListKind, format: "csv" | "xlsx") {
    if (!(await ensureSaved())) return;
    const id = scope === "drawing" ? drawing?.id : projectId;
    if (!id) return;
    setListsBusy(true);
    try {
      const { blob, filename } = await api.downloadList(scope, id, kind, format);
      downloadBlob(filename, blob);
      notify(`Exported ${filename}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "List export failed.", true);
    } finally {
      setListsBusy(false);
    }
  }

  async function generateBom() {
    if (!drawing || !(await ensureSaved())) return;
    setListsBusy(true);
    try {
      const snapshot = await api.generateDrawingBom(drawing.id);
      setBom(snapshot);
      setBomReadiness(await api.getBomReadiness(snapshot.id));
      notify(`Generated BoM rev ${snapshot.revision} for ${drawing.number} (${snapshot.rows.length} rows).`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "BoM generation failed.", true);
    } finally {
      setListsBusy(false);
    }
  }

  // Forget the shown BoM when the drawing changes.
  useEffect(() => {
    setBom(null);
    setBomReadiness(null);
  }, [drawing?.id]);

  const focusItem = useCallback(
    (itemId: string) => {
      if (!editor) return;
      const item = editor.itemById(itemId);
      if (!item) {
        notify("That item is no longer on the sheet.", true);
        return;
      }
      editor.setTool("select");
      editor.select([itemId]);
      canvasRef.current?.focusPoint(itemAnchor(item));
    },
    [editor, notify]
  );

  function locate(target: LocateTarget) {
    const targetDrawing = target.drawingId ?? drawing?.id ?? null;
    const targetSheet = target.sheetId ?? sheetId;
    if (targetDrawing === (drawing?.id ?? null) && targetSheet === sheetId) {
      focusItem(target.itemId);
      return;
    }
    if (!confirmDiscard()) return;
    pendingLocate.current = { drawingId: targetDrawing, sheetId: targetSheet, itemId: target.itemId };
    if (targetDrawing && targetDrawing !== drawing?.id) setDrawingId(targetDrawing);
    setSheetId(targetSheet);
  }

  // Complete a cross-sheet locate once the target sheet's editor is open.
  useEffect(() => {
    const pending = pendingLocate.current;
    if (!editor || !pending || pending.sheetId !== sheetId) return;
    pendingLocate.current = null;
    // The canvas fits the sheet after mount; focus on the next frame so the fit does not undo it.
    const handle = window.setTimeout(() => focusItem(pending.itemId), 50);
    return () => window.clearTimeout(handle);
  }, [editor, sheetId, focusItem]);

  async function exportSheet(format: "pdf" | "png" | "svg") {
    if (!editor || !sheetId || !context) return;
    setExporting(true);
    try {
      const connectorTargets = resolveConnectorTargets({ sheetNo: sheetSummary?.sheet_no ?? 1, doc: editor.store.doc }, otherSheets).targets;
      const fullContext = withLegends(context, editor.store.doc, registry, tagScheme, flags, connectorTargets);
      const svg = renderDocumentSvg(editor.store.doc, registry, {
        standalone: true,
        background: "#ffffff",
        context: fullContext
      });
      const pages: string[] = [];
      if (format === "pdf" && exportFindings) {
        const drc = runDrc({ doc: editor.store.doc, registry, connectivity: editor.connectivity, tagScheme, parts: partMap, requirements: requirementRefs, waivers });
        pages.push(renderFindingsSheet(editor.store.doc, registry, fullContext, drc.findings, drc.waived));
      }
      const { blob, filename } = await api.exportSheet(sheetId, { svg, format, dpi: 300, pages });
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
    <PageLayout className="draftingPage" title="Drafting" description="Paper-space P&ID drawings" showHeader={false}>
      <header className="draftingHeader">
        <h1>Drafting</h1>
        <label className="draftingDrawingSelect">
          <span className="srOnly">Drawing</span>
          <select value={drawingId} onChange={(event) => switchDrawing(event.target.value)} disabled={!drawings.length} aria-label="Drawing">
            {drawings.length === 0 && <option value="">No drawings in this project</option>}
            {drawings.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.number} · {entry.title.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
        {drawing && (
          <div className="sheetTabs" role="tablist" aria-label="Sheets">
            <span className="sheetTabsLabel">Sheet</span>
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
            <button type="button" className="sheetTab sheetTabAdd" disabled={!canWrite} onClick={() => void addSheet()} title="Add sheet">
              +
            </button>
          </div>
        )}
        <div className="draftingHeaderActions">
          <button type="button" disabled={!canWrite || !projectId} onClick={() => setCreating({ mode: "new" })}>
            New drawing
          </button>
          <button type="button" disabled={!canWrite || !diagrams.length} onClick={() => setCreating({ mode: "convert" })} title="Create a drawing from a diagram on the Diagrams page">
            Convert diagram…
          </button>
          {editor && (
            <>
              <span className="draftingHeaderDivider" />
              <div className="exportGroup" role="group" aria-label="Export">
                <button type="button" disabled={exporting} onClick={() => void exportSheet("pdf")} title="Vector PDF at paper size">
                  PDF
                </button>
                <button type="button" disabled={exporting} onClick={() => void exportSheet("png")} title="PNG at 300 dpi">
                  PNG
                </button>
                <button type="button" disabled={exporting} onClick={() => void exportSheet("svg")} title="SVG at paper size">
                  SVG
                </button>
                <label className="checkRow" title="Append a design rule check findings page to the PDF">
                  <input type="checkbox" checked={exportFindings} onChange={() => setExportFindings((current) => !current)} />
                  <span>DRC page</span>
                </label>
              </div>
              <SaveButton editor={editor} canWrite={canWrite} onSave={() => void save()} />
            </>
          )}
        </div>
      </header>
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
      <section className="draftingWorkspace">
        {editor && (
          <EditorToolbar
            editor={editor}
            registry={registry}
            canWrite={canWrite}
            showGrid={showGrid}
            onToggleGrid={() => setShowGrid((current) => !current)}
            onFit={() => canvasRef.current?.fitToSheet()}
            onZoom={(factor) => canvasRef.current?.zoomBy(factor)}
            showLibrary={showLibrary}
            onToggleLibrary={() => setShowLibrary((current) => !current)}
            showLists={showLists}
            onToggleLists={() => setShowLists((current) => !current)}
          />
        )}
        <div className="draftingColumns">
          {editor && showLibrary && (
            <>
              <aside className="draftingLibrary" style={{ width: libraryWidth }}>
                <LibraryPanelHost editor={editor} registry={registry} canWrite={canWrite} onUpdateCustom={(id, patch) => void updateCustomSymbol(id, patch)} />
              </aside>
              <PanelResizer width={libraryWidth} onResize={setLibraryWidth} direction={1} label="Resize symbol library" />
            </>
          )}
          <div className="draftingCenter">
            {editor ? (
              <DrawingCanvas
                editor={editor}
                registry={registry}
                showGrid={showGrid}
                baseContext={context}
                scheme={tagScheme}
                flags={flags}
                sheetNo={sheetSummary?.sheet_no ?? 1}
                otherSheets={otherSheets}
                parts={parts}
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
            {editor && showLists && (
              <ListsDrawer
                editor={editor}
                sheetId={sheetId}
                sheetNo={sheetSummary?.sheet_no ?? 1}
                otherSheets={otherSheets}
                parts={parts}
                projectId={projectId}
                drawing={drawing}
                canWrite={canWrite}
                tab={listTab}
                onTab={setListTab}
                onLocate={locate}
                onExport={(scope, kind, format) => void exportList(scope, kind, format)}
                onGenerateBom={() => void generateBom()}
                bom={bom}
                readiness={bomReadiness}
                busy={listsBusy}
                onClose={() => setShowLists(false)}
              />
            )}
          </div>
          {(drawing || editor) && (
            <>
              <PanelResizer width={sideWidth} onResize={setSideWidth} direction={-1} label="Resize inspector" />
              <div className="draftingSide" style={{ width: sideWidth }}>
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
                {editor && (
                  <Inspector
                    editor={editor}
                    registry={registry}
                    canWrite={canWrite}
                    lineClasses={lineClasses}
                    otherSheets={otherSheets}
                    sheetNo={sheetSummary?.sheet_no ?? 1}
                    parts={parts}
                    drcInputs={drcInputs}
                    onLocate={focusItem}
                    onWaive={(key, reason) => void waiveFinding(key, reason)}
                    onUnwaive={(key) => void unwaiveFinding(key)}
                    onRunDrc={reportDrc}
                  />
                )}
              </div>
            </>
          )}
        </div>
        {editor && <StatusBar editor={editor} cursor={cursor} viewport={viewport} drcInputs={drcInputs} />}
      </section>
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
    legendLetters: legendFlags(drawing).letters,
    legendLines: legendFlags(drawing).lines
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
      legendLetters: legendFlags(drawing).letters,
      legendLines: legendFlags(drawing).lines
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
    form.legendLetters !== legendFlags(drawing).letters ||
    form.legendLines !== legendFlags(drawing).lines;

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
        legends: [form.legendSymbols ? "symbols" : "", form.legendLetters ? "letters" : "", form.legendLines ? "lines" : ""].filter(Boolean).join(",")
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
          {open ? "Hide" : "Edit"}
        </button>
      </div>
      {!open && (
        <p className="drawingSummary">
          <span>{drawing.title.split("\n")[0]}</span>
          <span className="mono">{SHEET_SIZES[drawing.size as SheetSizeId]?.label ?? drawing.size}</span>
          <span>{sheetCount} sheet(s)</span>
          <span>rev {drawing.revisions[drawing.revisions.length - 1]?.label ?? "-"}</span>
          <span className="pill pill-muted">{drawing.status}</span>
        </p>
      )}
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
            <label className="checkRow">
              <input type="checkbox" checked={form.legendLines} onChange={(event) => update({ legendLines: event.target.checked })} disabled={!canWrite} />
              <span>Line legend</span>
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

/** Save button that reflects the store's dirty state. */
function SaveButton({ editor, canWrite, onSave }: { editor: Editor; canWrite: boolean; onSave: () => void }) {
  useEditorSnapshot(editor);
  const dirty = editor.store.dirty;
  return (
    <button type="button" className="primary" disabled={!canWrite || !dirty} onClick={onSave} title="Save the sheet (Ctrl+S)">
      {dirty ? "Save" : "Saved"}
    </button>
  );
}

function RibbonButton({ active, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button type="button" className={active ? "ribbonButton active" : "ribbonButton"} aria-pressed={active} {...props}>
      {children}
    </button>
  );
}

/** One-row ribbon: tools, edit, view, panels, and tagging/find, in that order. */
function EditorToolbar({
  editor,
  registry,
  canWrite,
  showGrid,
  onToggleGrid,
  onFit,
  onZoom,
  showLibrary,
  onToggleLibrary,
  showLists,
  onToggleLists
}: {
  editor: Editor;
  registry: SymbolRegistry;
  canWrite: boolean;
  showGrid: boolean;
  onToggleGrid: () => void;
  onFit: () => void;
  onZoom: (factor: number) => void;
  showLibrary: boolean;
  onToggleLibrary: () => void;
  showLists: boolean;
  onToggleLists: () => void;
}) {
  const { state } = useEditorSnapshot(editor);
  const store = editor.store;
  void registry;
  void canWrite;
  const hasSelection = state.selection.length > 0;

  return (
    <div className="draftingRibbon" role="toolbar" aria-label="Editor tools">
      <div className="ribbonGroup" role="group" aria-label="Tools">
        {TOOLS.map((tool) => (
          <RibbonButton key={tool.id} active={state.tool === tool.id} onClick={() => editor.setTool(tool.id)} title={`${tool.label} (${tool.key})`}>
            {tool.label}
          </RibbonButton>
        ))}
        <select className="ribbonSelect" value={state.lineType} onChange={(event) => editor.setLineType(event.target.value as LineType)} aria-label="Line type" title="Line type for new wires">
          {(Object.keys(LINE_TYPE_LABELS) as LineType[]).map((type) => (
            <option key={type} value={type}>
              {LINE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      <span className="ribbonDivider" />
      <div className="ribbonGroup" role="group" aria-label="Edit">
        <RibbonButton disabled={!store.canUndo} onClick={() => store.undo()} title="Undo (Ctrl+Z)">
          Undo
        </RibbonButton>
        <RibbonButton disabled={!store.canRedo} onClick={() => store.redo()} title="Redo (Ctrl+Shift+Z)">
          Redo
        </RibbonButton>
        <RibbonButton disabled={!hasSelection && state.tool !== "place"} onClick={() => editor.rotateSelection()} title="Rotate (R)">
          Rotate
        </RibbonButton>
        <RibbonButton disabled={!hasSelection && state.tool !== "place"} onClick={() => editor.mirrorSelection()} title="Mirror (X)">
          Mirror
        </RibbonButton>
        <RibbonButton disabled={!hasSelection} onClick={() => editor.deleteSelection()} title="Delete (Del)">
          Delete
        </RibbonButton>
      </div>
      <span className="ribbonDivider" />
      <div className="ribbonGroup" role="group" aria-label="View">
        <RibbonButton onClick={onFit} title="Fit sheet">
          Fit
        </RibbonButton>
        <RibbonButton onClick={() => onZoom(1.25)} title="Zoom in">
          +
        </RibbonButton>
        <RibbonButton onClick={() => onZoom(0.8)} title="Zoom out">
          −
        </RibbonButton>
        <RibbonButton active={showGrid} onClick={onToggleGrid} title="Show or hide the grid">
          Grid
        </RibbonButton>
        <select className="ribbonSelect ribbonSelectNarrow" value={String(state.grid)} onChange={(event) => editor.setGrid(Number(event.target.value))} aria-label="Snap grid" title="Snap grid">
          <option value="1.25">1.25 mm</option>
          <option value="2.5">2.5 mm</option>
          <option value="5">5 mm</option>
        </select>
      </div>
      <span className="ribbonDivider" />
      <div className="ribbonGroup" role="group" aria-label="Panels">
        <RibbonButton active={showLibrary} onClick={onToggleLibrary} title="Show or hide the symbol library (P)">
          Library
        </RibbonButton>
        <RibbonButton active={showLists} onClick={onToggleLists} title="Instrument index, line list, valve list, equipment list, tie-ins, and BoM">
          Lists
        </RibbonButton>
      </div>
      <div className="ribbonGroup ribbonEnd" role="group" aria-label="Search">
        <input
          type="search"
          className="findInput"
          placeholder="Find tag…"
          aria-label="Find"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const count = editor.findTag((event.target as HTMLInputElement).value).length;
              (event.target as HTMLInputElement).setAttribute("data-matches", String(count));
            }
          }}
        />
      </div>
    </div>
  );
}

function Inspector({
  editor,
  registry,
  canWrite,
  lineClasses,
  otherSheets,
  sheetNo,
  parts,
  drcInputs,
  onLocate,
  onWaive,
  onUnwaive,
  onRunDrc
}: {
  editor: Editor;
  registry: SymbolRegistry;
  canWrite: boolean;
  lineClasses: LineClass[];
  otherSheets: SheetDoc[];
  sheetNo: number;
  parts: Part[];
  drcInputs: DrcInputs;
  onLocate: (itemId: string) => void;
  onWaive: (key: string, reason: string) => void;
  onUnwaive: (key: string) => void;
  onRunDrc: (result: DrcResult) => void;
}) {
  const { state, connectivity, doc } = useEditorSnapshot(editor);
  const connectorResolution = useMemo(() => resolveConnectorTargets({ sheetNo, doc }, otherSheets), [doc, sheetNo, otherSheets]);
  const unassigned = useMemo(() => unassignedItems(doc, registry), [doc, registry]);
  const [annotationDraft, setAnnotationDraft] = useState<{ kind: LineAnnotation["kind"]; at: number; text: string; side: 1 | -1 }>({ kind: "note", at: 0.5, text: "", side: -1 });
  const [nozzleDraft, setNozzleDraft] = useState<{ side: Side; offset: number; size: string }>({ side: "left", offset: 50, size: "" });
  const items = editor.selectedItems();
  const item: Item | undefined = items.length === 1 ? items[0] : undefined;
  const update = (patch: Record<string, unknown>) => {
    if (item && canWrite) editor.updateItem(item.id, patch);
  };

  return (
    <aside className="inspector draftingInspector">
      <article className="panel">
        <div className="panelHead">
          <h2>{item ? item.kind[0].toUpperCase() + item.kind.slice(1) : items.length ? `${items.length} items` : "Sheet"}</h2>
        </div>
        {!item && items.length === 0 && (
          <>
            <div className="fieldRow">
              <label>
                Paper size
                <select
                  value={doc.sheet.size}
                  onChange={(event) => editor.store.dispatch({ type: "sheet", sheet: makeSheet(event.target.value as SheetSizeId, doc.sheet.orientation) })}
                  disabled={!canWrite}
                >
                  {(Object.keys(SHEET_SIZES) as SheetSizeId[]).map((size) => (
                    <option key={size} value={size}>
                      {SHEET_SIZES[size].label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Orientation
                <select value={doc.sheet.orientation} onChange={(event) => editor.store.dispatch({ type: "sheet", sheet: makeSheet(doc.sheet.size, event.target.value as "landscape" | "portrait") })} disabled={!canWrite}>
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </label>
            </div>
            {editor.tagScheme.kind === "structured" && (
              <div className="fieldRow">
                <label>
                  New tags: system
                  <select value={state.tagContext.system ?? editor.tagScheme.systems[0]?.digit ?? ""} onChange={(event) => editor.setTagContext({ system: event.target.value })} aria-label="Tag system" title="System digit for new tags">
                    {editor.tagScheme.systems.map((entry) => (
                      <option key={entry.digit} value={entry.digit}>
                        {entry.digit} · {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  New tags: class
                  <select value={state.tagContext.cls ?? editor.tagScheme.classes[0]?.digit ?? ""} onChange={(event) => editor.setTagContext({ cls: event.target.value })} aria-label="Tag class" title="Class digit for new tags">
                    {editor.tagScheme.classes.map((entry) => (
                      <option key={entry.digit} value={entry.digit}>
                        {entry.digit} · {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <p className="hint">
              Click to select, drag to move. Shift-click adds. Drag left-to-right for a window, right-to-left for a crossing
              selection. Space + drag or middle mouse pans; wheel zooms.
            </p>
          </>
        )}
        {!item && items.length > 1 && (
          <>
            <div className="selectionActions">
              <select
                aria-label="Align or distribute"
                value=""
                disabled={!canWrite}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("distribute-")) editor.distributeSelection(value.endsWith("x") ? "x" : "y");
                  else if (value) editor.alignSelection(value as AlignMode);
                }}
                title="Align or distribute the selection"
              >
                <option value="">Align…</option>
                <option value="left">Left edges</option>
                <option value="centerX">Centres (vertical axis)</option>
                <option value="right">Right edges</option>
                <option value="top">Top edges</option>
                <option value="centerY">Centres (horizontal axis)</option>
                <option value="bottom">Bottom edges</option>
                <option value="distribute-x">Distribute horizontally</option>
                <option value="distribute-y">Distribute vertically</option>
              </select>
              <button type="button" disabled={!canWrite} onClick={() => editor.renumberSelection()} title="Re-sequence the selected tags in reading order">
                Renumber
              </button>
            </div>
            <p className="hint">Rotate (R), mirror (X), duplicate (Ctrl+D), or delete the selection.</p>
          </>
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
            {registry.resolve(item.symbol).category === "connector" && (
              <>
                <label>
                  Connector reference (pair id)
                  <input
                    value={typeof item.fields.ref === "string" ? item.fields.ref : ""}
                    onChange={(event) => update({ fields: { ...item.fields, ref: event.target.value.toUpperCase() || null } })}
                    placeholder="A"
                    disabled={!canWrite}
                  />
                </label>
                <p>
                  {connectorResolution.targets[item.id] ? (
                    <span className="pill pill-good">{connectorResolution.targets[item.id]}</span>
                  ) : typeof item.fields.ref === "string" && item.fields.ref ? (
                    <span className="pill pill-warn">no matching connector with this reference</span>
                  ) : (
                    <span className="pill pill-muted">set a reference to pair with another sheet</span>
                  )}
                </p>
              </>
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
            <PartSection item={item} editor={editor} registry={registry} parts={parts} canWrite={canWrite} />
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
              Line class
              <select
                value={item.lineClass ?? ""}
                onChange={(event) => {
                  const chosen = lineClasses.find((entry) => entry.name === event.target.value);
                  const spec = chosen ? [chosen.material, chosen.wall ? `x ${chosen.wall} WALL` : ""].filter(Boolean).join(" ") : item.spec;
                  update({
                    lineClass: chosen?.name,
                    spec: spec || undefined,
                    insulation: chosen?.insulation ?? item.insulation,
                    size: chosen && chosen.sizes.length && !chosen.sizes.includes(item.size ?? "") ? chosen.sizes[0] : item.size
                  });
                }}
                disabled={!canWrite}
              >
                <option value="">None</option>
                {lineClasses.map((entry) => (
                  <option key={entry.id} value={entry.name}>
                    {entry.name}
                    {entry.material ? ` · ${entry.material}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="fieldRow">
              <label>
                Size
                <input list="lineSizes" value={item.size ?? ""} onChange={(event) => update({ size: event.target.value || undefined })} disabled={!canWrite} />
                <datalist id="lineSizes">
                  {(lineClasses.find((entry) => entry.name === item.lineClass)?.sizes ?? []).map((size) => (
                    <option key={size} value={size} />
                  ))}
                </datalist>
              </label>
              <label>
                Spec
                <input value={item.spec ?? ""} onChange={(event) => update({ spec: event.target.value || undefined })} disabled={!canWrite} />
              </label>
            </div>
            <div className="fieldRow">
              <label>
                Design P / T
                <input value={[item.designPressure, item.designTemperature].filter(Boolean).join(" / ")} onChange={(event) => {
                  const [pressure, temperature] = event.target.value.split("/").map((part) => part.trim());
                  update({ designPressure: pressure || undefined, designTemperature: temperature || undefined });
                }} placeholder="3000 psig / 120 °F" disabled={!canWrite} />
              </label>
              <label>
                Operating P / T
                <input value={[item.operatingPressure, item.operatingTemperature].filter(Boolean).join(" / ")} onChange={(event) => {
                  const [pressure, temperature] = event.target.value.split("/").map((part) => part.trim());
                  update({ operatingPressure: pressure || undefined, operatingTemperature: temperature || undefined });
                }} placeholder="2500 psig / 85 °F" disabled={!canWrite} />
              </label>
            </div>
            <div className="fieldRow">
              <label>
                Physical length (m)
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={item.physicalLength ?? ""}
                  onChange={(event) => update({ physicalLength: event.target.value === "" ? undefined : Number(event.target.value) })}
                  placeholder={String(lineLengthM(item))}
                  title="Blank estimates from the drawn length × factor"
                  disabled={!canWrite}
                />
              </label>
              <label>
                Length factor (m per drawn mm)
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  value={item.lengthFactor ?? ""}
                  onChange={(event) => update({ lengthFactor: event.target.value === "" ? undefined : Number(event.target.value) })}
                  placeholder="0.001"
                  disabled={!canWrite}
                />
              </label>
            </div>
            <div className="fieldRow">
              <label>
                Insulation
                <input value={item.insulation ?? ""} onChange={(event) => update({ insulation: event.target.value || undefined })} disabled={!canWrite} />
              </label>
              <label>
                Tracing
                <input value={item.tracing ?? ""} onChange={(event) => update({ tracing: event.target.value || undefined })} disabled={!canWrite} />
              </label>
            </div>
            <label className="checkRow">
              <input type="checkbox" checked={Boolean(item.showArrow)} onChange={(event) => update({ showArrow: event.target.checked })} disabled={!canWrite} />
              <span>Flow arrow at end</span>
            </label>
            <label className="checkRow">
              <input type="checkbox" checked={item.showSpecLabel !== false} onChange={(event) => update({ showSpecLabel: event.target.checked })} disabled={!canWrite} />
              <span>Print size and spec on the line</span>
            </label>
            {(() => {
              const ends = lineEndpoints(doc, connectivity, item);
              return (
                <p>
                  From <strong>{ends.from || "—"}</strong> to <strong>{ends.to || "—"}</strong>
                </p>
              );
            })()}
            <p>
              Length <span className="mono">{polylineLength(item.points).toFixed(1)} mm</span> · {item.points.length} vertices · net{" "}
              <span className="mono">{connectivity.lineNet.get(item.id) ?? "—"}</span>
            </p>
            <p>
              <strong>Annotations</strong>
            </p>
            <ul className="portList">
              {(item.annotations ?? []).map((annotation) => (
                <li key={annotation.id}>
                  <span className="mono">{annotation.kind}</span> @ {Math.round(annotation.at * 100)}% {annotation.text ? `· ${annotation.text}` : ""}{" "}
                  {canWrite && (
                    <button type="button" className="linkButton" onClick={() => editor.removeLineAnnotation(item.id, annotation.id)}>
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canWrite && (
              <form
                className="annotationForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  editor.addLineAnnotation(item.id, { kind: annotationDraft.kind, at: annotationDraft.at, text: annotationDraft.text || undefined, side: annotationDraft.side });
                  setAnnotationDraft({ ...annotationDraft, text: "" });
                }}
              >
                <select value={annotationDraft.kind} onChange={(event) => setAnnotationDraft({ ...annotationDraft, kind: event.target.value as LineAnnotation["kind"] })} aria-label="Annotation kind">
                  <option value="note">Note</option>
                  <option value="spec">Spec label</option>
                  <option value="flow_arrow">Flow arrow</option>
                  <option value="size_change">Size change</option>
                  <option value="spec_break">Spec break</option>
                </select>
                <input type="number" min={0} max={1} step={0.05} value={annotationDraft.at} onChange={(event) => setAnnotationDraft({ ...annotationDraft, at: Number(event.target.value) })} aria-label="Annotation position" />
                <input value={annotationDraft.text} onChange={(event) => setAnnotationDraft({ ...annotationDraft, text: event.target.value })} placeholder="Text" aria-label="Annotation text" />
                <button type="submit">Add</button>
              </form>
            )}
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
            <p>
              <strong>Nozzles</strong>
            </p>
            <ul className="portList">
              {(item.nozzles ?? []).map((nozzle) => (
                <li key={nozzle.id}>
                  <span className="mono">{nozzle.id}</span> · {nozzle.side} · {nozzle.size || "—"} ·{" "}
                  {connectivity.portNet.get(`${item.id}:${nozzle.id}`) ? <span className="pill pill-good">connected</span> : <span className="pill pill-warn">open</span>}{" "}
                  {canWrite && (
                    <button type="button" className="linkButton" onClick={() => update({ nozzles: (item.nozzles ?? []).filter((entry) => entry.id !== nozzle.id) })}>
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canWrite && (
              <form
                className="annotationForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const grid = state.grid;
                  const along = Math.round((Math.max(0, Math.min(100, nozzleDraft.offset)) / 100) * (nozzleDraft.side === "left" || nozzleDraft.side === "right" ? item.size.height : item.size.width) / grid) * grid;
                  const position =
                    nozzleDraft.side === "left" ? { x: 0, y: along } :
                    nozzleDraft.side === "right" ? { x: item.size.width, y: along } :
                    nozzleDraft.side === "top" ? { x: along, y: 0 } : { x: along, y: item.size.height };
                  const nozzle: Nozzle = { id: `N${(item.nozzles?.length ?? 0) + 1}`, ...position, side: nozzleDraft.side, size: nozzleDraft.size || undefined };
                  update({ nozzles: [...(item.nozzles ?? []), nozzle] });
                }}
              >
                <select value={nozzleDraft.side} onChange={(event) => setNozzleDraft({ ...nozzleDraft, side: event.target.value as Side })} aria-label="Nozzle side">
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                </select>
                <input type="number" min={0} max={100} value={nozzleDraft.offset} onChange={(event) => setNozzleDraft({ ...nozzleDraft, offset: Number(event.target.value) })} aria-label="Nozzle position (% along side)" />
                <input value={nozzleDraft.size} onChange={(event) => setNozzleDraft({ ...nozzleDraft, size: event.target.value })} placeholder="Size" aria-label="Nozzle size" />
                <button type="submit">Add nozzle</button>
              </form>
            )}
            <PartSection item={item} editor={editor} registry={registry} parts={parts} canWrite={canWrite} />
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
      <DrcPanel editor={editor} inputs={drcInputs} canWrite={canWrite} onLocate={onLocate} onWaive={onWaive} onUnwaive={onUnwaive} onRun={onRunDrc} />
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
        <p>
          {unassigned.length ? (
            <>
              <span className="pill pill-warn">{unassigned.length} item(s) without a part</span>{" "}
              <button type="button" className="linkButton" onClick={() => editor.select(unassigned.map((entry) => entry.id))}>
                select
              </button>
            </>
          ) : (
            <span className="pill pill-good">every counted item has a part</span>
          )}
        </p>
        <p>
          {connectorResolution.unmatched.length ? (
            <span className="pill pill-warn">{connectorResolution.unmatched.length} unmatched connector(s)</span>
          ) : (
            <span className="pill pill-muted">{Object.keys(connectorResolution.targets).length} paired connector(s)</span>
          )}{" "}
          <span className="pill pill-muted">{[...connectivity.crossings.values()].reduce((sum, hops) => sum + hops.length, 0)} crossing(s)</span>
        </p>
        {state.tool === "wire" && (
          <p className="hint">Click a port or point to start, click to add corners, click a port or line to finish. Space flips the bend, Enter ends, Esc cancels.</p>
        )}
        {state.tool === "place" && <p className="hint">Click to place. R rotates, X mirrors, Esc stops placing.</p>}
      </article>
    </aside>
  );
}

/** Assigned part, DNP and spare flags for a symbol or equipment item. */
function PartSection({ item, editor, registry, parts, canWrite }: { item: SymbolItem | EquipmentItem; editor: Editor; registry: SymbolRegistry; parts: Part[]; canWrite: boolean }) {
  const [assigning, setAssigning] = useState(false);
  const { connectivity, doc } = useEditorSnapshot(editor);
  const part = item.partId ? (parts.find((entry) => entry.id === item.partId) ?? null) : null;
  const category = item.kind === "symbol" ? (registry.has(item.symbol) ? registry.resolve(item.symbol).category : null) : "equipment";
  const connectedLines = useMemo(() => {
    const ids = new Set<string>();
    for (const end of connectivity.lineEnds) if (end.attachments.some((attachment) => attachment.kind === "port" && attachment.itemId === item.id)) ids.add(end.lineId);
    return doc.items.filter((entry): entry is LineItem => entry.kind === "line" && ids.has(entry.id));
  }, [connectivity, doc, item.id]);
  const warnings = part ? partWarnings(part, connectedLines) : [];
  const caption = item.kind === "symbol" ? (item.tag ?? item.label ?? item.symbol.key) : (item.tag ?? item.name);
  const update = (patch: Record<string, unknown>) => {
    if (canWrite) editor.updateItem(item.id, patch);
  };
  return (
    <div className="partSection">
      <p>
        <strong>Part</strong>
      </p>
      {part ? (
        <p className="partCurrent">
          <Link to={`/parts?part=${part.id}`} className="mono" title="Open in the parts catalog">
            {part.part_number}
          </Link>{" "}
          {part.description}{" "}
          <span className={`pill pill-${part.lifecycle_status === "obsolete" || part.lifecycle_status === "restricted" ? "bad" : warnings.length ? "warn" : "good"}`}>
            {part.lifecycle_status === "active" ? part.qualification_status : part.lifecycle_status}
          </span>
        </p>
      ) : item.partId ? (
        <p>
          <span className="pill pill-bad">part {item.partId} is not in the catalog</span>
        </p>
      ) : (
        <p>
          <span className="pill pill-muted">no part assigned</span>
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="partWarnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="toolGroup">
        <button type="button" disabled={!canWrite} onClick={() => setAssigning(true)}>
          {part ? "Replace part…" : "Assign part…"}
        </button>
        {item.partId && (
          <button type="button" disabled={!canWrite} onClick={() => update({ partId: null })}>
            Remove
          </button>
        )}
      </div>
      <div className="fieldRow">
        <label className="checkRow">
          <input type="checkbox" checked={Boolean(item.dnp)} onChange={(event) => update({ dnp: event.target.checked || undefined })} disabled={!canWrite} />
          <span>Do not populate (DNP)</span>
        </label>
        <label>
          Spares
          <input type="number" min={0} step={1} value={item.spare ?? 0} onChange={(event) => update({ spare: Math.max(0, Math.floor(Number(event.target.value))) || undefined })} disabled={!canWrite} />
        </label>
      </div>
      {assigning && (
        <AssignPartModal
          parts={parts}
          category={category}
          currentPartId={item.partId}
          connectedLines={connectedLines}
          caption={caption}
          onAssign={(partId) => {
            update({ partId });
            setAssigning(false);
          }}
          onClose={() => setAssigning(false)}
        />
      )}
    </div>
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

function StatusBar({ editor, cursor, viewport, drcInputs }: { editor: Editor; cursor: Point | null; viewport: Viewport; drcInputs: DrcInputs }) {
  const { doc, state } = useEditorSnapshot(editor);
  const drc = useDrc(editor, drcInputs);
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
      <span className={drc.counts.error ? "statusDrc drcBad" : drc.counts.warning ? "statusDrc drcWarn" : "statusDrc"} title="Design rule check">
        DRC {drc.counts.error} / {drc.counts.warning}
      </span>
      <span>{editor.store.dirty ? "Unsaved changes" : "Saved"}</span>
    </div>
  );
}

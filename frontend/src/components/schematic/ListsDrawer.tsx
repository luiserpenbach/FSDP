/**
 * Lists drawer: instrument index, line list, valve list, equipment list,
 * tie-in list, and the drawing BoM, under the canvas. Drawing scope is live
 * (computed from the open sheets by the engine); project scope reads the
 * saved index across every drawing. Double-click a row (or press Enter) to
 * locate it on its sheet.
 *
 * Every list renders in <DataGrid>: natural tag sort, filters, multi-select,
 * copy, CSV export. In drawing scope, when the drawing can be edited, cells
 * that live in the drawing (tag, part, notes, line number, class, service,
 * size, pressures, ...) are editable inline or by pasting a block from Excel,
 * and the selected rows take bulk actions (assign or clear a part, set line
 * class or service). Every write goes through `onCommitEdits`, which applies
 * them to the open sheet as one undo step or to the drawing's other sheets.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../../api";
import { resolveConnectorTargets, type SheetDoc } from "../../engine/connectors";
import type { Editor } from "../../engine/editor";
import type { EditField, LineClassLike } from "../../engine/fieldEdits";
import { buildSheetIndex, type SheetIndex } from "../../engine/index";
import type { SymbolRegistry } from "../../engine/library";
import { partWarnings } from "../../engine/parts";
import { validateTag, type TagScheme } from "../../engine/tags";
import type { FieldValue, SchematicDocument } from "../../engine/types";
import { LIST_DEFINITIONS, listRows, type IndexedSheet, type ListKind } from "../../engine/lists";
import type { BomReadiness, BomSnapshot, Drawing, ListRead, Part } from "../../types";
import { DataGrid, type DataGridCellErrors, type DataGridColumn, type DataGridEdit } from "../datagrid";
import { AssignPartModal, type ConnectedLine } from "./AssignPartModal";
import { BulkEditActions } from "./BulkEditActions";
import type { SheetEditResult, SheetFieldEdit } from "./sheetEdits";
import { useSettledSnapshot } from "./useSettledSnapshot";
import { StaleSheetsWarning } from "../StaleSheetsWarning";

export type DrawerTab = ListKind | "bom";
export type ListScope = "drawing" | "project";

export type LocateTarget = { drawingId?: string | null; sheetId?: string | null; itemId: string };

const TAB_LABELS: Record<DrawerTab, string> = {
  instrument: "Instruments",
  line: "Lines",
  valve: "Valves",
  equipment: "Equipment",
  tie_in: "Tie-ins",
  bom: "BoM"
};

const TABS: DrawerTab[] = ["instrument", "line", "valve", "equipment", "tie_in", "bom"];

/** Grid columns that write back into the drawing, per list, and the document field each one edits. */
const EDITABLE: Record<ListKind, Record<string, EditField>> = {
  instrument: { tag: "tag", part_number: "partId", dnp: "dnp", mounting: "mounting", notes: "notes" },
  valve: { tag: "tag", part_number: "partId", dnp: "dnp", notes: "notes" },
  equipment: { tag: "tag", name: "name", part_number: "partId", notes: "notes" },
  tie_in: { tag: "tag", notes: "notes" },
  line: {
    line_number: "lineNumber",
    service: "service",
    size: "size",
    spec: "spec",
    line_class: "lineClass",
    design_pressure: "designPressure",
    design_temperature: "designTemperature",
    operating_pressure: "operatingPressure",
    operating_temperature: "operatingTemperature",
    insulation: "insulation",
    tracing: "tracing"
  }
};

const MONO = new Set(["tag", "line_number", "zone", "part_number", "from_tag", "to_tag", "drawing_number"]);
const NUMERIC = new Set(["sheet_no", "length_m", "nozzle_count"]);

type GridRow = Record<string, unknown> & { row_id: string; item_id: string };

type CachedIndex = { doc: SchematicDocument; registry: SymbolRegistry; targets: Record<string, string>; index: SheetIndex };

function sameTargets(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sheetKey(sheet: SheetDoc): string {
  return sheet.sheetId ?? `sheet-no-${sheet.sheetNo}`;
}

/**
 * Index rows for the other (not open) sheets, rebuilt only when that sheet's
 * document, the registry, or its resolved off-page targets change, so editing
 * the open sheet leaves them untouched.
 */
class OtherSheetIndexCache {
  private entries = new Map<string, CachedIndex>();

  get(sheet: SheetDoc, registry: SymbolRegistry, targets: Record<string, string>): SheetIndex {
    const cached = this.entries.get(sheetKey(sheet));
    if (cached && cached.doc === sheet.doc && cached.registry === registry && sameTargets(cached.targets, targets)) return cached.index;
    const index = buildSheetIndex(sheet.doc, registry, { connectorTargets: targets });
    this.entries.set(sheetKey(sheet), { doc: sheet.doc, registry, targets, index });
    return index;
  }

  /** Drop sheets that are no longer listed. */
  retain(sheets: SheetDoc[]): void {
    const keep = new Set(sheets.map(sheetKey));
    for (const key of [...this.entries.keys()]) if (!keep.has(key)) this.entries.delete(key);
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return String(value);
}

function rowKey(sheetRef: unknown, itemId: unknown): string {
  return `${String(sheetRef)}:${String(itemId)}`;
}

/** Lines connected to each item, per sheet, for the part warnings (design pressure). */
function connectedLinesByItem(sheets: IndexedSheet[]): Map<string, ConnectedLine[]> {
  const map = new Map<string, ConnectedLine[]>();
  for (const sheet of sheets) {
    const sheetRef = sheet.sheetId ?? sheet.sheetNo;
    for (const line of sheet.index.lines) {
      for (const itemId of new Set([line.from_item, line.to_item])) {
        if (!itemId) continue;
        const key = rowKey(sheetRef, itemId);
        const list = map.get(key) ?? [];
        list.push({ designPressure: line.design_pressure ?? undefined });
        map.set(key, list);
      }
    }
  }
  return map;
}

export function ListsDrawer({
  editor,
  sheetId,
  sheetNo,
  otherSheets,
  parts,
  projectId,
  drawing,
  canWrite,
  editable = false,
  readOnlyReason,
  tagScheme,
  lineClasses = [],
  onCommitEdits,
  staleSheetNos = [],
  tab,
  onTab,
  onLocate,
  onExport,
  onGenerateBom,
  bom,
  readiness,
  busy,
  onClose
}: {
  editor: Editor;
  sheetId: string;
  sheetNo: number;
  otherSheets: SheetDoc[];
  parts: Part[];
  projectId: string;
  drawing: Drawing | null;
  canWrite: boolean;
  /** Drawing-scope cells can be edited (writer on a drawing that is not released). */
  editable?: boolean;
  /** Shown when the lists cannot be edited (released drawing, viewer). */
  readOnlyReason?: string | null;
  tagScheme?: TagScheme;
  lineClasses?: readonly LineClassLike[];
  /** Write field edits back into the drawing; rejects when the drawing cannot be edited. */
  onCommitEdits?: (edits: SheetFieldEdit[]) => Promise<SheetEditResult>;
  /** Sheets of this drawing whose stored index is out of date (exports and the BoM read it). */
  staleSheetNos?: number[];
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onLocate: (target: LocateTarget) => void;
  onExport: (scope: ListScope, kind: ListKind, format: "csv" | "xlsx") => void;
  onGenerateBom: () => void;
  bom: BomSnapshot | null;
  readiness: BomReadiness | null;
  busy: boolean;
  onClose: () => void;
}) {
  // Throttled while editing: at most every ~250 ms, and at once when a drag ends.
  const { doc, connectivity } = useSettledSnapshot(editor);
  const [scope, setScope] = useState<ListScope>("drawing");
  const [projectList, setProjectList] = useState<ListRead | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<GridRow[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const partById = useMemo(() => new Map(parts.map((part) => [part.id, part])), [parts]);
  // Row -> locate on its sheet (switching sheet or drawing when needed); a ref keeps the columns stable.
  const locateRef = useRef<(row: GridRow) => void>(() => undefined);
  useEffect(() => {
    locateRef.current = (row) =>
      onLocate({ drawingId: (row.drawing_id as string | undefined) ?? drawing?.id ?? null, sheetId: (row.sheet_id as string | undefined) ?? null, itemId: String(row.item_id) });
  });

  // Live rows: the open sheet from the editor (reusing its connectivity), other
  // sheets from their stored documents through a per-sheet cache.
  const [otherIndexes] = useState(() => new OtherSheetIndexCache());
  const liveSheets = useMemo<IndexedSheet[]>(() => {
    const registry = editor.registry;
    const current: SheetDoc = { sheetNo, doc, sheetId };
    const sheets = [current, ...otherSheets];
    otherIndexes.retain(otherSheets);
    return sheets.map((sheet) => {
      const others = sheets.filter((entry) => entry !== sheet);
      const targets = resolveConnectorTargets(sheet, others).targets;
      const index =
        sheet === current
          ? buildSheetIndex(doc, registry, { connectivity, connectorTargets: targets })
          : otherIndexes.get(sheet, registry, targets);
      return { sheetNo: sheet.sheetNo, sheetId: sheet.sheetId, index };
    });
  }, [doc, connectivity, sheetId, sheetNo, otherSheets, editor.registry, otherIndexes]);

  const listKind: ListKind | null = tab === "bom" ? null : tab;
  const counts = useMemo(() => Object.fromEntries((TABS.filter((entry) => entry !== "bom") as ListKind[]).map((kind) => [kind, listRows(kind, liveSheets).length])), [liveSheets]);
  const connected = useMemo(() => connectedLinesByItem(liveSheets), [liveSheets]);
  const liveRows = useMemo<GridRow[]>(
    () =>
      listKind
        ? listRows(listKind, liveSheets, (id) => partById.get(id)?.part_number).map((row) => ({ ...row, row_id: rowKey(row.sheet_id ?? row.sheet_no, row.item_id) }))
        : [],
    [listKind, liveSheets, partById]
  );

  useEffect(() => {
    if (scope !== "project" || !listKind || !projectId) return;
    let cancelled = false;
    setProjectError(null);
    api
      .getProjectList(projectId, listKind)
      .then((list) => {
        if (!cancelled) setProjectList(list);
      })
      .catch((error) => {
        if (!cancelled) setProjectError(error instanceof Error ? error.message : "Could not load the project list.");
      });
    return () => {
      cancelled = true;
    };
  }, [scope, listKind, projectId]);

  useEffect(() => setNotice(null), [tab, scope]);

  const canEditCells = scope === "drawing" && editable && Boolean(onCommitEdits);
  const projectRows = useMemo<GridRow[]>(
    () =>
      scope === "project" && projectList?.kind === listKind
        ? projectList.rows.map((row) => ({ ...row, row_id: `${String(row.drawing_id ?? "")}:${rowKey(row.sheet_id ?? row.sheet_no, row.item_id)}`, item_id: String(row.item_id) }))
        : [],
    [scope, projectList, listKind]
  );
  const rows = scope === "project" ? projectRows : liveRows;
  const rowById = useMemo(() => new Map(rows.map((row) => [row.row_id, row])), [rows]);

  const columns = useMemo<DataGridColumn<GridRow>[]>(() => {
    if (!listKind) return [];
    const definition = LIST_DEFINITIONS[listKind];
    const base = scope === "project" ? [{ key: "drawing_number", label: "Drawing" }, ...definition.columns] : definition.columns;
    const editableKeys = canEditCells ? EDITABLE[listKind] : {};
    const partOptions = parts.map((part) => ({ value: part.id, label: part.part_number }));
    return base.map((source): DataGridColumn<GridRow> => {
      const column: DataGridColumn<GridRow> = {
        key: source.key,
        header: source.label,
        mono: MONO.has(source.key),
        frozen: source.key === "tag" || source.key === "line_number",
        editable: Boolean(editableKeys[source.key]),
        width: source.key === "notes" ? 200 : NUMERIC.has(source.key) ? 80 : undefined
      };
      if (column.frozen) {
        // The identifying cell carries the locate button (double-click on it edits when editable).
        column.render = (row, value) => (
          <span className="listIdCell">
            <button
              type="button"
              className="listLocate"
              title="Locate on the sheet"
              aria-label={`Locate ${String(value ?? row.item_id)}`}
              onClick={(event) => {
                event.stopPropagation();
                locateRef.current(row);
              }}
            >
              ⌖
            </button>
            <span>{value === null || value === undefined ? "" : String(value)}</span>
          </span>
        );
      }
      if (NUMERIC.has(source.key)) {
        column.type = "number";
        column.format = (value) => (typeof value === "number" ? String(Math.round(value * 1000) / 1000) : "");
      }
      if (source.key === "tag" && tagScheme) {
        column.validate = (value) => {
          const text = typeof value === "string" ? value.trim() : "";
          if (!text) return null;
          const verdict = validateTag(text, tagScheme);
          return verdict.ok ? null : verdict.reason;
        };
      }
      if (source.key === "dnp") {
        column.type = "boolean";
        column.width = 70;
        column.getValue = (row) => row.dnp === "DNP" || row.dnp === true;
        column.setValue = (row, value) => ({ ...row, dnp: value ? "DNP" : "" });
        column.format = (value) => (value ? "DNP" : "");
      }
      if (source.key === "line_class" && scope === "drawing" && lineClasses.length) {
        column.type = "enum";
        column.options = lineClasses.map((entry) => entry.name);
      }
      if (source.key === "part_number" && scope === "drawing") {
        column.type = "enum";
        column.width = 170;
        column.options = partOptions;
        column.getValue = (row) => row.part_id ?? null;
        column.setValue = (row, value) => ({ ...row, part_id: value ?? null, part_number: value ? (partById.get(String(value))?.part_number ?? null) : null });
        column.format = (value) => (value ? (partById.get(String(value))?.part_number ?? String(value)) : "");
        column.sortValue = (row) => (row.part_id ? (partById.get(String(row.part_id))?.part_number ?? String(row.part_id)) : null);
        column.parse = (text) => {
          const trimmed = text.trim();
          if (!trimmed) return null;
          const lower = trimmed.toLowerCase();
          const part = parts.find((entry) => entry.part_number.toLowerCase() === lower) ?? partById.get(trimmed);
          if (!part) throw new Error(`${trimmed} is not in the parts catalog.`);
          return part.id;
        };
        column.validate = (value) => {
          const part = value ? partById.get(String(value)) : null;
          return part?.lifecycle_status === "obsolete" ? `${part.part_number} is obsolete and cannot be assigned.` : null;
        };
        column.render = (row) => renderPart(row, partById, connected);
      }
      return column;
    });
  }, [listKind, scope, canEditCells, parts, partById, lineClasses, tagScheme, connected]);

  async function commit(gridEdits: DataGridEdit[]): Promise<{ errors: DataGridCellErrors }> {
    if (!listKind || !onCommitEdits) return { errors: {} };
    const fields = EDITABLE[listKind];
    const edits: SheetFieldEdit[] = [];
    const cells = new Map<string, { rowId: string; key: string }>();
    for (const gridEdit of gridEdits) {
      const row = rowById.get(gridEdit.rowId);
      const field = fields[gridEdit.key];
      if (!row || !field || !row.sheet_id) continue;
      const edit: SheetFieldEdit = { sheetId: String(row.sheet_id), itemId: row.item_id, field, value: (gridEdit.value ?? null) as FieldValue };
      edits.push(edit);
      cells.set(`${edit.sheetId}|${edit.itemId}|${field}`, { rowId: gridEdit.rowId, key: gridEdit.key });
    }
    const result = await onCommitEdits(edits);
    const errors: DataGridCellErrors = {};
    for (const error of result.errors) {
      const target = cells.get(`${error.sheetId}|${error.itemId}|${error.field}`);
      if (target) (errors[target.rowId] ??= {})[target.key] = error.message;
    }
    return { errors };
  }

  async function bulk(selected: GridRow[], field: EditField, value: FieldValue, done: string) {
    if (!onCommitEdits) return;
    const targets = selected.filter((row) => row.sheet_id);
    try {
      const result = await onCommitEdits(targets.map((row) => ({ sheetId: String(row.sheet_id), itemId: row.item_id, field, value })));
      const refused = result.errors.length;
      const first = result.errors[0];
      const firstCaption = first ? (rows.find((row) => row.item_id === first.itemId && String(row.sheet_id) === first.sheetId)?.[listKind === "line" ? "line_number" : "tag"] ?? first.itemId) : "";
      setNotice({
        text: refused ? `${done} on ${targets.length - refused} of ${targets.length}. ${refused} refused — ${String(firstCaption)}: ${first.message}` : `${done} on ${targets.length} row(s).`,
        error: refused > 0
      });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "The edit failed.", error: true });
    }
  }

  const bulkActions =
    canEditCells && listKind
      ? (selected: GridRow[]) => {
          const isLines = listKind === "line";
          const withParts = isLines || listKind === "tie_in" ? 0 : selected.length;
          return (
            <BulkEditActions
              itemCount={withParts}
              lineCount={isLines ? selected.length : 0}
              partCount={selected.filter((row) => row.part_id).length}
              lineClasses={lineClasses}
              onAssignPart={() => setAssigning(selected)}
              onClearPart={() => void bulk(selected, "partId", null, "Cleared the part")}
              onSetLineClass={(value) => void bulk(selected, "lineClass", value, value ? `Set line class ${value}` : "Cleared the line class")}
              onSetService={(value) => void bulk(selected, "service", value, value ? `Set service ${value}` : "Cleared the service")}
            />
          );
        }
      : undefined;

  const emptyMessage: ReactNode = scope === "project" ? "No saved rows in this project. Save a sheet to index it." : "Nothing on this drawing yet.";

  return (
    <section className="listsDrawer" aria-label="Engineering lists">
      <div className="listsHead">
        <div className="listTabs" role="tablist" aria-label="Lists">
          {TABS.map((entry) => (
            <button key={entry} type="button" role="tab" aria-selected={tab === entry} className={tab === entry ? "listTab active" : "listTab"} onClick={() => onTab(entry)}>
              {TAB_LABELS[entry]}
              {entry !== "bom" && scope === "drawing" && <span className="listCount">{counts[entry]}</span>}
            </button>
          ))}
        </div>
        {tab !== "bom" && (
          <div className="listControls">
            <label className="checkRow">
              <input type="radio" name="listScope" checked={scope === "drawing"} onChange={() => setScope("drawing")} />
              <span>This drawing</span>
            </label>
            <label className="checkRow">
              <input type="radio" name="listScope" checked={scope === "project"} onChange={() => setScope("project")} />
              <span>Project</span>
            </label>
            <button
              type="button"
              disabled={busy || !listKind || (scope === "drawing" && !drawing)}
              onClick={() => listKind && onExport(scope, listKind, "csv")}
              title="Export the saved list with its title block (server)"
            >
              CSV
            </button>
            <button
              type="button"
              disabled={busy || !listKind || (scope === "drawing" && !drawing)}
              onClick={() => listKind && onExport(scope, listKind, "xlsx")}
              title="Export the saved list with its title block (server)"
            >
              XLSX
            </button>
          </div>
        )}
        <button type="button" className="linkButton" onClick={onClose} aria-label="Close lists">
          Hide
        </button>
      </div>
      {tab !== "bom" ? (
        <div className="listScroll listGridScroll">
          {scope === "project" && projectError && <p className="formError">{projectError}</p>}
          {scope === "project" && projectList?.kind === listKind && <StaleSheetsWarning sheets={projectList.stale_sheets ?? []}>These rows show their last saved state.</StaleSheetsWarning>}
          {scope === "drawing" && <StaleSheetsWarning sheets={staleSheetNos.map((sheet_no) => ({ sheet_no }))}>The rows here are live; CSV and XLSX exports read the stored index until the re-index finishes.</StaleSheetsWarning>}
          {scope === "drawing" && !editable && readOnlyReason && <p className="hint listReadOnly">{readOnlyReason}</p>}
          {scope === "project" && editable && <p className="hint listReadOnly">Project scope is read-only; switch to This drawing to edit.</p>}
          {notice && (
            <p className={notice.error ? "formError listNotice" : "hint listNotice"} role="status">
              {notice.text}
            </p>
          )}
          {listKind && (
            <DataGrid<GridRow>
              key={`${scope}-${listKind}`}
              ariaLabel={`${LIST_DEFINITIONS[listKind].title}${scope === "project" ? " (project)" : ""}`}
              rows={rows}
              columns={columns}
              getRowId={(row) => row.row_id}
              onCommit={canEditCells ? commit : undefined}
              bulkActions={bulkActions}
              onRowActivate={(row) => locateRef.current(row)}
              defaultSort={[{ key: listKind === "line" ? "line_number" : "tag", dir: "asc" }]}
              storageKey={`drafting.lists.${listKind}.${scope}`}
              exportFileName={`${drawing?.number ?? "drawing"}-${listKind}-list`}
              loading={scope === "project" && !projectList && !projectError}
              emptyMessage={emptyMessage}
              height={210}
              rowHeight={28}
              className="listGrid"
            />
          )}
        </div>
      ) : (
        <div className="listScroll">
          <div className="listControls bomControls">
            <button type="button" className="primary" disabled={busy || !canWrite || !drawing} onClick={onGenerateBom}>
              Generate BoM from drawing
            </button>
            {bom && (
              <span className="hint">
                Rev {bom.revision} · {bom.rows.length} row(s) · {bom.created_at ? new Date(bom.created_at).toLocaleString() : ""}
              </span>
            )}
            {readiness && (
              <span className={readiness.ready ? "pill pill-good" : readiness.blocking_count ? "pill pill-bad" : "pill pill-warn"}>
                {readiness.ready ? "ready" : `${readiness.blocking_count ?? 0} blocking · ${readiness.warning_count ?? 0} warning(s)`}
              </span>
            )}
          </div>
          {bom ? (
            <StaleSheetsWarning sheets={bom.stale_sheets ?? []}>This BoM cannot be released; generate a new one once the sheets are re-indexed.</StaleSheetsWarning>
          ) : (
            <StaleSheetsWarning sheets={staleSheetNos.map((sheet_no) => ({ sheet_no }))}>A BoM generated now would read their last saved state and could not be released.</StaleSheetsWarning>
          )}
          {!bom && <p className="hint">The BoM rolls tagged valves, instruments, and equipment up by assigned part and adds tubing, fittings, and tees from the lines. Save the sheet first: it reads the saved index.</p>}
          {bom && (
            <table className="listTable">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Part</th>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Spares</th>
                  <th>Tags</th>
                  <th>DNP</th>
                  <th>Sheets</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bom.rows.map((row, index) => {
                  const tags = Array.isArray(row.component_tags) ? (row.component_tags as string[]) : [];
                  const dnp = Array.isArray(row.dnp_tags) ? (row.dnp_tags as string[]) : [];
                  const issue = readiness?.issues.find((entry) => entry.part_number === row.part_number && entry.component_tags.join() === tags.join());
                  return (
                    <tr key={index} className={tags.length ? "listRow" : undefined} onClick={() => tags.length && onLocateTag(liveSheets, tags[0], onLocate)}>
                      <td>{cell(row.kind)}</td>
                      <td className="mono">{cell(row.part_number)}</td>
                      <td>{cell(row.description)}</td>
                      <td className="mono">{cell(row.quantity)}</td>
                      <td>{cell(row.unit)}</td>
                      <td className="mono">{cell(row.spare_quantity)}</td>
                      <td className="mono">{tags.join(", ") || "—"}</td>
                      <td className="mono">{dnp.join(", ") || "—"}</td>
                      <td className="mono">{Array.isArray(row.sheets) ? (row.sheets as number[]).join(", ") : "—"}</td>
                      <td>{issue ? <span className={issue.severity === "blocking" ? "pill pill-bad" : "pill pill-warn"}>{issue.code}</span> : <span className="pill pill-good">ok</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {assigning && listKind && (
        <AssignPartModal
          parts={parts}
          category={sharedValue(assigning.map((row) => (row.category as string | null) ?? null)) ?? null}
          currentPartId={sharedValue(assigning.map((row) => (row.part_id as string | null) ?? null))}
          assignedCount={assigning.filter((row) => row.part_id).length}
          targetCount={assigning.length}
          connectedLines={assigning.flatMap((row) => connected.get(rowKey(row.sheet_id ?? row.sheet_no, row.item_id)) ?? [])}
          caption={assigning.length === 1 ? String(assigning[0].tag ?? assigning[0].item_id) : `${assigning.length} ${TAB_LABELS[listKind].toLowerCase()}`}
          onAssign={(partId) => {
            const targets = assigning;
            setAssigning(null);
            const part = partId ? partById.get(partId) : null;
            void bulk(targets, "partId", partId, part ? `Assigned ${part.part_number}` : "Cleared the part");
          }}
          onClose={() => setAssigning(null)}
        />
      )}
    </section>
  );
}

/** The one value every entry shares, or undefined when they differ. */
function sharedValue<T>(values: T[]): T | undefined {
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function renderPart(row: GridRow, partById: Map<string, Part>, connected: Map<string, ConnectedLine[]>): ReactNode {
  const partId = row.part_id ? String(row.part_id) : null;
  if (!partId) return null;
  const part = partById.get(partId);
  if (!part)
    return (
      <span className="pill pill-bad" title="This part is not in the catalog">
        {partId}
      </span>
    );
  const warnings = partWarnings(part, connected.get(rowKey(row.sheet_id ?? row.sheet_no, row.item_id)) ?? []);
  return (
    <span className="listPart">
      <span className="mono">{part.part_number}</span>
      {warnings.length > 0 && (
        <span className={part.lifecycle_status === "obsolete" || part.lifecycle_status === "restricted" ? "listPartWarn bad" : "listPartWarn"} title={warnings.join("\n")} aria-label={`${warnings.length} part warning(s): ${warnings.join(" ")}`}>
          ⚠ {warnings.length}
        </span>
      )}
    </span>
  );
}

/** Locate the item whose tag (or line number) is `tag` on the live sheets. */
function onLocateTag(sheets: IndexedSheet[], tag: string, onLocate: (target: LocateTarget) => void): void {
  for (const sheet of sheets) {
    const item = sheet.index.items.find((entry) => (entry.tag ?? entry.label) === tag);
    if (item) {
      onLocate({ sheetId: sheet.sheetId ?? null, itemId: item.item_id });
      return;
    }
    const line = sheet.index.lines.find((entry) => entry.line_number === tag || entry.line_id === tag);
    if (line) {
      onLocate({ sheetId: sheet.sheetId ?? null, itemId: line.line_id });
      return;
    }
  }
}

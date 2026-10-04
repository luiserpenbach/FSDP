/**
 * Lists drawer: instrument index, line list, valve list, equipment list,
 * tie-in list, and the drawing BoM, under the canvas. Drawing scope is live
 * (computed from the open sheets by the engine); project scope reads the
 * saved index across every drawing. Click a row to locate it on the sheet.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { resolveConnectorTargets, type SheetDoc } from "../../engine/connectors";
import type { Editor } from "../../engine/editor";
import { buildSheetIndex, type SheetIndex } from "../../engine/index";
import type { SymbolRegistry } from "../../engine/library";
import type { SchematicDocument } from "../../engine/types";
import { LIST_DEFINITIONS, listRows, type IndexedSheet, type ListKind } from "../../engine/lists";
import type { BomReadiness, BomSnapshot, Drawing, ListRead, Part } from "../../types";
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

export function ListsDrawer({
  editor,
  sheetId,
  sheetNo,
  otherSheets,
  parts,
  projectId,
  drawing,
  canWrite,
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
  const [filter, setFilter] = useState("");
  const partNumbers = useMemo(() => new Map(parts.map((part) => [part.id, part.part_number])), [parts]);

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
  const liveRows = useMemo(() => (listKind ? listRows(listKind, liveSheets, (id) => partNumbers.get(id)) : []), [listKind, liveSheets, partNumbers]);

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

  const columns = listKind ? (scope === "project" ? [{ key: "drawing_number", label: "Drawing" }, ...LIST_DEFINITIONS[listKind].columns] : LIST_DEFINITIONS[listKind].columns) : [];
  const rows: Array<Record<string, unknown>> = scope === "project" ? (projectList?.kind === listKind ? projectList.rows : []) : liveRows;
  const needle = filter.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => columns.some((column) => cell(row[column.key]).toLowerCase().includes(needle))) : rows;

  return (
    <section className="listsDrawer" aria-label="Engineering lists">
      <div className="listsHead">
        <div className="listTabs" role="tablist" aria-label="Lists">
          {(["instrument", "line", "valve", "equipment", "tie_in", "bom"] as DrawerTab[]).map((entry) => (
            <button key={entry} type="button" role="tab" aria-selected={tab === entry} className={tab === entry ? "listTab active" : "listTab"} onClick={() => onTab(entry)}>
              {TAB_LABELS[entry]}
              {entry !== "bom" && scope === "drawing" && <span className="listCount">{listRows(entry, liveSheets).length}</span>}
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
            <input className="findInput" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows" aria-label="Filter list rows" />
            <button type="button" disabled={busy || !listKind || (scope === "drawing" && !drawing)} onClick={() => listKind && onExport(scope, listKind, "csv")}>
              CSV
            </button>
            <button type="button" disabled={busy || !listKind || (scope === "drawing" && !drawing)} onClick={() => listKind && onExport(scope, listKind, "xlsx")}>
              XLSX
            </button>
          </div>
        )}
        <button type="button" className="linkButton" onClick={onClose} aria-label="Close lists">
          Hide
        </button>
      </div>
      {tab !== "bom" ? (
        <div className="listScroll">
          {scope === "project" && projectError && <p className="formError">{projectError}</p>}
          {scope === "project" && projectList?.kind === listKind && <StaleSheetsWarning sheets={projectList.stale_sheets ?? []}>These rows show their last saved state.</StaleSheetsWarning>}
          {scope === "drawing" && <StaleSheetsWarning sheets={staleSheetNos.map((sheet_no) => ({ sheet_no }))}>The rows here are live; CSV and XLSX exports read the stored index until the re-index finishes.</StaleSheetsWarning>}
          {scope === "project" && !projectList && !projectError && <p className="hint">Loading project list…</p>}
          <table className="listTable">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="hint">
                    {scope === "project" ? "No saved rows in this project. Save a sheet to index it." : "Nothing on this drawing yet."}
                  </td>
                </tr>
              )}
              {visible.map((row) => (
                <tr
                  key={`${String(row.sheet_id ?? row.sheet_no)}-${String(row.item_id)}`}
                  className="listRow"
                  onClick={() => onLocate({ drawingId: (row.drawing_id as string) ?? drawing?.id ?? null, sheetId: (row.sheet_id as string) ?? null, itemId: String(row.item_id) })}
                  title="Locate on the sheet"
                >
                  {columns.map((column) => (
                    <td key={column.key} className={column.key === "tag" || column.key === "line_number" || column.key === "zone" ? "mono" : undefined}>
                      {cell(row[column.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
    </section>
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

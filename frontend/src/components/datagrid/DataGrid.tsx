/**
 * <DataGrid> — spreadsheet-grade table for every FSDP list (docs/codebase-review.md §2.4).
 *
 * Features: multi-column sort (natural "HV-2 < HV-10"), quick filter + per-column
 * filters, row selection with bulk-action toolbar, Excel-style keyboard navigation and
 * cell-range selection, inline editing with validation and optimistic commits,
 * clipboard copy/paste as TSV (Excel / Google Sheets compatible), CSV export (with
 * formula-injection guard) and an optional XLSX hook, column chooser and resizable
 * widths persisted to localStorage, row virtualization, frozen columns.
 *
 * Props (see ./types.ts for full docs):
 *   rows, columns, getRowId              data; memoize `columns`
 *   onCommit(edits) => Promise<void | { errors: {[rowId]: {[key]: msg}} }>
 *                                        omit for read-only. Edits show immediately
 *                                        (pending), roll back + show the error when the
 *                                        promise rejects or returns errors for a cell.
 *   onPasteNewRows(rows)                 pasted lines below the last row ({key: text})
 *   selectedIds / defaultSelectedIds / onSelectionChange / selectable
 *   bulkActions                          node or (selectedRows, clear) => node
 *   onRowActivate(row)                   double-click / Enter on a non-editable cell
 *   defaultSort, storageKey, exportFileName, onExportXlsx(rows, columns), toolbar
 *   loading, emptyMessage, height (max), rowHeight, overscan, rowClassName, ariaLabel
 *
 * Column: { key, header, width?, type?: "text"|"number"|"enum"|"boolean"|"date",
 *   options?, editable?: boolean | (row) => boolean, render?, getValue?, setValue?,
 *   parse? (throw to reject), format?, sortValue?, validate?: (value,row) => msg|null,
 *   align?, frozen?, hidden?, hideable?, sortable?, filterable?, mono? }
 *
 * Keyboard (grid focused): arrows / Home / End / PageUp / PageDown / Ctrl+Home/End move;
 * Shift+move extends the range; Tab / Shift+Tab move across cells and wrap rows (they leave
 * the grid from the first / last cell); Enter or F2 edits (Enter on a read-only
 * cell activates the row); typing starts editing with that character; in the editor
 * Enter commits and moves down, Tab commits and moves right, Escape cancels;
 * Delete / Backspace clear editable cells in the range; Space toggles the row's
 * selection; Ctrl+A selects all cells; Ctrl+C / Ctrl+X / Ctrl+V copy, cut, paste.
 * Column filters accept "text", "=exact", "!=x", ">10", "<=5", "1..5", "=" (blank).
 *
 * Usage:
 *   const columns = useMemo<DataGridColumn<Part>[]>(() => [
 *     { key: "part_number", header: "Part no.", mono: true, frozen: true },
 *     { key: "description", header: "Description", editable: true, width: 260 },
 *     { key: "lifecycle_status", header: "Lifecycle", type: "enum",
 *       options: ["draft", "active", "obsolete"], editable: (p) => p.lifecycle_status !== "obsolete" },
 *     { key: "mass_kg", header: "Mass (kg)", type: "number", editable: true,
 *       validate: (v) => (typeof v === "number" && v < 0 ? "Must be ≥ 0" : null) },
 *     { key: "preferred", header: "Preferred", type: "boolean", editable: true },
 *   ], []);
 *
 *   <DataGrid
 *     rows={parts} columns={columns} getRowId={(p) => p.id} storageKey="parts"
 *     ariaLabel="Parts catalog" exportFileName="parts"
 *     onCommit={async (edits) => { const res = await api.bulkUpdateParts(edits); setParts(res.parts);
 *                                  return { errors: res.errors }; }}
 *     onPasteNewRows={(lines) => createParts(lines)}
 *     bulkActions={(selected, clear) => <button onClick={() => retire(selected).then(clear)}>Retire</button>}
 *     onRowActivate={(p) => openPart(p.id)}
 *     onExportXlsx={(rows) => downloadPartsXlsx(rows)}
 *   />
 */
import "./DataGrid.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from "react";
import {
  cellText,
  cellValue,
  columnAlign,
  columnType,
  defaultWidth,
  editText,
  filterRows,
  isCellEditable,
  isFilterActive,
  minWidth,
  optionList,
  parseCellText,
  sameValue,
  sortRows,
  usesSetFilter,
  withCellValue
} from "./gridModel";
import { useColumnPrefs, useRowSelection } from "./hooks";
import { CellEditor, ColumnChooser, SetFilter } from "./parts";
import type { EditorMove } from "./parts";
import type { DataGridColumn, DataGridEdit, DataGridFilter, DataGridProps, DataGridSort } from "./types";
import { downloadText, isBlank, parseTsv, toCsv, toTsv } from "./utils";

const HEAD_HEIGHT = 34;
const CHECK_WIDTH = 40;

interface Cell {
  r: number;
  c: number;
}

interface RangeSelection {
  anchor: Cell;
  cursor: Cell;
}

interface OverlayEntry {
  value: unknown;
  status: "pending" | "committed";
  token: number;
  /** For committed entries: the rows prop they were committed against (dropped once rows change). */
  rows?: ReadonlyArray<unknown>;
}

interface EditState {
  rowId: string;
  key: string;
  initialText: string;
  error: string | null;
  session: number;
}

interface EditRequest {
  rowId: string;
  key: string;
  text?: string;
  value?: unknown;
}

interface CellError {
  rowId: string;
  key: string;
  message: string;
}

function cellKey(rowId: string, key: string): string {
  return `${rowId}\u0000${key}`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/** Excel-style status bar numbers for a cell range (raw values, not pending edits). */
function rangeStats<T>(
  viewRows: ReadonlyArray<T>,
  columns: ReadonlyArray<DataGridColumn<T>>,
  rect: { r1: number; r2: number; c1: number; c2: number }
) {
  let count = 0;
  let numeric = 0;
  let sum = 0;
  for (let r = rect.r1; r <= rect.r2; r += 1) {
    const row = viewRows[r];
    if (row === undefined) continue;
    for (let c = rect.c1; c <= rect.c2; c += 1) {
      const column = columns[c];
      if (!column) continue;
      const value = cellValue(column, row);
      if (isBlank(value)) continue;
      count += 1;
      if (typeof value === "number" && Number.isFinite(value)) {
        numeric += 1;
        sum += value;
      }
    }
  }
  return { count, numeric, sum };
}

/** Locate the grid cell an event happened in (event delegation keeps per-cell closures out of render). */
function eventCell(target: EventTarget | null): { r: number; c: number; rowId: string; kind: string } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("[data-dg-cell]");
  if (!element) return null;
  return {
    r: Number(element.dataset.r),
    c: Number(element.dataset.c),
    rowId: element.dataset.rowId ?? "",
    kind: element.dataset.dgCell ?? ""
  };
}

function noop() {}

function formatStat(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
}

export function DataGrid<T>(props: DataGridProps<T>) {
  const {
    rows,
    columns,
    getRowId,
    onCommit,
    onPasteNewRows,
    selectedIds,
    defaultSelectedIds,
    onSelectionChange,
    selectable = true,
    bulkActions,
    onRowActivate,
    defaultSort,
    storageKey,
    exportFileName = "export",
    onExportXlsx,
    toolbar,
    loading = false,
    emptyMessage,
    height = 480,
    rowHeight = 32,
    overscan = 8,
    rowClassName,
    ariaLabel,
    className = ""
  } = props;

  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  const commitTokenRef = useRef(0);
  const editCounterRef = useRef(0);
  const activeEditRef = useRef(0);
  const draggingRef = useRef(false);
  const rowAnchorRef = useRef<string | null>(null);

  const columnPrefs = useColumnPrefs(storageKey);
  const selection = useRowSelection(selectedIds, defaultSelectedIds, onSelectionChange);
  const [sort, setSort] = useState<DataGridSort[]>(() => [...(defaultSort ?? [])]);
  const [quickFilter, setQuickFilter] = useState("");
  const [filters, setFilters] = useState<Record<string, DataGridFilter>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sel, setSel] = useState<RangeSelection | null>(null);
  const [focusKind, setFocusKind] = useState<"cells" | "rows">("cells");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [overlay, setOverlay] = useState<ReadonlyMap<string, OverlayEntry>>(() => new Map());
  const [cellErrors, setCellErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(typeof height === "number" ? height : 600);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stopDrag = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  /* ---------- Columns ---------- */

  const { visibility, widths: savedWidths } = columnPrefs.prefs;
  const visibleColumns = useMemo(() => {
    const shown = columns.filter((column) => column.hideable === false || (visibility[column.key] ?? !column.hidden));
    return [...shown.filter((column) => column.frozen), ...shown.filter((column) => !column.frozen)];
  }, [columns, visibility]);
  const isColumnVisible = (column: DataGridColumn<T>) => column.hideable === false || (visibility[column.key] ?? !column.hidden);
  const columnByKey = useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns]);

  const leadWidth = selectable ? CHECK_WIDTH : 0;
  const widths = visibleColumns.map((column) => Math.max(minWidth(column), savedWidths[column.key] ?? defaultWidth(column)));
  const offsets: number[] = [];
  let totalWidth = leadWidth;
  let frozenEdge = leadWidth;
  for (let index = 0; index < visibleColumns.length; index += 1) {
    offsets.push(totalWidth);
    totalWidth += widths[index];
    if (visibleColumns[index].frozen) frozenEdge = totalWidth;
  }

  /* ---------- Rows: filter + sort (memoized), optimistic overlay ---------- */

  const viewRows = useMemo(
    () => sortRows(filterRows(rows, visibleColumns, visibleColumns, filters, quickFilter), visibleColumns, sort),
    [rows, visibleColumns, filters, quickFilter, sort]
  );
  const rowCount = viewRows.length;
  const colCount = visibleColumns.length;

  const overlayByRow = useMemo(() => {
    const byRow = new Map<string, Map<string, unknown>>();
    for (const [key, entry] of overlay) {
      if (entry.status === "committed" && entry.rows !== rows) continue;
      const [rowId, columnKey] = key.split("\u0000");
      let cells = byRow.get(rowId);
      if (!cells) {
        cells = new Map();
        byRow.set(rowId, cells);
      }
      cells.set(columnKey, entry.value);
    }
    return byRow;
  }, [overlay, rows]);

  function effectiveRow(row: T): T {
    const cells = overlayByRow.get(getRowId(row));
    if (!cells) return row;
    let next = row;
    for (const [key, value] of cells) {
      const column = columnByKey.get(key);
      if (column) next = withCellValue(column, next, value);
    }
    return next;
  }

  /* ---------- Cell range ---------- */

  const clampCell = (cell: Cell): Cell => ({ r: clamp(cell.r, 0, rowCount - 1), c: clamp(cell.c, 0, colCount - 1) });
  const activeSel = sel && rowCount > 0 && colCount > 0 ? { anchor: clampCell(sel.anchor), cursor: clampCell(sel.cursor) } : null;
  const rect = activeSel
    ? {
        r1: Math.min(activeSel.anchor.r, activeSel.cursor.r),
        r2: Math.max(activeSel.anchor.r, activeSel.cursor.r),
        c1: Math.min(activeSel.anchor.c, activeSel.cursor.c),
        c2: Math.max(activeSel.anchor.c, activeSel.cursor.c)
      }
    : null;
  const multiCell = rect !== null && (rect.r2 > rect.r1 || rect.c2 > rect.c1);

  const stats = rect && multiCell ? rangeStats(viewRows, visibleColumns, rect) : null;

  /* ---------- Row selection ---------- */

  const selectedRows = selection.set.size > 0 ? rows.filter((row) => selection.set.has(getRowId(row))) : [];
  let visibleSelected = 0;
  if (selection.set.size > 0) for (const row of viewRows) if (selection.set.has(getRowId(row))) visibleSelected += 1;
  const allVisibleSelected = rowCount > 0 && visibleSelected === rowCount;
  const someVisibleSelected = visibleSelected > 0 && !allVisibleSelected;

  function toggleRow(rowId: string) {
    const next = new Set(selection.set);
    if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    rowAnchorRef.current = rowId;
    selection.change(next);
    setFocusKind("rows");
  }

  function selectRowRangeTo(index: number) {
    const anchorIndex = rowAnchorRef.current === null ? -1 : viewRows.findIndex((row) => getRowId(row) === rowAnchorRef.current);
    if (anchorIndex < 0) {
      toggleRow(getRowId(viewRows[index]));
      return;
    }
    const next = new Set(selection.set);
    for (let r = Math.min(anchorIndex, index); r <= Math.max(anchorIndex, index); r += 1) next.add(getRowId(viewRows[r]));
    selection.change(next);
    setFocusKind("rows");
  }

  function toggleAllFiltered() {
    if (allVisibleSelected) {
      const next = new Set(selection.set);
      for (const row of viewRows) next.delete(getRowId(row));
      selection.change(next);
    } else {
      selection.change(viewRows.map(getRowId));
    }
    setFocusKind("rows");
  }

  function clearSelection() {
    selection.change([]);
  }

  /* ---------- Virtual window ---------- */

  const headerRowCount = showFilters ? 2 : 1;
  const headerHeight = HEAD_HEIGHT * headerRowCount;
  const bodyViewport = Math.max(rowHeight, viewportHeight - headerHeight);
  const windowStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const windowEnd = Math.min(rowCount, Math.ceil((scrollTop + bodyViewport) / rowHeight) + overscan);
  const editingIndex = editing ? viewRows.findIndex((row) => getRowId(row) === editing.rowId) : -1;

  function focusGrid() {
    scrollRef.current?.focus({ preventScroll: true });
  }

  function ensureVisible(cell: Cell) {
    const element = scrollRef.current;
    if (!element) return;
    const view = element.clientHeight > 0 ? Math.max(rowHeight, element.clientHeight - headerHeight) : bodyViewport;
    const top = cell.r * rowHeight;
    let nextTop = scrollTop;
    if (top < scrollTop) nextTop = top;
    else if (top + rowHeight > scrollTop + view) nextTop = top + rowHeight - view;
    if (nextTop !== scrollTop) {
      element.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
    const column = visibleColumns[cell.c];
    if (element.clientWidth > 0 && column && !column.frozen) {
      const left = offsets[cell.c];
      const right = left + widths[cell.c];
      if (left < element.scrollLeft + frozenEdge) element.scrollLeft = left - frozenEdge;
      else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
    }
  }

  function moveTo(cell: Cell, extend: boolean) {
    const target = clampCell(cell);
    setSel(extend && activeSel ? { anchor: activeSel.anchor, cursor: target } : { anchor: target, cursor: target });
    setFocusKind("cells");
    ensureVisible(target);
  }

  /* ---------- Editing & commits ---------- */

  function prepareEdits(requests: EditRequest[]) {
    const byId = new Map(rows.map((row) => [getRowId(row), row]));
    const valid: DataGridEdit[] = [];
    const errors: CellError[] = [];
    const touched: string[] = [];
    for (const request of requests) {
      const row = byId.get(request.rowId);
      const column = columnByKey.get(request.key);
      if (row === undefined || !column) continue;
      const current = effectiveRow(row);
      if (!isCellEditable(column, current)) continue;
      touched.push(cellKey(request.rowId, request.key));
      let value: unknown = request.value;
      if (request.text !== undefined) {
        try {
          value = parseCellText(column, request.text, current);
        } catch (error) {
          errors.push({ rowId: request.rowId, key: request.key, message: errorMessage(error, "Invalid value") });
          continue;
        }
      }
      const invalid = column.validate?.(value, current);
      if (invalid) {
        errors.push({ rowId: request.rowId, key: request.key, message: invalid });
        continue;
      }
      if (sameValue(cellValue(column, current), value)) continue;
      valid.push({ rowId: request.rowId, key: request.key, value });
    }
    return { valid, errors, touched };
  }

  function recordErrors(touched: string[], errors: CellError[]) {
    if (touched.length === 0 && errors.length === 0) return;
    setCellErrors((prev) => {
      const next = new Map(prev);
      for (const key of touched) next.delete(key);
      for (const error of errors) next.set(cellKey(error.rowId, error.key), error.message);
      return next;
    });
  }

  async function runCommit(edits: DataGridEdit[]) {
    if (!onCommit || edits.length === 0) return;
    commitTokenRef.current += 1;
    const token = commitTokenRef.current;
    setOverlay((prev) => {
      const next = new Map(prev);
      for (const edit of edits) next.set(cellKey(edit.rowId, edit.key), { value: edit.value, status: "pending", token });
      return next;
    });
    let failure: string | null = null;
    let serverErrors: Record<string, Record<string, string>> = {};
    try {
      const result = await onCommit(edits);
      if (result && typeof result === "object" && result.errors) serverErrors = result.errors;
    } catch (error) {
      failure = errorMessage(error, "Save failed");
    }
    const committedAgainst = rowsRef.current;
    setOverlay((prev) => {
      const next = new Map(prev);
      for (const edit of edits) {
        const key = cellKey(edit.rowId, edit.key);
        const entry = next.get(key);
        if (!entry || entry.token !== token) continue;
        if (failure || serverErrors[edit.rowId]?.[edit.key]) next.delete(key);
        else next.set(key, { ...entry, status: "committed", rows: committedAgainst });
      }
      // Drop committed entries superseded by a newer rows prop.
      for (const [key, entry] of next) if (entry.status === "committed" && entry.rows !== committedAgainst) next.delete(key);
      return next;
    });
    const errors: CellError[] = [];
    for (const edit of edits) {
      const message = failure ?? serverErrors[edit.rowId]?.[edit.key];
      if (message) errors.push({ rowId: edit.rowId, key: edit.key, message });
    }
    for (const [rowId, byKey] of Object.entries(serverErrors))
      for (const [key, message] of Object.entries(byKey))
        if (!edits.some((edit) => edit.rowId === rowId && edit.key === key)) errors.push({ rowId, key, message });
    recordErrors([], errors);
  }

  function commitRequests(requests: EditRequest[]): CellError[] {
    const { valid, errors, touched } = prepareEdits(requests);
    recordErrors(touched, errors);
    void runCommit(valid);
    return errors;
  }

  function startEdit(cell: Cell, typed?: string): boolean {
    if (!onCommit) return false;
    const row = viewRows[cell.r];
    const column = visibleColumns[cell.c];
    if (row === undefined || !column) return false;
    const current = effectiveRow(row);
    if (!isCellEditable(column, current)) return false;
    const rowId = getRowId(row);
    setSel({ anchor: cell, cursor: cell });
    setFocusKind("cells");
    if (columnType(column) === "boolean") {
      if (typed === undefined) commitRequests([{ rowId, key: column.key, value: cellValue(column, current) !== true }]);
      return true;
    }
    let initialText = typed ?? editText(column, current);
    if (typed !== undefined && columnType(column) === "enum") {
      const match = optionList(column).find((option) => option.label.toLowerCase().startsWith(typed.toLowerCase()));
      initialText = match ? match.value : editText(column, current);
    }
    editCounterRef.current += 1;
    activeEditRef.current = editCounterRef.current;
    setEditing({ rowId, key: column.key, initialText, error: null, session: editCounterRef.current });
    ensureVisible(cell);
    return true;
  }

  function stepCell(cell: Cell, move: EditorMove): Cell {
    switch (move) {
      case "up":
        return { r: cell.r - 1, c: cell.c };
      case "down":
        return { r: cell.r + 1, c: cell.c };
      case "left":
        return { r: cell.r, c: cell.c - 1 };
      case "right":
        return { r: cell.r, c: cell.c + 1 };
      default:
        return cell;
    }
  }

  function commitEditor(text: string, move: EditorMove, fromBlur: boolean) {
    const current = editing;
    if (!current || activeEditRef.current !== current.session) return;
    const { valid, errors, touched } = prepareEdits([{ rowId: current.rowId, key: current.key, text }]);
    if (errors.length > 0) {
      if (fromBlur) {
        // Focus left the grid: keep the old value and flag what was rejected.
        activeEditRef.current = 0;
        setEditing(null);
        recordErrors(touched, [{ ...errors[0], message: `${errors[0].message} — edit discarded` }]);
        return;
      }
      setEditing({ ...current, error: errors[0].message });
      return;
    }
    activeEditRef.current = 0;
    setEditing(null);
    recordErrors(touched, []);
    void runCommit(valid);
    if (!fromBlur) {
      focusGrid();
      if (move && activeSel) moveTo(stepCell(activeSel.cursor, move), false);
    }
  }

  function cancelEditor() {
    activeEditRef.current = 0;
    setEditing(null);
    focusGrid();
  }

  /* ---------- Range operations: clear, copy, paste ---------- */

  function clearRange() {
    if (!onCommit || !rect) return;
    const requests: EditRequest[] = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      const rowId = getRowId(viewRows[r]);
      for (let c = rect.c1; c <= rect.c2; c += 1) requests.push({ rowId, key: visibleColumns[c].key, text: "" });
    }
    commitRequests(requests);
  }

  function copyText(): string | null {
    if (focusKind === "rows" && selection.set.size > 0) {
      const lines = viewRows
        .filter((row) => selection.set.has(getRowId(row)))
        .map((row) => {
          const current = effectiveRow(row);
          return visibleColumns.map((column) => cellText(column, current));
        });
      return toTsv([visibleColumns.map((column) => column.header), ...lines]);
    }
    if (!rect) return null;
    const lines: string[][] = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      const current = effectiveRow(viewRows[r]);
      const line: string[] = [];
      for (let c = rect.c1; c <= rect.c2; c += 1) line.push(cellText(visibleColumns[c], current));
      lines.push(line);
    }
    return toTsv(lines);
  }

  function pasteText(text: string) {
    let block = parseTsv(text);
    if (block.length === 0 || colCount === 0) return;
    const startRow = rect?.r1 ?? 0;
    const startCol = rect?.c1 ?? 0;
    const looksLikeHeader = (line: string[]) =>
      line.some((cell) => cell.trim() !== "") &&
      line.every((cell, j) => {
        const column = visibleColumns[startCol + j];
        return cell.trim() === "" || (column !== undefined && column.header.toLowerCase() === cell.trim().toLowerCase());
      });
    if (block.length > 1 && looksLikeHeader(block[0])) block = block.slice(1);

    const requests: EditRequest[] = [];
    const newRows: Array<Record<string, string>> = [];
    if (rect && multiCell && block.length === 1 && block[0].length === 1) {
      // One value pasted onto a range fills the range (Excel behaviour).
      for (let r = rect.r1; r <= rect.r2; r += 1)
        for (let c = rect.c1; c <= rect.c2; c += 1)
          requests.push({ rowId: getRowId(viewRows[r]), key: visibleColumns[c].key, text: block[0][0] });
    } else {
      block.forEach((line, i) => {
        const r = startRow + i;
        if (r < rowCount) {
          const rowId = getRowId(viewRows[r]);
          line.forEach((cell, j) => {
            const column = visibleColumns[startCol + j];
            if (column) requests.push({ rowId, key: column.key, text: cell });
          });
        } else {
          const record: Record<string, string> = {};
          line.forEach((cell, j) => {
            const column = visibleColumns[startCol + j];
            if (column) record[column.key] = cell;
          });
          newRows.push(record);
        }
      });
      if (rowCount > 0) {
        const width = Math.max(...block.map((line) => line.length));
        const anchor = { r: startRow, c: startCol };
        const cursor = clampCell({ r: startRow + block.length - 1, c: startCol + width - 1 });
        setSel({ anchor, cursor });
        setFocusKind("cells");
      }
    }
    if (onCommit && requests.length > 0) commitRequests(requests);
    if (newRows.length > 0) onPasteNewRows?.(newRows);
  }

  function onCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || editing) return;
    const text = copyText();
    if (text === null) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  }

  function onCut(event: ReactClipboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || editing) return;
    onCopy(event);
    if (focusKind === "cells") clearRange();
  }

  function onPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || editing) return;
    if (!onCommit && !onPasteNewRows) return;
    event.preventDefault();
    pasteText(event.clipboardData.getData("text/plain"));
  }

  /* ---------- Keyboard ---------- */

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || editing) return;
    if (rowCount === 0 || colCount === 0) return;
    const mod = event.ctrlKey || event.metaKey;
    const extend = event.shiftKey;
    const cursor = activeSel?.cursor ?? null;
    const lastRow = rowCount - 1;
    const lastCol = colCount - 1;
    const page = Math.max(1, Math.floor(bodyViewport / rowHeight) - 1);
    const navigate = (cell: Cell, allowExtend = true) => {
      event.preventDefault();
      moveTo(cell, allowExtend && extend);
    };

    if (!cursor) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", "F2"].includes(event.key)) {
        navigate({ r: 0, c: 0 }, false);
      }
      return;
    }
    const { r, c } = cursor;
    switch (event.key) {
      case "ArrowUp":
        navigate({ r: mod ? 0 : r - 1, c });
        return;
      case "ArrowDown":
        navigate({ r: mod ? lastRow : r + 1, c });
        return;
      case "ArrowLeft":
        navigate({ r, c: mod ? 0 : c - 1 });
        return;
      case "ArrowRight":
        navigate({ r, c: mod ? lastCol : c + 1 });
        return;
      case "Home":
        navigate(mod ? { r: 0, c: 0 } : { r, c: 0 });
        return;
      case "End":
        navigate(mod ? { r: lastRow, c: lastCol } : { r, c: lastCol });
        return;
      case "PageUp":
        navigate({ r: r - page, c });
        return;
      case "PageDown":
        navigate({ r: r + page, c });
        return;
      case "Tab": {
        if (event.shiftKey) {
          if (r === 0 && c === 0) return;
          navigate(c > 0 ? { r, c: c - 1 } : { r: r - 1, c: lastCol }, false);
        } else {
          if (r === lastRow && c === lastCol) return;
          navigate(c < lastCol ? { r, c: c + 1 } : { r: r + 1, c: 0 }, false);
        }
        return;
      }
      case "Enter":
      case "F2": {
        event.preventDefault();
        if (!startEdit(cursor) && event.key === "Enter") onRowActivate?.(viewRows[r]);
        return;
      }
      case "Escape":
        if (multiCell) {
          event.preventDefault();
          setSel({ anchor: cursor, cursor });
        }
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        clearRange();
        return;
      case " ":
        if (selectable && !mod) {
          event.preventDefault();
          if (extend) selectRowRangeTo(r);
          else toggleRow(getRowId(viewRows[r]));
        }
        return;
      default:
        break;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSel({ anchor: { r: 0, c: 0 }, cursor: { r: lastRow, c: lastCol } });
      setFocusKind("cells");
      return;
    }
    if (!mod && !event.altKey && event.key.length === 1) {
      if (startEdit(cursor, event.key)) event.preventDefault();
    }
  }

  /* ---------- Mouse ---------- */

  function onGridMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const hit = eventCell(event.target);
    if (!hit) return;
    const { r, c, rowId } = hit;
    if (hit.kind === "check") {
      event.preventDefault();
      focusGrid();
      if (activeSel) setSel({ anchor: { r, c: activeSel.cursor.c }, cursor: { r, c: activeSel.cursor.c } });
      return;
    }
    if (editing && editing.rowId === rowId && editing.key === visibleColumns[c]?.key) return;
    if (event.target instanceof HTMLInputElement) event.preventDefault(); // keep focus on the grid
    focusGrid();
    if (event.shiftKey && activeSel) {
      event.preventDefault();
      setSel({ anchor: activeSel.anchor, cursor: { r, c } });
    } else {
      setSel({ anchor: { r, c }, cursor: { r, c } });
      draggingRef.current = true;
    }
    if ((event.ctrlKey || event.metaKey) && selectable) toggleRow(rowId);
    else setFocusKind("cells");
  }

  function onGridMouseOver(event: ReactMouseEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const hit = eventCell(event.target);
    if (!hit || hit.kind !== "data") return;
    setSel((prev) => (prev ? { anchor: prev.anchor, cursor: { r: hit.r, c: hit.c } } : prev));
  }

  function onGridClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    const hit = eventCell(target);
    if (!hit) return;
    if (hit.kind === "check") {
      if (event.shiftKey) selectRowRangeTo(hit.r);
      else toggleRow(hit.rowId);
      return;
    }
    const column = visibleColumns[hit.c];
    const row = viewRows[hit.r];
    if (!onCommit || !column || row === undefined || columnType(column) !== "boolean") return;
    commitRequests([{ rowId: hit.rowId, key: column.key, value: cellValue(column, effectiveRow(row)) !== true }]);
  }

  function onGridDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const hit = eventCell(event.target);
    if (!hit || hit.kind !== "data") return;
    const column = visibleColumns[hit.c];
    const row = viewRows[hit.r];
    if (!column || row === undefined) return;
    if (onCommit && isCellEditable(column, effectiveRow(row))) {
      // Boolean cells toggle on the checkbox click itself.
      if (columnType(column) !== "boolean") startEdit({ r: hit.r, c: hit.c });
      return;
    }
    onRowActivate?.(row);
  }

  /* ---------- Header: sort, resize, filters ---------- */

  function toggleSort(key: string, additive: boolean) {
    setSort((prev) => {
      const index = prev.findIndex((entry) => entry.key === key);
      const current = index >= 0 ? prev[index].dir : null;
      const nextDir: "asc" | "desc" | null = current === null ? "asc" : current === "asc" ? "desc" : null;
      if (!additive) {
        // Plain click: cycle when this is the only sort key, otherwise start a fresh ascending sort.
        if (prev.length !== 1 || index !== 0) return [{ key, dir: "asc" }];
        return nextDir ? [{ key, dir: nextDir }] : [];
      }
      if (index < 0) return [...prev, { key, dir: "asc" }];
      if (!nextDir) return prev.filter((entry) => entry.key !== key);
      return prev.map((entry) => (entry.key === key ? { key, dir: nextDir } : entry));
    });
  }

  function startResize(event: ReactPointerEvent, column: DataGridColumn<T>, startWidth: number) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const setWidth = columnPrefs.setWidth;
    const onMove = (moveEvent: PointerEvent) => setWidth(column.key, Math.max(minWidth(column), startWidth + moveEvent.clientX - startX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function setColumnFilter(key: string, filter: DataGridFilter | undefined) {
    setFilters((prev) => {
      const next = { ...prev };
      if (filter) next[key] = filter;
      else delete next[key];
      return next;
    });
  }

  const activeFilterCount = visibleColumns.filter((column) => isFilterActive(filters[column.key])).length;
  const anyFilter = activeFilterCount > 0 || quickFilter.trim() !== "";

  function clearFilters() {
    setFilters({});
    setQuickFilter("");
  }

  function exportCsv() {
    const header = visibleColumns.map((column) => column.header);
    const body = viewRows.map((row) => {
      const current = effectiveRow(row);
      return visibleColumns.map((column) => {
        const value = cellValue(column, current);
        return columnType(column) === "number" && typeof value === "number" && !column.format ? value : cellText(column, current, value);
      });
    });
    downloadText(`${exportFileName}.csv`, toCsv([header, ...body]));
  }

  /* ---------- Render ---------- */

  const rendered: number[] = [];
  for (let r = windowStart; r < windowEnd; r += 1) rendered.push(r);
  if (editingIndex >= 0 && (editingIndex < windowStart || editingIndex >= windowEnd)) rendered.push(editingIndex);

  const cursor = activeSel?.cursor ?? null;
  const cursorRendered = cursor !== null && rendered.includes(cursor.r) && !editing;
  const cellId = (r: number, c: number) => `${gridId}-cell-${r}-${c}`;
  const ariaColOffset = selectable ? 2 : 1;

  function frozenStyle(index: number) {
    return visibleColumns[index].frozen ? { left: offsets[index] } : undefined;
  }

  function renderCellContent(column: DataGridColumn<T>, row: T, value: unknown, editable: boolean): ReactNode {
    if (column.render) return column.render(row, value);
    if (columnType(column) === "boolean") {
      return (
        <input
          aria-label={column.header}
          checked={value === true}
          className="dgBool"
          disabled={!editable}
          onChange={noop}
          tabIndex={-1}
          type="checkbox"
        />
      );
    }
    return <span className="dgText">{cellText(column, row, value)}</span>;
  }

  const bodyRows = rendered.map((r) => {
    const row = viewRows[r];
    const rowId = getRowId(row);
    const current = effectiveRow(row);
    const selected = selection.set.has(rowId);
    const extraClass = rowClassName?.(row);
    return (
      <div
        aria-rowindex={r + headerRowCount + 1}
        aria-selected={selectable ? selected : undefined}
        className={`dgRow${r % 2 ? " dgRowOdd" : ""}${selected ? " dgRowSelected" : ""}${extraClass ? ` ${extraClass}` : ""}`}
        key={rowId}
        role="row"
        style={{ top: r * rowHeight, height: rowHeight, width: totalWidth }}
      >
        {selectable && (
          <div
            aria-colindex={1}
            className="dgCell dgCheckCell dgFrozen"
            data-dg-cell="check"
            data-r={r}
            data-row-id={rowId}
            role="gridcell"
            style={{ width: CHECK_WIDTH, left: 0 }}
          >
            <input
              aria-label={`Select row ${r + 1}`}
              checked={selected}
              onChange={noop}
              tabIndex={-1}
              type="checkbox"
            />
          </div>
        )}
        {visibleColumns.map((column, c) => {
          const value = cellValue(column, current);
          const key = cellKey(rowId, column.key);
          const pending = overlay.get(key)?.status === "pending";
          const error = cellErrors.get(key);
          const isEditing = editing !== null && editing.rowId === rowId && editing.key === column.key;
          const inRange = rect !== null && r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2;
          const isCursor = cursor !== null && cursor.r === r && cursor.c === c;
          const editable = Boolean(onCommit) && isCellEditable(column, current);
          const classes = [
            "dgCell",
            `dgAlign-${columnAlign(column)}`,
            column.mono ? "dgMono" : "",
            column.frozen ? "dgFrozen" : "",
            inRange && multiCell ? "dgInRange" : "",
            isCursor ? "dgCursor" : "",
            pending ? "dgPending" : "",
            error ? "dgError" : "",
            editable ? "dgEditable" : "",
            isEditing ? "dgEditing" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              aria-busy={pending || undefined}
              aria-colindex={c + ariaColOffset}
              aria-invalid={error ? true : undefined}
              aria-readonly={onCommit ? !editable : undefined}
              aria-selected={inRange}
              className={classes}
              data-c={c}
              data-dg-cell="data"
              data-r={r}
              data-row-id={rowId}
              id={cellId(r, c)}
              key={column.key}
              role="gridcell"
              style={{ width: widths[c], ...frozenStyle(c) }}
              title={error ?? (column.render || columnType(column) === "boolean" ? undefined : cellText(column, current, value) || undefined)}
            >
              {isEditing && editing ? (
                <CellEditor
                  column={column}
                  error={editing.error}
                  initialText={editing.initialText}
                  key={editing.session}
                  onCancel={cancelEditor}
                  onCommit={commitEditor}
                />
              ) : (
                renderCellContent(column, current, value, editable)
              )}
              {error && !isEditing && <span aria-hidden="true" className="dgErrorMark" />}
            </div>
          );
        })}
      </div>
    );
  });

  let emptyState: ReactNode = null;
  if (rowCount === 0) {
    if (loading) emptyState = <span>Loading…</span>;
    else if (rows.length === 0) emptyState = emptyMessage ?? "No records yet.";
    else
      emptyState = (
        <>
          <span>No rows match the current filters.</span>
          <button className="dgButton" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </>
      );
  }

  return (
    <div className={`dataGrid ${className}`.trim()}>
      <div className="dgToolbar">
        <input
          aria-label="Search rows"
          className="dgQuickFilter"
          onChange={(event) => setQuickFilter(event.target.value)}
          placeholder="Search rows…"
          type="search"
          value={quickFilter}
        />
        <button aria-pressed={showFilters} className="dgButton" onClick={() => setShowFilters((value) => !value)} type="button">
          {activeFilterCount ? `Filters (${activeFilterCount})` : "Filters"}
        </button>
        {anyFilter && (
          <button className="dgButton dgLink" onClick={clearFilters} type="button">
            Clear filters
          </button>
        )}
        <ColumnChooser
          columns={columns}
          isVisible={isColumnVisible}
          onReset={columnPrefs.reset}
          onToggle={(column, visible) => columnPrefs.setVisible(column.key, visible)}
        />
        {toolbar}
        <span className="dgSpacer" />
        <span aria-live="polite" className="dgCount">
          {rowCount} of {rows.length} rows
        </span>
        <button className="dgButton" disabled={rowCount === 0} onClick={exportCsv} type="button">
          Export CSV
        </button>
        {onExportXlsx && (
          <button
            className="dgButton"
            disabled={rowCount === 0}
            onClick={() => onExportXlsx(viewRows.map(effectiveRow), [...visibleColumns])}
            type="button"
          >
            Export XLSX
          </button>
        )}
      </div>

      {selectable && selectedRows.length > 0 && (
        <div aria-label="Bulk actions" className="dgBulk" role="region">
          <strong>{selectedRows.length} selected</strong>
          {selectedRows.length > visibleSelected && (
            <span className="dgMuted">({selectedRows.length - visibleSelected} hidden by filters)</span>
          )}
          <div className="dgBulkActions">{typeof bulkActions === "function" ? bulkActions(selectedRows, clearSelection) : bulkActions}</div>
          <button className="dgButton dgLink" onClick={clearSelection} type="button">
            Clear selection
          </button>
        </div>
      )}

      <div
        aria-activedescendant={cursorRendered && cursor ? cellId(cursor.r, cursor.c) : undefined}
        aria-busy={loading || undefined}
        aria-colcount={colCount + (selectable ? 1 : 0)}
        aria-label={ariaLabel}
        aria-multiselectable={selectable || undefined}
        aria-rowcount={rowCount + headerRowCount}
        className="dgScroll"
        onClick={onGridClick}
        onCopy={onCopy}
        onCut={onCut}
        onDoubleClick={onGridDoubleClick}
        onFocus={(event) => {
          if (event.target === event.currentTarget && !sel && rowCount > 0 && colCount > 0) setSel({ anchor: { r: 0, c: 0 }, cursor: { r: 0, c: 0 } });
        }}
        onKeyDown={onKeyDown}
        onMouseDown={onGridMouseDown}
        onMouseOver={onGridMouseOver}
        onPaste={onPaste}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        ref={scrollRef}
        role="grid"
        style={{ maxHeight: height }}
        tabIndex={0}
      >
        <div className="dgHead" role="rowgroup" style={{ width: totalWidth }}>
          <div aria-rowindex={1} className="dgHeadRow" role="row" style={{ height: HEAD_HEIGHT }}>
            {selectable && (
              <div aria-colindex={1} className="dgHeadCell dgCheckCell dgFrozen" role="columnheader" style={{ width: CHECK_WIDTH, left: 0 }}>
                <input
                  aria-label="Select all rows"
                  checked={allVisibleSelected}
                  disabled={rowCount === 0}
                  onChange={toggleAllFiltered}
                  ref={(element) => {
                    if (element) element.indeterminate = someVisibleSelected;
                  }}
                  type="checkbox"
                />
              </div>
            )}
            {visibleColumns.map((column, c) => {
              const sortIndex = sort.findIndex((entry) => entry.key === column.key);
              const entry = sortIndex >= 0 ? sort[sortIndex] : null;
              const sortable = column.sortable !== false;
              return (
                <div
                  aria-colindex={c + ariaColOffset}
                  aria-sort={entry ? (entry.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={`dgHeadCell dgAlign-${columnAlign(column)}${column.frozen ? " dgFrozen" : ""}`}
                  key={column.key}
                  role="columnheader"
                  style={{ width: widths[c], ...frozenStyle(c) }}
                >
                  {sortable ? (
                    <button
                      className="dgSortButton"
                      onClick={(event) => toggleSort(column.key, event.shiftKey)}
                      title="Sort (Shift+click adds a secondary sort)"
                      type="button"
                    >
                      <span className="dgHeadLabel">{column.header}</span>
                      {entry && (
                        <span aria-hidden="true" className="dgSortIcon">
                          {entry.dir === "asc" ? "▲" : "▼"}
                          {sort.length > 1 ? <sup>{sortIndex + 1}</sup> : null}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="dgHeadLabel">{column.header}</span>
                  )}
                  <div
                    aria-label={`Resize ${column.header}`}
                    aria-orientation="vertical"
                    className="dgResize"
                    onDoubleClick={() => columnPrefs.resetWidth(column.key)}
                    onPointerDown={(event) => startResize(event, column, widths[c])}
                    role="separator"
                  />
                </div>
              );
            })}
          </div>
          {showFilters && (
            <div aria-rowindex={2} className="dgHeadRow dgFilterRow" role="row" style={{ height: HEAD_HEIGHT }}>
              {selectable && <div className="dgHeadCell dgCheckCell dgFrozen" role="gridcell" style={{ width: CHECK_WIDTH, left: 0 }} />}
              {visibleColumns.map((column, c) => {
                const filter = filters[column.key];
                return (
                  <div
                    className={`dgHeadCell${column.frozen ? " dgFrozen" : ""}`}
                    key={column.key}
                    role="gridcell"
                    style={{ width: widths[c], ...frozenStyle(c) }}
                  >
                    {column.filterable === false ? null : usesSetFilter(column) ? (
                      <SetFilter column={column} filter={filter} onChange={(next) => setColumnFilter(column.key, next)} />
                    ) : (
                      <input
                        aria-label={`Filter ${column.header}`}
                        className="dgFilterInput"
                        onChange={(event) =>
                          setColumnFilter(column.key, event.target.value ? { kind: "text", text: event.target.value } : undefined)
                        }
                        placeholder={columnType(column) === "number" ? ">10, 1..5" : "Filter…"}
                        value={filter?.kind === "text" ? filter.text : ""}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="dgBody" role="rowgroup" style={{ height: rowCount * rowHeight, width: totalWidth }}>
          {bodyRows}
        </div>
        {emptyState !== null && <div className="dgEmpty">{emptyState}</div>}
        {loading && rows.length > 0 && <div aria-hidden="true" className="dgLoadingBar" />}
      </div>

      {stats && stats.count > 0 && (
        <div className="dgStatus">
          <span>Count: {stats.count}</span>
          {stats.numeric > 0 && (
            <>
              <span>Sum: {formatStat(stats.sum)}</span>
              <span>Average: {formatStat(stats.sum / stats.numeric)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

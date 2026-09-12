/**
 * The FMEA grid: a keyboard-driven table whose reference cells (item,
 * failure mode, detected by, hazard) are pickers bound to the drawing, the
 * library, and the hazard log, and whose ratings recompute RPN as you type.
 *
 * Keys: arrows move, Enter/typing edits, Escape cancels, Tab moves right,
 * Ctrl+D fills the active cell's value down the selected rows, Ctrl+Z / Ctrl+Y
 * undo and redo, Ctrl+V pastes TSV starting at the active cell.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../api";
import type { FmeaRow, Hazard, SafetySettings } from "../../types";
import { StatusPill } from "../ui";
import { RefPicker, type PickerOption } from "./RefPicker";
import type { RowPatch } from "./useFmeaRows";

export type ColumnKind = "text" | "rating" | "select" | "picker" | "readonly" | "modes";

export type GridColumn = {
  key: string;
  label: string;
  kind: ColumnKind;
  width?: number;
  field?: keyof RowPatch;
  options?: Array<{ value: string; label: string }>;
  picker?: "item" | "failure_mode" | "detected_by" | "hazard";
};

export const GRID_COLUMNS: GridColumn[] = [
  { key: "item", label: "Item", kind: "picker", picker: "item", width: 150 },
  { key: "item_zone", label: "Zone", kind: "readonly", width: 56 },
  { key: "failure_mode", label: "Failure mode", kind: "picker", picker: "failure_mode", width: 170 },
  { key: "operating_modes", label: "Modes", kind: "modes", width: 130 },
  { key: "cause", label: "Cause", kind: "text", field: "cause", width: 170 },
  { key: "local_effect", label: "Local effect", kind: "text", field: "local_effect", width: 190 },
  { key: "next_effect", label: "Next effect", kind: "text", field: "next_effect", width: 170 },
  { key: "end_effect", label: "End effect", kind: "text", field: "end_effect", width: 170 },
  { key: "detected_by", label: "Detected by", kind: "picker", picker: "detected_by", width: 120 },
  {
    key: "detection_kind",
    label: "Detection",
    kind: "select",
    field: "detection_kind",
    width: 100,
    options: [
      { value: "instrument", label: "instrument" },
      { value: "procedure", label: "procedure" },
      { value: "inspection", label: "inspection" },
      { value: "none", label: "none" }
    ]
  },
  { key: "severity", label: "S", kind: "rating", field: "severity", width: 40 },
  { key: "occurrence", label: "O", kind: "rating", field: "occurrence", width: 40 },
  { key: "detection", label: "D", kind: "rating", field: "detection", width: 40 },
  { key: "rpn", label: "RPN", kind: "readonly", width: 52 },
  { key: "controls", label: "Controls", kind: "readonly", width: 130 },
  { key: "hazard", label: "Hazard", kind: "picker", picker: "hazard", width: 90 },
  { key: "recommended_action", label: "Action", kind: "text", field: "recommended_action", width: 170 },
  { key: "action_owner", label: "Owner", kind: "text", field: "action_owner", width: 100 },
  {
    key: "action_status",
    label: "Action status",
    kind: "select",
    field: "action_status",
    width: 100,
    options: [
      { value: "not_required", label: "not required" },
      { value: "open", label: "open" },
      { value: "in_progress", label: "in progress" },
      { value: "done", label: "done" }
    ]
  },
  { key: "severity_residual", label: "S'", kind: "rating", field: "severity_residual", width: 40 },
  { key: "occurrence_residual", label: "O'", kind: "rating", field: "occurrence_residual", width: 40 },
  { key: "detection_residual", label: "D'", kind: "rating", field: "detection_residual", width: 40 },
  { key: "rpn_residual", label: "RPN'", kind: "readonly", width: 52 },
  { key: "notes", label: "Notes", kind: "text", field: "notes", width: 150 }
];

export type GridFilter = "all" | "stale" | "above_threshold" | "missing_detection" | "open_actions";

export function cellText(row: FmeaRow, column: GridColumn): string {
  switch (column.key) {
    case "item":
      return row.item_tag ?? row.subject_text ?? "";
    case "failure_mode":
      return row.failure_mode_title ?? row.failure_mode_text ?? "";
    case "operating_modes":
      return (row.operating_modes ?? []).join(", ");
    case "detected_by":
      return row.detected_by_tag ?? (row.detection_kind !== "none" && row.detection_kind !== "instrument" ? row.detection_kind : "");
    case "hazard":
      return row.hazard_key ?? "";
    case "controls":
      return row.controls.map((control) => control.label).join(", ");
    default: {
      const value = (row as unknown as Record<string, unknown>)[column.key];
      return value == null ? "" : String(value);
    }
  }
}

function parseRating(text: string, max: number): number | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

export function FmeaGrid({
  projectId,
  drawingId,
  rows,
  settings,
  hazards,
  canWrite,
  filter,
  onPatch,
  onUndo,
  onRedo,
  onRowAction,
  onOpenRow
}: {
  projectId: string;
  drawingId: string | null;
  rows: FmeaRow[];
  settings: SafetySettings;
  hazards: Hazard[];
  canWrite: boolean;
  filter: GridFilter;
  onPatch: (patches: RowPatch[]) => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onRowAction: (row: FmeaRow, action: "locate" | "delete" | "duplicate" | "not_applicable" | "confirm") => void;
  onOpenRow: (row: FmeaRow) => void;
}) {
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [picker, setPicker] = useState<{ row: number; col: number } | null>(null);
  const [message, setMessage] = useState("");
  const tableRef = useRef<HTMLTableElement>(null);
  const scaleMax = settings.fmea_scale_max ?? 10;
  const threshold = settings.rpn_threshold;

  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (filter === "stale") return Boolean(row.stale_reason);
      if (filter === "above_threshold") return (row.rpn ?? 0) >= threshold;
      if (filter === "missing_detection") return row.detection_kind === "none" && !row.detection_reason;
      if (filter === "open_actions") return row.action_status === "open" || row.action_status === "in_progress";
      return true;
    });
  }, [rows, filter, threshold]);

  useEffect(() => {
    setActive((current) => ({ row: Math.min(current.row, Math.max(0, visible.length - 1)), col: current.col }));
  }, [visible.length]);

  const columns = GRID_COLUMNS;
  const activeRow = visible[active.row];
  const activeColumn = columns[active.col];

  const focusCell = useCallback((rowIndex: number, colIndex: number) => {
    const cell = tableRef.current?.querySelector<HTMLElement>(`[data-cell="${rowIndex}:${colIndex}"]`);
    cell?.focus();
    cell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  function move(deltaRow: number, deltaCol: number) {
    setActive((current) => {
      const next = {
        row: Math.max(0, Math.min(visible.length - 1, current.row + deltaRow)),
        col: Math.max(0, Math.min(columns.length - 1, current.col + deltaCol))
      };
      window.setTimeout(() => focusCell(next.row, next.col), 0);
      return next;
    });
  }

  function beginEdit(rowIndex: number, colIndex: number, initial?: string) {
    const column = columns[colIndex];
    const row = visible[rowIndex];
    if (!canWrite || !row) return;
    if (column.kind === "picker") {
      setPicker({ row: rowIndex, col: colIndex });
      return;
    }
    if (column.kind === "readonly") return;
    setEditing({ row: rowIndex, col: colIndex, value: initial ?? cellText(row, column) });
  }

  async function commitEdit(value: string, advance = true) {
    if (!editing) return;
    const column = columns[editing.col];
    const row = visible[editing.row];
    setEditing(null);
    if (!row || !column.field) return;
    const patch: RowPatch = { id: row.id };
    if (column.kind === "rating") {
      const rating = parseRating(value, scaleMax);
      if (value.trim() && rating === null) {
        setMessage(`Ratings run from 1 to ${scaleMax}.`);
        return;
      }
      (patch as Record<string, unknown>)[column.field] = rating;
    } else if (column.kind === "modes") {
      patch.operating_modes = value.split(",").map((entry) => entry.trim().toLowerCase().replaceAll(/\s+/g, "_")).filter(Boolean);
    } else {
      (patch as Record<string, unknown>)[column.field] = value;
    }
    setMessage("");
    await onPatch([patch]);
    if (advance) move(1, 0);
  }

  async function fillDown() {
    if (!activeRow || !activeColumn.field || activeColumn.kind === "readonly" || activeColumn.kind === "picker") return;
    const targets = visible.filter((row, index) => index > active.row && (selectedRows.size === 0 || selectedRows.has(row.id)));
    if (!targets.length) {
      setMessage("Select rows below the active cell to fill down.");
      return;
    }
    const value = (activeRow as unknown as Record<string, unknown>)[activeColumn.field];
    await onPatch(targets.map((row) => ({ id: row.id, [activeColumn.field as string]: value }) as RowPatch));
    setMessage(`Filled ${targets.length} row(s).`);
  }

  async function pasteTsv(text: string) {
    if (!activeRow || !canWrite) return;
    const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.length);
    const patches: RowPatch[] = [];
    const rejected: string[] = [];
    lines.forEach((line, lineIndex) => {
      const row = visible[active.row + lineIndex];
      if (!row) return;
      const patch: RowPatch = { id: row.id };
      line.split("\t").forEach((cell, cellIndex) => {
        const column = columns[active.col + cellIndex];
        if (!column) return;
        if (column.kind === "text" && column.field) (patch as Record<string, unknown>)[column.field] = cell;
        else if (column.kind === "rating" && column.field) {
          const rating = parseRating(cell, scaleMax);
          if (cell.trim() && rating === null) rejected.push(`${column.label} "${cell}"`);
          else (patch as Record<string, unknown>)[column.field] = rating;
        } else if (column.kind === "select" && column.field) {
          const option = column.options?.find((entry) => entry.value === cell.trim() || entry.label === cell.trim());
          if (option) (patch as Record<string, unknown>)[column.field] = option.value;
          else rejected.push(`${column.label} "${cell}"`);
        } else if (column.picker === "hazard") {
          const hazard = hazards.find((entry) => entry.key === cell.trim());
          if (hazard) patch.hazard_id = hazard.id;
          else if (cell.trim()) rejected.push(`Hazard "${cell}"`);
        } else if (column.picker === "detected_by") {
          rejected.push(`Detected by "${cell}" (pick from the drawing)`);
        } else if (column.kind === "modes") {
          patch.operating_modes = cell.split(",").map((entry) => entry.trim()).filter(Boolean);
        }
      });
      if (Object.keys(patch).length > 1) patches.push(patch);
    });
    if (patches.length) await onPatch(patches);
    setMessage(rejected.length ? `Rejected: ${rejected.join("; ")}` : `Pasted ${patches.length} row(s).`);
  }

  async function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    if (editing || picker) return;
    const { key } = event;
    if (key === "ArrowDown") return void (event.preventDefault(), move(1, 0));
    if (key === "ArrowUp") return void (event.preventDefault(), move(-1, 0));
    if (key === "ArrowRight" || (key === "Tab" && !event.shiftKey)) return void (event.preventDefault(), move(0, 1));
    if (key === "ArrowLeft" || (key === "Tab" && event.shiftKey)) return void (event.preventDefault(), move(0, -1));
    if (key === "Enter" || key === "F2") return void (event.preventDefault(), beginEdit(active.row, active.col));
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "d") return void (event.preventDefault(), await fillDown());
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z" && !event.shiftKey) return void (event.preventDefault(), await onUndo());
    if ((event.ctrlKey || event.metaKey) && (key.toLowerCase() === "y" || (key.toLowerCase() === "z" && event.shiftKey))) return void (event.preventDefault(), await onRedo());
    if (key === "Delete" || key === "Backspace") {
      if (activeColumn.field && activeColumn.kind !== "readonly" && activeColumn.kind !== "picker" && activeRow && canWrite) {
        event.preventDefault();
        await onPatch([{ id: activeRow.id, [activeColumn.field]: activeColumn.kind === "modes" ? [] : null } as RowPatch]);
      }
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && canWrite) {
      if (activeColumn.kind === "rating" && /[0-9]/.test(key)) {
        event.preventDefault();
        const rating = key === "0" ? 10 : Number(key);
        if (activeRow && activeColumn.field && rating <= scaleMax) await onPatch([{ id: activeRow.id, [activeColumn.field]: rating } as RowPatch]);
        return;
      }
      if (activeColumn.kind === "text" || activeColumn.kind === "modes") {
        event.preventDefault();
        beginEdit(active.row, active.col, key);
      } else if (activeColumn.kind === "picker") {
        event.preventDefault();
        beginEdit(active.row, active.col);
      }
    }
  }

  const search = useMemo(() => {
    return {
      item: async (query: string): Promise<PickerOption[]> => {
        const items = await api.listSheetItems(projectId, { q: query, limit: 30 });
        return items
          .filter((item) => !drawingId || item.drawing_id === drawingId)
          .map((item) => ({ id: `${item.sheet_id}|${item.item_id}`, label: item.tag ?? item.label ?? item.item_id, detail: `${item.symbol_name ?? item.category ?? ""} · ${item.drawing_number} sheet ${item.sheet_no}${item.zone ? ` · ${item.zone}` : ""}` }));
      },
      detected_by: async (query: string): Promise<PickerOption[]> => {
        const items = await api.listSheetItems(projectId, { q: query, category: "instrument", limit: 30 });
        return items.filter((item) => !drawingId || item.drawing_id === drawingId).map((item) => ({ id: item.item_id, label: item.tag ?? item.item_id, detail: `${item.symbol_name ?? ""} · sheet ${item.sheet_no}` }));
      },
      failure_mode: async (query: string): Promise<PickerOption[]> => {
        const modes = await api.listFailureModes();
        const q = query.trim().toLowerCase();
        const category = activeRow?.item_category ?? null;
        return modes
          .filter((mode) => mode.active && (!category || mode.category === category) && (!q || mode.title.toLowerCase().includes(q) || mode.name.includes(q)))
          .slice(0, 40)
          .map((mode) => ({ id: mode.id, label: mode.title, detail: `${mode.category}${mode.symbol_key ? ` · ${mode.symbol_key}` : ""}` }));
      },
      hazard: async (query: string): Promise<PickerOption[]> => {
        const q = query.trim().toLowerCase();
        return hazards.filter((hazard) => !q || hazard.key.toLowerCase().includes(q) || hazard.title.toLowerCase().includes(q)).map((hazard) => ({ id: hazard.id, label: hazard.key, detail: hazard.title }));
      }
    };
  }, [projectId, drawingId, hazards, activeRow?.item_category]);

  async function pick(option: PickerOption | null) {
    if (!picker) return;
    const column = columns[picker.col];
    const row = visible[picker.row];
    setPicker(null);
    if (!row) return;
    let patch: RowPatch = { id: row.id };
    if (column.picker === "item") {
      if (option) {
        const [sheetId, itemId] = option.id.split("|");
        patch = { ...patch, sheet_id: sheetId, item_id: itemId, subject_text: null };
      } else patch = { ...patch, sheet_id: null, item_id: null };
    } else if (column.picker === "detected_by") {
      patch = { ...patch, detected_by_item_id: option?.id ?? null, detection_kind: option ? "instrument" : row.detection_kind === "instrument" ? "none" : row.detection_kind };
    } else if (column.picker === "failure_mode") {
      patch = { ...patch, failure_mode_id: option?.id ?? null };
    } else if (column.picker === "hazard") {
      patch = { ...patch, hazard_id: option?.id ?? null };
    }
    await onPatch([patch]);
    focusCell(picker.row, picker.col);
  }

  function renderCell(row: FmeaRow, column: GridColumn, rowIndex: number, colIndex: number): ReactNode {
    const isEditing = editing && editing.row === rowIndex && editing.col === colIndex;
    if (isEditing) {
      if (column.kind === "select") {
        return (
          <select
            autoFocus
            defaultValue={editing.value}
            aria-label={column.label}
            onChange={(event) => void commitEdit(event.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
            }}
          >
            {column.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          autoFocus
          aria-label={column.label}
          value={editing.value}
          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          onBlur={() => void commitEdit(editing.value, false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit(editing.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(null);
              window.setTimeout(() => focusCell(rowIndex, colIndex), 0);
            } else if (event.key === "Tab") {
              event.preventDefault();
              void commitEdit(editing.value, false).then(() => move(0, event.shiftKey ? -1 : 1));
            }
          }}
        />
      );
    }
    if (picker && picker.row === rowIndex && picker.col === colIndex && column.picker) {
      return <RefPicker label={column.label} initialQuery="" search={search[column.picker]} onPick={(option) => void pick(option)} onClose={() => setPicker(null)} />;
    }
    switch (column.key) {
      case "item":
        return (
          <span className="gridItem">
            <b className="mono">{row.item_tag ?? row.subject_text ?? "—"}</b>
            <small>
              {row.part_number ?? row.item_symbol ?? (row.item_id ? "" : "not on drawing")}
              {row.item_id && !row.item_exists ? " · missing" : ""}
            </small>
          </span>
        );
      case "rpn":
      case "rpn_residual": {
        const value = column.key === "rpn" ? row.rpn : row.rpn_residual;
        return <span className={`mono${value != null && value >= threshold ? " overThreshold" : ""}`}>{value ?? ""}</span>;
      }
      case "controls":
        return <span className="mono hint">{row.controls.map((control) => control.label).join(", ")}</span>;
      case "hazard":
        return row.hazard_key ? <span className="mono ref">{row.hazard_key}</span> : <span className="hint">—</span>;
      case "detected_by":
        return row.detected_by_tag ? <span className="mono ref">{row.detected_by_tag}</span> : row.detection_kind === "none" ? <span className="hint">{row.detection_reason ? `none · ${row.detection_reason}` : "none"}</span> : <span className="hint">{row.detection_kind}</span>;
      case "detection_kind":
      case "action_status":
        return <StatusPill value={cellText(row, column) || "none"} />;
      default:
        return <span className={column.kind === "rating" ? "mono ratingCell" : ""}>{cellText(row, column)}</span>;
    }
  }

  return (
    <div className="fmeaGridWrap">
      {message && <p className="hint gridMessage">{message}</p>}
      <table ref={tableRef} className="fmeaGrid" role="grid" aria-label="FMEA worksheet" tabIndex={0} onKeyDown={(event) => void onKeyDown(event)} onPaste={(event) => {
        if (editing) return;
        const text = event.clipboardData.getData("text/plain");
        if (text) {
          event.preventDefault();
          void pasteTsv(text);
        }
      }}>
        <thead>
          <tr>
            <th className="rowTools" aria-label="Row tools" />
            {columns.map((column) => (
              <th key={column.key} style={{ minWidth: column.width }} title={column.kind === "rating" ? `${column.label}: 1–${scaleMax}` : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="hint">
                {rows.length === 0 ? "No rows yet. Generate rows from the drawing or add one by hand." : "No rows match this filter."}
              </td>
            </tr>
          )}
          {visible.map((row, rowIndex) => {
            const isStale = Boolean(row.stale_reason);
            const over = (row.rpn ?? 0) >= threshold;
            const classes = [isStale ? "stale" : "", over ? "over" : "", row.not_applicable ? "notApplicable" : "", selectedRows.has(row.id) ? "rowSelected" : ""].filter(Boolean).join(" ");
            return (
              <tr key={row.id} className={classes || undefined} title={row.stale_detail ?? undefined}>
                <td className="rowTools">
                  <input
                    type="checkbox"
                    aria-label={`Select row ${row.item_tag ?? row.subject_text ?? rowIndex + 1}`}
                    checked={selectedRows.has(row.id)}
                    onChange={(event) => {
                      const next = new Set(selectedRows);
                      if (event.target.checked) next.add(row.id);
                      else next.delete(row.id);
                      setSelectedRows(next);
                    }}
                  />
                  <button type="button" className="rowMenu" aria-label={`Open row ${row.item_tag ?? row.subject_text ?? rowIndex + 1}`} onClick={() => onOpenRow(row)}>
                    ⋯
                  </button>
                  {row.open_comment_count > 0 && <span className="commentDot" title={`${row.open_comment_count} open comment(s)`}>{row.open_comment_count}</span>}
                  {isStale && (
                    <button type="button" className="linkButton staleFlag" title={row.stale_detail ?? row.stale_reason ?? ""} onClick={() => onRowAction(row, "confirm")}>
                      stale
                    </button>
                  )}
                </td>
                {columns.map((column, colIndex) => {
                  const isActive = active.row === rowIndex && active.col === colIndex;
                  return (
                    <td
                      key={column.key}
                      data-cell={`${rowIndex}:${colIndex}`}
                      tabIndex={isActive ? 0 : -1}
                      className={`${column.kind}${isActive ? " activeCell" : ""}`}
                      onClick={() => {
                        setActive({ row: rowIndex, col: colIndex });
                        setSelectedRows(new Set());
                      }}
                      onDoubleClick={() => beginEdit(rowIndex, colIndex)}
                    >
                      {renderCell(row, column, rowIndex, colIndex)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

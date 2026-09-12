/**
 * Row state for the FMEA grid: optimistic patches saved through the bulk
 * endpoint, a local undo stack of inverse patches, and reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { FmeaRow, FmeaRowPatch } from "../../types";

export type RowPatch = FmeaRowPatch & { id: string };

const PATCHABLE: Array<keyof FmeaRowPatch> = [
  "sheet_id",
  "item_id",
  "subject_text",
  "failure_mode_id",
  "failure_mode_text",
  "operating_modes",
  "cause",
  "local_effect",
  "next_effect",
  "end_effect",
  "detected_by_item_id",
  "detection_kind",
  "detection_reason",
  "severity",
  "occurrence",
  "detection",
  "hazard_id",
  "recommended_action",
  "action_owner",
  "action_due",
  "action_status",
  "severity_residual",
  "occurrence_residual",
  "detection_residual",
  "notes",
  "not_applicable",
  "position"
];

function inverse(row: FmeaRow, patch: RowPatch): RowPatch {
  const before: RowPatch = { id: row.id };
  for (const key of Object.keys(patch) as Array<keyof RowPatch>) {
    if (key === "id" || !PATCHABLE.includes(key as keyof FmeaRowPatch)) continue;
    (before as Record<string, unknown>)[key] = (row as Record<string, unknown>)[key] ?? null;
  }
  return before;
}

export function useFmeaRows(worksheetId: string | null) {
  const [rows, setRows] = useState<FmeaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const undoStack = useRef<RowPatch[][]>([]);
  const redoStack = useRef<RowPatch[][]>([]);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  const reload = useCallback(async () => {
    if (!worksheetId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      setRows(await api.listWorksheetRows(worksheetId));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the rows.");
    } finally {
      setLoading(false);
    }
  }, [worksheetId]);

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setHistory({ undo: 0, redo: 0 });
    void reload();
  }, [reload]);

  /** Apply patches optimistically, save them, and record the inverse for undo. */
  const applyPatches = useCallback(
    async (patches: RowPatch[], record = true) => {
      if (!worksheetId || patches.length === 0) return;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const inverses = patches.map((patch) => inverse(byId.get(patch.id)!, patch)).filter((patch) => byId.has(patch.id));
      setRows((current) =>
        current.map((row) => {
          const patch = patches.find((entry) => entry.id === row.id);
          if (!patch) return row;
          const next = { ...row, ...patch } as FmeaRow;
          next.rpn = next.severity != null && next.occurrence != null && next.detection != null ? next.severity * next.occurrence * next.detection : null;
          return next;
        })
      );
      try {
        const saved = await api.bulkUpdateRows(worksheetId, patches);
        setRows((current) => current.map((row) => saved.find((entry) => entry.id === row.id) ?? row));
        if (record) {
          undoStack.current.push(inverses);
          if (undoStack.current.length > 100) undoStack.current.shift();
          redoStack.current = [];
          setHistory({ undo: undoStack.current.length, redo: 0 });
        }
        setError("");
      } catch (caught) {
        // Roll back the optimistic change.
        setRows((current) => current.map((row) => byId.get(row.id) ?? row));
        setError(caught instanceof Error ? caught.message : "Could not save the change.");
      }
    },
    [rows, worksheetId]
  );

  const undo = useCallback(async () => {
    const patches = undoStack.current.pop();
    if (!patches) return;
    const byId = new Map(rows.map((row) => [row.id, row]));
    redoStack.current.push(patches.map((patch) => inverse(byId.get(patch.id)!, patch)));
    await applyPatches(patches, false);
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyPatches, rows]);

  const redo = useCallback(async () => {
    const patches = redoStack.current.pop();
    if (!patches) return;
    const byId = new Map(rows.map((row) => [row.id, row]));
    undoStack.current.push(patches.map((patch) => inverse(byId.get(patch.id)!, patch)));
    await applyPatches(patches, false);
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyPatches, rows]);

  const replaceRow = useCallback((row: FmeaRow) => {
    setRows((current) => (current.some((entry) => entry.id === row.id) ? current.map((entry) => (entry.id === row.id ? row : entry)) : [...current, row]));
  }, []);

  const removeRow = useCallback((rowId: string) => {
    setRows((current) => current.filter((entry) => entry.id !== rowId));
  }, []);

  return {
    rows,
    loading,
    error,
    setError,
    reload,
    applyPatches,
    undo,
    redo,
    canUndo: history.undo > 0,
    canRedo: history.redo > 0,
    replaceRow,
    removeRow
  };
}

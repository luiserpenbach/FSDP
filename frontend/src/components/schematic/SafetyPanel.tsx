/**
 * Safety panel in the Drafting inspector: for the selected item, its FMEA
 * rows, hazards, and controlling requirements; for the sheet, the isolable
 * volumes with hazards. "Add failure mode" drops a row into the drawing's
 * draft worksheet.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import type { FmeaRow, FmeaWorksheet, Hazard, SheetOverlay } from "../../types";
import { StatusPill } from "../ui";

export function SafetyPanel({
  projectId,
  drawingId,
  sheetId,
  itemId,
  itemTag,
  overlay,
  canWrite,
  onLocate,
  notify
}: {
  projectId: string;
  drawingId: string;
  sheetId: string;
  itemId: string | null;
  itemTag: string | null;
  overlay: SheetOverlay | null;
  canWrite: boolean;
  onLocate: (itemId: string) => void;
  notify: (text: string, isError?: boolean) => void;
}) {
  const [worksheets, setWorksheets] = useState<FmeaWorksheet[]>([]);
  const [rows, setRows] = useState<FmeaRow[]>([]);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sheets, projectHazards] = await Promise.all([api.listWorksheets(projectId), api.listHazards(projectId)]);
      const forDrawing = sheets.filter((sheet) => sheet.drawing_id === drawingId);
      setWorksheets(forDrawing);
      setHazards(projectHazards);
      if (itemId && forDrawing.length) {
        const lists = await Promise.all(forDrawing.map((sheet) => api.listWorksheetRows(sheet.id)));
        setRows(lists.flat().filter((row) => row.sheet_id === sheetId && row.item_id === itemId));
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    }
  }, [projectId, drawingId, sheetId, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const entry = overlay?.items.find((candidate) => candidate.item_id === itemId) ?? null;
  const itemHazards = hazards.filter((hazard) => entry?.hazard_keys.includes(hazard.key));
  const volumeHazards = (overlay?.volumes ?? []).filter((volume) => volume.hazard_keys.length);

  async function addFailureMode() {
    if (!itemId || !canWrite) return;
    setBusy(true);
    try {
      let worksheet = worksheets.find((sheet) => sheet.status !== "released") ?? worksheets[0];
      if (!worksheet) {
        worksheet = await api.createWorksheet(projectId, { title: `FMEA ${itemTag ?? ""}`.trim(), drawing_id: drawingId });
      }
      await api.createWorksheetRow(worksheet.id, { sheet_id: sheetId, item_id: itemId, failure_mode_text: "New failure mode", detection_kind: "none" });
      notify(`Added a row for ${itemTag ?? itemId} to ${worksheet.title}. Open the Safety page to rate it.`);
      await load();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Could not add the row.", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel safetyPanel" aria-label="Safety">
      <div className="panelHead">
        <h2>Safety</h2>
        <Link to="/safety" className="linkButton">
          Open Safety page
        </Link>
      </div>
      {itemId ? (
        <>
          <p className="hint">
            <span className="mono">{itemTag ?? itemId}</span>
            {entry ? ` · ${entry.open_rows} FMEA row(s)${entry.stale_rows ? `, ${entry.stale_rows} stale` : ""}${entry.max_rpn ? `, max RPN ${entry.max_rpn}` : ""}` : " · no FMEA rows or hazards yet"}
          </p>
          {rows.length > 0 && (
            <ul className="controlList">
              {rows.map((row) => (
                <li key={row.id}>
                  <span className="mono">{row.failure_mode_title ?? row.failure_mode_text ?? "mode"}</span>
                  <span className="controlTitle">{row.local_effect}</span>
                  <span className={`mono${(row.rpn ?? 0) >= 100 ? " overThreshold" : ""}`}>{row.rpn ?? "—"}</span>
                  {row.stale_reason ? <span className="pill pill-warn">stale</span> : <span />}
                </li>
              ))}
            </ul>
          )}
          {itemHazards.length > 0 && (
            <ul className="controlList">
              {itemHazards.map((hazard) => (
                <li key={hazard.id}>
                  <span className="mono">{hazard.key}</span>
                  <span className="controlTitle">
                    {hazard.title}
                    <span className="hint"> · controls {hazard.controls.map((control) => control.label).join(", ") || "none"}</span>
                  </span>
                  <StatusPill value={hazard.computed_status} />
                  <span />
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <div className="buttonRow compact">
              <button type="button" disabled={busy} onClick={() => void addFailureMode()}>
                Add failure mode
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="hint">Select an item to see its failure modes, hazards, and controls.</p>
      )}
      {volumeHazards.length > 0 && (
        <>
          <h3 className="panelSub">Volumes with hazards</h3>
          <ul className="controlList">
            {volumeHazards.map((volume) => (
              <li key={volume.key}>
                <span className={`pill risk-${volume.highest_risk ?? "low"}`}>{volume.highest_risk ?? "—"}</span>
                <span className="controlTitle">{volume.hazard_keys.join(", ")}</span>
                <span className="hint">{volume.relieved ? "relieved" : "no relief"}</span>
                <button type="button" className="linkButton" onClick={() => volume.line_ids[0] && onLocate(volume.line_ids[0])}>
                  Go
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

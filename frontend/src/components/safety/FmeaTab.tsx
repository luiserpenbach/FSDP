/**
 * FMEA tab of the Safety page: worksheet list, create and generate dialogs,
 * the grid with its toolbar, a row drawer (controls, comments, actions),
 * and release / diff / export.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import type { Drawing, FmeaComment, FmeaDiff, FmeaGate, FmeaRelease, FmeaRow, FmeaWorksheet, Hazard, Requirement, SafetySettings } from "../../types";
import { FormError, Panel, StatusPill } from "../ui";
import { FmeaGrid, type GridFilter } from "./FmeaGrid";
import { RefPicker } from "./RefPicker";
import { useFmeaRows } from "./useFmeaRows";

const CATEGORIES = ["valve", "regulator", "inline", "instrument", "equipment"];

function humanize(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

export function FmeaTab({
  projectId,
  drawings,
  hazards,
  requirements,
  settings,
  canWrite,
  onHazardsChanged
}: {
  projectId: string;
  drawings: Drawing[];
  hazards: Hazard[];
  requirements: Requirement[];
  settings: SafetySettings;
  canWrite: boolean;
  onHazardsChanged: () => void;
}) {
  const navigate = useNavigate();
  const [worksheets, setWorksheets] = useState<FmeaWorksheet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter] = useState<GridFilter>("all");
  const [openRow, setOpenRow] = useState<FmeaRow | null>(null);
  const [gate, setGate] = useState<FmeaGate | null>(null);
  const [releases, setReleases] = useState<FmeaRelease[]>([]);
  const [diff, setDiff] = useState<FmeaDiff | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rowsState = useFmeaRows(selectedId);

  const selected = worksheets.find((entry) => entry.id === selectedId) ?? null;

  const reloadWorksheets = useCallback(async () => {
    try {
      const list = await api.listWorksheets(projectId);
      setWorksheets(list);
      setSelectedId((current) => (current && list.some((entry) => entry.id === current) ? current : list[0]?.id ?? null));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load worksheets.");
    }
  }, [projectId]);

  useEffect(() => {
    void reloadWorksheets();
  }, [reloadWorksheets]);

  const refreshMeta = useCallback(async () => {
    if (!selectedId) {
      setGate(null);
      setReleases([]);
      return;
    }
    try {
      const [nextGate, nextReleases, sheet] = await Promise.all([api.getWorksheetGate(selectedId), api.listWorksheetReleases(selectedId), api.getWorksheet(selectedId)]);
      setGate(nextGate);
      setReleases(nextReleases);
      setWorksheets((current) => current.map((entry) => (entry.id === sheet.id ? sheet : entry)));
    } catch {
      /* the grid still works without the gate */
    }
  }, [selectedId]);

  useEffect(() => {
    setDiff(null);
    setOpenRow(null);
    void refreshMeta();
  }, [refreshMeta, rowsState.rows]);

  async function run<T>(action: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function rowAction(row: FmeaRow, action: "locate" | "delete" | "duplicate" | "not_applicable" | "confirm") {
    if (action === "locate") {
      if (!row.drawing_id || !row.sheet_id || !row.item_id) return;
      navigate(`/drafting?drawing=${row.drawing_id}&sheet=${row.sheet_id}&item=${encodeURIComponent(row.item_id)}`);
      return;
    }
    if (action === "delete") {
      if (!window.confirm("Delete this row?")) return;
      const done = await run(async () => {
        await api.deleteWorksheetRow(row.id);
        return true;
      }, "Could not delete the row.");
      if (done) rowsState.removeRow(row.id);
      return;
    }
    if (action === "duplicate" && selectedId) {
      const created = await run(
        () =>
          api.createWorksheetRow(selectedId, {
            sheet_id: row.sheet_id,
            item_id: row.item_id,
            subject_text: row.subject_text,
            failure_mode_id: row.failure_mode_id,
            failure_mode_text: row.failure_mode_text,
            operating_modes: [],
            cause: row.cause,
            local_effect: row.local_effect,
            next_effect: row.next_effect,
            end_effect: row.end_effect,
            detected_by_item_id: row.detected_by_item_id,
            detection_kind: row.detection_kind,
            severity: row.severity
          }),
        "Could not duplicate the row."
      );
      if (created) rowsState.replaceRow(created);
      return;
    }
    if (action === "not_applicable") {
      await rowsState.applyPatches([{ id: row.id, not_applicable: !row.not_applicable }]);
      return;
    }
    if (action === "confirm") {
      const confirmed = await run(() => api.confirmRow(row.id), "Could not confirm the row.");
      if (confirmed) rowsState.replaceRow(confirmed);
    }
  }

  async function confirmAll() {
    if (!selectedId) return;
    const done = await run(() => api.confirmAllRows(selectedId), "Could not confirm the rows.");
    if (done) {
      await rowsState.reload();
      await reloadWorksheets();
    }
  }

  async function releaseNow() {
    if (!selectedId) return;
    const note = window.prompt("Release note (optional)") ?? "";
    const released = await run(() => api.releaseWorksheet(selectedId, note || undefined), "Could not release the worksheet.");
    if (released) {
      await reloadWorksheets();
      await refreshMeta();
    }
  }

  async function showDiff() {
    if (!selectedId) return;
    const result = await run(() => api.getWorksheetDiff(selectedId), "No release to compare against.");
    if (result) setDiff(result);
  }

  async function download(format: "xlsx" | "csv" | "pdf") {
    if (!selectedId) return;
    const result = await run(() => api.downloadWorksheet(selectedId, format), "Could not export.");
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function addManualRow() {
    if (!selectedId) return;
    const subject = window.prompt("Subject of the row (procedure, operator, environment…)");
    if (!subject) return;
    const created = await run(() => api.createWorksheetRow(selectedId, { subject_text: subject, failure_mode_text: "New failure mode", detection_kind: "none" }), "Could not add the row.");
    if (created) rowsState.replaceRow(created);
  }

  const drawing = drawings.find((entry) => entry.id === selected?.drawing_id) ?? null;
  const counts = useMemo(() => {
    const rows = rowsState.rows;
    return {
      stale: rows.filter((row) => row.stale_reason).length,
      over: rows.filter((row) => (row.rpn ?? 0) >= settings.rpn_threshold && !row.not_applicable).length,
      missing: rows.filter((row) => row.detection_kind === "none" && !row.detection_reason).length,
      actions: rows.filter((row) => row.action_status === "open" || row.action_status === "in_progress").length
    };
  }, [rowsState.rows, settings.rpn_threshold]);

  return (
    <section className="fmeaTab">
      <div className="fmeaHeader">
        <label className="worksheetPicker">
          Worksheet
          <select value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value || null)} aria-label="Worksheet">
            {worksheets.length === 0 && <option value="">No worksheets yet</option>}
            {worksheets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title} · rev {entry.revision} · {entry.status}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <span className="hint fmeaMeta">
            {selected.drawing_number ? (
              <>
                generated against <span className="mono">{selected.drawing_number}</span> rev {selected.drawing_revision_label ?? "-"}
                {selected.revision_drift ? <span className="pill pill-warn"> drawing now rev {selected.drawing_current_revision_label}</span> : null}
              </>
            ) : (
              "no drawing"
            )}
            {" · "}
            {selected.row_count} rows · <StatusPill value={selected.status} />
          </span>
        )}
        <span className="buttonRow compact fmeaActions">
          {canWrite && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              New worksheet
            </button>
          )}
          {canWrite && selected && (
            <button type="button" onClick={() => setGenerating(true)}>
              Generate rows…
            </button>
          )}
          {canWrite && selected && (
            <button type="button" onClick={() => void addManualRow()}>
              Add row
            </button>
          )}
          {selected && (
            <>
              <button type="button" onClick={() => void download("xlsx")}>
                XLSX
              </button>
              <button type="button" onClick={() => void download("pdf")}>
                PDF
              </button>
            </>
          )}
          {canWrite && selected && (
            <button type="button" className="danger" onClick={() => void run(async () => {
              if (!window.confirm(`Delete worksheet "${selected.title}"?`)) return;
              await api.deleteWorksheet(selected.id);
              setSelectedId(null);
              await reloadWorksheets();
            }, "Could not delete the worksheet.")}>
              Delete
            </button>
          )}
        </span>
      </div>
      <FormError message={error || rowsState.error} />

      {selected && (
        <>
          {counts.stale > 0 && (
            <div className="banner">
              <span>
                <b>{counts.stale} stale row{counts.stale === 1 ? "" : "s"}.</b> {rowsState.rows.find((row) => row.stale_detail)?.stale_detail ?? "The drawing changed under these rows."}
              </span>
              <span className="buttonRow compact" style={{ marginLeft: "auto" }}>
                <button type="button" onClick={() => setFilter("stale")}>
                  Reassess
                </button>
                {canWrite && (
                  <button type="button" className="primary" disabled={busy} onClick={() => void confirmAll()}>
                    Confirm all
                  </button>
                )}
              </span>
            </div>
          )}
          <div className="filterRow gridToolbar">
            <span className="segmented" role="group" aria-label="Filter rows">
              {(
                [
                  ["all", `All ${rowsState.rows.length}`],
                  ["stale", `Stale ${counts.stale}`],
                  ["above_threshold", `RPN ≥ ${settings.rpn_threshold}: ${counts.over}`],
                  ["missing_detection", `No detection ${counts.missing}`],
                  ["open_actions", `Open actions ${counts.actions}`]
                ] as Array<[GridFilter, string]>
              ).map(([value, label]) => (
                <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </span>
            <span className="buttonRow compact">
              <button type="button" disabled={!rowsState.canUndo} onClick={() => void rowsState.undo()}>
                Undo
              </button>
              <button type="button" disabled={!rowsState.canRedo} onClick={() => void rowsState.redo()}>
                Redo
              </button>
              <button type="button" onClick={() => void showDiff()} disabled={releases.length === 0}>
                Diff vs release
              </button>
              {canWrite && (
                <button type="button" className="primary" disabled={busy || !gate?.ready} title={gate && !gate.ready ? `${gate.blockers.length} blocker(s)` : undefined} onClick={() => void releaseNow()}>
                  Release rev {(selected.revision ?? 0) + 1}
                </button>
              )}
            </span>
          </div>
          {gate && !gate.ready && (
            <details className="gateList">
              <summary>{gate.blockers.length === 1 ? "1 thing blocks release" : `${gate.blockers.length} things block release`}</summary>
              <ul>
                {gate.blockers.slice(0, 30).map((blocker, index) => (
                  <li key={`${blocker.row_id}-${index}`}>
                    <span className="mono">{blocker.item}</span> · {blocker.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {diff && (
            <Panel title={`Diff against release ${diff.against_revision}`} actions={<button type="button" onClick={() => setDiff(null)}>Close</button>}>
              <p className="hint">
                {diff.added.length} added · {diff.removed.length} removed · {diff.changed.length} changed
              </p>
              <ul className="attentionList">
                {diff.changed.map((entry, index) => (
                  <li key={index}>
                    <span className="mono">{entry.item_tag ?? "—"}</span> {entry.failure_mode_title}:{" "}
                    {Object.entries(entry.fields)
                      .map(([field, change]) => `${humanize(field)} ${String(change.from ?? "—")} → ${String(change.to ?? "—")}`)
                      .join("; ")}
                  </li>
                ))}
                {diff.added.map((entry, index) => (
                  <li key={`a${index}`}>
                    <span className="pill pill-good">added</span> <span className="mono">{String(entry.item_tag ?? "")}</span> {String(entry.failure_mode_title ?? "")}
                  </li>
                ))}
                {diff.removed.map((entry, index) => (
                  <li key={`r${index}`}>
                    <span className="pill pill-bad">removed</span> <span className="mono">{String(entry.item_tag ?? "")}</span> {String(entry.failure_mode_title ?? "")}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <div className={`safetyLayout${openRow ? " withDrawer" : ""}`}>
            <FmeaGrid
              projectId={projectId}
              drawingId={selected.drawing_id}
              rows={rowsState.rows}
              settings={settings}
              hazards={hazards}
              canWrite={canWrite}
              filter={filter}
              onPatch={rowsState.applyPatches}
              onUndo={rowsState.undo}
              onRedo={rowsState.redo}
              onRowAction={(row, action) => void rowAction(row, action)}
              onOpenRow={setOpenRow}
            />
            {openRow && (
              <RowDrawer
                row={rowsState.rows.find((entry) => entry.id === openRow.id) ?? openRow}
                projectId={projectId}
                requirements={requirements}
                canWrite={canWrite}
                onChanged={(row) => rowsState.replaceRow(row)}
                onAction={(action) => void rowAction(openRow, action)}
                onClose={() => setOpenRow(null)}
                onHazardsChanged={onHazardsChanged}
              />
            )}
          </div>
          {releases.length > 0 && (
            <p className="hint">
              Releases: {releases.map((entry) => `rev ${entry.revision} (${entry.drawing_revision_label ? `drawing ${entry.drawing_revision_label}, ` : ""}${entry.row_count} rows, ${entry.released_by ?? "—"})`).join(" · ")}
            </p>
          )}
        </>
      )}
      {!selected && worksheets.length === 0 && <p className="hint">Create a worksheet for a drawing, then generate rows from its saved sheets.</p>}

      {creating && (
        <WorksheetDialog
          drawings={drawings}
          settings={settings}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            const created = await run(() => api.createWorksheet(projectId, body), "Could not create the worksheet.");
            if (created) {
              setCreating(false);
              await reloadWorksheets();
              setSelectedId(created.id);
            }
          }}
        />
      )}
      {generating && selected && (
        <GenerateDialog
          worksheet={selected}
          drawing={drawing}
          drawings={drawings}
          settings={settings}
          onClose={() => setGenerating(false)}
          onGenerate={async (body) => {
            const result = await run(() => api.generateWorksheet(selected.id, body), "Could not generate rows.");
            if (result) {
              setGenerating(false);
              await rowsState.reload();
              await reloadWorksheets();
              window.setTimeout(() => setError(result.items_without_modes.length ? `Generated ${result.added} rows (${result.kept} kept). No library modes for: ${result.items_without_modes.join(", ")}` : ""), 0);
            }
          }}
        />
      )}
    </section>
  );
}

function WorksheetDialog({ drawings, settings, onClose, onCreate }: { drawings: Drawing[]; settings: SafetySettings; onClose: () => void; onCreate: (body: { title: string; drawing_id: string | null; operating_modes: string[] }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [drawingId, setDrawingId] = useState(drawings[0]?.id ?? "");
  const [modes, setModes] = useState<string[]>(settings.operating_modes);
  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-label="New worksheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void onCreate({ title: title.trim(), drawing_id: drawingId || null, operating_modes: modes });
        }}
      >
        <h2>New FMEA worksheet</h2>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="LOX fill and drain" />
        </label>
        <label>
          Drawing
          <select value={drawingId} onChange={(event) => setDrawingId(event.target.value)}>
            <option value="">None yet</option>
            {drawings.map((drawing) => (
              <option key={drawing.id} value={drawing.id}>
                {drawing.number} · {drawing.title.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="modeSet">
          <legend>Operating modes in scope</legend>
          <div className="modeChips">
            {settings.operating_modes.map((mode) => (
              <label key={mode} className={`chip${modes.includes(mode) ? " active" : ""}`}>
                <input type="checkbox" checked={modes.includes(mode)} onChange={(event) => setModes(event.target.checked ? settings.operating_modes.filter((entry) => entry === mode || modes.includes(entry)) : modes.filter((entry) => entry !== mode))} />
                {humanize(mode)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!title.trim()}>
            Create worksheet
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function GenerateDialog({ worksheet, drawing, drawings, settings, onClose, onGenerate }: { worksheet: FmeaWorksheet; drawing: Drawing | null; drawings: Drawing[]; settings: SafetySettings; onClose: () => void; onGenerate: (body: { drawing_id: string | null; categories: string[]; operating_modes: string[] }) => Promise<void> }) {
  const [drawingId, setDrawingId] = useState(drawing?.id ?? drawings[0]?.id ?? "");
  const [categories, setCategories] = useState<string[]>(CATEGORIES);
  const [modes, setModes] = useState<string[]>(worksheet.operating_modes ?? settings.operating_modes);
  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-label="Generate rows"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void onGenerate({ drawing_id: drawingId || null, categories, operating_modes: modes });
        }}
      >
        <h2>Generate rows from a drawing</h2>
        <p className="hint">One row per item and applicable failure mode from the library. Existing rows are kept, so you can re-run after the drawing changes.</p>
        <label>
          Drawing
          <select value={drawingId} onChange={(event) => setDrawingId(event.target.value)} disabled={Boolean(worksheet.drawing_id)}>
            {drawings.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.number} · {entry.title.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="modeSet">
          <legend>Item categories</legend>
          <div className="modeChips">
            {CATEGORIES.map((category) => (
              <label key={category} className={`chip${categories.includes(category) ? " active" : ""}`}>
                <input type="checkbox" checked={categories.includes(category)} onChange={(event) => setCategories(event.target.checked ? [...categories, category] : categories.filter((entry) => entry !== category))} />
                {category}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="modeSet">
          <legend>Operating modes</legend>
          <div className="modeChips">
            {settings.operating_modes.map((mode) => (
              <label key={mode} className={`chip${modes.includes(mode) ? " active" : ""}`}>
                <input type="checkbox" checked={modes.includes(mode)} onChange={(event) => setModes(event.target.checked ? settings.operating_modes.filter((entry) => entry === mode || modes.includes(entry)) : modes.filter((entry) => entry !== mode))} />
                {humanize(mode)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!drawingId || categories.length === 0}>
            Generate
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function RowDrawer({ row, projectId, requirements, canWrite, onChanged, onAction, onClose, onHazardsChanged }: { row: FmeaRow; projectId: string; requirements: Requirement[]; canWrite: boolean; onChanged: (row: FmeaRow) => void; onAction: (action: "locate" | "delete" | "duplicate" | "not_applicable" | "confirm") => void; onClose: () => void; onHazardsChanged: () => void }) {
  const [comments, setComments] = useState<FmeaComment[]>([]);
  const [draft, setDraft] = useState("");
  const [controlPicker, setControlPicker] = useState<"requirement" | "sheet_item" | null>(null);
  const [detectionReason, setDetectionReason] = useState(row.detection_reason ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    setDetectionReason(row.detection_reason ?? "");
    void api.listRowComments(row.id).then(setComments).catch(() => setComments([]));
  }, [row.id, row.detection_reason]);

  async function guard<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      setError("");
      return await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      return undefined;
    }
  }

  const search = useMemo(
    () => ({
      requirement: async (query: string) => {
        const q = query.trim().toLowerCase();
        return requirements.filter((entry) => !q || entry.key.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)).map((entry) => ({ id: entry.id, label: entry.key, detail: entry.title }));
      },
      sheet_item: async (query: string) => {
        const items = await api.listSheetItems(projectId, { q: query, limit: 30 });
        return items.map((item) => ({ id: item.id, label: item.tag ?? item.item_id, detail: `${item.symbol_name ?? ""} · ${item.drawing_number} sheet ${item.sheet_no}` }));
      }
    }),
    [projectId, requirements]
  );

  return (
    <aside className="drawer rowDrawer" aria-label={`Row ${row.item_tag ?? row.subject_text ?? ""}`}>
      <div className="drawerHead">
        <div>
          <span className="mono">{row.item_tag ?? row.subject_text ?? "Row"}</span> <span className="hint">{row.failure_mode_title ?? row.failure_mode_text}</span>
        </div>
        <button type="button" className="drawerClose" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {row.stale_reason && (
        <p className="formError">
          Stale: {row.stale_detail ?? row.stale_reason}
          {canWrite && (
            <>
              {" "}
              <button type="button" className="linkButton" onClick={() => onAction("confirm")}>
                Confirm and clear
              </button>
            </>
          )}
        </p>
      )}
      <div className="buttonRow compact">
        <button type="button" disabled={!row.item_id} onClick={() => onAction("locate")}>
          Locate on sheet
        </button>
        {canWrite && (
          <>
            <button type="button" onClick={() => onAction("duplicate")}>
              Duplicate for another mode
            </button>
            <button type="button" onClick={() => onAction("not_applicable")}>
              {row.not_applicable ? "Mark applicable" : "Mark not applicable"}
            </button>
            <button type="button" className="danger" onClick={() => onAction("delete")}>
              Delete row
            </button>
          </>
        )}
      </div>
      <FormError message={error} />

      {row.detection_kind === "none" && (
        <section className="drawerSection">
          <h3>No detection</h3>
          <label>
            Why is that acceptable?
            <textarea rows={2} value={detectionReason} disabled={!canWrite} onChange={(event) => setDetectionReason(event.target.value)} onBlur={() => void guard(async () => onChanged(await api.updateWorksheetRow(row.id, { detection_reason: detectionReason || null })))} />
          </label>
        </section>
      )}

      <section className="drawerSection">
        <h3>Existing controls</h3>
        {row.controls.length === 0 ? <p className="hint">No controls linked. Link the requirement or the hardware that keeps this failure from mattering.</p> : (
          <ul className="controlList">
            {row.controls.map((control) => (
              <li key={control.link_id}>
                <span className="mono">{control.label}</span>
                <span className="hint controlTitle">{control.type === "requirement" ? "requirement" : "hardware item"}</span>
                <span />
                {canWrite ? (
                  <button type="button" className="linkButton" onClick={() => void guard(async () => onChanged(await api.removeRowControl(row.id, control.link_id)))}>
                    Remove
                  </button>
                ) : <span />}
              </li>
            ))}
          </ul>
        )}
        {canWrite && !controlPicker && (
          <div className="buttonRow compact">
            <button type="button" onClick={() => setControlPicker("requirement")}>
              Link requirement
            </button>
            <button type="button" onClick={() => setControlPicker("sheet_item")}>
              Link hardware item
            </button>
          </div>
        )}
        {controlPicker && (
          <RefPicker
            label={controlPicker === "requirement" ? "Requirement" : "Hardware item"}
            allowNone={false}
            search={search[controlPicker]}
            onPick={(option) => {
              const kind = controlPicker;
              setControlPicker(null);
              if (option) void guard(async () => onChanged(await api.addRowControl(row.id, { type: kind, id: option.id })));
              onHazardsChanged();
            }}
            onClose={() => setControlPicker(null)}
          />
        )}
      </section>

      <section className="drawerSection">
        <h3>Comments</h3>
        {comments.length === 0 ? <p className="hint">No comments.</p> : (
          <ul className="historyList">
            {comments.map((comment) => (
              <li key={comment.id} className={comment.resolved ? "resolved" : ""}>
                <span className="hint">{comment.author ?? "—"} · {new Date(comment.created_at).toLocaleString()}</span> {comment.body}{" "}
                {canWrite && !comment.resolved && (
                  <button type="button" className="linkButton" onClick={() => void guard(async () => {
                    await api.updateRowComment(comment.id, { resolved: true });
                    setComments(await api.listRowComments(row.id));
                    onChanged({ ...row, open_comment_count: Math.max(0, row.open_comment_count - 1) });
                  })}>
                    Resolve
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form
            className="drawerForm"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              void guard(async () => {
                await api.addRowComment(row.id, draft.trim());
                setDraft("");
                setComments(await api.listRowComments(row.id));
                onChanged({ ...row, comment_count: row.comment_count + 1, open_comment_count: row.open_comment_count + 1 });
              });
            }}
          >
            <label>
              Add a comment
              <textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} />
            </label>
            <div className="buttonRow">
              <button type="submit" disabled={!draft.trim()}>
                Comment
              </button>
            </div>
          </form>
        )}
      </section>
    </aside>
  );
}

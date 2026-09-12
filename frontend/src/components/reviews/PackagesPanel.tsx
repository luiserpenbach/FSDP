/**
 * Safety review packages on the Reviews page: pick the drawings and
 * worksheets to cover, generate, and download the PDF or XLSX of earlier
 * packages. The server renders the package, so it works without the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { Drawing, FmeaWorksheet, SafetyPackage } from "../../types";
import { FormError, Panel } from "../ui";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PackagesPanel({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const [packages, setPackages] = useState<SafetyPackage[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [worksheets, setWorksheets] = useState<FmeaWorksheet[]>([]);
  const [title, setTitle] = useState("");
  const [drawingIds, setDrawingIds] = useState<string[]>([]);
  const [worksheetIds, setWorksheetIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [list, drawingList, worksheetList] = await Promise.all([api.listPackages(projectId), api.listDrawings(projectId), api.listWorksheets(projectId)]);
      setPackages(list);
      setDrawings(drawingList);
      setWorksheets(worksheetList);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the packages.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(list: string[], id: string, set: (next: string[]) => void) {
    set(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  }

  async function generate() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const started = performance.now();
      const created = await api.createPackage(projectId, {
        title: title.trim() || null,
        drawing_ids: drawingIds.length ? drawingIds : null,
        worksheet_ids: worksheetIds.length ? worksheetIds : null
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      setStatus(`Generated ${created.title} in ${seconds} s: ${created.summary?.hazards ?? 0} hazards, ${created.summary?.fmea_rows ?? 0} FMEA rows, ${created.summary?.actions ?? 0} open actions.`);
      setTitle("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate the package.");
    } finally {
      setBusy(false);
    }
  }

  async function download(pkg: SafetyPackage, kind: "pdf" | "xlsx") {
    try {
      const result = await api.downloadPackage(pkg, kind);
      saveBlob(result.blob, result.filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not download the package.");
    }
  }

  async function remove(pkg: SafetyPackage) {
    if (!window.confirm(`Delete "${pkg.title}"? Its files are removed.`)) return;
    try {
      await api.deletePackage(pkg.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the package.");
    }
  }

  if (!projectId) {
    return (
      <Panel title="Safety Review Packages">
        <p className="hint">Select a project to generate review packages.</p>
      </Panel>
    );
  }

  return (
    <Panel title="Safety Review Packages">
      <p className="hint">
        One PDF and one XLSX: hazard log, risk matrices, FMEA rows by RPN, verification matrix, open actions, design rule findings and waivers, and the change log since the previous package.
      </p>
      {canWrite && (
        <div className="packageForm">
          <label>
            Title (optional)
            <input value={title} placeholder="PDR safety package" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="fieldRow">
            <fieldset className="checkList">
              <legend>Drawings ({drawingIds.length ? drawingIds.length : "all"})</legend>
              {drawings.map((drawing) => (
                <label key={drawing.id} className="checkRow">
                  <input type="checkbox" checked={drawingIds.includes(drawing.id)} onChange={() => toggle(drawingIds, drawing.id, setDrawingIds)} />
                  <span>
                    <span className="mono">{drawing.number}</span> {drawing.title}
                  </span>
                </label>
              ))}
              {drawings.length === 0 && <span className="hint">No drawings yet.</span>}
            </fieldset>
            <fieldset className="checkList">
              <legend>Worksheets ({worksheetIds.length ? worksheetIds.length : "all"})</legend>
              {worksheets.map((worksheet) => (
                <label key={worksheet.id} className="checkRow">
                  <input type="checkbox" checked={worksheetIds.includes(worksheet.id)} onChange={() => toggle(worksheetIds, worksheet.id, setWorksheetIds)} />
                  <span>
                    {worksheet.title} <span className="hint">rev {worksheet.revision} · {worksheet.status}</span>
                  </span>
                </label>
              ))}
              {worksheets.length === 0 && <span className="hint">No FMEA worksheets yet.</span>}
            </fieldset>
          </div>
          <div className="buttonRow">
            <button type="button" className="primary" disabled={busy} onClick={() => void generate()}>
              {busy ? "Generating…" : "Generate package"}
            </button>
          </div>
        </div>
      )}
      <FormError message={error} />
      {status && <p className="hint">{status}</p>}
      {packages.length === 0 ? (
        <p className="hint">No packages yet.</p>
      ) : (
        <ul className="packageList">
          {packages.map((pkg) => (
            <li key={pkg.id}>
              <div>
                <strong>{pkg.title}</strong>
                <span className="hint">
                  {" "}
                  · {pkg.generated_at ? new Date(pkg.generated_at).toLocaleString() : "—"} by {pkg.generated_by ?? "—"}
                  {pkg.scope ? ` · ${pkg.scope.drawings.length} drawing(s), ${pkg.scope.worksheets.length} worksheet(s)` : ""}
                </span>
                {pkg.summary && (
                  <p className="hint">
                    {pkg.summary.hazards} hazards ({pkg.summary.hazards_high_open} severity I–II not accepted) · {pkg.summary.fmea_rows} FMEA rows ({pkg.summary.fmea_over_threshold} at or above RPN {pkg.summary.rpn_threshold}) · {pkg.summary.requirements_verified}/{pkg.summary.requirements_safety} safety requirements verified · {pkg.summary.actions} open actions · {pkg.summary.changes} changes since previous
                  </p>
                )}
              </div>
              <div className="buttonRow compact">
                <button type="button" onClick={() => void download(pkg, "pdf")}>
                  PDF
                </button>
                <button type="button" onClick={() => void download(pkg, "xlsx")}>
                  XLSX
                </button>
                {canWrite && (
                  <button type="button" className="danger" onClick={() => void remove(pkg)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

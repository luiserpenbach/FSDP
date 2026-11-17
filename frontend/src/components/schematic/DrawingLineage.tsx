import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { draftingHref } from "../../pages/draftingLinks";
import type { Drawing, Lineage, LineageDiff, LineageDrawing } from "../../types";

const FIELD_LABELS: Record<string, string> = {
  tag: "Tag",
  label: "Label",
  symbol_name: "Symbol",
  part: "Part",
  dnp: "Do not populate",
  spare: "Spares",
  line_number: "Line number",
  service: "Service",
  size: "Size",
  line_class: "Line class",
  spec: "Spec",
  design_pressure: "Design pressure",
  design_temperature: "Design temperature"
};

function describe(entry: LineageDrawing, currentProjectId: string): string {
  const revision = entry.revision ? ` rev ${entry.revision}` : "";
  const project = entry.project_id === currentProjectId ? "" : ` · ${entry.project_name}`;
  return `${entry.number}${revision}${project}`;
}

/**
 * Where a drawing came from and where it went: the source it was copied from
 * (with a comparison against it) and the copies taken of it.
 */
export function DrawingLineage({ drawing }: { drawing: Drawing }) {
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [diff, setDiff] = useState<LineageDiff | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getLineage(drawing.id)
      .then((next) => {
        if (!cancelled) setLineage(next);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [drawing.id]);

  const shown = lineage && lineage.drawing_id === drawing.id ? lineage : null;
  if (!shown || (!shown.copied_from_number && !shown.copies.length)) return null;

  async function compare() {
    setComparing(true);
    setError("");
    setDiff(null);
    try {
      setDiff(await api.getLineageDiff(drawing.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not compare with the source.");
    }
  }

  const origin = `${shown.copied_from_number}${shown.copied_from_revision ? ` rev ${shown.copied_from_revision}` : ""}`;

  return (
    <section aria-label="Lineage">
      {shown.copied_from_number && (
        <p className="lineageNote">
          Copied from{" "}
          {shown.source ? (
            <Link to={draftingHref({ projectId: shown.source.project_id, drawingId: shown.source.id })} title={shown.source.title}>
              {origin}
            </Link>
          ) : (
            <span className="mono">{origin}</span>
          )}
          {shown.source && shown.source.project_id !== drawing.project_id && ` in ${shown.source.project_name}`}
          {!shown.source && " (the source is no longer available to you)"}
          {shown.source_revision_changed && shown.source && `. The source is now at rev ${shown.source.revision ?? "-"}`}
          {shown.source && (
            <button type="button" className="linkButton" onClick={() => void compare()}>
              Compare with source
            </button>
          )}
        </p>
      )}
      {shown.copies.length > 0 && (
        <>
          <p className="lineageNote">
            <strong>Copies of this drawing</strong> · {shown.copies.length}
          </p>
          <ul className="lineageCopies">
            {shown.copies.map((entry) => (
              <li key={entry.id}>
                <Link to={draftingHref({ projectId: entry.project_id, drawingId: entry.id })} title={entry.title}>
                  {describe(entry, drawing.project_id)}
                </Link>
                <span className="hint">{entry.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {comparing && (
        <div className="modalBackdrop" role="presentation" onClick={() => setComparing(false)}>
          <div
            className="modal lineageDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lineage-diff-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setComparing(false);
            }}
          >
            <div className="modalHeader">
              <h2 id="lineage-diff-title">
                {drawing.number} compared with {shown.source?.number ?? shown.copied_from_number}
              </h2>
              <button type="button" className="modalClose" aria-label="Close" autoFocus onClick={() => setComparing(false)}>
                ×
              </button>
            </div>
            <div className="lineageBody">
              {error && <p className="formError" role="alert">{error}</p>}
              {!diff && !error && <p className="hint">Comparing…</p>}
              {diff && <LineageDiffReport diff={diff} drawing={drawing} />}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function LineageDiffReport({ diff, drawing }: { diff: LineageDiff; drawing: Drawing }) {
  const { added, removed, changed } = diff.counts;
  const sheetIds = new Map(drawing.sheets.map((sheet) => [sheet.sheet_no, sheet.id]));
  return (
    <>
      <p>
        {added + removed + changed === 0
          ? "This drawing matches its source: same tags, parts, and line data."
          : `${changed} changed, ${added} added here, ${removed} removed here, compared with the source as it stands now.`}
      </p>
      {diff.stale.length > 0 && (
        <p className="hint" role="status">
          The index is out of date for {diff.stale.join(", ")}, so rows from those sheets may be missing. Open the drawing to refresh it.
        </p>
      )}
      {(diff.sheets_added.length > 0 || diff.sheets_removed.length > 0) && (
        <p className="hint">
          {diff.sheets_added.length > 0 && `Sheets only in this drawing: ${diff.sheets_added.join(", ")}. `}
          {diff.sheets_removed.length > 0 && `Sheets only in the source: ${diff.sheets_removed.join(", ")}.`}
        </p>
      )}
      {diff.rows.length > 0 && (
        <table className="lineageTable">
          <thead>
            <tr>
              <th>Change</th>
              <th>Sheet</th>
              <th>Item</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row) => {
              const sheetId = sheetIds.get(row.sheet_no);
              return (
                <tr key={`${row.kind}:${row.sheet_no}:${row.item_id}`}>
                  <td>
                    <span className={`lineageChange lineageChange-${row.change}`}>{row.change}</span>
                  </td>
                  <td>{row.sheet_no}</td>
                  <td>
                    {row.change !== "removed" && sheetId ? (
                      <Link className="mono" to={draftingHref({ projectId: drawing.project_id, drawingId: drawing.id, sheetId, itemId: row.item_id })}>
                        {row.label}
                      </Link>
                    ) : (
                      <span className="mono">{row.label}</span>
                    )}
                    {row.description && <span className="hint"> {row.description}</span>}
                  </td>
                  <td>
                    {row.change === "changed"
                      ? row.changes.map((change) => (
                          <div key={change.field}>
                            {FIELD_LABELS[change.field] ?? change.field}: <span className="lineageWas">{change.source ?? "none"}</span> → {change.copy ?? "none"}
                          </div>
                        ))
                      : row.kind === "line"
                        ? "Line"
                        : "Item"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

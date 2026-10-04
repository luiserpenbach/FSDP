/**
 * Drawing release workflow UI for the drafting page: the status badge with the
 * actions each state allows (submit, withdraw, release, start a new revision),
 * the reasons a release was refused, the index status of the drawing's sheets,
 * the revision history with its server-stamped signatures, and a read-only view
 * of a released revision's snapshot.
 */
import { useEffect, useMemo, useState } from "react";
import { getRevisionSnapshot } from "../../api";
import type { DrawingContext } from "../../engine/frames";
import type { SymbolRegistry } from "../../engine/library";
import { renderDocumentSvg } from "../../engine/render";
import type { SchematicDocument } from "../../engine/types";
import type { DrawingRevision, DrawingStatus, ReleaseBlocker, ReleaseSnapshotSheet, RevisionSnapshot } from "../../types";
import { StatusPill } from "../ui";
import type { ReindexStatus } from "./useStaleReindex";

export const DRAWING_STATUS_LABELS: Record<DrawingStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  released: "Released"
};

/** Workflow state of a drawing; statuses from before the workflow read as draft. */
export function drawingStatusOf(status: string | null | undefined): DrawingStatus {
  return status === "in_review" || status === "released" ? status : "draft";
}

function shortDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function stamp(by: string | null | undefined, date: string | null | undefined): string {
  return [by, shortDate(date)].filter(Boolean).join(" · ");
}

export function WorkflowPanel({
  status,
  revisionLabel,
  canWrite,
  busy,
  blockers,
  onSubmit,
  onWithdraw,
  onRelease,
  onRevise,
  onBlocker,
  onReindex,
  onDismissBlockers
}: {
  status: DrawingStatus;
  revisionLabel: string;
  canWrite: boolean;
  busy: boolean;
  /** Reasons the last release attempt was refused. */
  blockers: ReleaseBlocker[];
  onSubmit: () => void;
  onWithdraw: () => void;
  onRelease: () => void;
  onRevise: (body: { label?: string; description?: string }) => void;
  onBlocker: (blocker: ReleaseBlocker) => void;
  onReindex: (sheetId: string) => void;
  onDismissBlockers: () => void;
}) {
  const [revising, setRevising] = useState(false);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  return (
    <section className="workflowPanel" aria-label="Release workflow">
      <div className="workflowState">
        <StatusPill value={status} />
        <span className="mono">rev {revisionLabel}</span>
        {canWrite && (
          <span className="workflowActions">
            {status === "draft" && (
              <button type="button" disabled={busy} onClick={onSubmit} title="Ask for review; stamps you as the submitter">
                Submit for review
              </button>
            )}
            {status === "in_review" && (
              <button type="button" disabled={busy} onClick={onWithdraw} title="Return the drawing to draft">
                Withdraw
              </button>
            )}
            {status !== "released" && (
              <button type="button" className="primary" disabled={busy} onClick={onRelease} title="Lock the drawing and stamp you as the approver">
                Release…
              </button>
            )}
            {status === "released" && !revising && (
              <button type="button" className="primary" disabled={busy} onClick={() => setRevising(true)}>
                Start new revision…
              </button>
            )}
          </span>
        )}
      </div>
      {status === "released" && revising && canWrite && (
        <form
          className="reviseForm"
          onSubmit={(event) => {
            event.preventDefault();
            onRevise({ label: label.trim() || undefined, description: description.trim() || undefined });
            setRevising(false);
            setLabel("");
            setDescription("");
          }}
        >
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Next" aria-label="New revision label" title="Blank takes the next letter" />
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" aria-label="New revision description" />
          <button type="submit" className="primary" disabled={busy}>
            Start revision
          </button>
          <button type="button" onClick={() => setRevising(false)}>
            Cancel
          </button>
        </form>
      )}
      {blockers.length > 0 && (
        <div className="releaseBlockers" role="alert">
          <div className="releaseBlockersHead">
            <strong>Release refused</strong>
            <button type="button" className="linkButton" onClick={onDismissBlockers}>
              Dismiss
            </button>
          </div>
          <ul>
            {blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.sheet_id}`}>
                <span className={blocker.code === "drc_errors" ? "pill pill-bad" : "pill pill-warn"}>{blocker.code === "drc_errors" ? "DRC" : "stale"}</span>{" "}
                <button type="button" className="linkButton blockerLink" onClick={() => onBlocker(blocker)} title={blocker.code === "drc_errors" ? "Open the sheet and its design rule check" : "Open the sheet"}>
                  {blocker.message}
                </button>
                {blocker.code === "index_stale" && canWrite && (
                  <button type="button" className="blockerAction" disabled={busy} onClick={() => onReindex(blocker.sheet_id)}>
                    Re-index now
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** "Re-indexing 2 sheets…" / "Index up to date" / which sheets are still out of date. */
export function IndexStatusNote({
  staleSheetNos,
  status,
  canReindex,
  onReindex
}: {
  staleSheetNos: number[];
  status: ReindexStatus;
  canReindex: boolean;
  onReindex: () => void;
}) {
  if (status.running) {
    return (
      <p className="indexStatus" role="status">
        <span className="pill pill-info">Re-indexing {status.remaining} sheet{status.remaining === 1 ? "" : "s"}…</span>
      </p>
    );
  }
  if (!staleSheetNos.length) {
    return (
      <p className="indexStatus" role="status">
        <span className="pill pill-good">Index up to date</span>
      </p>
    );
  }
  return (
    <p className="indexStatus" role="status">
      <span className="pill pill-warn" title="Lists, BoM, and release read the stored index; these sheets' index and DRC are out of date">
        Sheet{staleSheetNos.length === 1 ? "" : "s"} {staleSheetNos.join(", ")} out of date
      </span>
      {status.failed.length > 0 && <span className="hint"> re-index failed</span>}{" "}
      {canReindex && (
        <button type="button" className="linkButton" onClick={onReindex}>
          Re-index now
        </button>
      )}
    </p>
  );
}

/** Revision history with the drawn / submitted / approved stamps the server records. */
export function RevisionTable({ revisions, onView }: { revisions: DrawingRevision[]; onView: (revision: DrawingRevision) => void }) {
  return (
    <table className="revisionTable">
      <thead>
        <tr>
          <th>Rev</th>
          <th>Description</th>
          <th>Signatures</th>
          <th>
            <span className="srOnly">Snapshot</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {revisions.map((row) => (
          <tr key={row.id}>
            <td className="mono">{row.label}</td>
            <td>
              {row.description} <StatusPill value={drawingStatusOf(row.status)} />
            </td>
            <td className="revisionStamps">
              <span title="Drawn">D: {stamp(row.drawn_by, row.drawn_date) || "—"}</span>
              <span title="Submitted for review">S: {stamp(row.submitted_by, row.submitted_at) || "—"}</span>
              <span title="Approved (released)">A: {stamp(row.approved_by, row.approved_date ?? row.approved_at) || "—"}</span>
            </td>
            <td>
              {row.status === "released" && (
                <button type="button" className="linkButton" onClick={() => onView(row)} aria-label={`View released snapshot of revision ${row.label}`}>
                  View
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function countErrors(sheet: ReleaseSnapshotSheet): { errors: number; waived: number } {
  const waived = new Set(sheet.drc.waivers.map((waiver) => waiver.key));
  return {
    errors: sheet.drc.findings.filter((finding) => finding.severity === "error" && !waived.has(finding.key)).length,
    waived: waived.size
  };
}

function svgFor(sheet: ReleaseSnapshotSheet, registry: SymbolRegistry, context: DrawingContext | undefined): string | null {
  try {
    return renderDocumentSvg(sheet.document as unknown as SchematicDocument, registry, { standalone: true, background: "#ffffff", context });
  } catch {
    return null;
  }
}

/** Read-only view of the immutable copy stored when a revision was released. */
export function RevisionSnapshotModal({
  revision,
  registry,
  contextFor,
  onClose
}: {
  revision: DrawingRevision;
  registry: SymbolRegistry;
  /** Title block context for a snapshot sheet. */
  contextFor: (snapshot: RevisionSnapshot, sheet: ReleaseSnapshotSheet) => DrawingContext | undefined;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<RevisionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [sheetId, setSheetId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError("");
    getRevisionSnapshot(revision.id)
      .then((read) => {
        if (cancelled) return;
        setSnapshot(read);
        setSheetId(read.snapshot.sheets[0]?.id ?? "");
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the snapshot.");
      });
    return () => {
      cancelled = true;
    };
  }, [revision.id]);

  const sheet = snapshot?.snapshot.sheets.find((entry) => entry.id === sheetId) ?? null;
  const svg = useMemo(() => (snapshot && sheet ? svgFor(sheet, registry, contextFor(snapshot, sheet)) : null), [snapshot, sheet, registry, contextFor]);
  const number = snapshot?.snapshot.drawing.number ?? "";

  function downloadSvg() {
    if (!svg || !sheet) return;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${number || "drawing"}-${String(sheet.sheet_no).padStart(2, "0")}-rev${revision.label}-released.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div className="modal snapshotModal" role="dialog" aria-modal="true" aria-label={`Released revision ${revision.label}`} onClick={(event) => event.stopPropagation()}>
        <div className="modalHeader">
          <h2>
            {number ? `${number} ` : ""}rev {revision.label} · released snapshot
          </h2>
          <button type="button" className="modalClose" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="snapshotBody">
          {error && <p className="formError">{error}</p>}
          {!snapshot && !error && <p className="hint">Loading the released snapshot…</p>}
          {snapshot && (
            <>
              <p className="snapshotMeta">
                Released by <strong>{snapshot.snapshot.released_by ?? snapshot.approved_by ?? "—"}</strong> on{" "}
                <span className="mono">{shortDate(snapshot.snapshot.released_at ?? snapshot.approved_at)}</span> · read-only
              </p>
              {snapshot.snapshot.migrated && <p className="hint">Released before snapshots were kept: sheet documents only, no index rows.</p>}
              <table className="revisionTable snapshotSheets">
                <thead>
                  <tr>
                    <th>Sheet</th>
                    <th>Title</th>
                    <th>Items</th>
                    <th>Lines</th>
                    <th>DRC errors</th>
                    <th>Waived</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.snapshot.sheets.map((entry) => {
                    const counts = countErrors(entry);
                    const items = Array.isArray((entry.document as { items?: unknown[] }).items) ? (entry.document as { items: unknown[] }).items.length : 0;
                    return (
                      <tr key={entry.id} className={entry.id === sheetId ? "selectedRow" : undefined} onClick={() => setSheetId(entry.id)}>
                        <td className="mono">{entry.sheet_no}</td>
                        <td>{entry.title ?? "—"}</td>
                        <td className="mono">{items}</td>
                        <td className="mono">{entry.lines.length}</td>
                        <td className="mono">{counts.errors}</td>
                        <td className="mono">{counts.waived}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sheet && (
                <div className="snapshotPreview">
                  {svg ? (
                    <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`Sheet ${sheet.sheet_no} as released`} />
                  ) : (
                    <p className="hint">This sheet cannot be previewed.</p>
                  )}
                  <div className="toolGroup">
                    <button type="button" disabled={!svg} onClick={downloadSvg}>
                      Download SVG
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

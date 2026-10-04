/**
 * BoM & Procurement: bills of materials generated from drawings.
 *
 * Pick a drawing of the project, generate a BoM snapshot from its saved sheet
 * index, check procurement readiness, release it (refused while blocking issues
 * remain; released snapshots are immutable), compare it with another snapshot of
 * the same drawing, and export CSV or XLSX. BoMs of legacy diagrams stay
 * available read-only as history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, bomCsvUrl, bomXlsxUrl, setBomStatusChecked, WorkflowConflictError } from "../api";
import { StaleSheetsWarning } from "../components/StaleSheetsWarning";
import { SortableTable, type SortableColumn } from "../components/SortableTable";
import { Panel, StatusPill } from "../components/ui";
import type { BomDiff, BomReadiness, BomReadinessIssue, BomSnapshot, Drawing, ProjectBom } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

type BomRow = Record<string, unknown>;
type IndexedRow = { index: number; row: BomRow };

const DRAWING_KEY = "fsdp.bom.drawing";

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** The readiness issue raised for a BoM row (same part number and tags). */
function issueFor(row: BomRow, readiness: BomReadiness | null): BomReadinessIssue | undefined {
  const tags = listOf(row.component_tags).join();
  return readiness?.issues.find((issue) => (issue.part_number ?? null) === ((row.part_number as string | null | undefined) ?? null) && issue.component_tags.join() === tags);
}

const SNAPSHOT_COLUMNS: Array<SortableColumn<BomSnapshot>> = [
  { key: "revision", header: "BoM rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span>, sortValue: (snapshot) => snapshot.revision },
  { key: "drawing_revision", header: "Drawing rev", render: (snapshot) => <span className="mono">{snapshot.drawing_revision ?? "—"}</span>, sortValue: (snapshot) => snapshot.drawing_revision },
  {
    key: "status",
    header: "Status",
    render: (snapshot) => (
      <>
        <StatusPill value={snapshot.status} /> {snapshot.stale_sheets?.length ? <span className="pill pill-warn">stale</span> : null}
      </>
    ),
    sortValue: (snapshot) => snapshot.status
  },
  { key: "rows", header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span>, sortValue: (snapshot) => snapshot.rows.length },
  { key: "created_at", header: "Generated", render: (snapshot) => <span className="mono">{when(snapshot.created_at)}</span>, sortValue: (snapshot) => snapshot.created_at },
  {
    key: "released",
    header: "Released",
    render: (snapshot) => (snapshot.released_by ? `${snapshot.released_by} · ${when(snapshot.released_at)}` : "—"),
    sortValue: (snapshot) => snapshot.released_at
  }
];

const LEGACY_COLUMNS: Array<SortableColumn<ProjectBom>> = [
  { key: "diagram", header: "Diagram", render: (snapshot) => snapshot.diagram_name, sortValue: (snapshot) => snapshot.diagram_name },
  { key: "revision", header: "Rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span>, sortValue: (snapshot) => snapshot.revision },
  { key: "status", header: "Status", render: (snapshot) => <StatusPill value={snapshot.status} />, sortValue: (snapshot) => snapshot.status },
  { key: "rows", header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span>, sortValue: (snapshot) => snapshot.rows.length },
  { key: "created_at", header: "Generated", render: (snapshot) => <span className="mono">{when(snapshot.created_at)}</span>, sortValue: (snapshot) => snapshot.created_at },
  {
    key: "csv",
    header: "Export",
    render: (snapshot) => (
      <a className="downloadLink" href={bomCsvUrl(snapshot.id)} onClick={(event) => event.stopPropagation()}>
        CSV
      </a>
    )
  }
];

function rowColumns(readiness: BomReadiness | null): Array<SortableColumn<IndexedRow>> {
  return [
    { key: "kind", header: "Kind", render: ({ row }) => text(row.kind), sortValue: ({ row }) => row.kind as string },
    { key: "part_number", header: "Part", className: "mono", render: ({ row }) => text(row.part_number), sortValue: ({ row }) => row.part_number as string },
    { key: "description", header: "Description", render: ({ row }) => text(row.description), sortValue: ({ row }) => row.description as string },
    { key: "quantity", header: "Qty", className: "mono", render: ({ row }) => text(row.quantity), sortValue: ({ row }) => numberOf(row.quantity) },
    { key: "unit", header: "Unit", render: ({ row }) => text(row.unit), sortValue: ({ row }) => row.unit as string },
    { key: "spare_quantity", header: "Spares", className: "mono", render: ({ row }) => text(row.spare_quantity), sortValue: ({ row }) => numberOf(row.spare_quantity) },
    { key: "material", header: "Material", render: ({ row }) => text(row.material), sortValue: ({ row }) => row.material as string },
    { key: "component_tags", header: "Tags", className: "mono", render: ({ row }) => text(row.component_tags), sortValue: ({ row }) => listOf(row.component_tags)[0] },
    { key: "sheets", header: "Sheets", className: "mono", render: ({ row }) => text(row.sheets), sortValue: ({ row }) => numberOf(listOf(row.sheets).map(Number)[0]) },
    {
      key: "readiness",
      header: "Readiness",
      render: ({ row }) => {
        const issue = issueFor(row, readiness);
        if (!readiness) return "—";
        return issue ? <span className={issue.severity === "blocking" ? "pill pill-bad" : "pill pill-warn"} title={issue.warnings.join(" ")}>{issue.code ?? "issue"}</span> : <span className="pill pill-good">ok</span>;
      },
      sortValue: ({ row }) => {
        const issue = issueFor(row, readiness);
        return issue ? (issue.severity === "blocking" ? 0 : 1) : 2;
      }
    }
  ];
}

const ISSUE_COLUMNS: Array<SortableColumn<BomReadinessIssue & { index: number }>> = [
  { key: "code", header: "Issue", render: (issue) => <span className="mono">{issue.code ?? "—"}</span>, sortValue: (issue) => issue.code },
  { key: "part", header: "Part", className: "mono", render: (issue) => issue.part_number ?? "—", sortValue: (issue) => issue.part_number },
  { key: "tags", header: "Tags", className: "mono", render: (issue) => issue.component_tags.join(", ") || "—", sortValue: (issue) => issue.component_tags[0] },
  { key: "warnings", header: "Detail", render: (issue) => issue.warnings.join(" ") }
];

function IssueList({ title, tone, issues }: { title: string; tone: "bad" | "warn"; issues: BomReadinessIssue[] }) {
  const rows = useMemo(() => issues.map((issue, index) => ({ ...issue, index })), [issues]);
  if (!issues.length) return null;
  return (
    <>
      <p className="snapshotMeta">
        <span className={`pill pill-${tone}`}>
          {issues.length} {title}
        </span>
      </p>
      <SortableTable rows={rows} columns={ISSUE_COLUMNS} getKey={(issue) => String(issue.index)} label={title} />
    </>
  );
}

export function BomPage() {
  const { busy, runAction, notify, canWrite, selectedProjectId } = useWorkspace();
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingId, setDrawingId] = useState("");
  const [snapshots, setSnapshots] = useState<BomSnapshot[]>([]);
  const [selectedBomId, setSelectedBomId] = useState("");
  const [readiness, setReadiness] = useState<BomReadiness | null>(null);
  const [releaseIssues, setReleaseIssues] = useState<BomReadinessIssue[]>([]);
  const [diffAgainstId, setDiffAgainstId] = useState("");
  const [diff, setDiff] = useState<BomDiff | null>(null);
  const [legacy, setLegacy] = useState<ProjectBom[]>([]);
  const [legacyId, setLegacyId] = useState("");

  const drawing = drawings.find((entry) => entry.id === drawingId) ?? null;
  const bom = snapshots.find((snapshot) => snapshot.id === selectedBomId) ?? null;
  const legacyBom = legacy.find((snapshot) => snapshot.id === legacyId) ?? null;

  // Current selections for async work: a response for a previous selection must not land on the new one.
  const drawingIdRef = useRef(drawingId);
  const selectedBomIdRef = useRef(selectedBomId);
  useEffect(() => {
    drawingIdRef.current = drawingId;
    selectedBomIdRef.current = selectedBomId;
  }, [drawingId, selectedBomId]);

  // Drawings of the project and the legacy diagram BoM history.
  useEffect(() => {
    setDrawings([]);
    setDrawingId("");
    setLegacy([]);
    setLegacyId("");
    if (!selectedProjectId) return;
    let cancelled = false;
    api
      .listDrawings(selectedProjectId)
      .then((list) => {
        if (cancelled) return;
        setDrawings(list);
        const remembered = readStored(`${DRAWING_KEY}.${selectedProjectId}`);
        setDrawingId((list.find((entry) => entry.id === remembered) ?? list[0])?.id ?? "");
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : "Could not load drawings.", true);
      });
    api
      .listProjectBoms(selectedProjectId)
      .then((list) => {
        if (!cancelled) setLegacy(list.filter((snapshot) => snapshot.diagram_id && !snapshot.drawing_id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, notify]);

  const loadSnapshots = useCallback(async (targetDrawingId: string, selectId?: string) => {
    const list = await api.listDrawingBoms(targetDrawingId);
    if (drawingIdRef.current !== targetDrawingId) return;
    setSnapshots(list);
    setSelectedBomId((current) => selectId ?? (list.some((snapshot) => snapshot.id === current) ? current : (list[0]?.id ?? "")));
  }, []);

  // BoM snapshots of the selected drawing.
  useEffect(() => {
    setSnapshots([]);
    setSelectedBomId("");
    if (!drawingId) return;
    if (selectedProjectId) writeStored(`${DRAWING_KEY}.${selectedProjectId}`, drawingId);
    loadSnapshots(drawingId).catch((error) => notify(error instanceof Error ? error.message : "Could not load BoM snapshots.", true));
  }, [drawingId, selectedProjectId, loadSnapshots, notify]);

  // Readiness of the selected snapshot; a new selection forgets the previous diff and refusal.
  useEffect(() => {
    setReadiness(null);
    setReleaseIssues([]);
    setDiff(null);
    setDiffAgainstId("");
    if (!selectedBomId) return;
    let cancelled = false;
    api
      .getBomReadiness(selectedBomId)
      .then((next) => {
        if (!cancelled) setReadiness(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedBomId]);

  function generate() {
    if (!drawing) return;
    const targetId = drawing.id;
    void runAction(`Generated a BoM for ${drawing.number}.`, async () => {
      const snapshot = await api.generateDrawingBom(targetId);
      await loadSnapshots(targetId, snapshot.id);
    });
  }

  async function release() {
    if (!bom || !drawing) return;
    if (!window.confirm(`Release BoM rev ${bom.revision} of ${drawing.number}? Released BoMs cannot change; later changes need a new BoM.`)) return;
    const target = bom;
    try {
      const updated = await setBomStatusChecked(target.id, "released");
      setSnapshots((current) => current.map((snapshot) => (snapshot.id === updated.id ? updated : snapshot)));
      setReleaseIssues([]);
      notify(`Released BoM rev ${updated.revision} of ${drawing.number}.`);
    } catch (error) {
      if (error instanceof WorkflowConflictError && selectedBomIdRef.current === target.id) setReleaseIssues(error.issues);
      notify(error instanceof Error ? error.message : "Could not release the BoM.", true);
    }
  }

  function compare() {
    if (!bom || !diffAgainstId) return;
    const bomId = bom.id;
    void runAction("Compared BoM revisions.", async () => {
      const next = await api.getBomDiff(bomId, diffAgainstId);
      if (selectedBomIdRef.current === bomId) setDiff(next);
    });
  }

  const indexedRows = useMemo<IndexedRow[]>(() => (bom ? bom.rows.map((row, index) => ({ index, row })) : []), [bom]);
  const columns = useMemo(() => rowColumns(readiness), [readiness]);
  const legacyRows = useMemo<IndexedRow[]>(() => (legacyBom ? legacyBom.rows.map((row, index) => ({ index, row })) : []), [legacyBom]);
  const legacyRowColumns = useMemo(() => rowColumns(null).filter((column) => column.key !== "readiness"), []);
  const blocking = readiness?.issues.filter((issue) => issue.severity === "blocking") ?? [];
  const warnings = readiness?.issues.filter((issue) => issue.severity !== "blocking") ?? [];
  const others = snapshots.filter((snapshot) => snapshot.id !== bom?.id);
  const released = bom?.status === "released";

  return (
    <PageLayout title="BoM & Procurement" description="Drawing BoMs: readiness, release, diff, and exports">
      <section className="bomToolbar">
        <label>
          Drawing
          <select value={drawingId} onChange={(event) => setDrawingId(event.target.value)} disabled={!drawings.length} aria-label="Drawing">
            {drawings.length === 0 && <option value="">{selectedProjectId ? "No drawings in this project" : "Select a project first"}</option>}
            {drawings.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.number} · {entry.title.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
        {drawing && (
          <span className="snapshotMeta">
            <StatusPill value={drawing.status} /> rev <span className="mono">{drawing.current_revision?.label ?? drawing.revisions[drawing.revisions.length - 1]?.label ?? "-"}</span>
            {drawing.sheets.some((sheet) => sheet.index_stale) && <span className="pill pill-warn">sheets out of date</span>}
          </span>
        )}
        <button type="button" className="primary" disabled={busy || !canWrite || !drawing} onClick={generate} title="Roll up the drawing's saved sheet index into a new BoM snapshot">
          Generate BoM
        </button>
      </section>
      {drawing && (
        <StaleSheetsWarning sheets={drawing.sheets.filter((sheet) => sheet.index_stale).map((sheet) => ({ sheet_no: sheet.sheet_no, drawing_number: drawing.number }))}>
          Open the drawing in Drafting to re-index them before generating a BoM to release.
        </StaleSheetsWarning>
      )}
      <section className="grid bomGrid">
        <Panel title="Snapshots" className="bomSnapshots">
          {drawing ? (
            <SortableTable
              rows={snapshots}
              columns={SNAPSHOT_COLUMNS}
              getKey={(snapshot) => snapshot.id}
              selectedKey={selectedBomId}
              onSelect={(snapshot) => setSelectedBomId(snapshot.id)}
              emptyText="No BoM generated for this drawing yet."
              label="BoM snapshots"
            />
          ) : (
            <p className="hint">Create a drawing on the Drafting page; its BoMs appear here.</p>
          )}
        </Panel>
        <Panel title="Readiness" className="bomReadiness">
          {!bom ? (
            <p className="hint">Select a snapshot to check procurement readiness.</p>
          ) : !readiness ? (
            <p className="hint">Checking…</p>
          ) : readiness.ready ? (
            <p className="snapshotMeta">
              <span className="pill pill-good">ready</span> All {readiness.row_count} row(s) reference qualified parts with complete data.
            </p>
          ) : (
            <>
              <p className="snapshotMeta">
                {readiness.blocking_count ?? blocking.length} blocking issue(s) stop the release; {readiness.warning_count ?? warnings.length} warning(s) do not.
              </p>
              <IssueList title="blocking" tone="bad" issues={blocking} />
              <IssueList title="warnings" tone="warn" issues={warnings} />
            </>
          )}
        </Panel>
      </section>
      {bom && (
        <Panel
          title={`BoM rev ${bom.revision}`}
          className="bomDetail"
          actions={
            <span className="bomActions">
              <a className="downloadLink" href={bomCsvUrl(bom.id)}>
                CSV
              </a>
              <a className="downloadLink" href={bomXlsxUrl(bom.id)}>
                XLSX
              </a>
              {!released && (
                <button type="button" className="primary" disabled={busy || !canWrite} onClick={() => void release()} title="Lock this BoM as a baseline; refused while blocking issues remain">
                  Release…
                </button>
              )}
            </span>
          }
        >
          <p className="snapshotMeta">
            <StatusPill value={bom.status} /> Drawing rev <span className="mono">{bom.drawing_revision ?? "—"}</span> · generated {when(bom.created_at)}
            {bom.released_by && (
              <>
                {" "}
                · released by <strong>{bom.released_by}</strong> {when(bom.released_at)}
              </>
            )}
          </p>
          {released && <p className="hint">Released BoMs are immutable baselines. Generate a new BoM to capture later drawing changes.</p>}
          <StaleSheetsWarning sheets={bom.stale_sheets ?? []}>This BoM was generated from out-of-date sheets and cannot be released.</StaleSheetsWarning>
          {releaseIssues.length > 0 && (
            <div className="releaseBlockers" role="alert">
              <div className="releaseBlockersHead">
                <strong>Release refused: {releaseIssues.length} blocking issue(s)</strong>
                <button type="button" className="linkButton" onClick={() => setReleaseIssues([])}>
                  Dismiss
                </button>
              </div>
              <ul>
                {releaseIssues.map((issue, index) => (
                  <li key={index}>
                    <span className="mono">{issue.code ?? "issue"}</span> {issue.part_number ?? issue.component_tags.join(", ")} — {issue.warnings.join(" ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <SortableTable rows={indexedRows} columns={columns} getKey={(entry) => String(entry.index)} emptyText="This BoM has no rows." label="BoM rows" />
        </Panel>
      )}
      {bom && (
        <Panel title="Compare" className="bomCompare">
          {others.length ? (
            <div className="bomCompareControls">
              <label>
                Compare rev {bom.revision} against
                <select value={diffAgainstId} onChange={(event) => setDiffAgainstId(event.target.value)} aria-label="Compare against">
                  <option value="">Select…</option>
                  {others.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      rev {snapshot.revision} ({snapshot.status})
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={busy || !diffAgainstId} onClick={compare}>
                Compare
              </button>
            </div>
          ) : (
            <p className="hint">Generate another BoM of this drawing to compare revisions.</p>
          )}
          {diff && <DiffView diff={diff} />}
        </Panel>
      )}
      {legacy.length > 0 && (
        <details className="legacyBoms">
          <summary>Legacy diagram BoMs ({legacy.length}) — read-only history</summary>
          <p className="hint">BoMs generated from diagrams before drawings existed. They can be viewed and exported, not generated or released.</p>
          <SortableTable rows={legacy} columns={LEGACY_COLUMNS} getKey={(snapshot) => snapshot.id} selectedKey={legacyId} onSelect={(snapshot) => setLegacyId(snapshot.id === legacyId ? "" : snapshot.id)} label="Legacy diagram BoMs" />
          {legacyBom && <SortableTable rows={legacyRows} columns={legacyRowColumns} getKey={(entry) => String(entry.index)} emptyText="No rows." label="Legacy BoM rows" />}
        </details>
      )}
    </PageLayout>
  );
}

const DIFF_ROW_COLUMNS: Array<SortableColumn<IndexedRow>> = [
  { key: "part_number", header: "Part", className: "mono", render: ({ row }) => text(row.part_number), sortValue: ({ row }) => row.part_number as string },
  { key: "description", header: "Description", render: ({ row }) => text(row.description), sortValue: ({ row }) => row.description as string },
  { key: "quantity", header: "Qty", className: "mono", render: ({ row }) => text(row.quantity), sortValue: ({ row }) => numberOf(row.quantity) }
];

type Changed = BomDiff["changed"][number] & { index: number };
const CHANGED_COLUMNS: Array<SortableColumn<Changed>> = [
  { key: "part_number", header: "Part", className: "mono", render: (row) => row.part_number ?? "—", sortValue: (row) => row.part_number },
  { key: "description", header: "Description", render: (row) => row.description ?? "—", sortValue: (row) => row.description },
  { key: "quantity", header: "Qty", className: "mono", render: (row) => `${row.from_quantity} → ${row.to_quantity}`, sortValue: (row) => row.to_quantity - row.from_quantity }
];

function DiffView({ diff }: { diff: BomDiff }) {
  const added = useMemo(() => diff.added.map((row, index) => ({ index, row })), [diff]);
  const removed = useMemo(() => diff.removed.map((row, index) => ({ index, row })), [diff]);
  const changed = useMemo(() => diff.changed.map((row, index) => ({ ...row, index })), [diff]);
  return (
    <>
      <p className="snapshotMeta">
        <span className="pill pill-good">{diff.added.length} added</span>
        <span className="pill pill-bad">{diff.removed.length} removed</span>
        <span className="pill pill-info">{diff.changed.length} qty changed</span>
      </p>
      {added.length > 0 && (
        <>
          <h3 className="bomDiffHeading">Added</h3>
          <SortableTable rows={added} columns={DIFF_ROW_COLUMNS} getKey={(entry) => `a${entry.index}`} label="Added rows" />
        </>
      )}
      {removed.length > 0 && (
        <>
          <h3 className="bomDiffHeading">Removed</h3>
          <SortableTable rows={removed} columns={DIFF_ROW_COLUMNS} getKey={(entry) => `r${entry.index}`} label="Removed rows" />
        </>
      )}
      {changed.length > 0 && (
        <>
          <h3 className="bomDiffHeading">Quantity changed</h3>
          <SortableTable rows={changed} columns={CHANGED_COLUMNS} getKey={(entry) => `c${entry.index}`} label="Changed quantities" />
        </>
      )}
      {!added.length && !removed.length && !changed.length && <p className="hint">No differences.</p>}
    </>
  );
}

/**
 * BoM & Procurement: bills of materials generated from drawings.
 *
 * Pick a drawing of the project, generate a BoM snapshot from its saved sheet
 * index, check procurement readiness, release it (refused while blocking issues
 * remain; released snapshots are immutable), compare it with another snapshot of
 * the same drawing, and export CSV or XLSX. BoMs of legacy diagrams stay
 * available read-only as history.
 *
 * Every table is a read-only DataGrid (sort, filter, copy, CSV export). BoM rows
 * carry their readiness as a column and filter by readiness and type; activating
 * a row opens its first tag (or sheet) in Drafting.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, bomCsvUrl, bomXlsxUrl, setBomStatusChecked, WorkflowConflictError } from "../api";
import { DataGrid, type DataGridColumn } from "../components/datagrid";
import { StaleSheetsWarning } from "../components/StaleSheetsWarning";
import { Panel, StatusPill } from "../components/ui";
import type { BomDiff, BomReadiness, BomReadinessIssue, BomSnapshot, Drawing, ProjectBom, ProjectSheetItem } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { draftingHref, type DraftingTarget } from "./draftingLinks";
import { PageLayout } from "./PageLayout";

type BomRow = Record<string, unknown>;
type Readiness = "blocking" | "warning" | "ok";
/** A BoM row as a grid row: stable id plus the readiness issue raised for it (if any). */
type GridRow = { id: string; row: BomRow; readiness: Readiness | null; issue: BomReadinessIssue | undefined };

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

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** The readiness issue raised for a BoM row (same part number and tags). */
function issueFor(row: BomRow, readiness: BomReadiness | null): BomReadinessIssue | undefined {
  const tags = listOf(row.component_tags).join();
  return readiness?.issues.find((issue) => (issue.part_number ?? null) === ((row.part_number as string | null | undefined) ?? null) && issue.component_tags.join() === tags);
}

function toGridRows(prefix: string, rows: BomRow[], readiness: BomReadiness | null): GridRow[] {
  return rows.map((row, index) => {
    const issue = issueFor(row, readiness);
    const level: Readiness | null = !readiness ? null : issue ? (issue.severity === "blocking" ? "blocking" : "warning") : "ok";
    return { id: `${prefix}:${index}`, row, readiness: level, issue };
  });
}

const READINESS_TONE: Record<Readiness, string> = { blocking: "bad", warning: "warn", ok: "good" };
const READINESS_RANK: Record<Readiness, number> = { blocking: 0, warning: 1, ok: 2 };
const KINDS = ["part", "unassigned", "bulk"];

/** A text column reading `row[key]` of the BoM row. */
function field(key: string, header: string, extra: Partial<DataGridColumn<GridRow>> = {}): DataGridColumn<GridRow> {
  return { key, header, getValue: (entry) => entry.row[key] ?? null, ...extra };
}

function listField(key: string, header: string, extra: Partial<DataGridColumn<GridRow>> = {}): DataGridColumn<GridRow> {
  return field(key, header, { mono: true, format: joined, sortValue: (entry) => listOf(entry.row[key])[0] ?? null, ...extra });
}

const ROW_COLUMNS: DataGridColumn<GridRow>[] = [
  {
    key: "readiness",
    header: "Readiness",
    width: 130,
    type: "enum",
    options: ["blocking", "warning", "ok"],
    frozen: true,
    render: (entry) =>
      entry.readiness ? (
        <span className={`pill pill-${READINESS_TONE[entry.readiness]}`} title={entry.issue?.warnings.join(" ")}>
          {entry.issue?.code ?? entry.readiness}
        </span>
      ) : (
        "—"
      ),
    format: (value, entry) => (entry.issue ? `${String(value)}: ${entry.issue.code ?? "issue"}` : value ? String(value) : ""),
    sortValue: (entry) => (entry.readiness ? READINESS_RANK[entry.readiness] : null)
  },
  field("kind", "Kind", { width: 110, type: "enum", options: KINDS }),
  field("part_number", "Part", { width: 140, mono: true, frozen: true }),
  field("description", "Description", { width: 240 }),
  field("quantity", "Qty", { width: 80, type: "number", mono: true, getValue: (entry) => numberOf(entry.row.quantity) }),
  field("unit", "Unit", { width: 70 }),
  field("spare_quantity", "Spares", { width: 80, type: "number", mono: true, getValue: (entry) => numberOf(entry.row.spare_quantity) }),
  field("material", "Material", { width: 130 }),
  listField("component_tags", "Tags", { width: 200 }),
  listField("sheets", "Sheets", { width: 90, sortValue: (entry) => numberOf(Number(listOf(entry.row.sheets)[0])) }),
  field("manufacturer", "Manufacturer", { width: 140, hidden: true }),
  field("revision", "Part rev", { width: 80, hidden: true, mono: true }),
  field("qualification_status", "Qualification", { width: 120, hidden: true }),
  field("certification_status", "Certification", { width: 120, hidden: true }),
  field("pressure_rating_bar", "Rating (bar)", { width: 100, type: "number", hidden: true, getValue: (entry) => numberOf(entry.row.pressure_rating_bar) }),
  field("mass_kg", "Mass (kg)", { width: 90, type: "number", hidden: true, getValue: (entry) => numberOf(entry.row.mass_kg) }),
  listField("dnp_tags", "DNP tags", { width: 140, hidden: true })
];

const LEGACY_ROW_COLUMNS = ROW_COLUMNS.filter((column) => column.key !== "readiness");

type IssueRow = BomReadinessIssue & { id: string };
const ISSUE_COLUMNS: DataGridColumn<IssueRow>[] = [
  {
    key: "severity",
    header: "Severity",
    width: 110,
    type: "enum",
    options: ["blocking", "warning"],
    getValue: (issue) => issue.severity ?? "warning",
    render: (issue) => <span className={`pill pill-${issue.severity === "blocking" ? "bad" : "warn"}`}>{issue.severity ?? "warning"}</span>
  },
  { key: "code", header: "Issue", width: 140, mono: true },
  { key: "part_number", header: "Part", width: 130, mono: true },
  { key: "component_tags", header: "Tags", width: 150, mono: true, format: joined, sortValue: (issue) => issue.component_tags[0] ?? null },
  { key: "warnings", header: "Detail", width: 320, format: (value) => (Array.isArray(value) ? value.join(" ") : "") }
];


type DiffRow = {
  id: string;
  change: "added" | "removed" | "changed";
  part_number: string | null;
  description: string | null;
  unit: string | null;
  from_quantity: number | null;
  to_quantity: number | null;
};

const CHANGE_TONE: Record<DiffRow["change"], string> = { added: "good", removed: "bad", changed: "info" };

function quantityText(value: number | null): string {
  return value === null ? "—" : String(value);
}

const DIFF_COLUMNS: DataGridColumn<DiffRow>[] = [
  {
    key: "change",
    header: "Change",
    width: 110,
    type: "enum",
    options: ["added", "removed", "changed"],
    render: (row) => <span className={`pill pill-${CHANGE_TONE[row.change]}`}>{row.change}</span>
  },
  { key: "part_number", header: "Part", width: 140, mono: true },
  { key: "description", header: "Description", width: 240 },
  {
    key: "quantity",
    header: "Qty (old → new)",
    width: 140,
    mono: true,
    getValue: (row) => `${quantityText(row.from_quantity)} → ${quantityText(row.to_quantity)}`,
    sortValue: (row) => (row.to_quantity ?? 0) - (row.from_quantity ?? 0)
  },
  {
    key: "delta",
    header: "Δ Qty",
    width: 90,
    type: "number",
    mono: true,
    getValue: (row) => Math.round(((row.to_quantity ?? 0) - (row.from_quantity ?? 0)) * 1000) / 1000
  },
  { key: "unit", header: "Unit", width: 70 },
  { key: "from_quantity", header: "Old qty", width: 90, type: "number", mono: true, hidden: true },
  { key: "to_quantity", header: "New qty", width: 90, type: "number", mono: true, hidden: true }
];

function diffRows(diff: BomDiff): DiffRow[] {
  const text = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
  return [
    ...diff.added.map((row, index) => ({ id: `a${index}`, change: "added" as const, part_number: text(row.part_number), description: text(row.description), unit: text(row.unit), from_quantity: null, to_quantity: numberOf(row.quantity) })),
    ...diff.removed.map((row, index) => ({ id: `r${index}`, change: "removed" as const, part_number: text(row.part_number), description: text(row.description), unit: text(row.unit), from_quantity: numberOf(row.quantity), to_quantity: null })),
    ...diff.changed.map((row, index) => ({ id: `c${index}`, change: "changed" as const, part_number: row.part_number ?? null, description: row.description ?? null, unit: null, from_quantity: row.from_quantity, to_quantity: row.to_quantity }))
  ];
}

function DiffView({ diff, fileName }: { diff: BomDiff; fileName: string }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  return (
    <>
      <p className="snapshotMeta">
        <span className="pill pill-good">{diff.added.length} added</span>
        <span className="pill pill-bad">{diff.removed.length} removed</span>
        <span className="pill pill-info">{diff.changed.length} qty changed</span>
      </p>
      {rows.length ? (
        <DataGrid rows={rows} columns={DIFF_COLUMNS} getRowId={(row) => row.id} selectable={false} storageKey="bom.diff" exportFileName={fileName} height={360} ariaLabel="BoM differences" />
      ) : (
        <p className="hint">No differences.</p>
      )}
    </>
  );
}

export function BomPage() {
  const { busy, runAction, notify, canWrite, selectedProjectId } = useWorkspace();
  const navigate = useNavigate();
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
  const [readinessFilter, setReadinessFilter] = useState<Readiness | "">("");
  const [kindFilter, setKindFilter] = useState("");

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

  // Tagged sheet items per project, fetched on the first "locate in Drafting".
  const sheetItemsRef = useRef(new Map<string, Promise<ProjectSheetItem[]>>());

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

  /** Open the row's first located tag in Drafting (falls back to its first sheet, then the drawing). */
  async function locate(entry: GridRow) {
    if (!drawing) return;
    const target: DraftingTarget = { projectId: drawing.project_id, drawingId: drawing.id };
    const firstSheet = drawing.sheets.find((sheet) => String(sheet.sheet_no) === listOf(entry.row.sheets)[0]);
    if (firstSheet) target.sheetId = firstSheet.id;
    // Bulk rows list line references, not tagged items.
    const tags = entry.row.kind === "bulk" ? [] : listOf(entry.row.component_tags);
    if (tags.length) {
      let pending = sheetItemsRef.current.get(drawing.project_id);
      if (!pending) {
        pending = api.listProjectSheetItems(drawing.project_id);
        sheetItemsRef.current.set(drawing.project_id, pending);
        pending.catch(() => sheetItemsRef.current.delete(drawing.project_id));
      }
      try {
        const items = (await pending).filter((item) => item.drawing_id === drawing.id);
        const hit = tags.map((tag) => items.find((item) => item.tag === tag)).find(Boolean);
        if (hit) {
          target.sheetId = hit.sheet_id;
          target.itemId = hit.item_id;
        }
      } catch {
        /* fall back to the sheet */
      }
    }
    navigate(draftingHref(target));
  }

  const snapshotColumns = useMemo<DataGridColumn<BomSnapshot>[]>(
    () => [
      {
        key: "revision",
        header: "BoM rev",
        width: 90,
        type: "number",
        render: (snapshot) => (
          <button type="button" className="linkButton mono" aria-pressed={snapshot.id === selectedBomId} onClick={() => setSelectedBomId(snapshot.id)}>
            rev {snapshot.revision}
          </button>
        )
      },
      { key: "drawing_revision", header: "Drawing rev", width: 100, mono: true },
      {
        key: "status",
        header: "Status",
        width: 130,
        format: (value, snapshot) => `${String(value)}${snapshot.stale_sheets?.length ? " (stale)" : ""}`,
        render: (snapshot) => (
          <>
            <StatusPill value={snapshot.status} /> {snapshot.stale_sheets?.length ? <span className="pill pill-warn">stale</span> : null}
          </>
        )
      },
      { key: "rows", header: "Rows", width: 70, type: "number", mono: true, getValue: (snapshot) => snapshot.rows.length },
      { key: "created_at", header: "Generated", width: 170, mono: true, format: (value) => when(value as string | null) },
      {
        key: "released_at",
        header: "Released",
        width: 230,
        format: (value, snapshot) => (snapshot.released_by ? `${snapshot.released_by} · ${when(value as string | null)}` : "—")
      }
    ],
    [selectedBomId]
  );

  const legacyColumns = useMemo<DataGridColumn<ProjectBom>[]>(
    () => [
      {
        key: "diagram_name",
        header: "Diagram",
        width: 200,
        render: (snapshot) => (
          <button type="button" className="linkButton" aria-pressed={snapshot.id === legacyId} onClick={() => setLegacyId(snapshot.id === legacyId ? "" : snapshot.id)}>
            {snapshot.diagram_name}
          </button>
        )
      },
      { key: "revision", header: "Rev", width: 70, type: "number", mono: true },
      { key: "status", header: "Status", width: 110, render: (snapshot) => <StatusPill value={snapshot.status} /> },
      { key: "rows", header: "Rows", width: 70, type: "number", mono: true, getValue: (snapshot) => snapshot.rows.length },
      { key: "created_at", header: "Generated", width: 170, mono: true, format: (value) => when(value as string | null) },
      {
        key: "csv",
        header: "Export",
        width: 80,
        sortable: false,
        filterable: false,
        getValue: () => "CSV",
        render: (snapshot) => (
          <a className="downloadLink" href={bomCsvUrl(snapshot.id)}>
            CSV
          </a>
        )
      }
    ],
    [legacyId]
  );

  const gridRows = useMemo(() => (bom ? toGridRows(bom.id, bom.rows, readiness) : []), [bom, readiness]);
  const visibleRows = useMemo(
    () => gridRows.filter((entry) => (!readinessFilter || entry.readiness === readinessFilter) && (!kindFilter || entry.row.kind === kindFilter)),
    [gridRows, readinessFilter, kindFilter]
  );
  const legacyRows = useMemo(() => (legacyBom ? toGridRows(legacyBom.id, legacyBom.rows, null) : []), [legacyBom]);
  const issueRows = useMemo<IssueRow[]>(
    () => [...(readiness?.issues ?? [])].sort((a, b) => Number(a.severity !== "blocking") - Number(b.severity !== "blocking")).map((issue, index) => ({ ...issue, id: String(index) })),
    [readiness]
  );
  const blocking = readiness?.issues.filter((issue) => issue.severity === "blocking") ?? [];
  const warnings = readiness?.issues.filter((issue) => issue.severity !== "blocking") ?? [];
  const others = snapshots.filter((snapshot) => snapshot.id !== bom?.id);
  const released = bom?.status === "released";
  const exportName = drawing && bom ? `bom-${drawing.number}-rev${bom.revision}` : "bom";

  const rowFilters = (
    <>
      <select className="bomFilter" value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value as Readiness | "")} aria-label="Filter by readiness" disabled={!readiness}>
        <option value="">All readiness</option>
        <option value="blocking">Blocking ({gridRows.filter((entry) => entry.readiness === "blocking").length})</option>
        <option value="warning">Warning ({gridRows.filter((entry) => entry.readiness === "warning").length})</option>
        <option value="ok">Ready ({gridRows.filter((entry) => entry.readiness === "ok").length})</option>
      </select>
      <select className="bomFilter" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} aria-label="Filter by type">
        <option value="">All types</option>
        {KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind} ({gridRows.filter((entry) => entry.row.kind === kind).length})
          </option>
        ))}
      </select>
    </>
  );

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
            <DataGrid
              rows={snapshots}
              columns={snapshotColumns}
              getRowId={(snapshot) => snapshot.id}
              selectable={false}
              onRowActivate={(snapshot) => setSelectedBomId(snapshot.id)}
              rowClassName={(snapshot) => (snapshot.id === selectedBomId ? "dgRowCurrent" : undefined)}
              storageKey="bom.snapshots"
              exportFileName={`bom-snapshots-${drawing.number}`}
              emptyMessage="No BoM generated for this drawing yet."
              height={280}
              ariaLabel="BoM snapshots"
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
                <span className="pill pill-bad">{readiness.blocking_count ?? blocking.length} blocking</span>
                <span className="pill pill-warn">{readiness.warning_count ?? warnings.length} warnings</span>
                Blocking issues stop the release; warnings do not.
              </p>
              <DataGrid rows={issueRows} columns={ISSUE_COLUMNS} getRowId={(issue) => issue.id} selectable={false} storageKey="bom.issues" exportFileName={`${exportName}-readiness`} height={280} ariaLabel="Readiness issues" />
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
          <DataGrid
            rows={visibleRows}
            columns={ROW_COLUMNS}
            getRowId={(entry) => entry.id}
            selectable={false}
            onRowActivate={(entry) => void locate(entry)}
            toolbar={rowFilters}
            storageKey="bom.rows"
            exportFileName={exportName}
            emptyMessage={gridRows.length ? "No rows match the filters." : "This BoM has no rows."}
            height={520}
            ariaLabel="BoM rows"
          />
          <p className="hint">Double-click a row (or press Enter) to locate its first tag in Drafting.</p>
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
          {diff && <DiffView diff={diff} fileName={`${exportName}-diff`} />}
        </Panel>
      )}
      {legacy.length > 0 && (
        <details className="legacyBoms">
          <summary>Legacy diagram BoMs ({legacy.length}) — read-only history</summary>
          <p className="hint">BoMs generated from diagrams before drawings existed. They can be viewed and exported, not generated or released.</p>
          <DataGrid
            rows={legacy}
            columns={legacyColumns}
            getRowId={(snapshot) => snapshot.id}
            selectable={false}
            onRowActivate={(snapshot) => setLegacyId(snapshot.id === legacyId ? "" : snapshot.id)}
            rowClassName={(snapshot) => (snapshot.id === legacyId ? "dgRowCurrent" : undefined)}
            storageKey="bom.legacy"
            exportFileName="legacy-boms"
            height={240}
            ariaLabel="Legacy diagram BoMs"
          />
          {legacyBom && (
            <DataGrid rows={legacyRows} columns={LEGACY_ROW_COLUMNS} getRowId={(entry) => entry.id} selectable={false} storageKey="bom.legacyRows" exportFileName={`legacy-bom-${legacyBom.diagram_name}-rev${legacyBom.revision}`} emptyMessage="No rows." height={360} ariaLabel="Legacy BoM rows" />
          )}
        </details>
      )}
    </PageLayout>
  );
}

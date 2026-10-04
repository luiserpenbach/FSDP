import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  api,
  bulkDeleteRequirements,
  bulkUpdateRequirements,
  downloadRequirementsImportTemplate,
  importRequirements
} from "../api";
import {
  DataGrid,
  type DataGridCellErrors,
  type DataGridColumn,
  type DataGridCommitResult,
  type DataGridEdit
} from "../components/datagrid";
import { exportGridXlsx } from "../components/gridXlsx";
import { ImportWizard, type ImportSourceRows } from "../components/ImportWizard";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type {
  Drawing,
  ProjectSheetItem,
  Requirement,
  RequirementBulkChanges,
  RequirementConstraintRead,
  TraceLink,
  VerificationMatrix,
  VerificationRow
} from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { draftingHref } from "./draftingLinks";
import { PageLayout } from "./PageLayout";

type ConstraintForm = { kind: "" | RequirementConstraintRead["kind"]; values: string; services: string; categories: string };

/** The API also returns `owner` (settable inline and in bulk). */
type RequirementRow = Requirement & { owner?: string | null };

type MatrixRow = VerificationRow & { verification_method: string | null };

type Notice = { text: string; refusals?: Array<{ id: string; label: string; reason: string }> };

const STATUS_VALUES = ["draft", "proposed", "approved", "verified", "deferred", "rejected"];
const METHOD_VALUES = ["inspection", "analysis", "demonstration", "test"];
const TYPE_VALUES = ["functional", "performance", "safety", "interface", "materials", "environmental"];
const VERDICT_OPTIONS = [
  { value: "pass", label: "pass" },
  { value: "fail", label: "fail" },
  { value: "no_data", label: "no data" },
  { value: "manual", label: "manual" }
];

/** Fields PATCH /projects/{id}/requirements/bulk may set. */
const BULK_FIELDS = new Set(["requirement_type", "verification_method", "status", "owner"]);

/** Grid columns that are not import fields as shown (the check is JSON in an import). */
const NOT_IMPORTED = new Set(["constraint"]);

const IMPORT_FIELD_LABELS: Record<string, string> = {
  requirement_type: "Type",
  verification_method: "Verification"
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Standard values first, then any other value already in use. */
function withExisting(standard: string[], used: Array<string | null | undefined>): string[] {
  const extra = used.filter((value): value is string => Boolean(value) && !standard.includes(value as string));
  return [...standard, ...Array.from(new Set(extra)).sort()];
}

const optionalText = (text: string) => (text.trim() === "" ? null : text.trim());

const required = (name: string) => (value: unknown) =>
  value === null || value === undefined || String(value).trim() === "" ? `${name} is required` : null;

function constraintText(constraint: RequirementConstraintRead | null | undefined): string {
  if (!constraint) return "manual";
  return `${constraint.kind}${constraint.values.length ? ` ${constraint.values.join("|")}` : ""}`;
}

function verdictPill(verdict: string) {
  const tone = verdict === "pass" ? "pill-good" : verdict === "fail" ? "pill-bad" : "pill-muted";
  return <span className={`pill ${tone}`}>{verdict.replace("_", " ")}</span>;
}

function requirementColumns(options: { types: string[]; methods: string[]; statuses: string[] }, onOpen: (row: RequirementRow) => void): DataGridColumn<RequirementRow>[] {
  return [
    {
      key: "key",
      header: "Key",
      frozen: true,
      hideable: false,
      mono: true,
      width: 140,
      render: (row) => (
        <button type="button" className="linkButton mono gridLink" title="Open in the editor and trace links" onClick={() => onOpen(row)}>
          {row.key}
        </button>
      )
    },
    { key: "title", header: "Title", width: 280, editable: true, parse: (text) => text.trim(), validate: required("Title") },
    {
      key: "requirement_type",
      header: "Type",
      type: "enum",
      options: options.types,
      width: 130,
      editable: true,
      // Types are open-ended: a known type matches case-insensitively, anything else is a new type.
      parse: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return null;
        return options.types.find((type) => type.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
      },
      validate: required("Type")
    },
    { key: "verification_method", header: "Verification", type: "enum", options: options.methods, width: 135, editable: true },
    {
      key: "status",
      header: "Status",
      type: "enum",
      options: options.statuses,
      width: 120,
      editable: true,
      render: (_row, value) => (value ? <StatusPill value={String(value)} /> : null),
      validate: required("Status")
    },
    { key: "owner", header: "Owner", width: 150, editable: true, parse: optionalText },
    {
      key: "constraint",
      header: "DRC check",
      width: 220,
      getValue: (row) => constraintText(row.constraint),
      render: (row) =>
        row.constraint ? <span className="mono">{constraintText(row.constraint)}</span> : <span className="hint">manual</span>
    },
    { key: "text", header: "Text", width: 360, hidden: true }
  ];
}

function matrixColumns(methods: string[], onOpen: (row: MatrixRow) => void): DataGridColumn<MatrixRow>[] {
  return [
    {
      key: "key",
      header: "Key",
      frozen: true,
      hideable: false,
      mono: true,
      width: 140,
      render: (row) => (
        <button type="button" className="linkButton mono gridLink" title="Open the requirement" onClick={() => onOpen(row)}>
          {row.key}
        </button>
      )
    },
    { key: "title", header: "Title", width: 240 },
    { key: "verdict", header: "Verdict", type: "enum", options: VERDICT_OPTIONS, width: 105, render: (row) => verdictPill(row.verdict) },
    { key: "verification_method", header: "Method", type: "enum", options: methods, width: 125 },
    { key: "status", header: "Status", type: "enum", options: STATUS_VALUES, width: 105, hidden: true },
    { key: "checked", header: "Checked", type: "number", width: 90 },
    { key: "passed", header: "Pass", type: "number", width: 75 },
    { key: "failed", header: "Fail", type: "number", width: 75 },
    {
      key: "drawings",
      header: "Drawings",
      width: 240,
      getValue: (row) =>
        row.drawings.length ? row.drawings.map((entry) => `${entry.drawing_number} (sheets ${entry.sheets.join(", ")})`).join("; ") : ""
    },
    {
      key: "links",
      header: "Links",
      width: 190,
      getValue: (row) => `${row.linked_drawings} drawing(s) · ${row.linked_components} component(s)`,
      mono: true
    },
    {
      key: "failures",
      header: "Failures",
      width: 260,
      mono: true,
      getValue: (row) =>
        row.failures.map((failure) => `${failure.subject ?? failure.item_id}${failure.zone ? ` @ ${failure.zone}` : ""}`).join(", ")
    }
  ];
}

/** Rows pasted below the grid (keyed by column) -> import rows with field-name headers. */
function pastedImportRows(records: Array<Record<string, string>>): ImportSourceRows {
  const headers: string[] = [];
  for (const record of records)
    for (const key of Object.keys(record)) if (!NOT_IMPORTED.has(key) && !headers.includes(key)) headers.push(key);
  return { headers, rows: records.map((record) => headers.map((header) => record[header] ?? "")) };
}

/**
 * Save grid edits: one field set to the same value on several requirements goes through
 * the bulk endpoint (one transaction); other edits save requirement by requirement so a
 * refused row only rolls back its own cells.
 */
async function saveRequirementEdits(projectId: string, edits: DataGridEdit[]): Promise<{ saved: number; errors: DataGridCellErrors }> {
  const errors: DataGridCellErrors = {};
  const fail = (rowId: string, keys: string[], message: string) => {
    errors[rowId] = { ...errors[rowId] };
    for (const key of keys) errors[rowId][key] = message;
  };
  const [first] = edits;
  const rowIds = new Set(edits.map((edit) => edit.rowId));
  const sameChange =
    edits.length > 1 &&
    rowIds.size === edits.length &&
    BULK_FIELDS.has(first.key) &&
    edits.every((edit) => edit.key === first.key && Object.is(edit.value, first.value));
  if (sameChange) {
    try {
      const result = await bulkUpdateRequirements(projectId, [...rowIds], { [first.key]: first.value } as RequirementBulkChanges);
      return { saved: result.items.length, errors };
    } catch (error) {
      const message = errorText(error, "Save failed");
      for (const edit of edits) fail(edit.rowId, [edit.key], message);
      return { saved: 0, errors };
    }
  }
  const byRow = new Map<string, Record<string, unknown>>();
  for (const edit of edits) byRow.set(edit.rowId, { ...byRow.get(edit.rowId), [edit.key]: edit.value });
  let saved = 0;
  for (const [rowId, changes] of byRow) {
    try {
      await api.updateRequirement(rowId, changes as Partial<Requirement>);
      saved += 1;
    } catch (error) {
      fail(rowId, Object.keys(changes), errorText(error, "Save failed"));
    }
  }
  return { saved, errors };
}

/** Requirements with machine-checkable constraints, their trace links, and the verification matrix. */
export function RequirementsPage() {
  const {
    busy,
    canWrite,
    formErrors,
    runAction,
    selectedProjectId,
    selectedProject,
    requirements,
    refreshRequirements,
    selectedRequirementId,
    setSelectedRequirementId
  } = useWorkspace();
  const [requirementForm, setRequirementForm] = useState({ key: "FSDP-REQ-1", title: "Maintain pressure boundary compatibility", text: "All pressurized components shall be compatible with maximum expected operating pressure.", requirement_type: "safety", verification_method: "analysis", status: "draft" });
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bulkOwner, setBulkOwner] = useState("");
  const [importer, setImporter] = useState<{ key: number; rows?: ImportSourceRows } | null>(null);
  const [constraintForm, setConstraintForm] = useState<ConstraintForm>({ kind: "", values: "", services: "", categories: "" });
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState("");
  const [verificationMatrix, setVerificationMatrix] = useState<VerificationMatrix | null>(null);
  const [traceLinks, setTraceLinks] = useState<TraceLink[]>([]);
  // Tagged items on the project's saved sheets: trace-link targets.
  const [sheetItems, setSheetItems] = useState<ProjectSheetItem[]>([]);
  const [itemFilter, setItemFilter] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  // Tags of legacy components that old trace links still point to (read-only).
  const [legacyComponents, setLegacyComponents] = useState<{ projectId: string; tags: Map<string, string> } | null>(null);

  // Current selections for async actions: a response for a previous selection
  // must not overwrite what is on screen now.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedRequirementIdRef = useRef(selectedRequirementId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedRequirementIdRef.current = selectedRequirementId;
  }, [selectedProjectId, selectedRequirementId]);

  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const itemsById = useMemo(() => new Map(sheetItems.map((item) => [item.id, item])), [sheetItems]);
  const selectedItem = itemsById.get(selectedItemId) ?? null;
  const itemGroups = useMemo(() => groupItemsByDrawing(sheetItems, itemFilter), [sheetItems, itemFilter]);

  useEffect(() => {
    // Clear first: the previous requirement's links (and their Remove
    // buttons) must not be shown under the newly selected requirement.
    setTraceLinks([]);
    if (!selectedRequirementId) return;
    let cancelled = false;
    api
      .listTraceLinks("requirement", selectedRequirementId)
      .then((links) => {
        if (!cancelled) setTraceLinks(links);
      })
      .catch(() => {
        if (!cancelled) setTraceLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRequirementId]);

  // Old links to legacy components show the component's tag; load the tags once per project when needed.
  const needsLegacyTags = traceLinks.some((link) => link.source_type === "component" || link.target_type === "component");
  useEffect(() => {
    if (!needsLegacyTags || !selectedProjectId || legacyComponents?.projectId === selectedProjectId) return;
    let cancelled = false;
    const projectId = selectedProjectId;
    api
      .listProjectDiagrams(projectId)
      .then((diagrams) => Promise.all(diagrams.map((diagram) => api.listComponents(diagram.id).then((components) => components.map((component) => [component.id, `${component.tag} (${diagram.name})`] as const)))))
      .then((entries) => {
        if (!cancelled) setLegacyComponents({ projectId, tags: new Map(entries.flat()) });
      })
      .catch(() => {
        if (!cancelled) setLegacyComponents({ projectId, tags: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, [needsLegacyTags, selectedProjectId, legacyComponents?.projectId]);

  // Drawings of the project (trace-link targets) and the verification matrix.
  const refreshVerification = useCallback(async (projectId: string) => {
    const [nextDrawings, matrix] = await Promise.all([api.listDrawings(projectId), api.getVerificationMatrix(projectId)]);
    if (selectedProjectIdRef.current !== projectId) return;
    setDrawings(nextDrawings);
    setVerificationMatrix(matrix);
  }, []);
  useEffect(() => {
    if (!selectedProjectId) {
      setDrawings([]);
      setVerificationMatrix(null);
      setSheetItems([]);
      return;
    }
    let cancelled = false;
    const projectId = selectedProjectId;
    Promise.all([api.listDrawings(projectId), api.getVerificationMatrix(projectId)])
      .then(([nextDrawings, matrix]) => {
        if (cancelled) return;
        setDrawings(nextDrawings);
        setVerificationMatrix(matrix);
      })
      .catch(() => {
        if (cancelled) return;
        setDrawings([]);
        setVerificationMatrix(null);
      });
    api
      .listProjectSheetItems(projectId)
      .then((items) => {
        if (!cancelled) setSheetItems(items);
      })
      .catch(() => {
        if (!cancelled) setSheetItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, requirements]);

  useEffect(() => {
    if (selectedRequirement) {
      setRequirementForm({
        key: selectedRequirement.key,
        title: selectedRequirement.title,
        text: selectedRequirement.text,
        requirement_type: selectedRequirement.requirement_type,
        verification_method: selectedRequirement.verification_method ?? "",
        status: selectedRequirement.status
      });
      const constraint = selectedRequirement.constraint;
      setConstraintForm({
        kind: constraint?.kind ?? "",
        values: constraint?.values.join(", ") ?? "",
        services: constraint?.scope?.services?.join(", ") ?? "",
        categories: constraint?.scope?.categories?.join(", ") ?? ""
      });
    }
  }, [selectedRequirement]);

  /** Requirement constraint from the form: kind plus comma-separated values and scope. */
  function constraintPayload(): RequirementConstraintRead | null {
    if (!constraintForm.kind) return null;
    const split = (text: string) => text.split(",").map((entry) => entry.trim()).filter(Boolean);
    const scope: RequirementConstraintRead["scope"] = {};
    if (split(constraintForm.services).length) scope.services = split(constraintForm.services);
    if (split(constraintForm.categories).length) scope.categories = split(constraintForm.categories);
    return { kind: constraintForm.kind, values: split(constraintForm.values), scope };
  }

  function submitRequirement(event: FormEvent) {
    event.preventDefault();
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    void runAction("Created requirement.", async () => {
      const requirement = await api.createRequirement({ ...requirementForm, status: requirementForm.status || "draft", project_id: projectId, constraint: constraintPayload() });
      await refreshRequirements(projectId);
      if (selectedProjectIdRef.current === projectId) setSelectedRequirementId(requirement.id);
    }, "requirement");
  }

  function updateRequirement() {
    if (!selectedProject || !selectedRequirement) return;
    void runAction("Updated requirement.", async () => {
      await api.updateRequirement(selectedRequirement.id, { ...requirementForm, status: requirementForm.status || undefined, constraint: constraintPayload() });
      await refreshRequirements(selectedProject.id);
    }, "requirement");
  }

  function deleteRequirement() {
    if (!selectedProject || !selectedRequirement || !window.confirm(`Delete requirement "${selectedRequirement.key}"?`)) return;
    const projectId = selectedProject.id;
    void runAction("Deleted requirement.", async () => {
      await api.deleteRequirement(selectedRequirement.id);
      const next = await refreshRequirements(projectId);
      if (selectedProjectIdRef.current === projectId) setSelectedRequirementId(next[0]?.id || "");
    });
  }

  /** Reload a requirement's trace links unless the selection moved on meanwhile. */
  async function reloadTraceLinks(requirementId: string) {
    const links = await api.listTraceLinks("requirement", requirementId);
    if (selectedRequirementIdRef.current === requirementId) setTraceLinks(links);
  }

  function linkRequirementToItem() {
    if (!selectedRequirement || !selectedItem) return;
    const requirementId = selectedRequirement.id;
    const item = selectedItem;
    void runAction(`Linked ${selectedRequirement.key} to ${item.tag}.`, async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: requirementId, target_type: "sheet_item", target_id: item.id, link_type: "satisfied_by" });
      await reloadTraceLinks(requirementId);
      await refreshVerification(selectedRequirement.project_id);
    }, "traceLink");
  }

  /** The end of a trace link that is not the selected requirement, described for the table. */
  function describeLinkTarget(link: TraceLink): { text: string; legacy: boolean; href?: string } {
    const ownEnd = link.source_type === "requirement" && link.source_id === selectedRequirementId;
    const type = ownEnd ? link.target_type : link.source_type;
    const id = ownEnd ? link.target_id : link.source_id;
    if (type === "drawing") {
      const drawing = drawings.find((entry) => entry.id === id);
      if (!drawing) return { text: "Drawing (deleted)", legacy: false };
      return { text: `Drawing ${drawing.number} · ${drawing.title.split("\n")[0]}`, legacy: false, href: draftingHref({ projectId: drawing.project_id, drawingId: drawing.id }) };
    }
    if (type === "sheet_item") {
      const item = itemsById.get(id);
      if (!item) return { text: "Drawing item (untagged)", legacy: false };
      return {
        text: `${item.drawing_number} sheet ${item.sheet_no} · ${item.tag}${item.zone ? ` @ ${item.zone}` : ""}`,
        legacy: false,
        href: draftingHref({ projectId: selectedProjectId, drawingId: item.drawing_id, sheetId: item.sheet_id, itemId: item.item_id })
      };
    }
    if (type === "component") {
      const tag = legacyComponents?.projectId === selectedProjectId ? legacyComponents.tags.get(id) : undefined;
      return { text: `Legacy component ${tag ?? id.slice(0, 8)}`, legacy: true };
    }
    return { text: `${type.replace("_", " ")} ${id.slice(0, 8)}`, legacy: false };
  }

  function linkRequirementToDrawing() {
    if (!selectedRequirement || !selectedDrawingId) return;
    const requirementId = selectedRequirement.id;
    void runAction("Linked requirement to drawing.", async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: requirementId, target_type: "drawing", target_id: selectedDrawingId, link_type: "verified_by" });
      await reloadTraceLinks(requirementId);
      await refreshVerification(selectedRequirement.project_id);
    }, "traceLink");
  }

  function removeTraceLink(linkId: string) {
    if (!selectedRequirement) return;
    const requirementId = selectedRequirement.id;
    void runAction("Removed trace link.", async () => {
      await api.deleteTraceLink(linkId);
      await reloadTraceLinks(requirementId);
    });
  }

  /* ---------- Requirements grid ---------- */

  const rows = requirements as RequirementRow[];
  const typeOptions = useMemo(() => withExisting(TYPE_VALUES, requirements.map((row) => row.requirement_type)), [requirements]);
  const methodOptions = useMemo(
    () => withExisting(METHOD_VALUES, requirements.map((row) => row.verification_method)),
    [requirements]
  );
  const statusOptions = useMemo(() => withExisting(STATUS_VALUES, requirements.map((row) => row.status)), [requirements]);
  const columns = useMemo(
    () => requirementColumns({ types: typeOptions, methods: methodOptions, statuses: statusOptions }, (row) => setSelectedRequirementId(row.id)),
    [typeOptions, methodOptions, statusOptions, setSelectedRequirementId]
  );
  const matrixRows = useMemo<MatrixRow[]>(() => {
    const methods = new Map(requirements.map((row) => [row.id, row.verification_method ?? null]));
    return (verificationMatrix?.rows ?? []).map((row) => ({ ...row, verification_method: methods.get(row.requirement_id) ?? null }));
  }, [verificationMatrix, requirements]);
  const matrixGridColumns = useMemo(
    () => matrixColumns(methodOptions, (row) => setSelectedRequirementId(row.requirement_id)),
    [methodOptions, setSelectedRequirementId]
  );

  async function commitEdits(edits: DataGridEdit[]): Promise<DataGridCommitResult> {
    const projectId = selectedProjectId;
    const { saved, errors } = await saveRequirementEdits(projectId, edits);
    if (saved) await refreshRequirements(projectId);
    return Object.keys(errors).length ? { errors } : undefined;
  }

  function bulkSet(selected: RequirementRow[], changes: RequirementBulkChanges, what: string) {
    const projectId = selectedProjectId;
    setNotice(null);
    void runAction(`${what} saved.`, async () => {
      const result = await bulkUpdateRequirements(projectId, selected.map((row) => row.id), changes);
      await refreshRequirements(projectId);
      setNotice({
        text: `${what}: updated ${result.updated} requirement${result.updated === 1 ? "" : "s"}${
          result.unchanged ? `, ${result.unchanged} already set` : ""
        }.`
      });
    }, "requirementsGrid");
  }

  function bulkDelete(selected: RequirementRow[]) {
    const count = selected.length;
    if (!window.confirm(`Delete ${count} requirement${count === 1 ? "" : "s"} and their trace links?`)) return;
    const projectId = selectedProjectId;
    const labels = new Map(selected.map((row) => [row.id, row.key]));
    setNotice(null);
    void runAction("Deleted requirements.", async () => {
      const result = await bulkDeleteRequirements(projectId, selected.map((row) => row.id));
      const next = await refreshRequirements(projectId);
      const refused = result.results.filter((entry) => !entry.deleted);
      setCheckedIds(refused.map((entry) => entry.id));
      if (selectedProjectIdRef.current === projectId && !next.some((row) => row.id === selectedRequirementIdRef.current)) {
        setSelectedRequirementId(next[0]?.id || "");
      }
      setNotice({
        text: `Deleted ${result.deleted} requirement${result.deleted === 1 ? "" : "s"}${refused.length ? `; ${refused.length} refused` : ""}.`,
        refusals: refused.map((entry) => ({ id: entry.id, label: labels.get(entry.id) ?? entry.id, reason: entry.reason ?? "Refused" }))
      });
    }, "requirementsGrid");
  }

  function openImport(rowsToImport?: ImportSourceRows) {
    setNotice(null);
    setImporter((current) => ({ key: (current?.key ?? 0) + 1, rows: rowsToImport }));
  }

  function exportXlsx<T>(title: string, fileName: string, exportRows: T[], visible: DataGridColumn<T>[]) {
    exportGridXlsx({ title, fileName, rows: exportRows, columns: visible }).catch((err: unknown) =>
      setNotice({ text: errorText(err, "XLSX export failed.") })
    );
  }

  const projectLabel = selectedProject ? `${selectedProject.name} ` : "";

  const bulkActions = (selected: RequirementRow[]) => (
    <>
      <select
        aria-label="Set status"
        className="bulkSelect"
        disabled={busy}
        value=""
        onChange={(event) => event.target.value && bulkSet(selected, { status: event.target.value }, "Status")}
      >
        <option value="">Set status…</option>
        {statusOptions.map((value) => (
          <option key={value} value={value}>
            {value.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <select
        aria-label="Set verification method"
        className="bulkSelect"
        disabled={busy}
        value=""
        onChange={(event) => event.target.value && bulkSet(selected, { verification_method: event.target.value }, "Verification method")}
      >
        <option value="">Set verification…</option>
        {methodOptions.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <input
        aria-label="Owner for selected"
        className="bulkInput"
        placeholder="Owner (blank clears)"
        value={bulkOwner}
        onChange={(event) => setBulkOwner(event.target.value)}
      />
      <button type="button" className="dgButton" disabled={busy} onClick={() => bulkSet(selected, { owner: bulkOwner.trim() || null }, "Owner")}>
        Set owner
      </button>
      <button type="button" className="dgButton danger" disabled={busy} onClick={() => bulkDelete(selected)}>
        Delete…
      </button>
    </>
  );

  return (
    <PageLayout title="Requirements" description="Traceable requirements">
      <section className="grid">
        <Panel
          title="Requirements"
          className="panelWide"
          actions={
            canWrite && selectedProject ? (
              <span className="panelActions">
                <button type="button" onClick={() => openImport()}>
                  Import…
                </button>
              </span>
            ) : null
          }
        >
          {notice && (
            <div className="bulkNotice" role="status">
              <div>
                <span>{notice.text}</span>
                {notice.refusals && notice.refusals.length > 0 && (
                  <ul aria-label="Refused">
                    {notice.refusals.map((entry) => (
                      <li key={entry.id}>
                        <span className="mono">{entry.label}</span>: {entry.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" className="modalClose" aria-label="Dismiss notice" onClick={() => setNotice(null)}>
                ×
              </button>
            </div>
          )}
          <FormError message={formErrors.requirementsGrid} />
          <DataGrid
            ariaLabel="Requirements"
            bulkActions={canWrite ? bulkActions : undefined}
            columns={columns}
            defaultSort={[{ key: "key", dir: "asc" }]}
            emptyMessage={
              selectedProject
                ? canWrite
                  ? "No requirements yet. Create one in the editor, or import a CSV/XLSX file."
                  : "No requirements yet."
                : "Select a project to see its requirements."
            }
            exportFileName="requirements"
            getRowId={(row) => row.id}
            height={420}
            onCommit={canWrite && selectedProject ? commitEdits : undefined}
            onExportXlsx={(exportRows, visible) => exportXlsx(`${projectLabel}requirements`, "requirements", exportRows, visible)}
            onPasteNewRows={canWrite && selectedProject ? (records) => openImport(pastedImportRows(records)) : undefined}
            onRowActivate={(row) => setSelectedRequirementId(row.id)}
            onSelectionChange={setCheckedIds}
            rowClassName={(row) => (row.id === selectedRequirementId ? "gridRowOpen" : undefined)}
            rows={rows}
            selectedIds={checkedIds}
            storageKey="requirements.list"
          />
          {importer && selectedProject && (
            <ImportWizard
              canWrite={canWrite}
              downloadTemplate={(format) => downloadRequirementsImportTemplate(selectedProject.id, format)}
              entityLabel="requirements"
              fieldLabels={IMPORT_FIELD_LABELS}
              initialRows={importer.rows}
              key={importer.key}
              keyLabel="key"
              onClose={() => setImporter(null)}
              onImported={async (report) => {
                await refreshRequirements(selectedProject.id);
                setNotice({
                  text: `Imported requirements: ${report.summary.create} created, ${report.summary.update} updated, ${report.summary.unchanged} unchanged.`
                });
              }}
              runImport={(source, options) => importRequirements(selectedProject.id, source, options)}
            />
          )}
        </Panel>
        <Panel title="Requirement Editor">
          <form onSubmit={submitRequirement}>
            <TextInput label="Key" value={requirementForm.key} onChange={(key) => setRequirementForm({ ...requirementForm, key })} />
            <TextInput label="Title" value={requirementForm.title} onChange={(title) => setRequirementForm({ ...requirementForm, title })} />
            <TextInput label="Type" value={requirementForm.requirement_type} onChange={(requirementType) => setRequirementForm({ ...requirementForm, requirement_type: requirementType })} />
            <TextInput label="Verification" value={requirementForm.verification_method} onChange={(verificationMethod) => setRequirementForm({ ...requirementForm, verification_method: verificationMethod })} />
            <Select label="Status" value={requirementForm.status} options={statusOptions.map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(status) => setRequirementForm({ ...requirementForm, status })} />
            <TextArea label="Text" value={requirementForm.text} onChange={(text) => setRequirementForm({ ...requirementForm, text })} />
            <Select
              label="Constraint (checked by the drawing DRC)"
              value={constraintForm.kind}
              options={[
                { value: "material_in", label: "Part material must be one of…" },
                { value: "material_not_in", label: "Part material must not be…" },
                { value: "pressure_rating_min", label: "Part rating at least (bar)" },
                { value: "part_qualified", label: "Parts must be qualified or preferred" },
                { value: "line_class_in", label: "Line class must be one of…" },
                { value: "relief_required", label: "Every isolable volume has relief" }
              ]}
              onChange={(kind) => setConstraintForm({ ...constraintForm, kind: kind as ConstraintForm["kind"] })}
            />
            {constraintForm.kind && constraintForm.kind !== "part_qualified" && constraintForm.kind !== "relief_required" && (
              <TextInput label="Constraint values (comma separated)" value={constraintForm.values} onChange={(values) => setConstraintForm({ ...constraintForm, values })} />
            )}
            {constraintForm.kind && constraintForm.kind !== "relief_required" && (
              <TextInput label="Scope: services (comma separated, blank = all)" value={constraintForm.services} onChange={(services) => setConstraintForm({ ...constraintForm, services })} />
            )}
            {constraintForm.kind && constraintForm.kind !== "relief_required" && constraintForm.kind !== "line_class_in" && (
              <TextInput label="Scope: symbol categories (blank = valves, regulators, inline, instruments, equipment)" value={constraintForm.categories} onChange={(categories) => setConstraintForm({ ...constraintForm, categories })} />
            )}
            <FormError message={formErrors.requirement} />
            <button disabled={busy || !selectedProject || !requirementForm.key}>Create requirement</button>
          </form>
          <div className="buttonRow"><button disabled={!selectedRequirement} onClick={updateRequirement}>Update selected</button><button className="danger" disabled={!selectedRequirement} onClick={deleteRequirement}>Delete selected</button></div>
        </Panel>
        <Panel title="Trace Links">
          <TextInput label="Find drawing item" value={itemFilter} onChange={setItemFilter} />
          <label>
            Drawing item
            <select value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)}>
              <option value="">{sheetItems.length ? "Choose a tagged item…" : "No tagged items on saved sheets"}</option>
              {itemGroups.map((group) => (
                <optgroup key={group.drawingId} label={group.label}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.tag} · sheet {item.sheet_no}
                      {item.zone ? ` @ ${item.zone}` : ""}
                      {item.symbol_name ? ` (${item.symbol_name})` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="primary" disabled={!selectedRequirement || !selectedItem} onClick={linkRequirementToItem}>Link requirement to item</button>
          {!sheetItems.length && <p className="hint">Tag symbols on the Drafting page and save the sheet to link requirements to them.</p>}
          <Select label="Drawing" value={selectedDrawingId} options={drawings.map((drawing) => ({ value: drawing.id, label: `${drawing.number} · ${drawing.title.split("\n")[0]}` }))} onChange={setSelectedDrawingId} />
          <button disabled={!selectedRequirement || !selectedDrawingId} onClick={linkRequirementToDrawing}>Link requirement to whole drawing</button>
          <FormError message={formErrors.traceLink} />
          {selectedRequirement && (
            traceLinks.length
              ? (
                <DataTable
                  rows={traceLinks}
                  getKey={(link) => link.id}
                  columns={[
                    { header: "Link", render: (link) => <span className="mono">{link.link_type}</span> },
                    {
                      header: "Target",
                      render: (link) => {
                        const target = describeLinkTarget(link);
                        if (target.href) {
                          return (
                            <Link className="mono" to={target.href} title="Open in Drafting">
                              {target.text}
                            </Link>
                          );
                        }
                        return (
                          <span className="mono" title={target.legacy ? "From the retired Diagrams editor; read-only" : undefined}>
                            {target.text}
                            {target.legacy && <span className="hint"> · read-only</span>}
                          </span>
                        );
                      }
                    },
                    { header: "", render: (link) => <button className="danger" disabled={busy} onClick={() => removeTraceLink(link.id)}>Remove</button> }
                  ]}
                />
              )
              : <p className="hint">No trace links for {selectedRequirement.key} yet.</p>
          )}
        </Panel>
        <Panel title="Verification Matrix" className="panelWide">
          {matrixRows.length ? (
            <DataGrid
              ariaLabel="Verification matrix"
              columns={matrixGridColumns}
              defaultSort={[{ key: "key", dir: "asc" }]}
              exportFileName="verification-matrix"
              getRowId={(row) => row.requirement_id}
              height={360}
              onExportXlsx={(exportRows, visible) => exportXlsx(`${projectLabel}verification matrix`, "verification-matrix", exportRows, visible)}
              onRowActivate={(row) => setSelectedRequirementId(row.requirement_id)}
              rowClassName={(row) => (row.requirement_id === selectedRequirementId ? "gridRowOpen" : undefined)}
              rows={matrixRows}
              selectable={false}
              storageKey="requirements.matrix"
            />
          ) : (
            <p className="hint">Requirements with a constraint are checked against every saved drawing sheet; open a drawing on the Drafting page and save it to populate the matrix.</p>
          )}
        </Panel>
      </section>
    </PageLayout>
  );
}

/** Sheet items grouped by drawing for the picker, filtered by tag, drawing number, title, or symbol name. */
function groupItemsByDrawing(items: ProjectSheetItem[], filter: string): Array<{ drawingId: string; label: string; items: ProjectSheetItem[] }> {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, { drawingId: string; label: string; items: ProjectSheetItem[] }>();
  for (const item of items) {
    const haystack = `${item.tag} ${item.drawing_number} ${item.drawing_title} ${item.symbol_name ?? ""} ${item.label ?? ""}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const group = groups.get(item.drawing_id) ?? { drawingId: item.drawing_id, label: `${item.drawing_number} · ${item.drawing_title}`, items: [] };
    group.items.push(item);
    groups.set(item.drawing_id, group);
  }
  return [...groups.values()];
}

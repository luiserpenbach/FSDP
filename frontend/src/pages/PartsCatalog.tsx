import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { api, bulkDeleteParts, bulkUpdateParts, downloadPartsImportTemplate, importParts } from "../api";
import {
  DataGrid,
  type DataGridCellErrors,
  type DataGridColumn,
  type DataGridCommitResult,
  type DataGridEdit
} from "../components/datagrid";
import { exportGridXlsx } from "../components/gridXlsx";
import { ImportWizard, type ImportSourceRows } from "../components/ImportWizard";
import { PanelResizer, useStoredWidth } from "../components/resizable";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type { CatalogDocument, CatalogSettings, Part, PartBulkChanges, PartUsage } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

const LIFECYCLE_OPTIONS = ["draft", "active", "legacy", "restricted", "obsolete"].map((value) => ({
  value,
  label: value
}));
const QUALIFICATION_OPTIONS = ["unqualified", "in_qualification", "qualified", "disqualified"].map(
  (value) => ({ value, label: value.replaceAll("_", " ") })
);
const CERTIFICATION_OPTIONS = ["unreviewed", "in_review", "certified", "rejected", "expired"].map(
  (value) => ({ value, label: value.replaceAll("_", " ") })
);
const SOURCE_OPTIONS = ["internal", "vendor", "custom"].map((value) => ({ value, label: value }));
const DOCUMENT_KINDS = ["datasheet", "drawing", "cad", "coc", "test_report", "memo", "photo", "other"];

/** Fields PATCH /parts/bulk may set; other fields go through PUT /parts/{id}. */
const BULK_FIELDS = new Set<string>([
  "manufacturer",
  "part_type",
  "source_type",
  "material",
  "pressure_rating_bar",
  "temperature_min_c",
  "temperature_max_c",
  "cv",
  "mass_kg",
  "certification_status",
  "qualification_status",
  "lifecycle_status",
  "preferred",
  "notes"
]);

/** Grid columns that are not import fields (derived), left out of pasted rows sent to the import. */
const DERIVED_COLUMNS = new Set(["completeness"]);

const IMPORT_FIELD_LABELS: Record<string, string> = {
  part_number: "Part number",
  revision: "Rev",
  pressure_rating_bar: "Pressure (bar)",
  temperature_min_c: "T min (°C)",
  temperature_max_c: "T max (°C)",
  cv: "Cv",
  mass_kg: "Mass (kg)",
  part_type: "Type",
  source_type: "Source",
  lifecycle_status: "Lifecycle",
  qualification_status: "Qualification",
  certification_status: "Certification"
};

const EMPTY_FORM = {
  part_number: "",
  description: "",
  part_type: "valve",
  source_type: "internal",
  manufacturer: "",
  material: "",
  revision: "",
  pressure_rating_bar: "",
  temperature_min_c: "",
  temperature_max_c: "",
  cv: "",
  mass_kg: "",
  qualification_status: "unqualified",
  certification_status: "unreviewed",
  lifecycle_status: "draft",
  preferred: false,
  notes: ""
};

type PartForm = typeof EMPTY_FORM;

type Notice = { text: string; refusals?: Array<{ id: string; label: string; reason: string }> };

function dash(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  return String(value);
}

function parseOptionalNumber(raw: string, label: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number (leave empty if unknown).`);
  }
  return parsed;
}

function formFromPart(part: Part): PartForm {
  return {
    part_number: part.part_number,
    description: part.description,
    part_type: part.part_type,
    source_type: part.source_type || "internal",
    manufacturer: part.manufacturer ?? "",
    material: part.material ?? "",
    revision: part.revision ?? "",
    pressure_rating_bar: part.pressure_rating_bar == null ? "" : String(part.pressure_rating_bar),
    temperature_min_c: part.temperature_min_c == null ? "" : String(part.temperature_min_c),
    temperature_max_c: part.temperature_max_c == null ? "" : String(part.temperature_max_c),
    cv: part.cv == null ? "" : String(part.cv),
    mass_kg: part.mass_kg == null ? "" : String(part.mass_kg),
    qualification_status: part.qualification_status,
    certification_status: part.certification_status,
    lifecycle_status: part.lifecycle_status || "draft",
    preferred: Boolean(part.preferred),
    notes: part.notes ?? ""
  };
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="catalogDetail">
      <span>{label}</span>
      <strong>{children}</strong>
    </p>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/* ---------- Grid cell parsing / validation ---------- */

const optionalText = (text: string) => (text.trim() === "" ? null : text.trim());

const required = (name: string) => (value: unknown) =>
  value === null || value === undefined || String(value).trim() === "" ? `${name} is required` : null;

const notNegative = (name: string) => (value: unknown) =>
  typeof value === "number" && value < 0 ? `${name} must be 0 or more` : null;

/** Part types are user-defined: match a known type case-insensitively, otherwise take the text as a new type. */
function parsePartType(options: string[]) {
  return (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return options.find((option) => option.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
  };
}

function partColumns(typeOptions: string[], onOpen: (part: Part) => void): DataGridColumn<Part>[] {
  const pill = (_part: Part, value: unknown) => (value ? <StatusPill value={String(value)} /> : null);
  return [
    {
      key: "part_number",
      header: "Part number",
      frozen: true,
      hideable: false,
      mono: true,
      width: 150,
      render: (part) => (
        <button type="button" className="linkButton mono gridLink" title="Open part details" onClick={() => onOpen(part)}>
          {part.part_number}
        </button>
      )
    },
    { key: "description", header: "Description", width: 240, editable: true, parse: (text) => text.trim(), validate: required("Description") },
    {
      key: "part_type",
      header: "Type",
      type: "enum",
      options: typeOptions,
      width: 120,
      editable: true,
      parse: parsePartType(typeOptions),
      validate: required("Type")
    },
    { key: "source_type", header: "Source", type: "enum", options: SOURCE_OPTIONS, width: 100, editable: true, hidden: true, validate: required("Source") },
    { key: "revision", header: "Rev", width: 70, editable: true, hidden: true, parse: optionalText },
    { key: "manufacturer", header: "Manufacturer", width: 150, editable: true, parse: optionalText },
    { key: "material", header: "Material", width: 110, editable: true, parse: optionalText },
    {
      key: "pressure_rating_bar",
      header: "Pressure (bar)",
      type: "number",
      width: 115,
      editable: true,
      validate: notNegative("Pressure rating")
    },
    { key: "temperature_min_c", header: "T min (°C)", type: "number", width: 95, editable: true },
    { key: "temperature_max_c", header: "T max (°C)", type: "number", width: 95, editable: true },
    { key: "cv", header: "Cv", type: "number", width: 80, editable: true, hidden: true, validate: notNegative("Cv") },
    { key: "mass_kg", header: "Mass (kg)", type: "number", width: 95, editable: true, hidden: true, validate: notNegative("Mass") },
    {
      key: "lifecycle_status",
      header: "Lifecycle",
      type: "enum",
      options: LIFECYCLE_OPTIONS,
      width: 115,
      editable: true,
      render: pill,
      validate: required("Lifecycle")
    },
    {
      key: "qualification_status",
      header: "Qualification",
      type: "enum",
      options: QUALIFICATION_OPTIONS,
      width: 135,
      editable: true,
      render: pill,
      validate: required("Qualification")
    },
    {
      key: "certification_status",
      header: "Certification",
      type: "enum",
      options: CERTIFICATION_OPTIONS,
      width: 125,
      editable: true,
      render: pill,
      validate: required("Certification")
    },
    { key: "preferred", header: "Preferred", type: "boolean", width: 90, editable: true },
    { key: "completeness", header: "Complete %", type: "number", width: 100 },
    { key: "notes", header: "Notes", width: 220, editable: true, hidden: true, parse: optionalText }
  ];
}

/** Rows pasted below the grid (keyed by column) -> import rows with field-name headers. */
function pastedImportRows(records: Array<Record<string, string>>): ImportSourceRows {
  const headers: string[] = [];
  for (const record of records)
    for (const key of Object.keys(record)) if (!DERIVED_COLUMNS.has(key) && !headers.includes(key)) headers.push(key);
  return { headers, rows: records.map((record) => headers.map((header) => record[header] ?? "")) };
}

/**
 * Save grid edits. One field set to the same value on several parts goes through the
 * bulk endpoint (one transaction); anything else is saved part by part, so one bad
 * row only rolls back its own cells. Returns per-cell errors and the saved parts.
 */
async function saveEdits(edits: DataGridEdit[]): Promise<{ saved: Part[]; errors: DataGridCellErrors }> {
  const errors: DataGridCellErrors = {};
  const saved: Part[] = [];
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
      const result = await bulkUpdateParts([...rowIds], { [first.key]: first.value } as PartBulkChanges);
      saved.push(...result.items);
    } catch (error) {
      const message = errorText(error, "Save failed");
      for (const edit of edits) fail(edit.rowId, [edit.key], message);
    }
    return { saved, errors };
  }
  const byRow = new Map<string, Record<string, unknown>>();
  for (const edit of edits) byRow.set(edit.rowId, { ...byRow.get(edit.rowId), [edit.key]: edit.value });
  for (const [rowId, changes] of byRow) {
    try {
      saved.push(await api.updatePart(rowId, changes as Partial<Part>));
    } catch (error) {
      fail(rowId, Object.keys(changes), errorText(error, "Save failed"));
    }
  }
  return { saved, errors };
}

export function PartsCatalog({
  parts,
  selectedPartId,
  projectId,
  canWrite = true,
  onSelectPart,
  onPartsChanged
}: {
  parts: Part[];
  selectedPartId: string;
  projectId?: string;
  /** Engineers and admins edit; viewers get a read-only grid (sort, filter, copy, export). */
  canWrite?: boolean;
  onSelectPart: (partId: string) => void;
  onPartsChanged: (parts: Part[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [catalogSettings, setCatalogSettings] = useState<CatalogSettings | null>(null);
  const [usage, setUsage] = useState<PartUsage | null>(null);
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadKind, setUploadKind] = useState("datasheet");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [importer, setImporter] = useState<{ key: number; rows?: ImportSourceRows } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useStoredWidth("fsdp.catalogInspectorWidth", 320, 260, 440);

  // Latest parts for async saves: a commit that resolves after another one must
  // merge into the newest list, not the one it started from.
  const partsRef = useRef(parts);
  useEffect(() => {
    partsRef.current = parts;
  }, [parts]);

  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const knownTypes = useMemo(() => {
    const fromSettings = catalogSettings?.part_types ?? [];
    return Array.from(new Set([...fromSettings, ...parts.map((part) => part.part_type)].filter(Boolean))).sort();
  }, [catalogSettings, parts]);
  const typeOptions = useMemo(
    () => Array.from(new Set([...knownTypes, form.part_type].filter(Boolean))).sort(),
    [knownTypes, form.part_type]
  );
  const columns = useMemo(() => partColumns(knownTypes, (part) => onSelectPart(part.id)), [knownTypes, onSelectPart]);

  useEffect(() => {
    void api.getCatalogSettings().then(setCatalogSettings).catch(() => undefined);
  }, []);

  // Keyed by id, and responses for a part that is no longer selected are
  // dropped: another part's documents (and their Remove buttons) must never
  // show under the current one.
  const selectedId = selectedPart?.id ?? "";
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    setUsage(null);
    setDocuments([]);
    if (!selectedId) return;
    let cancelled = false;
    api
      .getPartUsage(selectedId)
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    api
      .listPartDocuments(selectedId)
      .then((next) => {
        if (!cancelled) setDocuments(next);
      })
      .catch(() => {
        if (!cancelled) setDocuments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function reloadDocuments(partId: string) {
    const next = await api.listPartDocuments(partId);
    if (selectedIdRef.current === partId) setDocuments(next);
  }

  async function run(message: string, work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : message);
    } finally {
      setBusy(false);
    }
  }

  /** Replace saved parts in the current list. */
  function mergeParts(saved: Part[]) {
    if (!saved.length) return;
    const byId = new Map(saved.map((part) => [part.id, part]));
    onPartsChanged(partsRef.current.map((part) => byId.get(part.id) ?? part));
  }

  async function commitEdits(edits: DataGridEdit[]): Promise<DataGridCommitResult> {
    const { saved, errors } = await saveEdits(edits);
    mergeParts(saved);
    return Object.keys(errors).length ? { errors } : undefined;
  }

  function bulkSet(selected: Part[], changes: PartBulkChanges, what: string) {
    const ids = selected.map((part) => part.id);
    setNotice(null);
    void run("Bulk edit failed.", async () => {
      const result = await bulkUpdateParts(ids, changes);
      mergeParts(result.items);
      setNotice({
        text: `${what}: updated ${result.updated} part${result.updated === 1 ? "" : "s"}${
          result.unchanged ? `, ${result.unchanged} already set` : ""
        }.`
      });
    });
  }

  function bulkDelete(selected: Part[]) {
    const count = selected.length;
    if (!window.confirm(`Delete ${count} part${count === 1 ? "" : "s"}? Parts placed on drawings are kept and reported.`)) return;
    const labels = new Map(selected.map((part) => [part.id, part.part_number]));
    setNotice(null);
    void run("Bulk delete failed.", async () => {
      const result = await bulkDeleteParts(selected.map((part) => part.id));
      onPartsChanged(await api.listParts());
      const refused = result.results.filter((entry) => !entry.deleted);
      // Keep the refused parts selected so they can be marked obsolete instead.
      setCheckedIds(refused.map((entry) => entry.id));
      if (result.results.some((entry) => entry.deleted && entry.id === selectedPartId)) onSelectPart("");
      setNotice({
        text: `Deleted ${result.deleted} part${result.deleted === 1 ? "" : "s"}${refused.length ? `; ${refused.length} refused` : ""}.`,
        refusals: refused.map((entry) => ({
          id: entry.id,
          label: labels.get(entry.id) ?? entry.id,
          reason: entry.reason ?? "Refused"
        }))
      });
    });
  }

  function openImport(rows?: ImportSourceRows) {
    setNotice(null);
    setImporter((current) => ({ key: (current?.key ?? 0) + 1, rows }));
  }

  function payload() {
    return {
      part_number: form.part_number,
      description: form.description,
      part_type: form.part_type,
      source_type: form.source_type,
      manufacturer: form.manufacturer || undefined,
      material: form.material || undefined,
      revision: form.revision || undefined,
      pressure_rating_bar: parseOptionalNumber(form.pressure_rating_bar, "Pressure rating"),
      temperature_min_c: parseOptionalNumber(form.temperature_min_c, "Temperature min"),
      temperature_max_c: parseOptionalNumber(form.temperature_max_c, "Temperature max"),
      cv: parseOptionalNumber(form.cv, "Cv"),
      mass_kg: parseOptionalNumber(form.mass_kg, "Mass"),
      qualification_status: form.qualification_status,
      certification_status: form.certification_status,
      lifecycle_status: form.lifecycle_status,
      preferred: form.preferred,
      notes: form.notes || undefined
    };
  }

  function openCreate() {
    setError("");
    setForm(EMPTY_FORM);
    setEditorMode("create");
    setEditorOpen(true);
  }

  function openEdit() {
    if (!selectedPart) return;
    setError("");
    setForm(formFromPart(selectedPart));
    setEditorMode("edit");
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setError("");
  }

  function submitPart(event: FormEvent) {
    event.preventDefault();
    void run("Saved part.", async () => {
      if (editorMode === "create") {
        const part = await api.createPart(payload());
        onPartsChanged(await api.listParts());
        onSelectPart(part.id);
      } else if (selectedPart) {
        await api.updatePart(selectedPart.id, payload());
        onPartsChanged(await api.listParts());
      }
      setEditorOpen(false);
    });
  }

  function deleteSelected() {
    if (!selectedPart || !window.confirm(`Delete part "${selectedPart.part_number}"?`)) return;
    void run("Deleted part.", async () => {
      await api.deletePart(selectedPart.id);
      const next = await api.listParts();
      onPartsChanged(next);
      onSelectPart(next[0]?.id || "");
    });
  }

  function obsoleteSelected() {
    if (!selectedPart || !window.confirm(`Mark "${selectedPart.part_number}" obsolete?`)) return;
    void run("Marked obsolete.", async () => {
      await api.obsoletePart(selectedPart.id);
      onPartsChanged(await api.listParts());
    });
  }

  function generateName() {
    void run("Generated name.", async () => {
      const generated = await api.generatePartName(projectId);
      setForm((current) => ({ ...current, part_number: generated.part_number }));
    });
  }

  function onUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file || !selectedPart) return;
    const partId = selectedPart.id;
    void run("Uploaded document.", async () => {
      await api.uploadPartDocument(partId, file, file.name, uploadKind);
      await reloadDocuments(partId);
    });
  }

  function exportXlsx(rows: Part[], visible: DataGridColumn<Part>[]) {
    setError("");
    exportGridXlsx({ title: "Parts catalog", fileName: "parts", rows, columns: visible }).catch((err: unknown) =>
      setError(errorText(err, "XLSX export failed."))
    );
  }

  const bulkActions = (selected: Part[]) =>
    canWrite ? (
      <>
        <select
          aria-label="Set lifecycle"
          className="bulkSelect"
          disabled={busy}
          value=""
          onChange={(event) => event.target.value && bulkSet(selected, { lifecycle_status: event.target.value }, "Lifecycle")}
        >
          <option value="">Set lifecycle…</option>
          {LIFECYCLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Set qualification"
          className="bulkSelect"
          disabled={busy}
          value=""
          onChange={(event) =>
            event.target.value && bulkSet(selected, { qualification_status: event.target.value }, "Qualification")
          }
        >
          <option value="">Set qualification…</option>
          {QUALIFICATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Set certification"
          className="bulkSelect"
          disabled={busy}
          value=""
          onChange={(event) =>
            event.target.value && bulkSet(selected, { certification_status: event.target.value }, "Certification")
          }
        >
          <option value="">Set certification…</option>
          {CERTIFICATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" className="dgButton" disabled={busy} onClick={() => bulkSet(selected, { preferred: true }, "Preferred on")}>
          Mark preferred
        </button>
        <button type="button" className="dgButton" disabled={busy} onClick={() => bulkSet(selected, { preferred: false }, "Preferred off")}>
          Clear preferred
        </button>
        <button type="button" className="dgButton danger" disabled={busy} onClick={() => bulkDelete(selected)}>
          Delete…
        </button>
      </>
    ) : null;

  return (
    <>
      <header className="catalogPageHeader">
        <h1>Parts</h1>
        <p className="hint catalogHint">
          {canWrite
            ? "Edit cells in place, paste blocks from Excel, select rows for bulk changes. Open a part number for where-used and documents."
            : "Sort, filter, copy and export the catalog. Open a part number for where-used and documents."}
        </p>
        <div className="catalogPageActions">
          {canWrite && (
            <>
              <button type="button" onClick={() => openImport()}>
                Import…
              </button>
              <button type="button" className="primary" onClick={openCreate}>
                + New part
              </button>
            </>
          )}
        </div>
      </header>
      {/* The edit modal shows its own errors; delete, obsolete, bulk, and document failures report here. */}
      {error && !editorOpen && (
        <div className="pageError" role="alert">
          <span>{error}</span>
          <button type="button" className="modalClose" aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
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
      <section className="catalogWorkspace">
      <article className="panel catalogLibrary">
        <DataGrid
          ariaLabel="Parts catalog"
          bulkActions={canWrite ? bulkActions : undefined}
          className="catalogGrid"
          columns={columns}
          defaultSort={[{ key: "part_number", dir: "asc" }]}
          emptyMessage={canWrite ? "No parts yet. Add one, or import a CSV/XLSX file." : "No parts yet."}
          exportFileName="parts"
          getRowId={(part) => part.id}
          height="none"
          onCommit={canWrite ? commitEdits : undefined}
          onExportXlsx={exportXlsx}
          onPasteNewRows={canWrite ? (records) => openImport(pastedImportRows(records)) : undefined}
          onRowActivate={(part) => onSelectPart(part.id)}
          onSelectionChange={setCheckedIds}
          rowClassName={(part) => (part.id === selectedPartId ? "gridRowOpen" : undefined)}
          rows={parts}
          selectedIds={checkedIds}
          storageKey="parts.catalog"
        />
      </article>
      {importer && (
        <ImportWizard
          canWrite={canWrite}
          downloadTemplate={downloadPartsImportTemplate}
          entityLabel="parts"
          fieldLabels={IMPORT_FIELD_LABELS}
          initialRows={importer.rows}
          key={importer.key}
          keyLabel="part number"
          onClose={() => setImporter(null)}
          onImported={async (report) => {
            onPartsChanged(await api.listParts());
            setNotice({
              text: `Imported parts: ${report.summary.create} created, ${report.summary.update} updated, ${report.summary.unchanged} unchanged.`
            });
          }}
          runImport={(source, options) => importParts(source, options)}
        />
      )}
      {selectedPart && (
        <>
          <PanelResizer
            width={inspectorWidth}
            onResize={setInspectorWidth}
            direction={-1}
            label="Resize part details panel"
          />
          <aside className="catalogInspector" style={{ width: inspectorWidth }}>
            <Panel
              className="catalogInspectorPanel"
              title="Part details"
              actions={
                <button type="button" className="modalClose" aria-label="Close" onClick={() => onSelectPart("")}>
                  ×
                </button>
              }
            >
              <div className="catalogInspectorBody">
                <div className="buttonRow catalogInspectorActions">
                  <button type="button" className="primary" disabled={busy} onClick={openEdit}>
                    Edit
                  </button>
                  <button type="button" disabled={busy} onClick={obsoleteSelected}>
                    Obsolete
                  </button>
                  <button type="button" className="danger" disabled={busy} onClick={deleteSelected}>
                    Delete
                  </button>
                </div>
                <div className="catalogOverview">
                  <Detail label="Name">
                    <span className="mono">{selectedPart.part_number}</span>
                  </Detail>
                  <Detail label="Description">{dash(selectedPart.description)}</Detail>
                  <Detail label="Type">{dash(selectedPart.part_type)}</Detail>
                  <Detail label="Source">{dash(selectedPart.source_type)}</Detail>
                  <Detail label="Manufacturer">{dash(selectedPart.manufacturer)}</Detail>
                  <Detail label="Material">{dash(selectedPart.material)}</Detail>
                  <Detail label="Revision">{dash(selectedPart.revision)}</Detail>
                  <Detail label="Pressure">{dash(selectedPart.pressure_rating_bar)} bar</Detail>
                  <Detail label="Temperature">
                    {selectedPart.temperature_min_c == null && selectedPart.temperature_max_c == null
                      ? "—"
                      : `${dash(selectedPart.temperature_min_c)} to ${dash(selectedPart.temperature_max_c)} °C`}
                  </Detail>
                  <Detail label="Cv">{dash(selectedPart.cv)}</Detail>
                  <Detail label="Mass">{dash(selectedPart.mass_kg)} kg</Detail>
                  <Detail label="Lifecycle">
                    <StatusPill value={selectedPart.lifecycle_status} />
                  </Detail>
                  <Detail label="Qualification">
                    <StatusPill value={selectedPart.qualification_status} />
                  </Detail>
                  <Detail label="Certification">
                    <StatusPill value={selectedPart.certification_status} />
                  </Detail>
                  <Detail label="Preferred">{selectedPart.preferred ? "Yes" : "No"}</Detail>
                  <Detail label="Completeness">{dash(selectedPart.completeness)}%</Detail>
                  {selectedPart.notes ? <Detail label="Notes">{selectedPart.notes}</Detail> : null}
                </div>
                <section>
                  <h3>Where used</h3>
                  {usage?.components.length ? (
                    <DataTable
                      rows={usage.components}
                      getKey={(row) => row.id}
                      columns={[
                        { header: "Tag", render: (row) => <span className="mono">{row.tag}</span> },
                        { header: "Project", render: (row) => row.project_name },
                        { header: "Diagram", render: (row) => row.diagram_name },
                        { header: "Qty", render: (row) => <span className="mono">{row.quantity}</span> }
                      ]}
                    />
                  ) : (
                    <p className="hint">Not placed on any diagram.</p>
                  )}
                  {usage?.drawing_items?.length ? (
                    <DataTable
                      rows={usage.drawing_items}
                      getKey={(row) => `${row.sheet_id}-${row.item_id}`}
                      columns={[
                        { header: "Tag", render: (row) => <span className="mono">{row.tag ?? row.item_id}{row.dnp ? " (DNP)" : ""}</span> },
                        { header: "Drawing", render: (row) => `${row.drawing_number} sheet ${row.sheet_no}` },
                        { header: "Zone", render: (row) => <span className="mono">{row.zone ?? "—"}</span> }
                      ]}
                    />
                  ) : (
                    <p className="hint">Not on any drawing.</p>
                  )}
                  {usage && usage.bom_snapshots.length > 0 && (
                    <p className="hint">
                      {usage.bom_snapshots.length} BoM snapshot{usage.bom_snapshots.length === 1 ? "" : "s"} on those
                      diagrams.
                    </p>
                  )}
                </section>
                <section>
                  <h3>Documents</h3>
                  <div className="catalogFilters">
                    <Select
                      label="Kind"
                      value={uploadKind}
                      options={DOCUMENT_KINDS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
                      onChange={setUploadKind}
                    />
                    <label>
                      Upload file
                      <input type="file" disabled={busy} onChange={(event) => onUpload(event.target.files)} />
                    </label>
                  </div>
                  {documents.length ? (
                    <DataTable
                      rows={documents}
                      getKey={(doc) => doc.id}
                      columns={[
                        { header: "Title", render: (doc) => doc.title },
                        { header: "Kind", render: (doc) => doc.kind.replaceAll("_", " ") },
                        { header: "File", render: (doc) => <span className="mono">{doc.original_filename}</span> },
                        {
                          header: "",
                          render: (doc) => (
                            <span className="rowActions">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void api.downloadPartDocument(selectedPart.id, doc.id, doc.original_filename)
                                }
                              >
                                Download
                              </button>
                              <button
                                type="button"
                                className="danger"
                                disabled={busy}
                                onClick={() =>
                                  void run("Removed document.", async () => {
                                    await api.deletePartDocument(selectedPart.id, doc.id);
                                    await reloadDocuments(selectedPart.id);
                                  })
                                }
                              >
                                Remove
                              </button>
                            </span>
                          )
                        }
                      ]}
                    />
                  ) : (
                    <p className="hint">No files yet. PDF, images, STEP, ZIP, and Office documents up to 25 MB.</p>
                  )}
                </section>
              </div>
            </Panel>
          </aside>
        </>
      )}
      {editorOpen && (
        <div className="modalBackdrop" role="presentation" onClick={closeEditor}>
          <div
            className="modal partEditModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="part-edit-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modalHeader">
              <h2 id="part-edit-title">{editorMode === "create" ? "New part" : "Edit part"}</h2>
              <button type="button" className="modalClose" aria-label="Close" onClick={closeEditor}>
                ×
              </button>
            </div>
            <form className="partEditForm" onSubmit={submitPart}>
              <label>
                Part name
                <span className="inputWithAction">
                  <input
                    value={form.part_number}
                    onChange={(event) => setForm({ ...form, part_number: event.target.value })}
                  />
                  <button type="button" disabled={busy} onClick={generateName}>
                    Generate
                  </button>
                </span>
              </label>
              <p className="hint">
                Generate uses {"{prefix}-{seq}"}
                {catalogSettings ? ` (${catalogSettings.prefix}-001, …)` : ""}. You can type any unique name.
              </p>
              <TextInput
                label="Description"
                value={form.description}
                onChange={(description) => setForm({ ...form, description })}
              />
              <label>
                Type
                <input
                  list="catalog-part-types"
                  value={form.part_type}
                  onChange={(event) => setForm({ ...form, part_type: event.target.value })}
                />
                <datalist id="catalog-part-types">
                  {typeOptions.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </label>
              <Select
                label="Source"
                value={form.source_type}
                options={SOURCE_OPTIONS}
                onChange={(source_type) => setForm({ ...form, source_type })}
              />
              <TextInput
                label="Manufacturer"
                value={form.manufacturer}
                onChange={(manufacturer) => setForm({ ...form, manufacturer })}
              />
              <TextInput label="Material" value={form.material} onChange={(material) => setForm({ ...form, material })} />
              <TextInput label="Revision" value={form.revision} onChange={(revision) => setForm({ ...form, revision })} />
              <TextInput
                label="Pressure rating bar"
                value={form.pressure_rating_bar}
                onChange={(pressure_rating_bar) => setForm({ ...form, pressure_rating_bar })}
              />
              <div className="splitFields">
                <TextInput
                  label="Temp min °C"
                  value={form.temperature_min_c}
                  onChange={(temperature_min_c) => setForm({ ...form, temperature_min_c })}
                />
                <TextInput
                  label="Temp max °C"
                  value={form.temperature_max_c}
                  onChange={(temperature_max_c) => setForm({ ...form, temperature_max_c })}
                />
              </div>
              <div className="splitFields">
                <TextInput label="Cv" value={form.cv} onChange={(cv) => setForm({ ...form, cv })} />
                <TextInput label="Mass kg" value={form.mass_kg} onChange={(mass_kg) => setForm({ ...form, mass_kg })} />
              </div>
              <Select
                label="Lifecycle"
                value={form.lifecycle_status}
                options={LIFECYCLE_OPTIONS}
                onChange={(lifecycle_status) => setForm({ ...form, lifecycle_status })}
              />
              <Select
                label="Qualification"
                value={form.qualification_status}
                options={QUALIFICATION_OPTIONS}
                onChange={(qualification_status) => setForm({ ...form, qualification_status })}
              />
              <Select
                label="Certification"
                value={form.certification_status}
                options={CERTIFICATION_OPTIONS}
                onChange={(certification_status) => setForm({ ...form, certification_status })}
              />
              <label className="checkboxLabel">
                <input
                  type="checkbox"
                  checked={form.preferred}
                  onChange={(event) => setForm({ ...form, preferred: event.target.checked })}
                />
                Preferred
              </label>
              <TextArea label="Notes" value={form.notes} onChange={(notes) => setForm({ ...form, notes })} />
              <FormError message={error} />
              <div className="buttonRow modalActions">
                <button type="button" disabled={busy} onClick={closeEditor}>
                  Cancel
                </button>
                <button className="primary" disabled={busy || !form.part_number || !form.description || !form.part_type}>
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </section>
    </>
  );
}

/** The /parts route: the catalog bound to the workspace's parts and selection. */
export function PartsPage() {
  const { parts, setParts, selectedPartId, setSelectedPartId, selectedProjectId, canWrite } = useWorkspace();
  // Deep link from drawing part badges: /parts?part=<id>.
  const location = useLocation();
  useEffect(() => {
    const linked = new URLSearchParams(location.search).get("part");
    if (linked) setSelectedPartId(linked);
  }, [location.search, setSelectedPartId]);
  return (
    <PageLayout className="catalogPage" title="Parts" description="" showHeader={false}>
      <PartsCatalog
        parts={parts}
        selectedPartId={selectedPartId}
        projectId={selectedProjectId || undefined}
        canWrite={canWrite}
        onSelectPart={setSelectedPartId}
        onPartsChanged={setParts}
      />
    </PageLayout>
  );
}

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { PanelResizer, useStoredWidth } from "../components/resizable";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type { CatalogDocument, CatalogSettings, Part, PartUsage } from "../types";

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

const COLUMN_STORAGE_KEY = "fsdp.catalogVisibleColumns";

type ColumnId =
  | "name"
  | "description"
  | "type"
  | "source"
  | "manufacturer"
  | "material"
  | "revision"
  | "bar"
  | "lifecycle"
  | "qual"
  | "cert"
  | "preferred"
  | "completeness";

const COLUMN_DEFS: Array<{
  id: ColumnId;
  header: string;
  label: string;
  locked?: boolean;
  defaultOn: boolean;
}> = [
  { id: "name", header: "Name", label: "Name", locked: true, defaultOn: true },
  { id: "description", header: "Description", label: "Description", defaultOn: false },
  { id: "type", header: "Type", label: "Type", defaultOn: true },
  { id: "source", header: "Source", label: "Source", defaultOn: false },
  { id: "manufacturer", header: "Manufacturer", label: "Manufacturer", defaultOn: false },
  { id: "material", header: "Material", label: "Material", defaultOn: true },
  { id: "revision", header: "Rev", label: "Revision", defaultOn: false },
  { id: "bar", header: "Bar", label: "Pressure rating", defaultOn: true },
  { id: "lifecycle", header: "Lifecycle", label: "Lifecycle", defaultOn: true },
  { id: "qual", header: "Qual", label: "Qualification", defaultOn: true },
  { id: "cert", header: "Cert", label: "Certification", defaultOn: false },
  { id: "preferred", header: "Preferred", label: "Preferred", defaultOn: false },
  { id: "completeness", header: "%", label: "Completeness", defaultOn: true }
];

const DEFAULT_VISIBLE_COLUMNS = COLUMN_DEFS.filter((column) => column.defaultOn).map((column) => column.id);

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

function dash(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  return String(value);
}

function loadVisibleColumns(): Set<ColumnId> {
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const known = new Set(COLUMN_DEFS.map((column) => column.id));
    const next = parsed.filter((id): id is ColumnId => known.has(id as ColumnId));
    next.push("name");
    return new Set(next);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
}

function persistVisibleColumns(ids: Set<ColumnId>) {
  localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...ids]));
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

function ColumnPicker({
  visible,
  onChange
}: {
  visible: Set<ColumnId>;
  onChange: (next: Set<ColumnId>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function toggle(id: ColumnId, locked?: boolean) {
    if (locked) return;
    const next = new Set(visible);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    next.add("name");
    onChange(next);
  }

  return (
    <div className="columnPicker" ref={rootRef}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((current) => !current)}>
        Columns
      </button>
      {open && (
        <div className="columnPickerMenu" role="menu" aria-label="Visible columns">
          {COLUMN_DEFS.map((column) => (
            <label key={column.id} className="checkboxLabel">
              <input
                type="checkbox"
                checked={visible.has(column.id)}
                disabled={column.locked}
                onChange={() => toggle(column.id, column.locked)}
              />
              {column.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function PartsCatalog({
  parts,
  selectedPartId,
  projectId,
  onSelectPart,
  onPartsChanged
}: {
  parts: Part[];
  selectedPartId: string;
  projectId?: string;
  onSelectPart: (partId: string) => void;
  onPartsChanged: (parts: Part[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [catalogSettings, setCatalogSettings] = useState<CatalogSettings | null>(null);
  const [usage, setUsage] = useState<PartUsage | null>(null);
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadKind, setUploadKind] = useState("datasheet");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(loadVisibleColumns);
  const [inspectorWidth, setInspectorWidth] = useStoredWidth("fsdp.catalogInspectorWidth", 380, 300, 560);

  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const typeOptions = useMemo(() => {
    const fromSettings = catalogSettings?.part_types ?? [];
    const fromParts = parts.map((part) => part.part_type);
    return Array.from(new Set([...fromSettings, ...fromParts, form.part_type].filter(Boolean))).sort();
  }, [catalogSettings, parts, form.part_type]);

  const visibleParts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return parts.filter((part) => {
      if (typeFilter && part.part_type !== typeFilter) return false;
      if (lifecycleFilter && part.lifecycle_status !== lifecycleFilter) return false;
      if (!needle) return true;
      return [part.part_number, part.description, part.manufacturer ?? ""].some((value) =>
        value.toLowerCase().includes(needle)
      );
    });
  }, [parts, query, typeFilter, lifecycleFilter]);

  const libraryColumns = useMemo(() => {
    const renderers: Record<ColumnId, (part: Part) => ReactNode> = {
      name: (part) => <span className="mono">{part.part_number}</span>,
      description: (part) => part.description || "—",
      type: (part) => part.part_type,
      source: (part) => part.source_type || "—",
      manufacturer: (part) => part.manufacturer ?? "—",
      material: (part) => part.material ?? "—",
      revision: (part) => part.revision ?? "—",
      bar: (part) => <span className="mono">{part.pressure_rating_bar ?? "—"}</span>,
      lifecycle: (part) => <StatusPill value={part.lifecycle_status} />,
      qual: (part) => <StatusPill value={part.qualification_status} />,
      cert: (part) => <StatusPill value={part.certification_status} />,
      preferred: (part) => (part.preferred ? <StatusPill value="preferred" /> : "—"),
      completeness: (part) => <span className="mono">{part.completeness ?? "—"}</span>
    };
    return COLUMN_DEFS.filter((column) => visibleColumns.has(column.id)).map((column) => ({
      header: column.header,
      render: renderers[column.id]
    }));
  }, [visibleColumns]);

  useEffect(() => {
    void api.getCatalogSettings().then(setCatalogSettings).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedPart) {
      setUsage(null);
      setDocuments([]);
      return;
    }
    void api.getPartUsage(selectedPart.id).then(setUsage).catch(() => setUsage(null));
    void api.listPartDocuments(selectedPart.id).then(setDocuments).catch(() => setDocuments([]));
  }, [selectedPart]);

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
    void run("Uploaded document.", async () => {
      await api.uploadPartDocument(selectedPart.id, file, file.name, uploadKind);
      setDocuments(await api.listPartDocuments(selectedPart.id));
    });
  }

  function setColumns(next: Set<ColumnId>) {
    setVisibleColumns(next);
    persistVisibleColumns(next);
  }

  return (
    <section className="catalogWorkspace">
      <Panel className="catalogLibrary" title="Library">
        <div className="catalogToolbar">
          <div className="catalogFilters">
            <TextInput label="Search" value={query} onChange={setQuery} />
            <Select
              label="Type"
              value={typeFilter}
              options={typeOptions.map((value) => ({ value, label: value }))}
              onChange={setTypeFilter}
            />
            <Select label="Lifecycle" value={lifecycleFilter} options={LIFECYCLE_OPTIONS} onChange={setLifecycleFilter} />
          </div>
          <div className="catalogToolbarActions">
            <ColumnPicker visible={visibleColumns} onChange={setColumns} />
            <button type="button" className="primary" onClick={openCreate}>
              New part
            </button>
          </div>
        </div>
        <DataTable
          className="tableWrapFill"
          rows={visibleParts}
          selectedKey={selectedPartId}
          getKey={(part) => part.id}
          onSelect={(part) => onSelectPart(part.id)}
          columns={libraryColumns}
        />
        <p className="hint catalogCount">
          {visibleParts.length} of {parts.length} parts. Click a row to inspect it.
        </p>
      </Panel>
      {selectedPart && (
        <>
          <PanelResizer
            width={inspectorWidth}
            onResize={setInspectorWidth}
            direction={-1}
            label="Resize part details panel"
          />
          <aside className="catalogInspector" style={{ width: inspectorWidth }}>
            <Panel className="catalogInspectorPanel" title="Part details">
              <div className="catalogInspectorBody">
                <div className="buttonRow catalogInspectorActions">
                  <button type="button" className="primary" disabled={busy} onClick={openEdit}>
                    Edit
                  </button>
                  <button type="button" disabled={busy} onClick={obsoleteSelected}>
                    Mark obsolete
                  </button>
                  <button type="button" className="danger" disabled={busy} onClick={deleteSelected}>
                    Delete
                  </button>
                  <button type="button" onClick={() => onSelectPart("")}>
                    Close
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
                                    setDocuments(await api.listPartDocuments(selectedPart.id));
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
  );
}

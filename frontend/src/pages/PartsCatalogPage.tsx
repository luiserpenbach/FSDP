import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, TextArea, TextInput } from "../components/ui";
import type { Part, PartAttachment, PartCompare, PartFamily, PartRevision, PartWhereUsed } from "../types";
import {
  DEFAULT_VISIBLE_COLUMNS,
  IMPORTABLE_FIELDS,
  PART_COLUMNS,
  compareParts,
  emptyPartForm,
  exportPartsCsv,
  filterParts,
  getPartFieldValue,
  loadSavedViews,
  loadVisibleColumns,
  partToForm,
  saveSavedViews,
  saveVisibleColumns,
  uniquePartValues,
  type PartColumnKey,
  type PartFilters,
  type PartFormState,
  type SavedPartView,
  type SortDirection
} from "../utils/partsCatalog";
import { PageLayout } from "./PageLayout";

type PartsCatalogPageProps = {
  parts: Part[];
  busy: boolean;
  formErrors: Record<string, string>;
  selectedPartId: string;
  onSelectPart: (partId: string) => void;
  onPartsUpdated: () => Promise<void>;
  runAction: (successMessage: string, action: () => Promise<void>, formKey?: string) => Promise<void>;
};

type ViewerTab = "details" | "where-used" | "revisions" | "attachments";

const EMPTY_FILTERS: PartFilters = {
  part_type: "",
  source_type: "",
  qualification_status: "",
  lifecycle_status: ""
};

export function PartsCatalogPage({
  parts,
  busy,
  formErrors,
  selectedPartId,
  onSelectPart,
  onPartsUpdated,
  runAction
}: PartsCatalogPageProps) {
  const [showNewPartForm, setShowNewPartForm] = useState(false);
  const [newPartForm, setNewPartForm] = useState<PartFormState>(emptyPartForm);
  const [viewerForm, setViewerForm] = useState<PartFormState | null>(null);
  const [viewerTab, setViewerTab] = useState<ViewerTab>("details");
  const [isEditing, setIsEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<PartFilters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<PartColumnKey | null>("part_number");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [visibleColumns, setVisibleColumns] = useState<PartColumnKey[]>(loadVisibleColumns);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [checkedPartIds, setCheckedPartIds] = useState<Set<string>>(new Set());
  const [savedViews, setSavedViews] = useState<SavedPartView[]>(loadSavedViews);
  const [families, setFamilies] = useState<PartFamily[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [showFamilies, setShowFamilies] = useState(false);
  const [compareResult, setCompareResult] = useState<PartCompare | null>(null);
  const [importCsv, setImportCsv] = useState("");
  const [importDuplicateMode, setImportDuplicateMode] = useState("skip");
  const [importResult, setImportResult] = useState<string>("");
  const [bulkForm, setBulkForm] = useState({
    manufacturer: "",
    material: "",
    qualification_status: "",
    certification_status: "",
    lifecycle_status: "",
    family_id: ""
  });
  const [familyForm, setFamilyForm] = useState({
    name: "",
    part_type: "valve",
    description: "",
    templateJson: '{"material":"316L","source_type":"internal"}'
  });
  const [whereUsed, setWhereUsed] = useState<PartWhereUsed | null>(null);
  const [revisions, setRevisions] = useState<PartRevision[]>([]);
  const [attachments, setAttachments] = useState<PartAttachment[]>([]);
  const [attachmentType, setAttachmentType] = useState("datasheet");

  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const activeColumns = PART_COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const checkedIds = [...checkedPartIds];

  const filteredParts = useMemo(() => filterParts(parts, search, filters), [filters, parts, search]);
  const sortedParts = useMemo(() => {
    if (!sortKey) return filteredParts;
    return [...filteredParts].sort((left, right) => compareParts(left, right, sortKey, sortDirection));
  }, [filteredParts, sortDirection, sortKey]);

  const allVisibleChecked =
    sortedParts.length > 0 && sortedParts.every((part) => checkedPartIds.has(part.id));
  const someVisibleChecked = sortedParts.some((part) => checkedPartIds.has(part.id));

  useEffect(() => {
    void api.listPartFamilies().then(setFamilies).catch(() => setFamilies([]));
  }, []);

  useEffect(() => {
    if (!selectedPart) {
      setViewerForm(null);
      setIsEditing(false);
      setWhereUsed(null);
      setRevisions([]);
      setAttachments([]);
      return;
    }
    setViewerForm(partToForm(selectedPart));
    setIsEditing(false);
    setShowNewPartForm(false);
    setViewerTab("details");
  }, [selectedPart]);

  useEffect(() => {
    if (!selectedPart) return;
    if (viewerTab === "where-used") {
      void api.getPartWhereUsed(selectedPart.id).then(setWhereUsed);
    }
    if (viewerTab === "revisions") {
      void api.listPartRevisions(selectedPart.id).then(setRevisions);
    }
    if (viewerTab === "attachments") {
      void api.listPartAttachments(selectedPart.id).then(setAttachments);
    }
  }, [selectedPart, viewerTab]);

  function toggleSort(key: PartColumnKey) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      return;
    }
    setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
  }

  function toggleColumn(key: PartColumnKey) {
    setVisibleColumns((current) => {
      const next = current.includes(key) ? current.filter((column) => column !== key) : [...current, key];
      const normalized = next.length > 0 ? next : DEFAULT_VISIBLE_COLUMNS;
      saveVisibleColumns(normalized);
      return normalized;
    });
  }

  function togglePartChecked(partId: string) {
    setCheckedPartIds((current) => {
      const next = new Set(current);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
  }

  function toggleAllVisible() {
    setCheckedPartIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) sortedParts.forEach((part) => next.delete(part.id));
      else sortedParts.forEach((part) => next.add(part.id));
      return next;
    });
  }

  function applySavedView(viewId: string) {
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) return;
    setSearch(view.search);
    setFilters(view.filters);
    setVisibleColumns(view.visibleColumns);
    saveVisibleColumns(view.visibleColumns);
  }

  function saveCurrentView() {
    const name = window.prompt("Saved view name");
    if (!name?.trim()) return;
    const view: SavedPartView = {
      id: crypto.randomUUID(),
      name: name.trim(),
      search,
      filters,
      visibleColumns
    };
    const next = [...savedViews, view];
    setSavedViews(next);
    saveSavedViews(next);
  }

  function submitNewPart(event: FormEvent) {
    event.preventDefault();
    void runAction(
      "Created part.",
      async () => {
        const part = await api.createPart({
          ...newPartForm,
          family_id: newPartForm.family_id || undefined,
          replacement_part_id: newPartForm.replacement_part_id || undefined,
          pressure_rating_bar: newPartForm.pressure_rating_bar ? Number(newPartForm.pressure_rating_bar) : null
        });
        await onPartsUpdated();
        onSelectPart(part.id);
        setNewPartForm(emptyPartForm());
        setShowNewPartForm(false);
      },
      "part"
    );
  }

  function saveEditedPart() {
    if (!selectedPart || !viewerForm) return;
    void runAction(
      "Updated part.",
      async () => {
        await api.updatePart(selectedPart.id, {
          ...viewerForm,
          family_id: viewerForm.family_id || null,
          replacement_part_id: viewerForm.replacement_part_id || null,
          pressure_rating_bar: viewerForm.pressure_rating_bar ? Number(viewerForm.pressure_rating_bar) : null
        });
        await onPartsUpdated();
        setIsEditing(false);
      },
      "part"
    );
  }

  function deleteSelectedPart() {
    if (!selectedPart || !window.confirm(`Delete part "${selectedPart.part_number}"?`)) return;
    void runAction("Deleted part.", async () => {
      await api.deletePart(selectedPart.id);
      await onPartsUpdated();
      onSelectPart("");
    });
  }

  function deleteCheckedParts() {
    if (checkedIds.length === 0) return;
    if (!window.confirm(`Delete ${checkedIds.length} selected part(s)?`)) return;
    void runAction("Deleted selected parts.", async () => {
      for (const id of checkedIds) await api.deletePart(id);
      setCheckedPartIds(new Set());
      await onPartsUpdated();
      onSelectPart("");
    });
  }

  function exportCsv() {
    const exportRows = checkedPartIds.size
      ? sortedParts.filter((part) => checkedPartIds.has(part.id))
      : sortedParts;
    exportPartsCsv(exportRows, activeColumns);
  }

  function runImport() {
    const header = importCsv.split("\n")[0]?.split(",").map((value) => value.trim()) ?? [];
    const column_mapping = Object.fromEntries(
      header.filter((column) => IMPORTABLE_FIELDS.includes(column as (typeof IMPORTABLE_FIELDS)[number])).map((column) => [column, column])
    );
    void runAction("Imported parts.", async () => {
      const result = await api.importParts({
        csv_text: importCsv,
        column_mapping,
        on_duplicate: importDuplicateMode
      });
      setImportResult(
        `Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}` +
          (result.errors.length ? `. Errors: ${result.errors.join("; ")}` : "")
      );
      await onPartsUpdated();
    });
  }

  function runBulkEdit() {
    if (checkedIds.length === 0) return;
    const body = {
      part_ids: checkedIds,
      manufacturer: bulkForm.manufacturer || undefined,
      material: bulkForm.material || undefined,
      qualification_status: bulkForm.qualification_status || undefined,
      certification_status: bulkForm.certification_status || undefined,
      lifecycle_status: bulkForm.lifecycle_status || undefined,
      family_id: bulkForm.family_id || undefined
    };
    void runAction("Bulk updated parts.", async () => {
      await api.bulkUpdateParts(body);
      await onPartsUpdated();
      setShowBulkEdit(false);
    });
  }

  function runCompare() {
    if (checkedIds.length !== 2) return;
    void runAction("Compared parts.", async () => {
      setCompareResult(await api.compareParts(checkedIds[0], checkedIds[1]));
    });
  }

  function createFamily(event: FormEvent) {
    event.preventDefault();
    void runAction("Created part family.", async () => {
      const family = await api.createPartFamily({
        name: familyForm.name,
        part_type: familyForm.part_type,
        description: familyForm.description,
        template_properties: JSON.parse(familyForm.templateJson) as Record<string, unknown>
      });
      setFamilies(await api.listPartFamilies());
      setFamilyForm({ name: "", part_type: "valve", description: "", templateJson: familyForm.templateJson });
      setNewPartForm((current) => ({ ...current, family_id: family.id }));
    });
  }

  async function uploadAttachment(file: File) {
    if (!selectedPart) return;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    void runAction("Uploaded attachment.", async () => {
      await api.createPartAttachment(selectedPart.id, {
        filename: file.name,
        attachment_type: attachmentType,
        mime_type: file.type,
        size_bytes: file.size,
        content_base64: btoa(binary)
      });
      setAttachments(await api.listPartAttachments(selectedPart.id));
    });
  }

  function deleteAttachment(attachmentId: string) {
    void runAction("Deleted attachment.", async () => {
      await api.deletePartAttachment(attachmentId);
      if (selectedPart) setAttachments(await api.listPartAttachments(selectedPart.id));
    });
  }

  return (
    <PageLayout className="partsPage" title="Parts Catalog" description="Internal and vendor parts">
      <section className="partsCatalog">
        <div className="partsToolbar">
          <div className="partsToolbarMain">
            <button onClick={() => setShowNewPartForm((current) => !current)}>
              {showNewPartForm ? "Close new part form" : "New part"}
            </button>
            <input className="partsSearch" placeholder="Search parts..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select label="Type" value={filters.part_type} options={uniquePartValues(parts, "part_type").map((v) => ({ value: v, label: v }))} onChange={(part_type) => setFilters({ ...filters, part_type })} />
            <Select label="Source" value={filters.source_type} options={uniquePartValues(parts, "source_type").map((v) => ({ value: v, label: v }))} onChange={(source_type) => setFilters({ ...filters, source_type })} />
            <Select label="Qualification" value={filters.qualification_status} options={uniquePartValues(parts, "qualification_status").map((v) => ({ value: v, label: v }))} onChange={(qualification_status) => setFilters({ ...filters, qualification_status })} />
            <Select label="Lifecycle" value={filters.lifecycle_status} options={uniquePartValues(parts, "lifecycle_status").map((v) => ({ value: v, label: v }))} onChange={(lifecycle_status) => setFilters({ ...filters, lifecycle_status })} />
            <Select label="Saved view" value="" options={savedViews.map((view) => ({ value: view.id, label: view.name }))} onChange={applySavedView} />
            <button onClick={saveCurrentView}>Save view</button>
          </div>
          <div className="partsToolbarActions">
            <button onClick={() => setShowColumnPicker((c) => !c)}>{showColumnPicker ? "Hide columns" : "Columns"}</button>
            <button onClick={() => setShowFamilies((c) => !c)}>Families</button>
            <button onClick={() => setShowImport((c) => !c)}>Import CSV</button>
            <button disabled={checkedIds.length === 0} onClick={() => setShowBulkEdit((c) => !c)}>Bulk edit ({checkedIds.length})</button>
            <button disabled={checkedIds.length !== 2} onClick={runCompare}>Compare (2)</button>
            <button disabled={sortedParts.length === 0} onClick={exportCsv}>Export CSV</button>
            <button className="danger" disabled={checkedIds.length === 0 || busy} onClick={deleteCheckedParts}>Delete selected</button>
          </div>
        </div>

        {showNewPartForm && (
          <Panel title="New part">
            <form className="partsFormGrid" onSubmit={submitNewPart}>
              <PartFormFields families={families} parts={parts} disabled={busy} form={newPartForm} onChange={setNewPartForm} />
              <FormError message={formErrors.part} />
              <div className="buttonRow">
                <button disabled={busy || !newPartForm.part_number || !newPartForm.description}>Create part</button>
                <button type="button" onClick={() => setShowNewPartForm(false)}>Cancel</button>
              </div>
            </form>
          </Panel>
        )}

        {showImport && (
          <Panel title="Import vendor catalog (CSV)">
            <p className="hint">CSV header columns are auto-mapped when they match part fields.</p>
            <textarea className="importCsvArea" value={importCsv} onChange={(e) => setImportCsv(e.target.value)} placeholder="part_number,description,part_type,material" />
            <Select label="Duplicates" value={importDuplicateMode} options={[{ value: "skip", label: "Skip" }, { value: "update", label: "Update" }, { value: "error", label: "Error" }]} onChange={setImportDuplicateMode} />
            <div className="buttonRow"><button disabled={!importCsv.trim()} onClick={runImport}>Run import</button></div>
            {importResult && <p className="hint">{importResult}</p>}
          </Panel>
        )}

        {showBulkEdit && (
          <Panel title="Bulk edit selected parts">
            <div className="partsFormGrid">
              <TextInput label="Manufacturer" value={bulkForm.manufacturer} onChange={(manufacturer) => setBulkForm({ ...bulkForm, manufacturer })} />
              <TextInput label="Material" value={bulkForm.material} onChange={(material) => setBulkForm({ ...bulkForm, material })} />
              <TextInput label="Qualification" value={bulkForm.qualification_status} onChange={(qualification_status) => setBulkForm({ ...bulkForm, qualification_status })} />
              <TextInput label="Certification" value={bulkForm.certification_status} onChange={(certification_status) => setBulkForm({ ...bulkForm, certification_status })} />
              <TextInput label="Lifecycle" value={bulkForm.lifecycle_status} onChange={(lifecycle_status) => setBulkForm({ ...bulkForm, lifecycle_status })} />
              <Select label="Family" value={bulkForm.family_id} options={families.map((f) => ({ value: f.id, label: f.name }))} onChange={(family_id) => setBulkForm({ ...bulkForm, family_id })} />
            </div>
            <div className="buttonRow"><button disabled={checkedIds.length === 0} onClick={runBulkEdit}>Apply to {checkedIds.length} part(s)</button></div>
          </Panel>
        )}

        {compareResult && (
          <Panel title={`Compare: ${compareResult.left.part_number} vs ${compareResult.right.part_number}`}>
            <DataTable
              rows={compareResult.differences}
              getKey={(row) => row.field}
              columns={[
                { header: "Field", render: (row) => row.field },
                { header: compareResult.left.part_number, render: (row) => String(row.left ?? "-") },
                { header: compareResult.right.part_number, render: (row) => String(row.right ?? "-") }
              ]}
            />
            <button onClick={() => setCompareResult(null)}>Close compare</button>
          </Panel>
        )}

        <div className="partsTableLayout">
          <div className="partsTableArea">
            <div className="tableWrap partsTableWrap">
              <table className="partsTable">
                <thead>
                  <tr>
                    <th className="checkboxCell">
                      <input checked={allVisibleChecked} ref={(input) => { if (input) input.indeterminate = someVisibleChecked && !allVisibleChecked; }} type="checkbox" onChange={toggleAllVisible} />
                    </th>
                    {activeColumns.map((column) => (
                      <th key={column.key}>
                        <button className="sortHeader" onClick={() => toggleSort(column.key)} type="button">
                          {column.label}{sortKey === column.key ? (sortDirection === "asc" ? " ^" : " v") : ""}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedParts.length === 0 ? (
                    <tr><td colSpan={activeColumns.length + 1}>No parts match the current filters.</td></tr>
                  ) : (
                    sortedParts.map((part) => (
                      <tr className={selectedPartId === part.id ? "selectedRow" : undefined} key={part.id} onClick={() => onSelectPart(part.id)}>
                        <td className="checkboxCell" onClick={(e) => e.stopPropagation()}>
                          <input checked={checkedPartIds.has(part.id)} type="checkbox" onChange={() => togglePartChecked(part.id)} />
                        </td>
                        {activeColumns.map((column) => (
                          <td key={column.key}>{getPartFieldValue(part, column.key)}</td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {selectedPart && viewerForm && (
              <Panel title={`Part: ${selectedPart.part_number}`}>
                <div className="viewerTabs">
                  {(["details", "where-used", "revisions", "attachments"] as ViewerTab[]).map((tab) => (
                    <button className={viewerTab === tab ? "tabButton active" : "tabButton"} key={tab} onClick={() => setViewerTab(tab)} type="button">
                      {tab}
                    </button>
                  ))}
                </div>

                {viewerTab === "details" && (
                  <>
                    <div className="partsViewerHeader">
                      <p className="hint">{isEditing ? "Editing enabled" : "Read-only view"}</p>
                      <div className="buttonRow">
                        {!isEditing ? <button onClick={() => setIsEditing(true)}>Edit</button> : (
                          <>
                            <button disabled={busy} onClick={saveEditedPart}>Save changes</button>
                            <button type="button" onClick={() => { setViewerForm(partToForm(selectedPart)); setIsEditing(false); }}>Cancel</button>
                          </>
                        )}
                        <button className="danger" disabled={busy} onClick={deleteSelectedPart}>Delete</button>
                      </div>
                    </div>
                    <div className="partsFormGrid">
                      <PartFormFields families={families} parts={parts} disabled={!isEditing || busy} form={viewerForm} onChange={setViewerForm} />
                    </div>
                  </>
                )}

                {viewerTab === "where-used" && whereUsed && (
                  <div className="viewerSections">
                    <ViewerList title="Diagrams" items={whereUsed.diagrams.map((d) => `${d.diagram_name} (${d.project_name ?? "?"}/${d.system_name ?? "?"}) tags: ${d.component_tags.join(", ")}`)} />
                    <ViewerList title="BoM snapshots" items={whereUsed.bom_snapshots.map((b) => `${b.diagram_name ?? b.diagram_id} rev ${b.revision}`)} />
                    <ViewerList title="Requirements" items={whereUsed.requirements.map((r) => `${r.key} - ${r.title}`)} />
                  </div>
                )}

                {viewerTab === "revisions" && (
                  <div className="viewerSections">
                    {revisions.length === 0 ? <p className="hint">No revision history yet.</p> : revisions.map((revision) => (
                      <article className="revisionCard" key={revision.id}>
                        <strong>{revision.revision_label ?? "Snapshot"}</strong>
                        <p>{revision.change_summary}</p>
                        <p className="hint">{new Date(revision.created_at).toLocaleString()}</p>
                      </article>
                    ))}
                  </div>
                )}

                {viewerTab === "attachments" && (
                  <div className="viewerSections">
                    <div className="buttonRow">
                      <Select label="Attachment type" value={attachmentType} options={[{ value: "datasheet", label: "Datasheet" }, { value: "coc", label: "CoC" }, { value: "model", label: "3D model" }, { value: "test_report", label: "Test report" }]} onChange={setAttachmentType} />
                      <label className="fileUpload">
                        Upload file
                        <input type="file" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAttachment(file); }} />
                      </label>
                    </div>
                    {attachments.length === 0 ? <p className="hint">No attachments yet.</p> : attachments.map((attachment) => (
                      <article className="attachmentCard" key={attachment.id}>
                        <strong>{attachment.filename}</strong>
                        <p>{attachment.attachment_type} · {attachment.mime_type ?? "unknown"} · {attachment.size_bytes ?? 0} bytes</p>
                        <button className="danger" onClick={() => deleteAttachment(attachment.id)}>Delete</button>
                      </article>
                    ))}
                  </div>
                )}
              </Panel>
            )}
          </div>

          {showColumnPicker && (
            <aside className="columnPicker">
              <Panel title="Visible columns">
                <div className="columnPickerList">
                  {PART_COLUMNS.map((column) => (
                    <label className="columnPickerItem" key={column.key}>
                      <input checked={visibleColumns.includes(column.key)} type="checkbox" onChange={() => toggleColumn(column.key)} />
                      {column.label}
                    </label>
                  ))}
                </div>
              </Panel>
            </aside>
          )}

          {showFamilies && (
            <aside className="columnPicker">
              <Panel title="Part families">
                <form onSubmit={createFamily}>
                  <TextInput label="Family name" value={familyForm.name} onChange={(name) => setFamilyForm({ ...familyForm, name })} />
                  <TextInput label="Part type" value={familyForm.part_type} onChange={(part_type) => setFamilyForm({ ...familyForm, part_type })} />
                  <TextArea label="Description" value={familyForm.description} onChange={(description) => setFamilyForm({ ...familyForm, description })} />
                  <TextArea label="Template properties (JSON)" value={familyForm.templateJson} onChange={(templateJson) => setFamilyForm({ ...familyForm, templateJson })} />
                  <button disabled={!familyForm.name}>Create family</button>
                </form>
                <ul>{families.map((family) => <li key={family.id}><strong>{family.name}</strong> ({family.part_type})</li>)}</ul>
              </Panel>
            </aside>
          )}
        </div>
      </section>
    </PageLayout>
  );
}

function PartFormFields({
  form,
  onChange,
  disabled,
  families,
  parts
}: {
  form: PartFormState;
  onChange: (form: PartFormState) => void;
  disabled?: boolean;
  families: PartFamily[];
  parts: Part[];
}) {
  const familyOptions = families.map((family) => ({ value: family.id, label: family.name }));
  const replacementOptions = parts.map((part) => ({ value: part.id, label: part.part_number }));

  return (
    <>
      <TextInput label="Part number" readOnly={disabled} value={form.part_number} onChange={(part_number) => onChange({ ...form, part_number })} />
      <TextInput label="Description" readOnly={disabled} value={form.description} onChange={(description) => onChange({ ...form, description })} />
      <TextInput label="Type" readOnly={disabled} value={form.part_type} onChange={(part_type) => onChange({ ...form, part_type })} />
      <TextInput label="Revision" readOnly={disabled} value={form.revision} onChange={(revision) => onChange({ ...form, revision })} />
      <TextInput label="Manufacturer" readOnly={disabled} value={form.manufacturer} onChange={(manufacturer) => onChange({ ...form, manufacturer })} />
      <TextInput label="Source" readOnly={disabled} value={form.source_type} onChange={(source_type) => onChange({ ...form, source_type })} />
      <TextInput label="Material" readOnly={disabled} value={form.material} onChange={(material) => onChange({ ...form, material })} />
      <TextInput label="Pressure rating bar" readOnly={disabled} value={form.pressure_rating_bar} onChange={(pressure_rating_bar) => onChange({ ...form, pressure_rating_bar })} />
      <TextInput label="Qualification" readOnly={disabled} value={form.qualification_status} onChange={(qualification_status) => onChange({ ...form, qualification_status })} />
      <TextInput label="Certification" readOnly={disabled} value={form.certification_status} onChange={(certification_status) => onChange({ ...form, certification_status })} />
      <TextInput label="Lifecycle" readOnly={disabled} value={form.lifecycle_status} onChange={(lifecycle_status) => onChange({ ...form, lifecycle_status })} />
      <Select disabled={disabled} label="Family" value={form.family_id} options={familyOptions} onChange={(family_id) => onChange({ ...form, family_id })} />
      <Select disabled={disabled} label="Replacement part" value={form.replacement_part_id} options={replacementOptions} onChange={(replacement_part_id) => onChange({ ...form, replacement_part_id })} />
    </>
  );
}

function ViewerList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="hint">None</p> : <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>}
    </div>
  );
}

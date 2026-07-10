import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, TextArea, TextInput } from "../components/ui";
import type {
  Impact,
  Requirement,
  RequirementAttachment,
  RequirementCompare,
  RequirementRevision,
  RequirementSet,
  RequirementTraceability,
  TraceableComponent
} from "../types";
import {
  DEFAULT_REQUIREMENT_COLUMNS,
  IMPORTABLE_FIELDS,
  REQUIREMENT_COLUMNS,
  compareRequirements,
  emptyRequirementForm,
  exportRequirementsCsv,
  exportVerificationMatrixCsv,
  filterRequirements,
  getRequirementFieldValue,
  loadSavedViews,
  loadVisibleColumns,
  requirementToForm,
  saveSavedViews,
  saveVisibleColumns,
  uniqueRequirementValues,
  type RequirementColumnKey,
  type RequirementCoverageMap,
  type RequirementFilters,
  type RequirementFormState,
  type SavedRequirementView,
  type SortDirection
} from "../utils/requirementsWorkspace";
import { PageLayout } from "./PageLayout";

type RequirementsPageProps = {
  projectId: string;
  requirements: Requirement[];
  busy: boolean;
  formErrors: Record<string, string>;
  selectedRequirementId: string;
  onSelectRequirement: (requirementId: string) => void;
  onRequirementsUpdated: () => Promise<void>;
  runAction: (successMessage: string, action: () => Promise<void>, formKey?: string) => Promise<void>;
};

type ViewerTab = "details" | "traceability" | "revisions" | "verification";

const EMPTY_FILTERS: RequirementFilters = {
  requirement_type: "",
  status: "",
  verification_method: "",
  owner: "",
  link_status: "",
  lifecycle_status: "",
  verification_display: "",
  set_id: ""
};

function formToCreatePayload(form: RequirementFormState, projectId: string) {
  return {
    project_id: projectId,
    key: form.key,
    title: form.title,
    text: form.text,
    requirement_type: form.requirement_type,
    verification_method: form.verification_method || undefined,
    status: form.status,
    owner: form.owner || undefined,
    lifecycle_status: form.lifecycle_status,
    verification_status: form.verification_status,
    set_id: form.set_id || undefined,
    superseded_by_requirement_id: form.superseded_by_requirement_id || undefined
  };
}

function formToUpdatePayload(form: RequirementFormState) {
  return {
    key: form.key,
    title: form.title,
    text: form.text,
    requirement_type: form.requirement_type,
    verification_method: form.verification_method || undefined,
    status: form.status,
    owner: form.owner || undefined,
    lifecycle_status: form.lifecycle_status,
    verification_status: form.verification_status,
    set_id: form.set_id || null,
    superseded_by_requirement_id: form.superseded_by_requirement_id || null
  };
}

export function RequirementsPage({
  projectId,
  requirements,
  busy,
  formErrors,
  selectedRequirementId,
  onSelectRequirement,
  onRequirementsUpdated,
  runAction
}: RequirementsPageProps) {
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<RequirementFormState>(emptyRequirementForm);
  const [viewerForm, setViewerForm] = useState<RequirementFormState | null>(null);
  const [viewerTab, setViewerTab] = useState<ViewerTab>("details");
  const [isEditing, setIsEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<RequirementFilters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<RequirementColumnKey | null>("key");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [visibleColumns, setVisibleColumns] = useState<RequirementColumnKey[]>(loadVisibleColumns);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [showSets, setShowSets] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [savedViews, setSavedViews] = useState<SavedRequirementView[]>(loadSavedViews);
  const [coverage, setCoverage] = useState<RequirementCoverageMap>({});
  const [requirementSets, setRequirementSets] = useState<RequirementSet[]>([]);
  const [traceableComponents, setTraceableComponents] = useState<TraceableComponent[]>([]);
  const [traceability, setTraceability] = useState<RequirementTraceability | null>(null);
  const [revisions, setRevisions] = useState<RequirementRevision[]>([]);
  const [attachments, setAttachments] = useState<RequirementAttachment[]>([]);
  const [compareResult, setCompareResult] = useState<RequirementCompare | null>(null);
  const [importCsv, setImportCsv] = useState("");
  const [importDuplicateMode, setImportDuplicateMode] = useState("skip");
  const [importResult, setImportResult] = useState("");
  const [bulkForm, setBulkForm] = useState({
    status: "",
    owner: "",
    verification_method: "",
    requirement_type: "",
    lifecycle_status: "",
    verification_status: "",
    set_id: ""
  });
  const [setForm, setSetForm] = useState({
    name: "",
    requirement_type: "safety",
    description: "",
    default_verification_method: "analysis",
    template_text: ""
  });
  const [linkComponentId, setLinkComponentId] = useState("");
  const [linkType, setLinkType] = useState("satisfied_by");
  const [linkRationale, setLinkRationale] = useState("");
  const [attachmentType, setAttachmentType] = useState("test_report");

  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const activeColumns = REQUIREMENT_COLUMNS.filter((column) => visibleColumns.includes(column.key));
  const selectedIds = [...checkedIds];

  const filteredRequirements = useMemo(
    () => filterRequirements(requirements, search, filters, coverage),
    [coverage, filters, requirements, search]
  );
  const sortedRequirements = useMemo(() => {
    if (!sortKey) return filteredRequirements;
    return [...filteredRequirements].sort((left, right) =>
      compareRequirements(left, right, sortKey, sortDirection, coverage)
    );
  }, [coverage, filteredRequirements, sortDirection, sortKey]);

  const allVisibleChecked =
    sortedRequirements.length > 0 && sortedRequirements.every((requirement) => checkedIds.has(requirement.id));
  const someVisibleChecked = sortedRequirements.some((requirement) => checkedIds.has(requirement.id));

  useEffect(() => {
    if (!projectId) {
      setCoverage({});
      setTraceableComponents([]);
      setRequirementSets([]);
      return;
    }
    void api.getRequirementCoverage(projectId).then(setCoverage).catch(() => setCoverage({}));
    void api.listTraceableComponents(projectId).then(setTraceableComponents).catch(() => setTraceableComponents([]));
    void api.listRequirementSets(projectId).then(setRequirementSets).catch(() => setRequirementSets([]));
  }, [projectId, requirements]);

  useEffect(() => {
    if (!selectedRequirement) {
      setViewerForm(null);
      setIsEditing(false);
      setTraceability(null);
      setRevisions([]);
      setAttachments([]);
      return;
    }
    setViewerForm(requirementToForm(selectedRequirement));
    setIsEditing(false);
    setShowNewForm(false);
    setViewerTab("details");
  }, [selectedRequirement]);

  useEffect(() => {
    if (!selectedRequirement) return;
    if (viewerTab === "traceability") {
      void api.getRequirementTraceability(selectedRequirement.id).then(setTraceability);
    }
    if (viewerTab === "revisions") {
      void api.listRequirementRevisions(selectedRequirement.id).then(setRevisions);
    }
    if (viewerTab === "verification") {
      void api.listRequirementAttachments(selectedRequirement.id).then(setAttachments);
    }
  }, [selectedRequirement, viewerTab, requirements]);

  function refreshCoverage() {
    if (!projectId) return;
    void api.getRequirementCoverage(projectId).then(setCoverage);
  }

  function toggleSort(key: RequirementColumnKey) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
      return;
    }
    setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
  }

  function toggleColumn(key: RequirementColumnKey) {
    setVisibleColumns((current) => {
      const next = current.includes(key) ? current.filter((column) => column !== key) : [...current, key];
      const normalized = next.length > 0 ? next : DEFAULT_REQUIREMENT_COLUMNS;
      saveVisibleColumns(normalized);
      return normalized;
    });
  }

  function toggleChecked(requirementId: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(requirementId)) next.delete(requirementId);
      else next.add(requirementId);
      return next;
    });
  }

  function toggleAllVisible() {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) sortedRequirements.forEach((requirement) => next.delete(requirement.id));
      else sortedRequirements.forEach((requirement) => next.add(requirement.id));
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
    const view: SavedRequirementView = {
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

  async function confirmRequirementImpact(requirementId: string): Promise<boolean> {
    let impact: Impact;
    try {
      impact = await api.getImpact("requirement", requirementId);
    } catch {
      return window.confirm("Delete this requirement?");
    }
    const linkCount = impact.direct_links.length;
    const componentCount = impact.affected_components.length;
    if (linkCount === 0 && componentCount === 0) {
      return window.confirm("Delete this requirement?");
    }
    return window.confirm(
      `Delete this requirement? It has ${linkCount} trace link(s) and affects ${componentCount} component(s).`
    );
  }

  function submitNewRequirement(event: FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    void runAction(
      "Created requirement.",
      async () => {
        const requirement = await api.createRequirement(formToCreatePayload(newForm, projectId));
        await onRequirementsUpdated();
        onSelectRequirement(requirement.id);
        setNewForm(emptyRequirementForm());
        setShowNewForm(false);
        refreshCoverage();
      },
      "requirement"
    );
  }

  function saveEditedRequirement() {
    if (!selectedRequirement || !viewerForm) return;
    void runAction(
      "Updated requirement.",
      async () => {
        await api.updateRequirement(selectedRequirement.id, formToUpdatePayload(viewerForm));
        await onRequirementsUpdated();
        setIsEditing(false);
        refreshCoverage();
      },
      "requirement"
    );
  }

  function deleteRequirement(requirementId: string) {
    void (async () => {
      if (!(await confirmRequirementImpact(requirementId))) return;
      void runAction("Deleted requirement.", async () => {
        await api.deleteRequirement(requirementId);
        await onRequirementsUpdated();
        onSelectRequirement("");
        refreshCoverage();
      });
    })();
  }

  function deleteSelectedRequirement() {
    if (!selectedRequirement) return;
    deleteRequirement(selectedRequirement.id);
  }

  function deleteCheckedRequirements() {
    if (selectedIds.length === 0) return;
    void (async () => {
      for (const id of selectedIds) {
        if (!(await confirmRequirementImpact(id))) return;
      }
      if (!window.confirm(`Delete ${selectedIds.length} selected requirement(s)?`)) return;
      void runAction("Deleted selected requirements.", async () => {
        for (const id of selectedIds) await api.deleteRequirement(id);
        setCheckedIds(new Set());
        await onRequirementsUpdated();
        onSelectRequirement("");
        refreshCoverage();
      });
    })();
  }

  function exportCsv() {
    const exportRows = checkedIds.size
      ? sortedRequirements.filter((requirement) => checkedIds.has(requirement.id))
      : sortedRequirements;
    exportRequirementsCsv(exportRows, activeColumns, coverage);
  }

  function exportVerificationMatrix() {
    if (!projectId) return;
    void runAction("Exported verification matrix.", async () => {
      const matrix = await api.getRequirementVerificationMatrix(projectId);
      exportVerificationMatrixCsv(matrix);
    });
  }

  function runImport() {
    if (!projectId || !importCsv.trim()) return;
    const header = importCsv.split("\n")[0]?.split(",").map((value) => value.trim()) ?? [];
    const columnMapping = Object.fromEntries(
      header.filter((column) => IMPORTABLE_FIELDS.includes(column as (typeof IMPORTABLE_FIELDS)[number])).map((column) => [column, column])
    );
    void runAction("Imported requirements.", async () => {
      const result = await api.importRequirements({
        project_id: projectId,
        csv_text: importCsv,
        column_mapping: columnMapping,
        on_duplicate: importDuplicateMode
      });
      setImportResult(
        `Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}` +
          (result.errors.length ? `, errors: ${result.errors.join("; ")}` : "")
      );
      await onRequirementsUpdated();
      refreshCoverage();
    });
  }

  function runBulkEdit() {
    if (selectedIds.length === 0) return;
    const body = {
      requirement_ids: selectedIds,
      status: bulkForm.status || undefined,
      owner: bulkForm.owner || undefined,
      verification_method: bulkForm.verification_method || undefined,
      requirement_type: bulkForm.requirement_type || undefined,
      lifecycle_status: bulkForm.lifecycle_status || undefined,
      verification_status: bulkForm.verification_status || undefined,
      set_id: bulkForm.set_id || undefined
    };
    void runAction("Bulk updated requirements.", async () => {
      await api.bulkUpdateRequirements(body);
      await onRequirementsUpdated();
      refreshCoverage();
    });
  }

  function runCompare() {
    if (selectedIds.length !== 2) return;
    void runAction("Compared requirements.", async () => {
      setCompareResult(await api.compareRequirements(selectedIds[0], selectedIds[1]));
    });
  }

  function createSet(event: FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    void runAction("Created requirement set.", async () => {
      const requirementSet = await api.createRequirementSet(projectId, {
        name: setForm.name,
        requirement_type: setForm.requirement_type,
        description: setForm.description || undefined,
        default_verification_method: setForm.default_verification_method || undefined,
        template_text: setForm.template_text || undefined
      });
      setRequirementSets(await api.listRequirementSets(projectId));
      setNewForm((current) => ({ ...current, set_id: requirementSet.id, requirement_type: requirementSet.requirement_type }));
      setSetForm({ name: "", requirement_type: "safety", description: "", default_verification_method: "analysis", template_text: "" });
    });
  }

  function createTraceLink() {
    if (!selectedRequirement || !linkComponentId) return;
    void runAction("Created trace link.", async () => {
      await api.createTraceLink({
        source_type: "requirement",
        source_id: selectedRequirement.id,
        target_type: "component",
        target_id: linkComponentId,
        link_type: linkType,
        rationale: linkRationale || undefined
      });
      setLinkComponentId("");
      setLinkRationale("");
      refreshCoverage();
      setTraceability(await api.getRequirementTraceability(selectedRequirement.id));
    });
  }

  function removeTraceLink(linkId: string) {
    if (!selectedRequirement) return;
    void runAction("Removed trace link.", async () => {
      await api.deleteTraceLink(linkId);
      refreshCoverage();
      setTraceability(await api.getRequirementTraceability(selectedRequirement.id));
    });
  }

  async function uploadAttachment(file: File) {
    if (!selectedRequirement) return;
    const content = await file.arrayBuffer();
    const bytes = new Uint8Array(content);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    void runAction("Uploaded evidence.", async () => {
      await api.createRequirementAttachment(selectedRequirement.id, {
        filename: file.name,
        attachment_type: attachmentType,
        mime_type: file.type || undefined,
        size_bytes: file.size,
        content_base64: btoa(binary)
      });
      setAttachments(await api.listRequirementAttachments(selectedRequirement.id));
      refreshCoverage();
    });
  }

  function deleteAttachment(attachmentId: string) {
    if (!selectedRequirement) return;
    void runAction("Deleted evidence.", async () => {
      await api.deleteRequirementAttachment(attachmentId);
      setAttachments(await api.listRequirementAttachments(selectedRequirement.id));
      refreshCoverage();
    });
  }

  function renderCell(requirement: Requirement, column: RequirementColumnKey) {
    if (column === "coverage") {
      return coverage[requirement.id]?.linked ? (
        <span className="coverageBadge linked">Linked</span>
      ) : (
        <span className="coverageBadge unlinked">Unlinked</span>
      );
    }
    if (column === "verification_display") {
      const value = coverage[requirement.id]?.verification_display ?? "not_started";
      return <span className={`verificationBadge ${value}`}>{value.replaceAll("_", " ")}</span>;
    }
    if (column === "set_id") {
      const setName = requirementSets.find((set) => set.id === requirement.set_id)?.name;
      return setName ?? "-";
    }
    return getRequirementFieldValue(requirement, column, coverage);
  }

  if (!projectId) {
    return (
      <PageLayout className="requirementsPage" title="Requirements" description="Traceable requirements">
        <p className="hint">Select a project in the sidebar to manage requirements.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="requirementsPage" title="Requirements" description="Traceable requirements">
      <section className="partsCatalog">
        <div className="partsToolbar">
          <div className="partsToolbarMain">
            <button onClick={() => setShowNewForm((current) => !current)}>
              {showNewForm ? "Close new requirement form" : "New requirement"}
            </button>
            <input className="partsSearch" placeholder="Search requirements..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select label="Type" value={filters.requirement_type} options={uniqueRequirementValues(requirements, "requirement_type").map((v) => ({ value: v, label: v }))} onChange={(requirement_type) => setFilters({ ...filters, requirement_type })} />
            <Select label="Status" value={filters.status} options={uniqueRequirementValues(requirements, "status").map((v) => ({ value: v, label: v }))} onChange={(status) => setFilters({ ...filters, status })} />
            <Select label="Verification" value={filters.verification_method} options={uniqueRequirementValues(requirements, "verification_method").map((v) => ({ value: v, label: v }))} onChange={(verification_method) => setFilters({ ...filters, verification_method })} />
            <Select label="Owner" value={filters.owner} options={uniqueRequirementValues(requirements, "owner").map((v) => ({ value: v, label: v }))} onChange={(owner) => setFilters({ ...filters, owner })} />
            <Select label="Coverage" value={filters.link_status} options={[{ value: "linked", label: "Linked" }, { value: "unlinked", label: "Unlinked" }]} onChange={(link_status) => setFilters({ ...filters, link_status: link_status as RequirementFilters["link_status"] })} />
            <Select label="V&V readiness" value={filters.verification_display} options={[{ value: "not_started", label: "Not started" }, { value: "in_progress", label: "In progress" }, { value: "passed", label: "Passed" }, { value: "failed", label: "Failed" }]} onChange={(verification_display) => setFilters({ ...filters, verification_display })} />
            <Select label="Lifecycle" value={filters.lifecycle_status} options={uniqueRequirementValues(requirements, "lifecycle_status").map((v) => ({ value: v, label: v }))} onChange={(lifecycle_status) => setFilters({ ...filters, lifecycle_status })} />
            <Select label="Set" value={filters.set_id} options={requirementSets.map((set) => ({ value: set.id, label: set.name }))} onChange={(set_id) => setFilters({ ...filters, set_id })} />
            <Select label="Saved view" value="" options={savedViews.map((view) => ({ value: view.id, label: view.name }))} onChange={applySavedView} />
            <button onClick={saveCurrentView}>Save view</button>
          </div>
          <div className="partsToolbarActions">
            <button onClick={() => setShowColumnPicker((c) => !c)}>{showColumnPicker ? "Hide columns" : "Columns"}</button>
            <button onClick={() => setShowSets((c) => !c)}>Sets</button>
            <button onClick={() => setShowImport((c) => !c)}>Import CSV</button>
            <button disabled={selectedIds.length === 0} onClick={() => setShowBulkEdit((c) => !c)}>Bulk edit ({selectedIds.length})</button>
            <button disabled={selectedIds.length !== 2} onClick={runCompare}>Compare (2)</button>
            <button disabled={sortedRequirements.length === 0} onClick={exportCsv}>Export CSV</button>
            <button onClick={exportVerificationMatrix}>Verification matrix</button>
            <button className="danger" disabled={selectedIds.length === 0 || busy} onClick={deleteCheckedRequirements}>
              Delete selected ({selectedIds.length})
            </button>
          </div>
        </div>

        {showNewForm && (
          <Panel title="New requirement">
            <form className="partsFormGrid" onSubmit={submitNewRequirement}>
              <RequirementFormFields
                disabled={busy}
                form={newForm}
                onChange={setNewForm}
                requirementSets={requirementSets}
                requirements={requirements}
              />
              <FormError message={formErrors.requirement} />
              <div className="buttonRow">
                <button disabled={busy || !newForm.key || !newForm.title}>Create requirement</button>
                <button type="button" onClick={() => setShowNewForm(false)}>Cancel</button>
              </div>
            </form>
          </Panel>
        )}

        {showImport && (
          <Panel title="Import requirements (CSV)">
            <p className="hint">CSV header columns are auto-mapped when they match importable fields.</p>
            <textarea className="importCsvArea" value={importCsv} onChange={(e) => setImportCsv(e.target.value)} placeholder="key,title,text,requirement_type,status,owner" />
            <Select label="Duplicates" value={importDuplicateMode} options={[{ value: "skip", label: "Skip" }, { value: "update", label: "Update" }, { value: "error", label: "Error" }]} onChange={setImportDuplicateMode} />
            <div className="buttonRow"><button disabled={!importCsv.trim()} onClick={runImport}>Run import</button></div>
            {importResult && <p className="hint">{importResult}</p>}
          </Panel>
        )}

        {showBulkEdit && (
          <Panel title="Bulk edit selected requirements">
            <div className="partsFormGrid">
              <TextInput label="Status" value={bulkForm.status} onChange={(status) => setBulkForm({ ...bulkForm, status })} />
              <TextInput label="Owner" value={bulkForm.owner} onChange={(owner) => setBulkForm({ ...bulkForm, owner })} />
              <TextInput label="Verification method" value={bulkForm.verification_method} onChange={(verification_method) => setBulkForm({ ...bulkForm, verification_method })} />
              <TextInput label="Type" value={bulkForm.requirement_type} onChange={(requirement_type) => setBulkForm({ ...bulkForm, requirement_type })} />
              <TextInput label="Lifecycle" value={bulkForm.lifecycle_status} onChange={(lifecycle_status) => setBulkForm({ ...bulkForm, lifecycle_status })} />
              <TextInput label="Verification status" value={bulkForm.verification_status} onChange={(verification_status) => setBulkForm({ ...bulkForm, verification_status })} />
              <Select label="Set" value={bulkForm.set_id} options={requirementSets.map((set) => ({ value: set.id, label: set.name }))} onChange={(set_id) => setBulkForm({ ...bulkForm, set_id })} />
            </div>
            <div className="buttonRow"><button disabled={selectedIds.length === 0} onClick={runBulkEdit}>Apply to {selectedIds.length} requirement(s)</button></div>
          </Panel>
        )}

        {compareResult && (
          <Panel title={`Compare: ${compareResult.left.key} vs ${compareResult.right.key}`}>
            <DataTable
              rows={compareResult.differences}
              getKey={(row) => row.field}
              columns={[
                { header: "Field", render: (row) => row.field },
                { header: compareResult.left.key, render: (row) => String(row.left ?? "-") },
                { header: compareResult.right.key, render: (row) => String(row.right ?? "-") }
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
                  {sortedRequirements.length === 0 ? (
                    <tr><td colSpan={activeColumns.length + 1}>No requirements match the current filters.</td></tr>
                  ) : (
                    sortedRequirements.map((requirement) => (
                      <tr className={selectedRequirementId === requirement.id ? "selectedRow" : undefined} key={requirement.id} onClick={() => onSelectRequirement(requirement.id)}>
                        <td className="checkboxCell" onClick={(e) => e.stopPropagation()}>
                          <input checked={checkedIds.has(requirement.id)} type="checkbox" onChange={() => toggleChecked(requirement.id)} />
                        </td>
                        {activeColumns.map((column) => (
                          <td key={column.key}>{renderCell(requirement, column.key)}</td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {selectedRequirement && viewerForm && (
              <Panel title={`Requirement: ${selectedRequirement.key}`}>
                <div className="viewerTabs">
                  {(["details", "traceability", "revisions", "verification"] as ViewerTab[]).map((tab) => (
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
                            <button disabled={busy} onClick={saveEditedRequirement}>Save changes</button>
                            <button type="button" onClick={() => { setViewerForm(requirementToForm(selectedRequirement)); setIsEditing(false); }}>Cancel</button>
                          </>
                        )}
                        <button className="danger" disabled={busy} onClick={deleteSelectedRequirement}>Delete</button>
                      </div>
                    </div>
                    <div className="partsFormGrid">
                      <RequirementFormFields
                        disabled={!isEditing || busy}
                        form={viewerForm}
                        onChange={setViewerForm}
                        requirementSets={requirementSets}
                        requirements={requirements}
                      />
                    </div>
                  </>
                )}

                {viewerTab === "traceability" && traceability && (
                  <div className="viewerSections">
                    <Panel title="Add trace link">
                      <Select
                        label="Component"
                        value={linkComponentId}
                        options={traceableComponents.map((component) => ({
                          value: component.component_id,
                          label: `${component.tag} · ${component.diagram_name} (${component.system_name})`
                        }))}
                        onChange={setLinkComponentId}
                      />
                      <TextInput label="Link type" value={linkType} onChange={setLinkType} />
                      <TextArea label="Rationale" value={linkRationale} onChange={setLinkRationale} />
                      <button disabled={!linkComponentId} onClick={createTraceLink}>Link to component</button>
                      {traceableComponents.length === 0 && (
                        <p className="hint">No components in this project yet. Place components on diagrams first.</p>
                      )}
                    </Panel>
                    <DataTable
                      rows={traceability.links}
                      getKey={(link) => link.id}
                      columns={[
                        { header: "Type", render: (link) => link.link_type },
                        { header: "Target", render: (link) => `${link.target_type}:${link.target_id}` },
                        { header: "Rationale", render: (link) => link.rationale ?? "-" },
                        {
                          header: "",
                          render: (link) => (
                            <button className="danger" onClick={() => removeTraceLink(link.id)} type="button">
                              Remove
                            </button>
                          )
                        }
                      ]}
                    />
                    <ViewerList title="Components" items={traceability.components.map((c) => `${c.tag} (diagram ${c.diagram_id})`)} />
                    <ViewerList title="Diagrams" items={traceability.diagrams.map((d) => `${d.diagram_name} · ${d.system_name ?? ""}`)} />
                    <ViewerList title="Parts" items={traceability.parts.map((p) => `${p.part_number} - ${p.description}`)} />
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

                {viewerTab === "verification" && selectedRequirement && (
                  <div className="viewerSections">
                    <Panel title="Verification summary">
                      <p>Method: {selectedRequirement.verification_method ?? "-"}</p>
                      <p>Status: {selectedRequirement.verification_status}</p>
                      <p>V&V readiness: {coverage[selectedRequirement.id]?.verification_display ?? "not_started"}</p>
                      <p>Evidence files: {coverage[selectedRequirement.id]?.evidence_count ?? 0}</p>
                      <p>Trace links: {coverage[selectedRequirement.id]?.link_count ?? 0}</p>
                      <p className="hint">Last updated: {selectedRequirement.updated_at ? new Date(selectedRequirement.updated_at).toLocaleString() : "-"}</p>
                    </Panel>
                    <div className="buttonRow">
                      <Select label="Evidence type" value={attachmentType} options={[{ value: "test_report", label: "Test report" }, { value: "analysis_memo", label: "Analysis memo" }, { value: "inspection_record", label: "Inspection record" }, { value: "review_minutes", label: "Review minutes" }]} onChange={setAttachmentType} />
                      <label className="fileUpload">
                        Upload evidence
                        <input type="file" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAttachment(file); }} />
                      </label>
                    </div>
                    {attachments.length === 0 ? <p className="hint">No evidence attachments yet.</p> : attachments.map((attachment) => (
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
                  {REQUIREMENT_COLUMNS.map((column) => (
                    <label className="columnPickerItem" key={column.key}>
                      <input checked={visibleColumns.includes(column.key)} type="checkbox" onChange={() => toggleColumn(column.key)} />
                      {column.label}
                    </label>
                  ))}
                </div>
              </Panel>
            </aside>
          )}

          {showSets && (
            <aside className="columnPicker">
              <Panel title="Requirement sets">
                <form onSubmit={createSet}>
                  <TextInput label="Name" value={setForm.name} onChange={(name) => setSetForm({ ...setForm, name })} />
                  <TextInput label="Type" value={setForm.requirement_type} onChange={(requirement_type) => setSetForm({ ...setForm, requirement_type })} />
                  <TextInput label="Default verification" value={setForm.default_verification_method} onChange={(default_verification_method) => setSetForm({ ...setForm, default_verification_method })} />
                  <TextArea label="Template text" value={setForm.template_text} onChange={(template_text) => setSetForm({ ...setForm, template_text })} />
                  <button disabled={!setForm.name}>Create set</button>
                </form>
                <ViewerList title="Existing sets" items={requirementSets.map((set) => `${set.name} (${set.requirement_type})`)} />
              </Panel>
            </aside>
          )}
        </div>
      </section>
    </PageLayout>
  );
}

function RequirementFormFields({
  form,
  onChange,
  disabled,
  requirementSets,
  requirements
}: {
  form: RequirementFormState;
  onChange: (form: RequirementFormState) => void;
  disabled?: boolean;
  requirementSets: RequirementSet[];
  requirements: Requirement[];
}) {
  return (
    <>
      <TextInput label="Key" readOnly={disabled} value={form.key} onChange={(key) => onChange({ ...form, key })} />
      <TextInput label="Title" readOnly={disabled} value={form.title} onChange={(title) => onChange({ ...form, title })} />
      <TextInput label="Type" readOnly={disabled} value={form.requirement_type} onChange={(requirement_type) => onChange({ ...form, requirement_type })} />
      <TextInput label="Status" readOnly={disabled} value={form.status} onChange={(status) => onChange({ ...form, status })} />
      <TextInput label="Verification method" readOnly={disabled} value={form.verification_method} onChange={(verification_method) => onChange({ ...form, verification_method })} />
      <TextInput label="Verification status" readOnly={disabled} value={form.verification_status} onChange={(verification_status) => onChange({ ...form, verification_status })} />
      <TextInput label="Lifecycle" readOnly={disabled} value={form.lifecycle_status} onChange={(lifecycle_status) => onChange({ ...form, lifecycle_status })} />
      <TextInput label="Owner" readOnly={disabled} value={form.owner} onChange={(owner) => onChange({ ...form, owner })} />
      <Select
        disabled={disabled}
        label="Requirement set"
        value={form.set_id}
        options={requirementSets.map((set) => ({ value: set.id, label: set.name }))}
        onChange={(set_id) => onChange({ ...form, set_id })}
      />
      <Select
        disabled={disabled}
        label="Superseded by"
        value={form.superseded_by_requirement_id}
        options={requirements.map((requirement) => ({ value: requirement.id, label: requirement.key }))}
        onChange={(superseded_by_requirement_id) => onChange({ ...form, superseded_by_requirement_id })}
      />
      <TextArea label="Text" readOnly={disabled} value={form.text} onChange={(text) => onChange({ ...form, text })} />
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

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type { Drawing, ProjectSheetItem, RequirementConstraintRead, TraceLink, VerificationMatrix } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

type ConstraintForm = { kind: "" | RequirementConstraintRead["kind"]; values: string; services: string; categories: string };

/** Requirements with machine-checkable constraints, their trace links, and the verification matrix. */
export function RequirementsPage() {
  const {
    busy,
    formErrors,
    runAction,
    selectedProjectId,
    selectedProject,
    requirements,
    refreshRequirements,
    selectedRequirementId,
    setSelectedRequirementId
  } = useWorkspace();
  const [requirementForm, setRequirementForm] = useState({ key: "FSDP-REQ-1", title: "Maintain pressure boundary compatibility", text: "All pressurized components shall be compatible with maximum expected operating pressure.", requirement_type: "safety", verification_method: "analysis" });
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
        verification_method: selectedRequirement.verification_method ?? ""
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
      const requirement = await api.createRequirement({ ...requirementForm, project_id: projectId, status: "draft", constraint: constraintPayload() });
      await refreshRequirements(projectId);
      if (selectedProjectIdRef.current === projectId) setSelectedRequirementId(requirement.id);
    }, "requirement");
  }

  function updateRequirement() {
    if (!selectedProject || !selectedRequirement) return;
    void runAction("Updated requirement.", async () => {
      await api.updateRequirement(selectedRequirement.id, { ...requirementForm, constraint: constraintPayload() });
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
  function describeLinkTarget(link: TraceLink): { text: string; legacy: boolean } {
    const ownEnd = link.source_type === "requirement" && link.source_id === selectedRequirementId;
    const type = ownEnd ? link.target_type : link.source_type;
    const id = ownEnd ? link.target_id : link.source_id;
    if (type === "drawing") {
      const drawing = drawings.find((entry) => entry.id === id);
      return { text: drawing ? `Drawing ${drawing.number} · ${drawing.title.split("\n")[0]}` : "Drawing (deleted)", legacy: false };
    }
    if (type === "sheet_item") {
      const item = itemsById.get(id);
      return { text: item ? `${item.drawing_number} sheet ${item.sheet_no} · ${item.tag}${item.zone ? ` @ ${item.zone}` : ""}` : "Drawing item (untagged)", legacy: false };
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

  return (
    <PageLayout title="Requirements" description="Traceable requirements">
      <section className="grid">
        <Panel title="Requirement Editor">
          <form onSubmit={submitRequirement}>
            <TextInput label="Key" value={requirementForm.key} onChange={(key) => setRequirementForm({ ...requirementForm, key })} />
            <TextInput label="Title" value={requirementForm.title} onChange={(title) => setRequirementForm({ ...requirementForm, title })} />
            <TextInput label="Type" value={requirementForm.requirement_type} onChange={(requirementType) => setRequirementForm({ ...requirementForm, requirement_type: requirementType })} />
            <TextInput label="Verification" value={requirementForm.verification_method} onChange={(verificationMethod) => setRequirementForm({ ...requirementForm, verification_method: verificationMethod })} />
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
        <Panel title="Requirements">
          <DataTable rows={requirements} selectedKey={selectedRequirementId} getKey={(requirement) => requirement.id} onSelect={(requirement) => setSelectedRequirementId(requirement.id)} columns={[{ header: "Key", render: (requirement) => <span className="mono">{requirement.key}</span> }, { header: "Title", render: (requirement) => requirement.title }, { header: "Type", render: (requirement) => requirement.requirement_type }, { header: "Check", render: (requirement) => (requirement.constraint ? <span className="mono">{requirement.constraint.kind}{requirement.constraint.values.length ? ` ${requirement.constraint.values.join("|")}` : ""}</span> : <span className="hint">manual</span>) }, { header: "Status", render: (requirement) => <StatusPill value={requirement.status} /> }]} />
        </Panel>
        <Panel title="Verification Matrix">
          {verificationMatrix?.rows.length ? (
            <DataTable
              rows={verificationMatrix.rows}
              selectedKey={selectedRequirementId}
              getKey={(row) => row.requirement_id}
              onSelect={(row) => setSelectedRequirementId(row.requirement_id)}
              columns={[
                { header: "Key", render: (row) => <span className="mono">{row.key}</span> },
                { header: "Verdict", render: (row) => <span className={`pill ${row.verdict === "pass" ? "pill-good" : row.verdict === "fail" ? "pill-bad" : "pill-muted"}`}>{row.verdict.replace("_", " ")}</span> },
                { header: "Checked", render: (row) => <span className="mono">{row.constraint ? `${row.passed} pass / ${row.failed} fail` : "—"}</span> },
                { header: "Drawings", render: (row) => (row.drawings.length ? row.drawings.map((entry) => `${entry.drawing_number} (sheets ${entry.sheets.join(", ")})`).join("; ") : "—") },
                { header: "Links", render: (row) => <span className="mono">{row.linked_drawings} drawing(s) · {row.linked_components} component(s)</span> },
                { header: "Failures", render: (row) => (row.failures.length ? <span className="mono">{row.failures.map((failure) => `${failure.subject ?? failure.item_id}${failure.zone ? ` @ ${failure.zone}` : ""}`).join(", ")}</span> : "—") }
              ]}
            />
          ) : (
            <p className="hint">Requirements with a constraint are checked against every saved drawing sheet; open a drawing on the Drafting page and save it to populate the matrix.</p>
          )}
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

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type { ComponentInstance, Drawing, RequirementConstraintRead, TraceLink, VerificationMatrix } from "../types";
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
    setSelectedRequirementId,
    selectedDiagramId,
    selectedComponentId,
    setSelectedComponentId
  } = useWorkspace();
  const [requirementForm, setRequirementForm] = useState({ key: "FSDP-REQ-1", title: "Maintain pressure boundary compatibility", text: "All pressurized components shall be compatible with maximum expected operating pressure.", requirement_type: "safety", verification_method: "analysis" });
  const [constraintForm, setConstraintForm] = useState<ConstraintForm>({ kind: "", values: "", services: "", categories: "" });
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState("");
  const [verificationMatrix, setVerificationMatrix] = useState<VerificationMatrix | null>(null);
  const [traceLinks, setTraceLinks] = useState<TraceLink[]>([]);
  // Components of the diagram open on the legacy Diagrams page (trace-link targets).
  const [components, setComponents] = useState<ComponentInstance[]>([]);
  const [componentTag, setComponentTag] = useState("V-1");

  // Current selections for async actions: a response for a previous selection
  // must not overwrite what is on screen now.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedRequirementIdRef = useRef(selectedRequirementId);
  const selectedDiagramIdRef = useRef(selectedDiagramId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedRequirementIdRef.current = selectedRequirementId;
    selectedDiagramIdRef.current = selectedDiagramId;
  }, [selectedProjectId, selectedRequirementId, selectedDiagramId]);

  const selectedRequirement = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;
  const selectedComponent = components.find((component) => component.id === selectedComponentId) ?? null;

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

  useEffect(() => {
    setComponents([]);
    if (!selectedDiagramId) return;
    let cancelled = false;
    api
      .listComponents(selectedDiagramId)
      .then((next) => {
        if (!cancelled) setComponents(next);
      })
      .catch(() => {
        if (!cancelled) setComponents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDiagramId]);

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

  useEffect(() => {
    if (selectedComponent) {
      setComponentTag(selectedComponent.tag);
    }
  }, [selectedComponent]);

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

  function updateComponent() {
    if (!selectedComponent) return;
    void runAction("Updated component.", async () => {
      const updated = await api.updateComponent(selectedComponent.id, { tag: componentTag });
      setComponents((current) => current.map((component) => (component.id === updated.id ? updated : component)));
    }, "component");
  }

  function deleteComponent() {
    if (!selectedDiagramId || !selectedComponent || !window.confirm(`Delete component "${selectedComponent.tag}"?`)) return;
    const diagramId = selectedDiagramId;
    const componentId = selectedComponent.id;
    void runAction("Deleted component.", async () => {
      await api.deleteComponent(componentId);
      if (selectedDiagramIdRef.current !== diagramId) return;
      const next = await api.listComponents(diagramId);
      if (selectedDiagramIdRef.current !== diagramId) return;
      setComponents(next);
      setSelectedComponentId(next[0]?.id || "");
    });
  }

  /** Reload a requirement's trace links unless the selection moved on meanwhile. */
  async function reloadTraceLinks(requirementId: string) {
    const links = await api.listTraceLinks("requirement", requirementId);
    if (selectedRequirementIdRef.current === requirementId) setTraceLinks(links);
  }

  function linkRequirementToComponent() {
    if (!selectedRequirement || !selectedComponent) return;
    const requirementId = selectedRequirement.id;
    void runAction("Linked requirement.", async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: requirementId, target_type: "component", target_id: selectedComponent.id, link_type: "satisfied_by" });
      await reloadTraceLinks(requirementId);
    }, "traceLink");
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
          <Select label="Drawing" value={selectedDrawingId} options={drawings.map((drawing) => ({ value: drawing.id, label: `${drawing.number} · ${drawing.title.split("\n")[0]}` }))} onChange={setSelectedDrawingId} />
          <button className="primary" disabled={!selectedRequirement || !selectedDrawingId} onClick={linkRequirementToDrawing}>Link requirement to drawing</button>
          <Select label="Component" value={selectedComponentId} options={components.map((component) => ({ value: component.id, label: component.tag }))} onChange={setSelectedComponentId} />
          <TextInput label="Component tag" value={componentTag} onChange={setComponentTag} />
          <FormError message={formErrors.component} />
          <div className="buttonRow"><button disabled={!selectedComponent} onClick={updateComponent}>Update component</button><button className="danger" disabled={!selectedComponent} onClick={deleteComponent}>Delete component</button></div>
          <button className="primary" disabled={!selectedRequirement || !selectedComponent} onClick={linkRequirementToComponent}>Link requirement to component</button>
          <FormError message={formErrors.traceLink} />
          {selectedRequirement && (
            traceLinks.length
              ? <DataTable rows={traceLinks} getKey={(link) => link.id} columns={[{ header: "Link", render: (link) => <span className="mono">{link.link_type}</span> }, { header: "Target", render: (link) => <span className="mono">{link.target_type === "drawing" ? (drawings.find((drawing) => drawing.id === link.target_id)?.number ?? "drawing") : (components.find((component) => component.id === link.target_id)?.tag ?? `${link.target_type} ${link.target_id.slice(0, 8)}`)}</span> }, { header: "", render: (link) => <button className="danger" disabled={busy} onClick={() => removeTraceLink(link.id)}>Remove</button> }]} />
              : <p className="hint">No trace links for {selectedRequirement.key} yet.</p>
          )}
        </Panel>
      </section>
    </PageLayout>
  );
}

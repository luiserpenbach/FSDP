/**
 * Requirement detail drawer: fields, derivation, applicability, the
 * constraint builder, trace links, evidence, and history.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import type { ComponentInstance, Drawing, Evidence, Requirement, RequirementHistoryEntry, TraceLink } from "../../types";
import { FormError, StatusPill } from "../ui";
import { ConstraintBuilder, EMPTY_CONSTRAINT, constraintToForm, formToConstraint, type ConstraintForm } from "./ConstraintBuilder";

export const CATEGORIES = ["functional", "performance", "safety", "interface", "environmental", "manufacturing", "verification"];
export const METHODS = ["test", "analysis", "inspection", "demonstration", "design_rule"];
const STATUSES = ["draft", "in_review", "approved", "released", "obsolete"];
const EVIDENCE_KINDS = ["document", "test", "analysis", "inspection", "waiver"];

type Form = {
  key: string;
  title: string;
  text: string;
  category: string;
  verification_method: string;
  status: string;
  owner: string;
  parent_id: string;
  rationale: string;
  source_ref: string;
  services: string;
  operating_modes: string;
};

const EMPTY_FORM: Form = { key: "", title: "", text: "", category: "functional", verification_method: "", status: "draft", owner: "", parent_id: "", rationale: "", source_ref: "", services: "", operating_modes: "" };

function toForm(requirement: Requirement): Form {
  return {
    key: requirement.key,
    title: requirement.title,
    text: requirement.text,
    category: requirement.category ?? "functional",
    verification_method: requirement.verification_method ?? "",
    status: requirement.status,
    owner: requirement.owner ?? "",
    parent_id: requirement.parent_id ?? "",
    rationale: requirement.rationale ?? "",
    source_ref: requirement.source_ref ?? "",
    services: requirement.applicability?.services?.join(", ") ?? "",
    operating_modes: requirement.applicability?.operating_modes?.join(", ") ?? ""
  };
}

function split(text: string): string[] {
  return text.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function humanize(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

export function RequirementDrawer({
  projectId,
  requirement,
  requirements,
  drawings,
  components,
  canWrite,
  onSaved,
  onDeleted,
  onClose
}: {
  projectId: string;
  /** null creates a new requirement. */
  requirement: Requirement | null;
  requirements: Requirement[];
  drawings: Drawing[];
  components: ComponentInstance[];
  canWrite: boolean;
  onSaved: (requirement: Requirement) => void;
  onDeleted: (requirementId: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [constraint, setConstraint] = useState<ConstraintForm>(EMPTY_CONSTRAINT);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<TraceLink[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [history, setHistory] = useState<RequirementHistoryEntry[]>([]);
  const [linkDrawingId, setLinkDrawingId] = useState("");
  const [linkComponentId, setLinkComponentId] = useState("");
  const [evidenceForm, setEvidenceForm] = useState({ kind: "document", status: "pass", ref_id: "", note: "" });

  useEffect(() => {
    setError("");
    setForm(requirement ? toForm(requirement) : EMPTY_FORM);
    setConstraint(constraintToForm(requirement?.constraint));
    setLinkDrawingId("");
    setLinkComponentId("");
    if (!requirement) {
      setLinks([]);
      setEvidence([]);
      setHistory([]);
      return;
    }
    void Promise.all([api.listTraceLinks("requirement", requirement.id), api.listEvidence(requirement.id), api.getRequirementHistory(requirement.id)])
      .then(([nextLinks, nextEvidence, nextHistory]) => {
        setLinks(nextLinks);
        setEvidence(nextEvidence);
        setHistory(nextHistory);
      })
      .catch(() => undefined);
  }, [requirement]);

  async function run<T>(action: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function payload() {
    const applicability = { services: split(form.services), operating_modes: split(form.operating_modes) };
    return {
      key: form.key.trim(),
      title: form.title.trim(),
      text: form.text.trim(),
      requirement_type: form.category,
      category: form.category,
      verification_method: form.verification_method || null,
      status: form.status,
      owner: form.owner.trim() || null,
      parent_id: form.parent_id || null,
      rationale: form.rationale.trim() || null,
      source_ref: form.source_ref.trim() || null,
      applicability: applicability.services.length || applicability.operating_modes.length ? applicability : null,
      constraint: formToConstraint(constraint)
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.key.trim() || !form.title.trim() || !form.text.trim()) {
      setError("Key, title, and text are required.");
      return;
    }
    const body = payload();
    const saved = await run(() => (requirement ? api.updateRequirement(requirement.id, body) : api.createRequirement({ ...body, project_id: projectId })), "Could not save the requirement.");
    if (saved) onSaved(saved);
  }

  async function remove() {
    if (!requirement || !window.confirm(`Delete requirement "${requirement.key}"?`)) return;
    const done = await run(async () => {
      await api.deleteRequirement(requirement.id);
      return true;
    }, "Could not delete the requirement.");
    if (done) onDeleted(requirement.id);
  }

  async function addLink(targetType: "drawing" | "component", targetId: string) {
    if (!requirement || !targetId) return;
    const done = await run(async () => {
      await api.createTraceLink({ source_type: "requirement", source_id: requirement.id, target_type: targetType, target_id: targetId, link_type: targetType === "drawing" ? "verified_by" : "satisfied_by" });
      setLinks(await api.listTraceLinks("requirement", requirement.id));
      return true;
    }, "Could not add the trace link.");
    if (done) {
      setLinkDrawingId("");
      setLinkComponentId("");
    }
  }

  async function removeLink(linkId: string) {
    if (!requirement) return;
    await run(async () => {
      await api.deleteTraceLink(linkId);
      setLinks(await api.listTraceLinks("requirement", requirement.id));
    }, "Could not remove the trace link.");
  }

  async function addEvidence(event: FormEvent) {
    event.preventDefault();
    if (!requirement) return;
    const done = await run(async () => {
      await api.addEvidence(requirement.id, { kind: evidenceForm.kind, status: evidenceForm.status, ref_id: evidenceForm.ref_id.trim() || null, note: evidenceForm.note.trim() || null });
      setEvidence(await api.listEvidence(requirement.id));
      return true;
    }, "Could not record the evidence.");
    if (done) {
      setEvidenceForm({ kind: "document", status: "pass", ref_id: "", note: "" });
      const refreshed = await run(() => api.getRequirement(requirement.id), "Could not reload the requirement.");
      if (refreshed) onSaved(refreshed);
    }
  }

  async function setEvidenceStatus(entry: Evidence, status: string) {
    if (!requirement) return;
    await run(async () => {
      await api.updateEvidence(entry.id, { status });
      setEvidence(await api.listEvidence(requirement.id));
      onSaved(await api.getRequirement(requirement.id));
    }, "Could not update the evidence.");
  }

  async function removeEvidence(entry: Evidence) {
    if (!requirement) return;
    await run(async () => {
      await api.deleteEvidence(entry.id);
      setEvidence(await api.listEvidence(requirement.id));
      onSaved(await api.getRequirement(requirement.id));
    }, "Could not remove the evidence.");
  }

  function targetLabel(link: TraceLink): string {
    if (link.target_type === "drawing") return drawings.find((drawing) => drawing.id === link.target_id)?.number ?? "drawing";
    if (link.target_type === "component") return components.find((component) => component.id === link.target_id)?.tag ?? `component ${link.target_id.slice(0, 8)}`;
    return `${link.target_type} ${link.target_id.slice(0, 8)}`;
  }

  const parentOptions = requirements.filter((entry) => entry.id !== requirement?.id);

  return (
    <aside className="drawer requirementDrawer" aria-label={requirement ? `Requirement ${requirement.key}` : "New requirement"}>
      <div className="drawerHead">
        <div>
          <span className="mono">{requirement ? requirement.key : "New requirement"}</span>
          {requirement && (
            <span className="drawerStatus">
              <StatusPill value={requirement.verification_status ?? "planned"} />
              {requirement.safety_critical && <span className="pill pill-bad">safety-critical</span>}
              <span className="hint">rev {requirement.revision ?? 1}</span>
            </span>
          )}
        </div>
        <button type="button" className="drawerClose" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <form onSubmit={(event) => void submit(event)} className="drawerForm">
        <div className="fieldRow">
          <label>
            Key
            <input value={form.key} disabled={!canWrite} onChange={(event) => setForm({ ...form, key: event.target.value })} />
          </label>
          <label>
            Category
            <select value={form.category} disabled={!canWrite} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Title
          <input value={form.title} disabled={!canWrite} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </label>
        <label>
          Text
          <textarea rows={3} value={form.text} disabled={!canWrite} onChange={(event) => setForm({ ...form, text: event.target.value })} />
        </label>
        <label>
          Rationale
          <textarea rows={2} value={form.rationale} disabled={!canWrite} onChange={(event) => setForm({ ...form, rationale: event.target.value })} />
        </label>
        <div className="fieldRow">
          <label>
            Verification method
            <select value={form.verification_method} disabled={!canWrite} onChange={(event) => setForm({ ...form, verification_method: event.target.value })}>
              <option value="">Not set</option>
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {humanize(method)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={form.status} disabled={!canWrite} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {humanize(status)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fieldRow">
          <label>
            Owner
            <input value={form.owner} disabled={!canWrite} onChange={(event) => setForm({ ...form, owner: event.target.value })} />
          </label>
          <label>
            Derives from
            <select value={form.parent_id} disabled={!canWrite} onChange={(event) => setForm({ ...form, parent_id: event.target.value })}>
              <option value="">None (top level)</option>
              {parentOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.key} · {entry.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fieldRow">
          <label>
            Source reference
            <input value={form.source_ref} placeholder="Site standard §4.2" disabled={!canWrite} onChange={(event) => setForm({ ...form, source_ref: event.target.value })} />
          </label>
          <label>
            Applies to services
            <input value={form.services} placeholder="LOX, GN2" disabled={!canWrite} onChange={(event) => setForm({ ...form, services: event.target.value })} />
          </label>
        </div>
        <label>
          Applies in operating modes
          <input value={form.operating_modes} placeholder="hold, abort_safe" disabled={!canWrite} onChange={(event) => setForm({ ...form, operating_modes: event.target.value })} />
        </label>
        <ConstraintBuilder value={constraint} onChange={setConstraint} disabled={!canWrite} />
        <FormError message={error} />
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!canWrite || busy}>
            {requirement ? "Save requirement" : "Create requirement"}
          </button>
          {requirement && (
            <button type="button" className="danger" disabled={!canWrite || busy} onClick={() => void remove()}>
              Delete
            </button>
          )}
        </div>
      </form>

      {requirement && (
        <>
          <section className="drawerSection">
            <h3>Trace links</h3>
            {links.length === 0 ? (
              <p className="hint">Not linked to a drawing or component yet.</p>
            ) : (
              <ul className="controlList">
                {links.map((link) => (
                  <li key={link.id}>
                    <span className="mono">{link.link_type}</span>
                    <span className="controlTitle mono">{targetLabel(link)}</span>
                    <span />
                    {canWrite && (
                      <button type="button" className="linkButton" disabled={busy} onClick={() => void removeLink(link.id)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="addControl">
                <div className="fieldRow">
                  <label>
                    Drawing
                    <select value={linkDrawingId} onChange={(event) => setLinkDrawingId(event.target.value)}>
                      <option value="">Select…</option>
                      {drawings.map((drawing) => (
                        <option key={drawing.id} value={drawing.id}>
                          {drawing.number} · {drawing.title.split("\n")[0]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={busy || !linkDrawingId} onClick={() => void addLink("drawing", linkDrawingId)}>
                    Link drawing
                  </button>
                </div>
                <div className="fieldRow">
                  <label>
                    Component
                    <select value={linkComponentId} onChange={(event) => setLinkComponentId(event.target.value)}>
                      <option value="">Select…</option>
                      {components.map((component) => (
                        <option key={component.id} value={component.id}>
                          {component.tag}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={busy || !linkComponentId} onClick={() => void addLink("component", linkComponentId)}>
                    Link component
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="drawerSection">
            <h3>Evidence</h3>
            {evidence.length === 0 ? (
              <p className="hint">No evidence yet. Constraint requirements gain live DRC evidence when a sheet is saved; record test, analysis, inspection, or document evidence here.</p>
            ) : (
              <ul className="controlList">
                {evidence.map((entry) => (
                  <li key={entry.id}>
                    <span className="mono">{entry.kind}</span>
                    <span className="controlTitle" title={entry.note ?? ""}>
                      {entry.ref_id ?? entry.note ?? ""}
                      {entry.recorded_by ? <span className="hint"> · {entry.recorded_by}</span> : null}
                    </span>
                    {entry.kind === "drc" || !canWrite ? (
                      <StatusPill value={entry.status} />
                    ) : (
                      <select value={entry.status} aria-label={`Status of ${entry.kind} evidence`} onChange={(event) => void setEvidenceStatus(entry, event.target.value)}>
                        {["pass", "fail", "pending"].map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    )}
                    {entry.kind !== "drc" && canWrite ? (
                      <button type="button" className="linkButton" disabled={busy} onClick={() => void removeEvidence(entry)}>
                        Remove
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <form onSubmit={(event) => void addEvidence(event)} className="drawerForm">
                <div className="fieldRow">
                  <label>
                    Kind
                    <select value={evidenceForm.kind} onChange={(event) => setEvidenceForm({ ...evidenceForm, kind: event.target.value })}>
                      {EVIDENCE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Result
                    <select value={evidenceForm.status} onChange={(event) => setEvidenceForm({ ...evidenceForm, status: event.target.value })}>
                      {["pass", "fail", "pending"].map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="fieldRow">
                  <label>
                    Reference
                    <input value={evidenceForm.ref_id} placeholder="Report or procedure number" onChange={(event) => setEvidenceForm({ ...evidenceForm, ref_id: event.target.value })} />
                  </label>
                  <label>
                    Note
                    <input value={evidenceForm.note} onChange={(event) => setEvidenceForm({ ...evidenceForm, note: event.target.value })} />
                  </label>
                </div>
                <div className="buttonRow">
                  <button type="submit" disabled={busy}>
                    Record evidence
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="drawerSection">
            <h3>History</h3>
            {history.length === 0 ? (
              <p className="hint">No changes recorded since creation.</p>
            ) : (
              <ul className="historyList">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <span className="mono">rev {entry.revision}</span> {humanize(entry.field)}: <span className="hint">{entry.old_value ?? "—"}</span> → {entry.new_value ?? "—"}
                    <span className="hint">
                      {" "}
                      · {entry.actor ?? "—"} · {new Date(entry.created_at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

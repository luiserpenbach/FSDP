/**
 * Hazard detail drawer: fields, ratings, the control list (requirements and
 * hardware items with their verification state), derive-requirement, accept.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../../api";
import type { FluidSystem, Hazard, HazardInput, Requirement, SafetySettings, SheetItemRef } from "../../types";
import { FormError, StatusPill } from "../ui";

const EMPTY_FORM: HazardInput & { title: string } = {
  title: "",
  description: "",
  category: "other",
  system_id: null,
  operating_modes: [],
  severity_initial: null,
  likelihood_initial: null,
  severity_residual: null,
  likelihood_residual: null,
  owner: null
};

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

export function HazardDrawer({
  projectId,
  hazard,
  settings,
  systems,
  requirements,
  canWrite,
  onSaved,
  onDeleted,
  onRequirementsChanged,
  onClose
}: {
  projectId: string;
  /** null creates a new hazard. */
  hazard: Hazard | null;
  settings: SafetySettings;
  systems: FluidSystem[];
  requirements: Requirement[];
  canWrite: boolean;
  onSaved: (hazard: Hazard) => void;
  onDeleted: (hazardId: string) => void;
  onRequirementsChanged: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<HazardInput & { title: string }>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [controlType, setControlType] = useState<"requirement" | "sheet_item">("requirement");
  const [controlRequirementId, setControlRequirementId] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [itemMatches, setItemMatches] = useState<SheetItemRef[]>([]);
  const [derive, setDerive] = useState<{ open: boolean; key: string; title: string; text: string; method: string }>({ open: false, key: "", title: "", text: "", method: "test" });
  const [justification, setJustification] = useState("");

  useEffect(() => {
    setError("");
    setForm(
      hazard
        ? {
            title: hazard.title,
            description: hazard.description,
            category: hazard.category,
            system_id: hazard.system_id,
            operating_modes: hazard.operating_modes ?? [],
            severity_initial: hazard.severity_initial,
            likelihood_initial: hazard.likelihood_initial,
            severity_residual: hazard.severity_residual,
            likelihood_residual: hazard.likelihood_residual,
            owner: hazard.owner,
            fault_tolerance_required: hazard.fault_tolerance_required
          }
        : { ...EMPTY_FORM, severity_initial: settings.default_hazard_severity, likelihood_initial: settings.default_hazard_likelihood }
    );
    setJustification("");
    setDerive((current) => ({ ...current, open: false }));
  }, [hazard, settings.default_hazard_severity, settings.default_hazard_likelihood]);

  useEffect(() => {
    if (controlType !== "sheet_item" || !projectId) return;
    const handle = window.setTimeout(() => {
      void api
        .listSheetItems(projectId, { q: itemQuery, limit: 20 })
        .then(setItemMatches)
        .catch(() => setItemMatches([]));
    }, 150);
    return () => window.clearTimeout(handle);
  }, [controlType, itemQuery, projectId]);

  const linkedRequirementIds = useMemo(() => new Set((hazard?.controls ?? []).filter((control) => control.type === "requirement").map((control) => control.id)), [hazard]);
  const requirementOptions = requirements.filter((requirement) => !linkedRequirementIds.has(requirement.id));

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) {
      setError("Give the hazard a title.");
      return;
    }
    const body: HazardInput & { title: string } = { ...form, system_id: form.system_id || null };
    const saved = await run(() => (hazard ? api.updateHazard(hazard.id, body) : api.createHazard(projectId, body)), "Could not save the hazard.");
    if (saved) onSaved(saved);
  }

  async function remove() {
    if (!hazard) return;
    if (!window.confirm(`Delete ${hazard.key}? Its control links are removed too.`)) return;
    const done = await run(async () => {
      await api.deleteHazard(hazard.id);
      return true;
    }, "Could not delete the hazard.");
    if (done) onDeleted(hazard.id);
  }

  async function addControl(id: string) {
    if (!hazard || !id) return;
    const saved = await run(() => api.addHazardControl(hazard.id, { type: controlType, id }), "Could not add the control.");
    if (saved) {
      onSaved(saved);
      setControlRequirementId("");
      setItemQuery("");
      if (controlType === "requirement") onRequirementsChanged();
    }
  }

  async function removeControl(linkId: string) {
    if (!hazard) return;
    const saved = await run(() => api.removeHazardControl(hazard.id, linkId), "Could not remove the control.");
    if (saved) {
      onSaved(saved);
      onRequirementsChanged();
    }
  }

  async function submitDerive(event: FormEvent) {
    event.preventDefault();
    if (!hazard) return;
    const created = await run(
      () => api.deriveRequirement(hazard.id, { key: derive.key, title: derive.title, text: derive.text, verification_method: derive.method || null }),
      "Could not derive the requirement."
    );
    if (created) {
      setDerive({ open: false, key: "", title: "", text: "", method: "test" });
      onRequirementsChanged();
      const refreshed = await run(() => api.getHazard(hazard.id), "Could not reload the hazard.");
      if (refreshed) onSaved(refreshed);
    }
  }

  async function accept() {
    if (!hazard || !justification.trim()) return;
    const saved = await run(() => api.acceptHazard(hazard.id, justification.trim()), "Could not accept the hazard.");
    if (saved) onSaved(saved);
  }

  const severityOptions = settings.severity_scale.map((entry) => ({ value: entry.code, label: `${entry.code} · ${entry.name}` }));
  const likelihoodOptions = settings.likelihood_scale.map((entry) => ({ value: entry.code, label: `${entry.code} · ${entry.name}` }));

  return (
    <aside className="drawer hazardDrawer" aria-label={hazard ? `Hazard ${hazard.key}` : "New hazard"}>
      <div className="drawerHead">
        <div>
          <span className="mono">{hazard ? hazard.key : "New hazard"}</span>
          {hazard && (
            <span className="drawerStatus">
              <StatusPill value={hazard.computed_status} />
              {hazard.risk_residual && <span className={`pill risk-${hazard.risk_residual}`}>{hazard.risk_residual}</span>}
            </span>
          )}
        </div>
        <button type="button" className="drawerClose" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <form onSubmit={(event) => void submit(event)} className="drawerForm">
        <label>
          Title
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} disabled={!canWrite} />
        </label>
        <label>
          Description
          <textarea rows={3} value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} disabled={!canWrite} />
        </label>
        <div className="fieldRow">
          <label>
            Category
            <select value={form.category ?? "other"} onChange={(event) => setForm({ ...form, category: event.target.value })} disabled={!canWrite}>
              {settings.hazard_categories.map((category) => (
                <option key={category} value={category}>
                  {humanize(category)}
                </option>
              ))}
            </select>
          </label>
          <label>
            System
            <select value={form.system_id ?? ""} onChange={(event) => setForm({ ...form, system_id: event.target.value || null })} disabled={!canWrite}>
              <option value="">Any</option>
              {systems.map((system) => (
                <option key={system.id} value={system.id}>
                  {system.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="modeSet">
          <legend>Operating modes</legend>
          <div className="modeChips">
            {settings.operating_modes.map((mode) => {
              const active = (form.operating_modes ?? []).includes(mode);
              return (
                <label key={mode} className={`chip${active ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={!canWrite}
                    onChange={(event) => {
                      const current = new Set(form.operating_modes ?? []);
                      if (event.target.checked) current.add(mode);
                      else current.delete(mode);
                      setForm({ ...form, operating_modes: settings.operating_modes.filter((entry) => current.has(entry)) });
                    }}
                  />
                  {humanize(mode)}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="fieldRow">
          <label>
            Initial severity
            <select value={form.severity_initial ?? ""} onChange={(event) => setForm({ ...form, severity_initial: event.target.value || null })} disabled={!canWrite}>
              <option value="">Unrated</option>
              {severityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Initial likelihood
            <select value={form.likelihood_initial ?? ""} onChange={(event) => setForm({ ...form, likelihood_initial: event.target.value || null })} disabled={!canWrite}>
              <option value="">Unrated</option>
              {likelihoodOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fieldRow">
          <label>
            Residual severity
            <select value={form.severity_residual ?? ""} onChange={(event) => setForm({ ...form, severity_residual: event.target.value || null })} disabled={!canWrite}>
              <option value="">Same as initial</option>
              {severityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Residual likelihood
            <select value={form.likelihood_residual ?? ""} onChange={(event) => setForm({ ...form, likelihood_residual: event.target.value || null })} disabled={!canWrite}>
              <option value="">Same as initial</option>
              {likelihoodOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fieldRow">
          <label>
            Owner
            <input value={form.owner ?? ""} onChange={(event) => setForm({ ...form, owner: event.target.value || null })} disabled={!canWrite} />
          </label>
          <label>
            Independent controls required
            <input
              type="number"
              min={1}
              max={9}
              value={form.fault_tolerance_required ?? ""}
              placeholder={`policy: ${settings.fault_tolerance[form.severity_initial ?? ""] ?? 1}`}
              onChange={(event) => setForm({ ...form, fault_tolerance_required: event.target.value ? Number(event.target.value) : undefined })}
              disabled={!canWrite}
            />
          </label>
        </div>
        <FormError message={error} />
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!canWrite || busy}>
            {hazard ? "Save hazard" : "Create hazard"}
          </button>
          {hazard && (
            <button type="button" className="danger" disabled={!canWrite || busy} onClick={() => void remove()}>
              Delete
            </button>
          )}
        </div>
      </form>

      {hazard && (
        <>
          <section className="drawerSection">
            <h3>
              Controls{" "}
              <span className="hint">
                {hazard.controls_verified} of {hazard.controls_total} verified · {hazard.independent_controls} of {hazard.fault_tolerance_required} independent required
              </span>
            </h3>
            {hazard.controls.length === 0 ? (
              <p className="hint">No controls yet. A hazard is controlled only when every control is a verified requirement and the fault-tolerance policy is met.</p>
            ) : (
              <ul className="controlList">
                {hazard.controls.map((control) => (
                  <li key={control.link_id}>
                    <span className="mono">{control.label}</span>
                    <span className="controlTitle">
                      {control.title ?? ""}
                      {control.type === "sheet_item" && (
                        <span className="hint"> {control.covered ? `covered by ${control.covering_requirements.join(", ")}` : "no requirement applies to this item"}</span>
                      )}
                    </span>
                    <StatusPill value={control.verification_status} />
                    {canWrite && (
                      <button type="button" className="linkButton" disabled={busy} onClick={() => void removeControl(control.link_id)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="addControl">
                <select value={controlType} onChange={(event) => setControlType(event.target.value as "requirement" | "sheet_item")} aria-label="Control type">
                  <option value="requirement">Requirement</option>
                  <option value="sheet_item">Hardware item on a drawing</option>
                </select>
                {controlType === "requirement" ? (
                  <>
                    <select value={controlRequirementId} onChange={(event) => setControlRequirementId(event.target.value)} aria-label="Requirement">
                      <option value="">Select a requirement…</option>
                      {requirementOptions.map((requirement) => (
                        <option key={requirement.id} value={requirement.id}>
                          {requirement.key} · {requirement.title}
                        </option>
                      ))}
                    </select>
                    <button type="button" disabled={busy || !controlRequirementId} onClick={() => void addControl(controlRequirementId)}>
                      Add control
                    </button>
                  </>
                ) : (
                  <>
                    <input value={itemQuery} placeholder="Search tags (TRV-201, PT…)" aria-label="Search items" onChange={(event) => setItemQuery(event.target.value)} />
                    {itemMatches.length > 0 && (
                      <ul className="pickList">
                        {itemMatches.map((item) => (
                          <li key={item.id}>
                            <button type="button" disabled={busy} onClick={() => void addControl(item.id)}>
                              <span className="mono">{item.tag ?? item.label ?? item.item_id}</span>
                              <span className="hint">
                                {item.symbol_name ?? item.category ?? ""} · {item.drawing_number} sheet {item.sheet_no}
                                {item.zone ? ` · ${item.zone}` : ""}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          {canWrite && (
            <section className="drawerSection">
              <h3>Derive a requirement</h3>
              {derive.open ? (
                <form onSubmit={(event) => void submitDerive(event)} className="drawerForm">
                  <div className="fieldRow">
                    <label>
                      Key
                      <input value={derive.key} onChange={(event) => setDerive({ ...derive, key: event.target.value })} />
                    </label>
                    <label>
                      Verification
                      <select value={derive.method} onChange={(event) => setDerive({ ...derive, method: event.target.value })}>
                        {["test", "analysis", "inspection", "demonstration", "design_rule"].map((method) => (
                          <option key={method} value={method}>
                            {humanize(method)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Requirement title
                    <input value={derive.title} onChange={(event) => setDerive({ ...derive, title: event.target.value })} />
                  </label>
                  <label>
                    Requirement text
                    <textarea rows={3} value={derive.text} onChange={(event) => setDerive({ ...derive, text: event.target.value })} />
                  </label>
                  <div className="buttonRow">
                    <button type="submit" className="primary" disabled={busy || !derive.key.trim() || !derive.title.trim() || !derive.text.trim()}>
                      Create and link
                    </button>
                    <button type="button" disabled={busy} onClick={() => setDerive({ ...derive, open: false })}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" disabled={busy} onClick={() => setDerive({ ...derive, open: true, key: "", title: "", text: "" })}>
                  New safety requirement from this hazard
                </button>
              )}
            </section>
          )}

          <section className="drawerSection">
            <h3>Acceptance</h3>
            {hazard.status === "accepted" ? (
              <p className="hint">
                Accepted by {hazard.accepted_by ?? "—"}
                {hazard.accepted_at ? ` on ${new Date(hazard.accepted_at).toLocaleDateString()}` : ""}: {hazard.acceptance_justification}
              </p>
            ) : canWrite ? (
              <>
                <label>
                  Justification
                  <textarea rows={2} value={justification} onChange={(event) => setJustification(event.target.value)} />
                </label>
                <button type="button" disabled={busy || !justification.trim()} onClick={() => void accept()}>
                  Accept residual risk
                </button>
              </>
            ) : (
              <p className="hint">Not accepted.</p>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

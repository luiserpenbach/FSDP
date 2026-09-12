/**
 * Project safety settings (Settings page): operating modes, hazard
 * categories, the fault-tolerance policy by severity, and flags.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { FormError, Panel } from "../components/ui";
import type { Project, SafetySettings, User } from "../types";

function linesOf(values: string[]): string {
  return values.join("\n");
}

function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replaceAll(/\s+/g, "_"))
    .filter(Boolean);
}

export function SafetySettingsPanel({ project, canWrite, users = null }: { project: Project | null; canWrite: boolean; users?: User[] | null }) {
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [modesText, setModesText] = useState("");
  const [categoriesText, setCategoriesText] = useState("");
  const [approversText, setApproversText] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    setStatus("");
    setError("");
    void api
      .getSafetySettings(project.id)
      .then((read) => {
        setSettings(read.settings);
        setModesText(linesOf(read.settings.operating_modes));
        setCategoriesText(linesOf(read.settings.hazard_categories));
        setApproversText((read.settings.approvers ?? []).join("\n"));
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load safety settings."));
  }, [project]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!project || !settings) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.updateSafetySettings(project.id, {
        ...settings,
        operating_modes: toLines(modesText),
        hazard_categories: toLines(categoriesText),
        approvers: users ? settings.approvers : approversText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      });
      setSettings(saved.settings);
      setModesText(linesOf(saved.settings.operating_modes));
      setCategoriesText(linesOf(saved.settings.hazard_categories));
      setApproversText((saved.settings.approvers ?? []).join("\n"));
      setStatus("Safety settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save safety settings.");
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <Panel title="Safety Policy">
        <p className="hint">Select a project to configure its risk matrix, fault-tolerance policy, and operating modes.</p>
      </Panel>
    );
  }
  if (!settings) {
    return (
      <Panel title={`Safety Policy · ${project.name}`}>
        <FormError message={error} />
        <p className="hint">Loading…</p>
      </Panel>
    );
  }

  return (
    <Panel title={`Safety Policy · ${project.name}`}>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="policyGrid">
          <legend>Independent controls required before a hazard counts as controlled</legend>
          {settings.severity_scale.map((severity) => (
            <label key={severity.code}>
              {severity.code} · {severity.name}
              <input
                type="number"
                min={1}
                max={9}
                value={settings.fault_tolerance[severity.code] ?? 1}
                disabled={!canWrite}
                onChange={(event) => setSettings({ ...settings, fault_tolerance: { ...settings.fault_tolerance, [severity.code]: Math.max(1, Number(event.target.value) || 1) } })}
              />
            </label>
          ))}
        </fieldset>
        <div className="fieldRow">
          <label>
            Operating modes (one per line)
            <textarea rows={6} value={modesText} onChange={(event) => setModesText(event.target.value)} disabled={!canWrite} />
          </label>
          <label>
            Hazard categories (one per line)
            <textarea rows={6} value={categoriesText} onChange={(event) => setCategoriesText(event.target.value)} disabled={!canWrite} />
          </label>
        </div>
        <div className="fieldRow">
          <label>
            Default severity for new hazards
            <select value={settings.default_hazard_severity} disabled={!canWrite} onChange={(event) => setSettings({ ...settings, default_hazard_severity: event.target.value })}>
              {settings.severity_scale.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default likelihood for new hazards
            <select value={settings.default_hazard_likelihood} disabled={!canWrite} onChange={(event) => setSettings({ ...settings, default_hazard_likelihood: event.target.value })}>
              {settings.likelihood_scale.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          RPN action threshold (FMEA)
          <input type="number" min={1} value={settings.rpn_threshold} disabled={!canWrite} onChange={(event) => setSettings({ ...settings, rpn_threshold: Math.max(1, Number(event.target.value) || 1) })} />
        </label>
        <label className="checkRow">
          <input type="checkbox" checked={settings.auto_hazard} disabled={!canWrite} onChange={(event) => setSettings({ ...settings, auto_hazard: event.target.checked })} />
          <span>Create a trapped-fluid hazard for every relief-coverage finding (takes effect when engine analyses ship)</span>
        </label>
        <fieldset className="checkList">
          <legend>Safety approvers (may accept hazards and release worksheets; admins always may)</legend>
          {users ? (
            users.length ? (
              users.map((entry) => (
                <label key={entry.id} className="checkRow">
                  <input
                    type="checkbox"
                    disabled={!canWrite}
                    checked={settings.approvers.includes(entry.email) || settings.approvers.includes(entry.id)}
                    onChange={(event) => {
                      const without = settings.approvers.filter((value) => value !== entry.email && value !== entry.id);
                      setSettings({ ...settings, approvers: event.target.checked ? [...without, entry.email] : without });
                    }}
                  />
                  <span>
                    {entry.name} <span className="hint">{entry.email} · {entry.role}</span>
                  </span>
                </label>
              ))
            ) : (
              <span className="hint">No users yet.</span>
            )
          ) : (
            <label>
              Approver e-mails (one per line)
              <textarea rows={4} value={approversText} disabled={!canWrite} onChange={(event) => setApproversText(event.target.value)} />
            </label>
          )}
          <p className="hint">With no approvers listed, any engineer may accept hazards and release worksheets.</p>
        </fieldset>
        <p className="hint">
          Risk classes follow the MIL-STD-882 style matrix: severity {settings.severity_scale.map((entry) => entry.code).join("/")} against likelihood {settings.likelihood_scale.map((entry) => entry.code).join("/")}.
        </p>
        <FormError message={error} />
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!canWrite || busy}>
            Save safety settings
          </button>
        </div>
        {status && <p className="hint">{status}</p>}
      </form>
    </Panel>
  );
}

/**
 * Analyses tab: engine-derived safety analyses over saved sheets (trapped
 * volumes, relief scenarios, single-point failures, fault tolerance) and
 * manual ones. Each shows its inputs, assumptions, result, verdict, and can
 * be re-run or attached as evidence to a requirement.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../../api";
import type { Analysis, Drawing, Hazard, Requirement, SheetVolume } from "../../types";
import { DataTable, FormError, Panel, StatusPill } from "../ui";

const KINDS: Array<{ value: string; label: string; needsSheet: boolean }> = [
  { value: "trapped_volume", label: "Trapped volumes", needsSheet: true },
  { value: "relief_scenario", label: "Relief scenario", needsSheet: true },
  { value: "single_point_failure", label: "Single-point failures", needsSheet: true },
  { value: "fault_tolerance", label: "Fault tolerance of a hazard", needsSheet: false },
  { value: "manual", label: "Manual (attached report)", needsSheet: false }
];

function humanize(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

function verdictTone(verdict: string | null): string {
  return verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : verdict === "info" ? "waived" : "planned";
}

export function AnalysesTab({
  projectId,
  drawings,
  hazards,
  requirements,
  canWrite,
  onRequirementsChanged
}: {
  projectId: string;
  drawings: Drawing[];
  hazards: Hazard[];
  requirements: Requirement[];
  canWrite: boolean;
  onRequirementsChanged: () => void;
}) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<SheetVolume[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ kind: "trapped_volume", sheet_id: "", volume_key: "", hazard_id: "", title: "" });
  const [assumptionsText, setAssumptionsText] = useState("");
  const [attachId, setAttachId] = useState("");

  const reload = useCallback(async () => {
    try {
      const [list, projectVolumes] = await Promise.all([api.listAnalyses(projectId), api.listProjectVolumes(projectId).catch(() => [])]);
      setAnalyses(list);
      setVolumes(projectVolumes);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load analyses.");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = analyses.find((entry) => entry.id === selectedId) ?? null;
  useEffect(() => {
    setAssumptionsText(selected ? JSON.stringify(selected.assumptions ?? {}, null, 2) : "");
    setAttachId("");
  }, [selected]);

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

  const sheets = useMemo(() => drawings.flatMap((drawing) => drawing.sheets.map((sheet) => ({ id: sheet.id, label: `${drawing.number} sheet ${sheet.sheet_no}` }))), [drawings]);
  const sheetVolumes = volumes.filter((volume) => volume.sheet_id === form.sheet_id && volume.isolable);
  const kind = KINDS.find((entry) => entry.value === form.kind)!;

  async function create(event: FormEvent) {
    event.preventDefault();
    const scope: Record<string, unknown> = {};
    if (form.kind === "relief_scenario") scope.volume_key = form.volume_key;
    if (form.kind === "fault_tolerance") scope.hazard_id = form.hazard_id;
    const created = await run(() => api.createAnalysis(projectId, { kind: form.kind, title: form.title.trim() || null, sheet_id: kind.needsSheet ? form.sheet_id || null : null, scope }), "Could not create the analysis.");
    if (created) {
      await reload();
      setSelectedId(created.id);
    }
  }

  async function rerun() {
    if (!selected) return;
    let assumptions: Record<string, unknown> | null = null;
    try {
      assumptions = assumptionsText.trim() ? (JSON.parse(assumptionsText) as Record<string, unknown>) : null;
    } catch {
      setError("Assumptions must be valid JSON.");
      return;
    }
    const updated = await run(async () => {
      if (assumptions) await api.updateAnalysis(selected.id, { assumptions });
      return api.runAnalysis(selected.id);
    }, "Could not run the analysis.");
    if (updated) {
      setAnalyses((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    }
  }

  async function attach() {
    if (!selected || !attachId) return;
    const updated = await run(() => api.attachAnalysisEvidence(selected.id, attachId), "Could not attach the analysis.");
    if (updated) {
      setAnalyses((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      onRequirementsChanged();
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete analysis "${selected.title}"?`)) return;
    const done = await run(async () => {
      await api.deleteAnalysis(selected.id);
      return true;
    }, "Could not delete the analysis.");
    if (done) {
      setSelectedId(null);
      await reload();
      onRequirementsChanged();
    }
  }

  return (
    <section className={`safetyLayout${selected ? " withDrawer" : ""}`}>
      <div className="grid">
        <Panel title={`Analyses · ${analyses.length}`}>
          <FormError message={error} />
          <DataTable
            rows={analyses}
            selectedKey={selectedId ?? undefined}
            getKey={(entry) => entry.id}
            onSelect={(entry) => setSelectedId(entry.id)}
            columns={[
              { header: "Kind", render: (entry) => humanize(entry.kind) },
              { header: "Title", render: (entry) => <span className="clamp" title={entry.title}>{entry.title}</span> },
              { header: "Verdict", render: (entry) => <StatusPill value={verdictTone(entry.verdict)} /> },
              { header: "State", render: (entry) => (entry.outdated ? <span className="pill pill-warn">outdated</span> : <span className="hint">current</span>) },
              { header: "Evidence for", render: (entry) => <span className="mono">{entry.evidence_for.map((id) => requirements.find((requirement) => requirement.id === id)?.key ?? id.slice(0, 8)).join(", ") || "—"}</span> },
              { header: "Run", render: (entry) => <span className="hint">{entry.run_at ? new Date(entry.run_at).toLocaleString() : "—"}</span> }
            ]}
          />
        </Panel>
        {canWrite && (
          <Panel title="New analysis">
            <form onSubmit={(event) => void create(event)} className="drawerForm">
              <label>
                Kind
                <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                  {KINDS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              {kind.needsSheet && (
                <label>
                  Sheet
                  <select value={form.sheet_id} onChange={(event) => setForm({ ...form, sheet_id: event.target.value, volume_key: "" })}>
                    <option value="">Select a saved sheet…</option>
                    {sheets.map((sheet) => (
                      <option key={sheet.id} value={sheet.id}>
                        {sheet.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.kind === "relief_scenario" && (
                <label>
                  Isolable volume
                  <select value={form.volume_key} onChange={(event) => setForm({ ...form, volume_key: event.target.value })}>
                    <option value="">Select…</option>
                    {sheetVolumes.map((volume) => (
                      <option key={volume.key} value={volume.key}>
                        {volume.line_numbers.join(", ") || volume.key} · {volume.service ?? "?"} · isolated by {volume.isolating_tags.join(", ") || "?"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.kind === "fault_tolerance" && (
                <label>
                  Hazard
                  <select value={form.hazard_id} onChange={(event) => setForm({ ...form, hazard_id: event.target.value })}>
                    <option value="">Select…</option>
                    {hazards.map((hazard) => (
                      <option key={hazard.id} value={hazard.id}>
                        {hazard.key} · {hazard.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Title (optional)
                <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
              </label>
              <div className="buttonRow">
                <button type="submit" className="primary" disabled={busy || (kind.needsSheet && !form.sheet_id) || (form.kind === "relief_scenario" && !form.volume_key) || (form.kind === "fault_tolerance" && !form.hazard_id)}>
                  Create and run
                </button>
              </div>
            </form>
          </Panel>
        )}
      </div>
      {selected && (
        <aside className="drawer" aria-label={`Analysis ${selected.title}`}>
          <div className="drawerHead">
            <div>
              <span className="mono">{humanize(selected.kind)}</span> <span className="hint">{selected.drawing_number ? `${selected.drawing_number} sheet ${selected.sheet_no}` : ""}</span>
              <span className="drawerStatus">
                <StatusPill value={verdictTone(selected.verdict)} />
                {selected.outdated && <span className="pill pill-warn">outdated</span>}
              </span>
            </div>
            <button type="button" className="drawerClose" aria-label="Close" onClick={() => setSelectedId(null)}>
              ×
            </button>
          </div>
          <h3 style={{ margin: 0, fontSize: 15 }}>{selected.title}</h3>
          <AnalysisResult analysis={selected} />
          <section className="drawerSection">
            <h3>Assumptions</h3>
            <textarea rows={8} className="mono" value={assumptionsText} disabled={!canWrite || selected.kind === "manual"} onChange={(event) => setAssumptionsText(event.target.value)} aria-label="Assumptions" />
            {canWrite && (
              <div className="buttonRow compact">
                <button type="button" className="primary" disabled={busy} onClick={() => void rerun()}>
                  {selected.kind === "manual" ? "Save" : "Run"}
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                  Delete
                </button>
              </div>
            )}
          </section>
          <section className="drawerSection">
            <h3>Evidence</h3>
            {selected.evidence_for.length > 0 && (
              <p className="hint">
                Attached to {selected.evidence_for.map((id) => requirements.find((requirement) => requirement.id === id)?.key ?? id.slice(0, 8)).join(", ")}.
              </p>
            )}
            {canWrite && (
              <div className="fieldRow">
                <label>
                  Requirement
                  <select value={attachId} onChange={(event) => setAttachId(event.target.value)} aria-label="Attach to requirement">
                    <option value="">Select…</option>
                    {requirements.filter((requirement) => !selected.evidence_for.includes(requirement.id)).map((requirement) => (
                      <option key={requirement.id} value={requirement.id}>
                        {requirement.key} · {requirement.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" disabled={busy || !attachId || selected.outdated} title={selected.outdated ? "Re-run first" : undefined} onClick={() => void attach()}>
                  Attach as evidence
                </button>
              </div>
            )}
          </section>
        </aside>
      )}
    </section>
  );
}

function AnalysisResult({ analysis }: { analysis: Analysis }) {
  const result = (analysis.result ?? {}) as Record<string, unknown>;
  if (analysis.kind === "trapped_volume" && Array.isArray(result.volumes)) {
    const rows = result.volumes as Array<Record<string, unknown>>;
    return (
      <section className="drawerSection">
        <h3>
          Isolable volumes <span className="hint">{String(result.unrelieved_count ?? 0)} without relief</span>
        </h3>
        <ul className="controlList">
          {rows.map((row) => (
            <li key={String(row.volume_key)}>
              <span className="mono">{(row.line_numbers as string[])?.join(", ") || String(row.volume_key)}</span>
              <span className="controlTitle">
                {String(row.service ?? "")} · isolated by {(row.isolating_tags as string[])?.join(", ") || "?"} · {row.relieved ? `relief ${(row.relief_tags as string[])?.join(", ")}` : "no relief"}
                {row.temperature_rise_to_design_k != null ? ` · ${String(row.temperature_rise_to_design_k)} K to design pressure` : ""}
              </span>
              <StatusPill value={row.verdict === "fail" ? "failed" : row.verdict === "pass" ? "verified" : "in_progress"} />
              <span />
            </li>
          ))}
        </ul>
        <p className="hint">{String(result.method ?? "")}</p>
      </section>
    );
  }
  if (analysis.kind === "relief_scenario") {
    return (
      <section className="drawerSection">
        <h3>Relief scenario · {humanize(String(result.scenario ?? ""))}</h3>
        <dl className="kv">
          <dt>Volume</dt>
          <dd className="mono">{(result.line_numbers as string[])?.join(", ") || String(result.volume_key ?? "")}</dd>
          <dt>Design pressure</dt>
          <dd>{String(result.design_pressure ?? "—")}</dd>
          <dt>Required</dt>
          <dd>
            {result.required_kg_s != null ? `${String(result.required_kg_s)} kg/s` : "—"}
            {result.required_kw != null ? ` (${String(result.required_kw)} kW)` : ""}
          </dd>
          <dt>Installed</dt>
          <dd>{result.installed_total_kg_s != null ? `${String(result.installed_total_kg_s)} kg/s` : ((result.installed as unknown[])?.length ? "capacity not on part" : "none")}</dd>
        </dl>
        {Array.isArray(result.notes) && (result.notes as string[]).length > 0 && <p className="hint">{(result.notes as string[]).join(" ")}</p>}
      </section>
    );
  }
  if (analysis.kind === "single_point_failure") {
    const points = (result.single_points as Array<{ tag: string; symbol: string | null }>) ?? [];
    return (
      <section className="drawerSection">
        <h3>Single points of failure</h3>
        <p className="hint">
          Sources {(result.sources as string[])?.join(", ") || "—"} · boundaries {(result.boundaries as string[])?.join(", ") || "—"} · isolating {(result.isolating as string[])?.join(", ") || "—"}
        </p>
        {points.length === 0 ? <p className="hint">{String(result.message ?? "No single isolating item defeats the isolation on its own.")}</p> : (
          <ul className="attentionList">
            {points.map((point) => (
              <li key={point.tag}>
                <span className="mono">{point.tag}</span> {point.symbol ?? ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  if (analysis.kind === "fault_tolerance") {
    return (
      <section className="drawerSection">
        <h3>Fault tolerance · {String(result.hazard_key ?? "")}</h3>
        <p className="hint">
          {String(result.independent ?? 0)} independent of {String(result.required ?? 0)} required · {String(result.verified ?? 0)} verified. {String(result.method ?? "")}
        </p>
      </section>
    );
  }
  return (
    <section className="drawerSection">
      <h3>Result</h3>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(result, null, 2)}</pre>
    </section>
  );
}

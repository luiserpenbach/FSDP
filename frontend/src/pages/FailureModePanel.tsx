/**
 * Failure-mode library editor (Settings page): the organisation-wide list
 * of modes per symbol category or key, with effect templates and detection
 * hints. Admins add and edit; everyone can browse.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel } from "../components/ui";
import type { FailureMode } from "../types";

const CATEGORIES = ["valve", "regulator", "inline", "instrument", "equipment"];

export function FailureModePanel({ isAdmin }: { isAdmin: boolean }) {
  const [modes, setModes] = useState<FailureMode[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ category: "valve", symbol_key: "", name: "", title: "", default_local_effect: "", hint: "", default_severity: "", replaces_category: false });

  useEffect(() => {
    void api
      .listFailureModes()
      .then(setModes)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the library."));
  }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return modes.filter((mode) => !q || mode.category.includes(q) || (mode.symbol_key ?? "").includes(q) || mode.name.includes(q) || mode.title.toLowerCase().includes(q));
  }, [modes, filter]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await api.createFailureMode({
        category: form.category,
        symbol_key: form.symbol_key.trim() || null,
        name: form.name.trim().toLowerCase().replaceAll(/\s+/g, "_"),
        title: form.title.trim(),
        default_local_effect: form.default_local_effect.trim(),
        default_detection_hint: form.hint.split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean),
        default_severity: form.default_severity ? Number(form.default_severity) : null,
        applicable_modes: null,
        replaces_category: form.replaces_category,
        active: true
      });
      setModes((current) => [...current, created]);
      setForm({ ...form, name: "", title: "", default_local_effect: "", hint: "", default_severity: "" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the failure mode.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(mode: FailureMode) {
    try {
      const updated = await api.updateFailureMode(mode.id, { active: !mode.active });
      setModes((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the failure mode.");
    }
  }

  return (
    <Panel title="Failure-mode library" actions={<input value={filter} placeholder="Filter" aria-label="Filter failure modes" onChange={(event) => setFilter(event.target.value)} />}>
      <p className="hint">Modes apply by symbol category; symbol-level entries add to the category's modes, or replace them when marked. Templates may use {"{tag}"}, {"{name}"}, and {"{service}"}.</p>
      <DataTable
        rows={visible}
        getKey={(mode) => mode.id}
        columns={[
          { header: "Category", render: (mode) => mode.category },
          { header: "Symbol", render: (mode) => <span className="mono">{mode.symbol_key ?? "any"}</span> },
          { header: "Mode", render: (mode) => <span className="mono">{mode.name}</span> },
          { header: "Title", render: (mode) => mode.title },
          { header: "Detection", render: (mode) => <span className="mono">{(mode.default_detection_hint ?? []).join(", ") || "—"}</span> },
          { header: "S", render: (mode) => <span className="mono">{mode.default_severity ?? "—"}</span> },
          { header: "Replaces", render: (mode) => (mode.replaces_category ? "yes" : "") },
          {
            header: "Active",
            render: (mode) =>
              isAdmin ? (
                <button type="button" className="linkButton" onClick={() => void toggle(mode)}>
                  {mode.active ? "active" : "inactive"}
                </button>
              ) : (
                <span className="hint">{mode.active ? "active" : "inactive"}</span>
              )
          }
        ]}
      />
      {isAdmin && (
        <form onSubmit={(event) => void submit(event)} className="drawerForm" style={{ marginTop: 12 }}>
          <div className="fieldRow">
            <label>
              Category
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Symbol key (blank = whole category)
              <input value={form.symbol_key} placeholder="check_valve" onChange={(event) => setForm({ ...form, symbol_key: event.target.value })} />
            </label>
          </div>
          <div className="fieldRow">
            <label>
              Mode name
              <input value={form.name} placeholder="ice_lock" onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label>
              Title
              <input value={form.title} placeholder="Ice lock of the stem" onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </label>
          </div>
          <label>
            Local effect template
            <input value={form.default_local_effect} placeholder="{tag} cannot be operated; {service} isolation lost" onChange={(event) => setForm({ ...form, default_local_effect: event.target.value })} />
          </label>
          <div className="fieldRow">
            <label>
              Detection hint (tag letters, comma separated)
              <input value={form.hint} placeholder="ZS, PT" onChange={(event) => setForm({ ...form, hint: event.target.value })} />
            </label>
            <label>
              Default severity
              <input type="number" min={1} max={10} value={form.default_severity} onChange={(event) => setForm({ ...form, default_severity: event.target.value })} />
            </label>
          </div>
          <label className="checkRow">
            <input type="checkbox" checked={form.replaces_category} onChange={(event) => setForm({ ...form, replaces_category: event.target.checked })} />
            <span>Replaces the category's modes for this symbol</span>
          </label>
          <FormError message={error} />
          <div className="buttonRow">
            <button type="submit" className="primary" disabled={busy || !form.name.trim() || !form.title.trim()}>
              Add failure mode
            </button>
          </div>
        </form>
      )}
      {!isAdmin && <FormError message={error} />}
    </Panel>
  );
}

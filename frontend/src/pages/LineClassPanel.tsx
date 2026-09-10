/**
 * Project line classes (Settings page): pipe/tube specs that lines reference,
 * with a CSV import for standing up a spec table quickly.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { FormError, Panel } from "../components/ui";
import type { LineClass, Project } from "../types";

const EMPTY = { name: "", material: "", rating: "", wall: "", sizes: "", insulation: "", description: "" };

export function LineClassPanel({ project, canWrite }: { project: Project | null; canWrite: boolean }) {
  const [classes, setClasses] = useState<LineClass[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [csv, setCsv] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload(projectId: string) {
    setClasses(await api.listLineClasses(projectId));
  }

  useEffect(() => {
    if (!project) return;
    setError("");
    setStatus("");
    void reload(project.id).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load line classes."));
  }, [project]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!project || !form.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createLineClass(project.id, {
        name: form.name.trim(),
        material: form.material || null,
        rating: form.rating || null,
        wall: form.wall || null,
        sizes: form.sizes.split(/[;,]/).map((part) => part.trim()).filter(Boolean),
        insulation: form.insulation || null,
        description: form.description || null
      });
      setForm(EMPTY);
      await reload(project.id);
      setStatus("Line class added.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the line class.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(lineClass: LineClass) {
    if (!project || !window.confirm(`Delete line class ${lineClass.name}?`)) return;
    try {
      await api.deleteLineClass(lineClass.id);
      await reload(project.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the line class.");
    }
  }

  async function importCsv() {
    if (!project || !csv.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.importLineClasses(project.id, csv);
      await reload(project.id);
      setStatus(`Imported: ${result.created} created, ${result.updated} updated${result.errors.length ? `, ${result.errors.length} row error(s): ${result.errors.join("; ")}` : ""}.`);
      setCsv("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <Panel title="Line Classes">
        <p className="hint">Select a project to manage its pipe and tube classes.</p>
      </Panel>
    );
  }

  return (
    <Panel title={`Line Classes · ${project.name}`}>
      {classes.length ? (
        <table className="revisionTable">
          <thead>
            <tr>
              <th>Class</th>
              <th>Material</th>
              <th>Rating</th>
              <th>Wall</th>
              <th>Sizes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {classes.map((entry) => (
              <tr key={entry.id}>
                <td className="mono">{entry.name}</td>
                <td>{entry.material ?? ""}</td>
                <td>{entry.rating ?? ""}</td>
                <td>{entry.wall ?? ""}</td>
                <td>{entry.sizes.join(", ")}</td>
                <td>
                  {canWrite && (
                    <button type="button" className="linkButton" onClick={() => void remove(entry)}>
                      delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">No line classes yet. Add one below or import a CSV.</p>
      )}
      {canWrite && (
        <>
          <form onSubmit={(event) => void submit(event)}>
            <div className="fieldRow">
              <label>
                Class name
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="A1A" />
              </label>
              <label>
                Material
                <input value={form.material} onChange={(event) => setForm({ ...form, material: event.target.value })} placeholder="316L SS tube" />
              </label>
            </div>
            <div className="fieldRow">
              <label>
                Rating
                <input value={form.rating} onChange={(event) => setForm({ ...form, rating: event.target.value })} placeholder="3000 psig" />
              </label>
              <label>
                Wall
                <input value={form.wall} onChange={(event) => setForm({ ...form, wall: event.target.value })} placeholder='.035"' />
              </label>
            </div>
            <div className="fieldRow">
              <label>
                Sizes (semicolon separated)
                <input value={form.sizes} onChange={(event) => setForm({ ...form, sizes: event.target.value })} placeholder='1/8"; 1/4"; 1/2"' />
              </label>
              <label>
                Insulation
                <input value={form.insulation} onChange={(event) => setForm({ ...form, insulation: event.target.value })} placeholder="foam" />
              </label>
            </div>
            <div className="buttonRow">
              <button type="submit" className="primary" disabled={busy || !form.name.trim()}>
                Add line class
              </button>
            </div>
          </form>
          <label>
            CSV import (header: name, material, rating, wall, sizes, insulation, description)
            <textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={4} placeholder={'name,material,rating,wall,sizes\nA1A,316L SS tube,3000 psig,.035",1/4";1/2"'} />
          </label>
          <div className="buttonRow">
            <button type="button" disabled={busy || !csv.trim()} onClick={() => void importCsv()}>
              Import CSV
            </button>
          </div>
        </>
      )}
      <FormError message={error} />
      {status && <p className="hint">{status}</p>}
    </Panel>
  );
}

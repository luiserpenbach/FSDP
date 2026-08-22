import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { FormError, Panel, TextInput } from "../components/ui";
import type { CatalogSettings, Project } from "../types";

export function CatalogSettingsPanel({
  project,
  isAdmin,
  onProjectUpdated
}: {
  project: Project | null;
  isAdmin: boolean;
  onProjectUpdated: (project: Project) => void;
}) {
  const [settings, setSettings] = useState<CatalogSettings | null>(null);
  const [prefix, setPrefix] = useState("AMPH");
  const [padding, setPadding] = useState("3");
  const [typesText, setTypesText] = useState("");
  const [projectPrefix, setProjectPrefix] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void api
      .getCatalogSettings()
      .then((next) => {
        setSettings(next);
        setPrefix(next.prefix);
        setPadding(String(next.sequence_padding));
        setTypesText(next.part_types.join("\n"));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load catalog settings."));
  }, []);

  useEffect(() => {
    setProjectPrefix(project?.part_name_prefix ?? "");
  }, [project]);

  function saveOrg(event: FormEvent) {
    event.preventDefault();
    if (!isAdmin) return;
    setBusy(true);
    setError("");
    setStatus("");
    const partTypes = typesText
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    void api
      .updateCatalogSettings({
        prefix,
        sequence_padding: Number(padding) || 3,
        part_types: partTypes
      })
      .then((next) => {
        setSettings(next);
        setStatus("Saved catalog numbering.");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Save failed."))
      .finally(() => setBusy(false));
  }

  function saveProjectPrefix(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setBusy(true);
    setError("");
    setStatus("");
    void api
      .updateProject(project.id, { part_name_prefix: projectPrefix.trim() || undefined })
      .then((next) => {
        onProjectUpdated(next);
        setStatus("Saved project prefix.");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Save failed."))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <Panel title="Part numbering">
        <p className="hint">
          Generate fills <span className="mono">{"{prefix}-{seq}"}</span>
          {settings ? `, e.g. ${settings.prefix}-${String(settings.next_sequence).padStart(settings.sequence_padding, "0")}` : ""}.
          Names stay unique across the whole catalog.
        </p>
        <form onSubmit={saveOrg}>
          <TextInput label="Org prefix" value={prefix} onChange={setPrefix} />
          <TextInput label="Sequence padding" value={padding} onChange={setPadding} />
          <label>
            Part types (one per line; users can still add types when creating a part)
            <textarea value={typesText} onChange={(event) => setTypesText(event.target.value)} rows={8} />
          </label>
          <FormError message={error} />
          {status && <p className="hint">{status}</p>}
          <button disabled={busy || !isAdmin}>{isAdmin ? "Save catalog settings" : "Admin only"}</button>
        </form>
      </Panel>
      <Panel title="Project prefix">
        {project ? (
          <form onSubmit={saveProjectPrefix}>
            <TextInput
              label={`Prefix for ${project.name} (optional override)`}
              value={projectPrefix}
              onChange={setProjectPrefix}
            />
            <p className="hint">Leave blank to use the org prefix. Sequence is tracked separately per prefix.</p>
            <button disabled={busy}>Save project prefix</button>
          </form>
        ) : (
          <p className="hint">Select a project to set a program-specific prefix.</p>
        )}
      </Panel>
    </>
  );
}

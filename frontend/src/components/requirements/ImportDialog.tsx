/**
 * Requirements import: pick a CSV or XLSX file, map its columns, dry-run to
 * preview counts and errors, then import.
 */
import { useState } from "react";
import { api } from "../../api";
import type { RequirementImportResult } from "../../types";
import { FormError } from "../ui";

const FIELDS = [
  { value: "", label: "Ignore" },
  { value: "key", label: "Key" },
  { value: "title", label: "Title" },
  { value: "text", label: "Text" },
  { value: "category", label: "Category" },
  { value: "verification_method", label: "Verification method" },
  { value: "status", label: "Status" },
  { value: "owner", label: "Owner" },
  { value: "parent_key", label: "Derives from (parent key)" },
  { value: "rationale", label: "Rationale" },
  { value: "source_ref", label: "Source reference" }
];

export function ImportDialog({ projectId, onClose, onImported }: { projectId: string; onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<RequirementImportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.importRequirements(projectId, file, { mapping: Object.keys(mapping).length ? mapping : undefined, dryRun, updateExisting });
      if (dryRun) {
        setPreview(result);
        setMapping(result.mapping);
      } else {
        onImported();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const columns = preview ? Array.from(new Set([...Object.keys(preview.mapping), ...Object.keys(mapping)])) : [];

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Import requirements" onClick={(event) => event.stopPropagation()}>
        <h2>Import requirements</h2>
        <p className="hint">CSV or XLSX with one requirement per row. Columns named key, title, text, category, verification, status, owner, parent, rationale, or source are recognised; anything else can be mapped after a dry run.</p>
        <label>
          File
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setMapping({});
            }}
          />
        </label>
        <label className="checkRow">
          <input type="checkbox" checked={updateExisting} onChange={(event) => setUpdateExisting(event.target.checked)} />
          <span>Update requirements whose key already exists (otherwise they are skipped)</span>
        </label>
        {preview && (
          <>
            <div className="mappingGrid">
              {columns.map((column) => (
                <label key={column}>
                  Column “{column}”
                  <select value={mapping[column] ?? ""} onChange={(event) => setMapping({ ...mapping, [column]: event.target.value })}>
                    {FIELDS.map((field) => (
                      <option key={field.value} value={field.value}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="hint">
              Dry run: {preview.created} to create, {preview.updated} to update, {preview.skipped} skipped.
            </p>
            {preview.errors.length > 0 && (
              <ul className="attentionList">
                {preview.errors.map((entry) => (
                  <li key={entry} className="formError">
                    {entry}
                  </li>
                ))}
              </ul>
            )}
            {preview.preview.length > 0 && (
              <div className="tableWrap previewTable">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Action</th>
                      <th>Key</th>
                      <th>Title</th>
                      <th>Category</th>
                      <th>Parent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((row) => (
                      <tr key={row.row}>
                        <td>{row.row}</td>
                        <td>{row.action}</td>
                        <td className="mono">{row.key}</td>
                        <td>{row.title}</td>
                        <td>{row.category}</td>
                        <td className="mono">{row.parent_key ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <FormError message={error} />
        <div className="buttonRow">
          <button type="button" disabled={!file || busy} onClick={() => void run(true)}>
            Dry run
          </button>
          <button type="button" className="primary" disabled={!file || busy || !preview || preview.errors.some((entry) => entry.startsWith("No column"))} onClick={() => void run(false)}>
            Import
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

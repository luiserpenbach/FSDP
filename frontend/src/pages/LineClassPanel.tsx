/**
 * Project line classes (Settings page): the pipe/tube specs that lines reference.
 *
 * A spreadsheet-style grid (components/datagrid): writers edit any cell in place
 * (saved per row through PUT /line-classes/{id}; a refused cell rolls back and
 * shows the server's reason), paste rows from Excel below the last row to create
 * classes, select rows to delete them in bulk, and import a .csv/.xlsx file or
 * pasted CSV text. Everyone can sort, filter and export CSV. Viewers get the same
 * grid read-only.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, importLineClassesFile } from "../api";
import { DataGrid, parseTsv, type DataGridCellErrors, type DataGridColumn, type DataGridEdit } from "../components/datagrid";
import { FormError, Panel } from "../components/ui";
import type { LineClass, Project } from "../types";

type LineClassFields = Partial<Omit<LineClass, "id" | "project_id" | "created_at" | "updated_at">>;

/** Text fields of a line class; each is a grid column and accepted by the update endpoint. */
const TEXT_FIELDS = ["material", "rating", "wall", "insulation", "description", "notes"] as const;

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function splitSizes(text: string): string[] {
  return Array.from(new Set(text.split(/[;,]/).map((part) => part.trim()).filter(Boolean)));
}

function optionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
  return text || null;
}

/** Grid edit value -> request body field for PUT /line-classes/{id}. */
function fieldValue(key: string, value: unknown): unknown {
  if (key === "name") return String(value ?? "").trim();
  if (key === "sizes") return Array.isArray(value) ? value : splitSizes(String(value ?? ""));
  return optionalText(value);
}

/** A pasted line ({column key: text}) -> create body; null when it has no name. */
function createBody(record: Record<string, string>): (LineClassFields & { name: string }) | null {
  const name = (record.name ?? "").trim();
  if (!name) return null;
  const body: LineClassFields & { name: string } = { name, sizes: splitSizes(record.sizes ?? "") };
  for (const field of TEXT_FIELDS) body[field] = optionalText(record[field]);
  return body;
}

/** Column keys in grid order; pasted rows without a header row follow this order. */
const FIELD_ORDER = ["name", "material", "rating", "wall", "sizes", "insulation", "description", "notes"];
const HEADER_ALIASES: Record<string, string> = { class: "name", "class name": "name", "line class": "name" };

/** Clipboard TSV -> {column key: text} records, honouring a header row when there is one. */
function clipboardRecords(text: string): Array<Record<string, string>> {
  const lines = parseTsv(text).filter((line) => line.some((cell) => cell.trim()));
  if (!lines.length) return [];
  const headerKey = (cell: string) => {
    const lower = cell.trim().toLowerCase();
    return HEADER_ALIASES[lower] ?? (FIELD_ORDER.includes(lower) ? lower : null);
  };
  const header = lines[0].map(headerKey);
  const hasHeader = header.includes("name") && lines[0].every((cell, index) => !cell.trim() || header[index]);
  const keys = hasHeader ? header : FIELD_ORDER;
  return (hasHeader ? lines.slice(1) : lines).map((line) => {
    const record: Record<string, string> = {};
    line.forEach((cell, index) => {
      const key = keys[index];
      if (key) record[key] = cell;
    });
    return record;
  });
}

const COLUMNS: DataGridColumn<LineClass>[] = [
  {
    key: "name",
    header: "Class",
    width: 110,
    mono: true,
    frozen: true,
    hideable: false,
    editable: true,
    validate: (value) => (String(value ?? "").trim() ? null : "A line class needs a name")
  },
  { key: "material", header: "Material", width: 170, editable: true },
  { key: "rating", header: "Rating", width: 120, editable: true },
  { key: "wall", header: "Wall", width: 90, editable: true, mono: true },
  {
    key: "sizes",
    header: "Sizes",
    width: 180,
    editable: true,
    mono: true,
    format: (value) => (Array.isArray(value) ? value.join("; ") : ""),
    // Re-entering the same sizes is not an edit.
    parse: (text, row) => {
      const sizes = splitSizes(text);
      return sizes.join("\u0000") === row.sizes.join("\u0000") ? row.sizes : sizes;
    },
    sortValue: (row) => row.sizes[0] ?? null
  },
  { key: "insulation", header: "Insulation", width: 110, editable: true },
  { key: "description", header: "Description", width: 220, editable: true },
  { key: "notes", header: "Notes", width: 200, editable: true, hidden: true }
];

export function LineClassPanel({ project, canWrite }: { project: Project | null; canWrite: boolean }) {
  const [classes, setClasses] = useState<LineClass[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectId = project?.id ?? "";
  // The project the panel currently shows: responses for a previous project are dropped.
  const projectRef = useRef(projectId);
  useEffect(() => {
    projectRef.current = projectId;
  }, [projectId]);

  const reload = useCallback(async (targetId: string) => {
    const list = await api.listLineClasses(targetId);
    if (projectRef.current === targetId) setClasses(list);
  }, []);

  useEffect(() => {
    setClasses([]);
    setError("");
    setStatus("");
    setRowErrors([]);
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    api
      .listLineClasses(projectId)
      .then((list) => {
        if (!cancelled) setClasses(list);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught, "Could not load line classes."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function report(message: string, errors: string[] = []) {
    setStatus(message);
    setRowErrors(errors);
  }

  /** Inline edits: one PUT per row; a refused row reports its message on each edited cell. */
  const commit = useCallback(async (edits: DataGridEdit[]) => {
    const byRow = new Map<string, DataGridEdit[]>();
    for (const edit of edits) byRow.set(edit.rowId, [...(byRow.get(edit.rowId) ?? []), edit]);
    const errors: DataGridCellErrors = {};
    const saved: LineClass[] = [];
    await Promise.all(
      Array.from(byRow, async ([rowId, rowEdits]) => {
        const body: Record<string, unknown> = {};
        for (const edit of rowEdits) body[edit.key] = fieldValue(edit.key, edit.value);
        try {
          saved.push(await api.updateLineClass(rowId, body as LineClassFields));
        } catch (caught) {
          const message = errorText(caught, "Could not save the line class.");
          errors[rowId] = Object.fromEntries(rowEdits.map((edit) => [edit.key, message]));
        }
      })
    );
    if (saved.length) {
      const byId = new Map(saved.map((entry) => [entry.id, entry]));
      setClasses((current) => current.map((entry) => byId.get(entry.id) ?? entry));
    }
    return { errors };
  }, []);

  /** Rows pasted below the last row: create each one; report the rows the server refused. */
  async function createPasted(records: Array<Record<string, string>>) {
    if (!projectId) return;
    const targetId = projectId;
    setBusy(true);
    setError("");
    const failures: string[] = [];
    let created = 0;
    for (const [index, record] of records.entries()) {
      if (Object.values(record).every((value) => !value.trim())) continue;
      const body = createBody(record);
      const label = `Pasted row ${index + 1}`;
      if (!body) {
        failures.push(`${label}: missing class name`);
        continue;
      }
      try {
        await api.createLineClass(targetId, body);
        created += 1;
      } catch (caught) {
        failures.push(`${label} (${body.name}): ${errorText(caught, "could not be created")}`);
      }
    }
    try {
      await reload(targetId);
    } catch (caught) {
      setError(errorText(caught, "Could not reload line classes."));
    }
    setBusy(false);
    report(`Added ${created} line class(es)${failures.length ? `; ${failures.length} row(s) refused` : ""}.`, failures);
  }

  async function addOne(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!projectId || !name) return;
    setBusy(true);
    setError("");
    try {
      await api.createLineClass(projectId, { name, sizes: [] });
      setNewName("");
      await reload(projectId);
      report(`Line class ${name} added. Fill in its fields in the grid.`);
    } catch (caught) {
      setError(errorText(caught, "Could not add the line class."));
    } finally {
      setBusy(false);
    }
  }

  async function removeMany(selected: LineClass[], clear: () => void) {
    if (!projectId || !selected.length) return;
    const names = selected.map((entry) => entry.name);
    const preview = names.slice(0, 8).join(", ") + (names.length > 8 ? `, … (${names.length - 8} more)` : "");
    if (!window.confirm(`Delete ${selected.length} line class(es)? ${preview}`)) return;
    setBusy(true);
    setError("");
    const results = await Promise.allSettled(selected.map((entry) => api.deleteLineClass(entry.id)));
    const failures = results.flatMap((result, index) => (result.status === "rejected" ? [`${selected[index].name}: ${errorText(result.reason, "could not be deleted")}`] : []));
    try {
      await reload(projectId);
    } catch (caught) {
      setError(errorText(caught, "Could not reload line classes."));
    }
    clear();
    setBusy(false);
    report(`Deleted ${selected.length - failures.length} line class(es)${failures.length ? `; ${failures.length} failed` : ""}.`, failures);
  }

  function importReport(result: { created: number; updated: number; errors: string[] }) {
    report(`Imported: ${result.created} created, ${result.updated} updated${result.errors.length ? `, ${result.errors.length} row error(s)` : ""}.`, result.errors);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!projectId || !file) return;
    setBusy(true);
    setError("");
    try {
      importReport(await importLineClassesFile(projectId, file));
      await reload(projectId);
    } catch (caught) {
      setError(errorText(caught, "Import failed."));
    } finally {
      setBusy(false);
    }
  }

  async function importCsv() {
    if (!projectId || !csv.trim()) return;
    setBusy(true);
    setError("");
    try {
      importReport(await api.importLineClasses(projectId, csv));
      await reload(projectId);
      setCsv("");
    } catch (caught) {
      setError(errorText(caught, "Import failed."));
    } finally {
      setBusy(false);
    }
  }

  /** "Paste rows": clipboard TSV (from Excel) -> new classes; a header row maps columns by name. */
  async function pasteRows() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("The browser did not allow reading the clipboard. Paste into the grid, or use the CSV text box below.");
      return;
    }
    const records = clipboardRecords(text);
    if (!records.length) {
      setError("The clipboard holds no rows to add.");
      return;
    }
    await createPasted(records);
  }

  const toolbar = canWrite ? (
    <>
      <form className="lineClassAdd" onSubmit={(event) => void addOne(event)}>
        <input aria-label="New line class name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New class, e.g. A1A" />
        <button type="submit" className="dgButton" disabled={busy || !newName.trim()}>
          Add
        </button>
      </form>
      <button type="button" className="dgButton" disabled={busy} onClick={() => void pasteRows()} title="Create line classes from rows copied in Excel (class, material, rating, wall, sizes, insulation, description, notes)">
        Paste rows
      </button>
      <button type="button" className="dgButton" disabled={busy} onClick={() => fileRef.current?.click()} title="Upsert line classes from a .csv or .xlsx file (matched by class name)">
        Import file…
      </button>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Line class import file" onChange={(event) => void importFile(event)} />
    </>
  ) : null;

  if (!project) {
    return (
      <Panel title="Line Classes" className="lineClassPanel">
        <p className="hint">Select a project to manage its pipe and tube classes.</p>
      </Panel>
    );
  }

  return (
    <Panel title={`Line Classes · ${project.name}`} className="lineClassPanel">
      <DataGrid
        rows={classes}
        columns={COLUMNS}
        getRowId={(entry) => entry.id}
        onCommit={canWrite ? commit : undefined}
        onPasteNewRows={canWrite ? (records) => void createPasted(records) : undefined}
        selectable={canWrite}
        bulkActions={(selected, clear) => (
          <button type="button" className="dgButton danger" disabled={busy} onClick={() => void removeMany(selected, clear)}>
            Delete {selected.length}
          </button>
        )}
        defaultSort={[{ key: "name", dir: "asc" }]}
        storageKey="settings.lineClasses"
        exportFileName={`line-classes-${project.name}`}
        toolbar={toolbar}
        loading={loading}
        emptyMessage={canWrite ? "No line classes yet. Add one, paste rows from Excel, or import a file." : "No line classes yet."}
        height={360}
        ariaLabel="Line classes"
      />
      {canWrite && (
        <p className="hint">
          Double-click or type to edit a cell; paste a block from Excel to overwrite cells, and lines that run past the last row become new classes. “Paste rows” adds every copied row
          as a new class (class, material, rating, wall, sizes, insulation, description, notes, or a matching header row). Separate sizes with semicolons.
        </p>
      )}
      <FormError message={error} />
      {status && (
        <div className="lineClassStatus" role="status">
          <p className="hint">{status}</p>
          {rowErrors.length > 0 && (
            <ul className="lineClassRowErrors">
              {rowErrors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canWrite && (
        <details className="lineClassCsv">
          <summary>Paste CSV text</summary>
          <label>
            CSV (header: name, material, rating, wall, sizes, insulation, description, notes; existing classes are updated by name)
            <textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={4} placeholder={'name,material,rating,wall,sizes\nA1A,316L SS tube,3000 psig,.035",1/4";1/2"'} />
          </label>
          <div className="buttonRow">
            <button type="button" disabled={busy || !csv.trim()} onClick={() => void importCsv()}>
              Import CSV
            </button>
          </div>
        </details>
      )}
    </Panel>
  );
}

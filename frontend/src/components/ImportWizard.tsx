/**
 * <ImportWizard> — Excel-style import for a catalog or project table
 * (docs/codebase-review.md §2.4: paste / import CSV and XLSX).
 *
 * 1. Source: upload a .csv/.xlsx file, or paste a block copied from Excel
 *    (header row first; parsed as TSV and sent as JSON rows with headers).
 * 2. Mode: create new rows only, or create and update rows matched by key.
 * 3. Check (dry run): the server plans every row with the same validation as
 *    single edits; the wizard shows the column mapping (ignored columns
 *    highlighted), a summary, and a preview grid with each row's action,
 *    old → new changes and errors.
 * 4. Import commits all rows or none; disabled while any row has an error.
 *
 * The page supplies `runImport` (importParts / importRequirements bound to the
 * project) and `downloadTemplate`; `initialRows` starts from rows pasted below
 * a grid and runs the dry run right away.
 */
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ImportMode, ImportOptions, ImportReport, ImportRowReport, ImportRowsBody } from "../types";
import { DataGrid, parseTsv, toTsv, type DataGridColumn } from "./datagrid";
import { downloadBlob } from "./gridXlsx";

export type ImportSourceRows = { headers: string[]; rows: string[][] };

export interface ImportWizardProps {
  /** Plural noun for messages: "parts", "requirements". */
  entityLabel: string;
  /** What rows are matched on when updating: "part number", "key". */
  keyLabel: string;
  canWrite: boolean;
  runImport: (source: File | ImportRowsBody, options: ImportOptions) => Promise<ImportReport>;
  downloadTemplate: (format: "csv" | "xlsx") => Promise<{ blob: Blob; filename: string }>;
  /** Start from these rows (e.g. pasted below the grid) and run the dry run at once. */
  initialRows?: ImportSourceRows;
  initialMode?: ImportMode;
  /** Field name -> label used in the mapping and preview. */
  fieldLabels?: Record<string, string>;
  onClose: () => void;
  /** After a committed import: refresh the page's data. */
  onImported: (report: ImportReport) => void | Promise<void>;
}

type SourceKind = "file" | "paste";

const ACTION_OPTIONS = [
  { value: "create", label: "create" },
  { value: "update", label: "update" },
  { value: "unchanged", label: "unchanged" },
  { value: "error", label: "error" }
];

const NO_LABELS: Record<string, string> = {};

function fieldLabel(labels: Record<string, string>, field: string): string {
  return labels[field] ?? field.replaceAll("_", " ");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function showValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(blank)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Pasted text -> header row + data rows (blank lines dropped). */
export function pastedRows(text: string): ImportSourceRows | null {
  const lines = parseTsv(text).filter((line) => line.some((cell) => cell.trim() !== ""));
  if (lines.length < 2) return null;
  const [headers, ...rows] = lines;
  return { headers: headers.map((header) => header.trim()), rows };
}

export function ImportWizard({
  entityLabel,
  keyLabel,
  canWrite,
  runImport,
  downloadTemplate,
  initialRows,
  initialMode = "create_only",
  fieldLabels = NO_LABELS,
  onClose,
  onImported
}: ImportWizardProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>(initialRows ? "paste" : "file");
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState(() =>
    initialRows ? toTsv([initialRows.headers, ...initialRows.rows]) : ""
  );
  const [decimalComma, setDecimalComma] = useState(false);
  const [mode, setMode] = useState<ImportMode>(initialMode);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const label = (field: string) => fieldLabel(fieldLabels, field);

  /** Any change to the source or mode invalidates the last dry run. */
  function invalidate() {
    setReport(null);
    setDone(null);
    setError("");
  }

  function source(): File | ImportRowsBody | null {
    if (sourceKind === "file") return file;
    const parsed = pastedRows(pasteText);
    if (!parsed) return null;
    return { headers: parsed.headers, rows: parsed.rows, ...(decimalComma ? { decimal_comma: true } : {}) };
  }

  async function check() {
    const body = source();
    if (!body) {
      setError(
        sourceKind === "file"
          ? "Choose a .csv or .xlsx file first."
          : "Paste a header row and at least one data row (copy them from Excel with the headers)."
      );
      return;
    }
    setBusy("check");
    setError("");
    setDone(null);
    try {
      const next = await runImport(body, { dryRun: true, mode });
      setReport(next);
      setErrorsOnly(next.summary.error > 0);
    } catch (err) {
      setReport(null);
      setError(errorText(err, "The dry run failed."));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    const body = source();
    if (!body || !report) return;
    setBusy("import");
    setError("");
    try {
      const result = await runImport(body, { dryRun: false, mode });
      if (result.committed) {
        setDone(result);
        setReport(null);
        await onImported(result);
      } else {
        // Refused (all or nothing): show why.
        setReport(result);
        setErrorsOnly(result.summary.error > 0);
        setError(`Nothing was imported: ${result.summary.error} row(s) have errors.`);
      }
    } catch (err) {
      setError(errorText(err, "The import failed."));
    } finally {
      setBusy(null);
    }
  }

  function template(format: "csv" | "xlsx") {
    setError("");
    downloadTemplate(format)
      .then(({ blob, filename }) => downloadBlob(blob, filename))
      .catch((err: unknown) => setError(errorText(err, "Could not download the template.")));
  }

  const startWithInitialRows = useEffectEvent(() => {
    if (initialRows && canWrite) void check();
  });
  useEffect(() => {
    dialogRef.current?.focus();
    startWithInitialRows();
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !event.defaultPrevented && busy === null) {
      event.stopPropagation();
      onClose();
    }
  }

  const previewColumns = useMemo<DataGridColumn<ImportRowReport>[]>(() => {
    const label = (field: string) => fieldLabel(fieldLabels, field);
    return [
      { key: "row", header: "Row", type: "number", width: 64, align: "left", mono: true },
      {
        key: "action",
        header: "Action",
        type: "enum",
        options: ACTION_OPTIONS,
        width: 110,
        render: (row) => <span className={`importAction importAction-${row.action}`}>{row.action}</span>
      },
      { key: "key", header: keyLabel.charAt(0).toUpperCase() + keyLabel.slice(1), mono: true, width: 150 },
      {
        key: "changes",
        header: "Changes (old → new)",
        width: 380,
        getValue: (row) =>
          Object.entries(row.changes)
            .map(([field, [before, after]]) =>
              row.action === "create" ? `${label(field)}: ${showValue(after)}` : `${label(field)}: ${showValue(before)} → ${showValue(after)}`
            )
            .join("; "),
        render: (row) => (
          <span className="importChanges">
            {Object.entries(row.changes).map(([field, [before, after]]) => (
              <span className="importChange" key={field}>
                <span className="importField">{label(field)}</span>{" "}
                {row.action !== "create" && (
                  <>
                    <del>{showValue(before)}</del> →{" "}
                  </>
                )}
                <ins>{showValue(after)}</ins>
              </span>
            ))}
          </span>
        )
      },
      {
        key: "errors",
        header: "Errors",
        width: 340,
        getValue: (row) => row.errors.map((entry) => `${label(entry.field)}: ${entry.message}`).join("; "),
        render: (row) =>
          row.errors.length ? (
            <span className="importErrors">{row.errors.map((entry) => `${label(entry.field)}: ${entry.message}`).join("; ")}</span>
          ) : null
      }
    ];
  }, [keyLabel, fieldLabels]);

  const previewRows = report ? (errorsOnly ? report.rows.filter((row) => row.action === "error") : report.rows) : [];
  const toApply = report ? report.summary.create + report.summary.update : 0;
  const mappingEntries = report ? Object.entries(report.mapping) : [];
  const ignored = mappingEntries.filter(([, field]) => field === null).length;

  return (
    <div className="modalBackdrop" role="presentation" onClick={() => busy === null && onClose()}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal importWizard"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modalHeader">
          <h2 id={titleId}>Import {entityLabel}</h2>
          <button type="button" className="modalClose" aria-label="Close" disabled={busy !== null} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="importBody">
          {!canWrite ? (
            <p className="hint">Importing needs an engineer or admin account; viewers can export but not import.</p>
          ) : (
            <>
              <section className="importStep" aria-label="Source">
                <div className="importStepHead">
                  <h3>1. Source</h3>
                  <span className="importTemplates">
                    Template:
                    <button type="button" className="linkButton" onClick={() => template("xlsx")}>
                      XLSX
                    </button>
                    <button type="button" className="linkButton" onClick={() => template("csv")}>
                      CSV
                    </button>
                  </span>
                </div>
                <div className="importChoice" role="radiogroup" aria-label="Import source">
                  <label className="checkboxLabel">
                    <input
                      type="radio"
                      name={`${titleId}-source`}
                      checked={sourceKind === "file"}
                      onChange={() => {
                        setSourceKind("file");
                        invalidate();
                      }}
                    />
                    Upload a CSV or XLSX file
                  </label>
                  <label className="checkboxLabel">
                    <input
                      type="radio"
                      name={`${titleId}-source`}
                      checked={sourceKind === "paste"}
                      onChange={() => {
                        setSourceKind("paste");
                        invalidate();
                      }}
                    />
                    Paste from Excel
                  </label>
                </div>
                {sourceKind === "file" ? (
                  <label>
                    File
                    <input
                      accept=".csv,.tsv,.txt,.xlsx,.xlsm"
                      aria-label="Import file"
                      type="file"
                      onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        invalidate();
                      }}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Pasted rows (header row first)
                      <textarea
                        aria-label="Pasted rows"
                        className="importPaste"
                        placeholder={"Copy the cells in Excel, including the header row, and paste them here."}
                        rows={6}
                        spellCheck={false}
                        value={pasteText}
                        onChange={(event) => {
                          setPasteText(event.target.value);
                          invalidate();
                        }}
                      />
                    </label>
                    <label className="checkboxLabel">
                      <input
                        type="checkbox"
                        checked={decimalComma}
                        onChange={(event) => {
                          setDecimalComma(event.target.checked);
                          invalidate();
                        }}
                      />
                      Numbers use a decimal comma (2,5 = 2.5)
                    </label>
                  </>
                )}
              </section>

              <section className="importStep" aria-label="Mode">
                <h3>2. Mode</h3>
                <div className="importChoice" role="radiogroup" aria-label="Import mode">
                  <label className="checkboxLabel">
                    <input
                      type="radio"
                      name={`${titleId}-mode`}
                      checked={mode === "create_only"}
                      onChange={() => {
                        setMode("create_only");
                        invalidate();
                      }}
                    />
                    Create new only (an existing {keyLabel} is an error)
                  </label>
                  <label className="checkboxLabel">
                    <input
                      type="radio"
                      name={`${titleId}-mode`}
                      checked={mode === "upsert"}
                      onChange={() => {
                        setMode("upsert");
                        invalidate();
                      }}
                    />
                    Create or update (match on {keyLabel})
                  </label>
                </div>
              </section>

              <section className="importStep" aria-label="Check">
                <div className="importStepHead">
                  <h3>3. Check</h3>
                  <button type="button" className="primary" disabled={busy !== null} onClick={() => void check()}>
                    {busy === "check" ? "Checking…" : report ? "Check again" : "Check (dry run)"}
                  </button>
                </div>
                {error && (
                  <p className="formError" role="alert">
                    {error}
                  </p>
                )}
                {done && (
                  <p className="importDone" role="status">
                    Imported {entityLabel}: {done.summary.create} created, {done.summary.update} updated,{" "}
                    {done.summary.unchanged} unchanged.
                  </p>
                )}
                {report && (
                  <>
                    <div className="importSummary" aria-label="Dry run summary" role="status">
                      <span className="importAction importAction-create">{report.summary.create} create</span>
                      <span className="importAction importAction-update">{report.summary.update} update</span>
                      <span className="importAction importAction-unchanged">{report.summary.unchanged} unchanged</span>
                      <span className="importAction importAction-error">{report.summary.error} errors</span>
                    </div>
                    <div className="importMapping">
                      <strong>
                        Column mapping{ignored ? ` (${ignored} ignored)` : ""}
                      </strong>
                      <ul aria-label="Column mapping">
                        {mappingEntries.map(([header, field]) => (
                          <li className={field ? "importMapped" : "importIgnored"} key={header}>
                            <span className="mono">{header || "(no header)"}</span> →{" "}
                            {field ? label(field) : <em>ignored</em>}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {report.warnings.length > 0 && (
                      <ul className="importWarnings">
                        {report.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <label className="checkboxLabel">
                      <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
                      Only rows with errors ({report.summary.error})
                    </label>
                    <DataGrid
                      ariaLabel="Import preview"
                      columns={previewColumns}
                      emptyMessage={errorsOnly ? "No rows with errors." : "The source has no data rows."}
                      exportFileName={`${entityLabel}-import-check`}
                      getRowId={(row) => String(row.row)}
                      height={320}
                      rowClassName={(row) => (row.action === "error" ? "importRowError" : undefined)}
                      rows={previewRows}
                      selectable={false}
                    />
                  </>
                )}
              </section>
            </>
          )}
        </div>
        <div className="buttonRow modalActions importActions">
          {report && report.summary.error > 0 && (
            <span className="hint">Fix the rows with errors in the source and check again; nothing is imported while errors remain.</span>
          )}
          <button type="button" disabled={busy !== null} onClick={onClose}>
            {done ? "Done" : "Cancel"}
          </button>
          {canWrite && !done && (
            <button
              type="button"
              className="primary"
              disabled={busy !== null || !report || report.summary.error > 0 || toApply === 0}
              onClick={() => void commit()}
            >
              {busy === "import" ? "Importing…" : `Import ${toApply} ${toApply === 1 ? "row" : "rows"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

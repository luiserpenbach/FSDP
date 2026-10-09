import { useDeferredValue, useMemo, useState } from "react";
import { api } from "../api";
import { DataGrid, type DataGridColumn, type DataGridEdit } from "../components/datagrid";
import { exportGridXlsx } from "../components/gridXlsx";
import { FittingIllustration } from "../fittings/FittingIllustration";
import { addToBom, bomTotals, lineFitting, loadBom, saveBom, type FittingBomLine } from "../fittings/fittingBom";
import {
  KINDS,
  MATERIALS,
  THREADS,
  buildFitting,
  describeQuery,
  kindById,
  normalizeConfig,
  pipeOptions,
  searchFittings,
  secondTubeOptions,
  threadOptions,
  tubeById,
  tubeOptions,
  type Fitting,
  type FittingConfig,
  type KindId,
  type MaterialCode,
  type ThreadStd
} from "../fittings/swagelok";
import type { Part } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";

const EXAMPLES = [
  "1/4 union tee",
  "3/8 tube to 1/4 male NPT elbow",
  "1/2 x 3/8 reducing union",
  "6 mm female connector 1/4 BSPT",
  "brass 1/4 cap",
  "SS-400-1-4"
];

export function FittingsPage() {
  const { canWrite, parts, setParts, selectedProjectId, selectedProject } = useWorkspace();
  return (
    // Keyed by project: each project keeps its own working fitting list.
    <FittingSelector
      key={selectedProjectId || "none"}
      canWrite={canWrite}
      parts={parts}
      projectId={selectedProjectId}
      projectName={selectedProject?.name ?? ""}
      onPartsChanged={setParts}
    />
  );
}

export function FittingSelector({
  projectId,
  projectName,
  canWrite,
  parts,
  onPartsChanged
}: {
  projectId: string;
  projectName: string;
  canWrite: boolean;
  parts: Part[];
  onPartsChanged: (parts: Part[]) => void;
}) {
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const search = useMemo(() => searchFittings(query), [query]);
  // A pick (result click or configurator change) belongs to the query it was made under.
  const [picked, setPicked] = useState<{ query: string; config: FittingConfig } | null>(null);
  const config = picked && picked.query === query ? picked.config : search.results[0]?.config;
  const fitting = config ? buildFitting(config) : null;

  const [qty, setQty] = useState("1");
  const [lines, setLines] = useState<FittingBomLine[]>(() => loadBom(projectId));
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const catalogNumbers = useMemo(() => new Set(parts.map((part) => part.part_number.toUpperCase())), [parts]);

  function updateLines(next: FittingBomLine[]) {
    setLines(next);
    saveBom(projectId, next);
  }

  function pick(next: FittingConfig) {
    setPicked({ query, config: normalizeConfig(next) });
  }

  function addSelected() {
    if (!fitting) return;
    const count = Math.floor(Number(qty));
    if (!Number.isFinite(count) || count < 1) {
      setError("Quantity must be a whole number of 1 or more.");
      return;
    }
    setError("");
    updateLines(addToBom(lines, fitting, count));
    setNotice(`Added ${count} × ${fitting.partNumber} to the fitting list.`);
  }

  async function addToCatalog(targets: FittingBomLine[]) {
    const missing = targets.filter((line) => !catalogNumbers.has(line.partNumber.toUpperCase()));
    if (!missing.length) {
      setNotice("Every selected fitting is already in the parts catalog.");
      return;
    }
    setBusy(true);
    setError("");
    const failures: string[] = [];
    let created = 0;
    for (const line of missing) {
      const built = lineFitting(line);
      try {
        await api.createPart({
          part_number: line.partNumber,
          description: line.description,
          part_type: "fitting",
          source_type: "vendor",
          manufacturer: "Swagelok",
          material: line.material,
          notes: catalogNotes(built),
          dimensions: built ? catalogDimensions(built) : {},
          metadata: { swagelok: { config: line.config, product_url: built?.productUrl ?? null } }
        });
        created += 1;
      } catch (reason) {
        failures.push(`${line.partNumber}: ${reason instanceof Error ? reason.message : "could not be created"}`);
      }
    }
    try {
      onPartsChanged(await api.listParts());
    } catch {
      /* the list refreshes on the next visit */
    }
    setBusy(false);
    setNotice(`Added ${created} fitting${created === 1 ? "" : "s"} to the parts catalog.`);
    if (failures.length) setError(failures.join(" · "));
  }

  async function commitEdits(edits: DataGridEdit[]) {
    const byId = new Map(lines.map((line) => [line.id, { ...line }]));
    for (const edit of edits) {
      const line = byId.get(edit.rowId);
      if (!line) continue;
      if (edit.key === "qty") line.qty = Number(edit.value);
      else if (edit.key === "location") line.location = String(edit.value ?? "");
      else if (edit.key === "note") line.note = String(edit.value ?? "");
    }
    updateLines(lines.map((line) => byId.get(line.id) ?? line));
  }

  function removeLines(ids: string[]) {
    const drop = new Set(ids);
    updateLines(lines.filter((line) => !drop.has(line.id)));
    setCheckedIds([]);
  }

  const columns = useMemo<DataGridColumn<FittingBomLine>[]>(
    () => [
      {
        key: "partNumber",
        header: "Ordering number",
        frozen: true,
        hideable: false,
        mono: true,
        width: 160,
        render: (line) => (
          <button
            type="button"
            className="linkButton mono gridLink"
            title="Show this fitting"
            onClick={() => setPicked({ query, config: line.config })}
          >
            {line.partNumber}
          </button>
        )
      },
      { key: "description", header: "Description", width: 360 },
      { key: "material", header: "Material", width: 110 },
      {
        key: "qty",
        header: "Qty",
        type: "number",
        width: 70,
        editable: true,
        validate: (value) => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? null : "Qty must be a whole number of 1 or more")
      },
      { key: "location", header: "Location / tag", width: 140, editable: true },
      { key: "note", header: "Note", width: 180, editable: true },
      { key: "ends", header: "Ends", width: 280, hidden: true },
      {
        key: "inCatalog",
        header: "In catalog",
        type: "boolean",
        width: 90,
        getValue: (line) => catalogNumbers.has(line.partNumber.toUpperCase())
      },
      { key: "manufacturer", header: "Manufacturer", width: 110, getValue: () => "Swagelok", hidden: true }
    ],
    [catalogNumbers, query]
  );

  const totals = bomTotals(lines);
  const chips = describeQuery(search.query);

  return (
    <main className="page fittingsPage">
      <header className="catalogPageHeader fittingsHeader">
        <h1>Fitting Selector</h1>
        <p className="hint catalogHint">
          Swagelok tube fittings: describe the fitting you need, or paste an ordering number. Build a fitting list and
          export it or add it to the parts catalog.
        </p>
      </header>

      <section className="fittingSearchBar">
        <label className="catalogSearch fittingSearch">
          <span className="srOnly">Describe a fitting</span>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M13 13 L17 17" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            placeholder='e.g. "3/8 tube to 1/4 male NPT elbow" or "SS-400-3"'
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {search.query.text ? (
          <div className="fittingChips" aria-label="How the description was read">
            {chips.map((chip) => (
              <span className="pill pill-info" key={chip}>
                {chip}
              </span>
            ))}
            {search.query.warnings.map((warning) => (
              <span className="pill pill-warn" key={warning}>
                {warning}
              </span>
            ))}
          </div>
        ) : (
          <div className="fittingChips">
            <span className="hint">Try:</span>
            {EXAMPLES.map((example) => (
              <button type="button" className="fittingExample" key={example} onClick={() => setText(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="pageError" role="alert">
          <span>{error}</span>
          <button type="button" className="modalClose" aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="bulkNotice" role="status">
          <span>{notice}</span>
          <button type="button" className="modalClose" aria-label="Dismiss notice" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}

      <section className="fittingWorkspace">
        <article className="panel fittingResults" aria-label="Matching fittings">
          <div className="panelHead">
            <h2>Matches</h2>
            {search.results.length > 0 && <span className="hint">{search.results.length}</span>}
          </div>
          {search.results.length === 0 ? (
            <p className="hint">{search.message ?? "Describe a fitting above to see matches."}</p>
          ) : (
            <ul className="fittingResultList">
              {search.results.map((result) => (
                <li key={result.partNumber}>
                  <button
                    type="button"
                    className={result.partNumber === fitting?.partNumber ? "fittingResult selected" : "fittingResult"}
                    aria-pressed={result.partNumber === fitting?.partNumber}
                    onClick={() => setPicked({ query, config: result.config })}
                  >
                    <FittingIllustration fitting={result} className="fittingThumb" title="" />
                    <span>
                      <strong className="mono">{result.partNumber}</strong>
                      <small>{result.description.replace(/^.*Swagelok Tube Fitting, /, "")}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>

        {fitting ? (
          <FittingDetail
            fitting={fitting}
            inCatalog={catalogNumbers.has(fitting.partNumber.toUpperCase())}
            qty={qty}
            onQty={setQty}
            onAdd={addSelected}
            onChange={pick}
          />
        ) : (
          <article className="panel fittingDetail fittingDetailEmpty">
            <p className="hint">The selected fitting, its specifications and a product image show here.</p>
          </article>
        )}
      </section>

      <article className="panel fittingBomPanel">
        <div className="panelHead">
          <h2>Fitting list{projectName ? ` — ${projectName}` : ""}</h2>
          <span className="hint">
            {totals.lines} line{totals.lines === 1 ? "" : "s"} · {totals.pieces} piece{totals.pieces === 1 ? "" : "s"}
          </span>
        </div>
        <DataGrid
          ariaLabel="Fitting list"
          bulkActions={(selected, clear) => (
            <>
              {canWrite && (
                <button type="button" className="dgButton" disabled={busy} onClick={() => void addToCatalog(selected)}>
                  Add to catalog
                </button>
              )}
              <button
                type="button"
                className="dgButton danger"
                onClick={() => {
                  removeLines(selected.map((line) => line.id));
                  clear();
                }}
              >
                Remove
              </button>
            </>
          )}
          columns={columns}
          emptyMessage="No fittings yet. Pick a fitting above and add it to the list."
          exportFileName="fitting-list"
          getRowId={(line) => line.id}
          height={320}
          onCommit={commitEdits}
          onExportXlsx={(rows, visible) =>
            void exportGridXlsx({
              title: projectName ? `Fitting list — ${projectName}` : "Fitting list",
              fileName: "fitting-list",
              rows,
              columns: visible
            }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "XLSX export failed."))
          }
          onSelectionChange={setCheckedIds}
          rows={lines}
          selectedIds={checkedIds}
          storageKey="fittings.bom"
          toolbar={
            <>
              {canWrite && (
                <button type="button" className="dgButton" disabled={busy || !lines.length} onClick={() => void addToCatalog(lines)}>
                  Add all to catalog
                </button>
              )}
              <button
                type="button"
                className="dgButton"
                disabled={!lines.length}
                onClick={() => {
                  if (window.confirm("Clear the fitting list?")) removeLines(lines.map((line) => line.id));
                }}
              >
                Clear list
              </button>
            </>
          }
        />
      </article>
    </main>
  );
}

function FittingDetail({
  fitting,
  inCatalog,
  qty,
  onQty,
  onAdd,
  onChange
}: {
  fitting: Fitting;
  inCatalog: boolean;
  qty: string;
  onQty: (value: string) => void;
  onAdd: () => void;
  onChange: (config: FittingConfig) => void;
}) {
  const { config, kind } = fitting;
  const tube = tubeById(config.tube);
  const seconds = tube ? secondTubeOptions(kind, tube) : [];
  const pipes = tube ? pipeOptions(tube) : [];
  const threads = threadOptions(kind);
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard
      ?.writeText(fitting.partNumber)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  return (
    <article className="panel fittingDetail" aria-label="Selected fitting">
      <div className="fittingDetailHead">
        <div>
          <h2 className="mono fittingPartNumber">
            {fitting.partNumber}
            <button type="button" className="fittingCopy" onClick={copy} aria-label="Copy ordering number">
              {copied ? "Copied" : "Copy"}
            </button>
          </h2>
          <p className="fittingDescription">{fitting.description}</p>
        </div>
        {inCatalog && <span className="pill pill-good">in catalog</span>}
      </div>

      <div className="fittingDetailBody">
        <figure className="fittingFigure">
          <FittingIllustration fitting={fitting} annotate />
          <figcaption>
            Illustration generated from the configuration.{" "}
            <a href={fitting.productUrl} target="_blank" rel="noreferrer">
              Product photo and datasheet on swagelok.com ↗
            </a>
          </figcaption>
        </figure>

        <div className="fittingConfigure">
          <div className="fittingFields">
            <label>
              Type
              <select value={config.kind} onChange={(event) => onChange({ ...config, kind: event.target.value as KindId })}>
                {KINDS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Material
              <select
                value={config.material}
                onChange={(event) => onChange({ ...config, material: event.target.value as MaterialCode })}
              >
                {MATERIALS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.short} ({option.code})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {kind.tube2 ? "Tube OD (fitting end)" : "Tube OD"}
              <select value={config.tube} onChange={(event) => onChange({ ...config, tube: event.target.value })}>
                {tubeOptions(kind).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {kind.tube2 && (
              <label>
                {kind.tube2 === "stub" ? "Tube stub OD" : "Second tube OD"}
                <select value={config.tube2 ?? ""} onChange={(event) => onChange({ ...config, tube2: event.target.value })}>
                  {seconds.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind.pipe && (
              <>
                <label>
                  Thread size
                  <select value={config.pipe ?? ""} onChange={(event) => onChange({ ...config, pipe: event.target.value })}>
                    {pipes.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Thread
                  <select
                    value={config.thread ?? ""}
                    onChange={(event) => onChange({ ...config, thread: event.target.value as ThreadStd })}
                  >
                    {threads.map((option) => (
                      <option key={option} value={option}>
                        {THREADS[option].label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>

          <dl className="fittingSpecs">
            {fitting.specs.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.label === "Ordering number" ? <span className="mono">{row.value}</span> : row.value}
                  {row.note && <small>{row.note}</small>}
                </dd>
              </div>
            ))}
          </dl>

          <div className="fittingAdd">
            <label>
              Qty
              <input type="number" min={1} step={1} value={qty} onChange={(event) => onQty(event.target.value)} />
            </label>
            <button type="button" className="primary" onClick={onAdd}>
              Add to fitting list
            </button>
          </div>
          <p className="hint fittingCaveat">
            Built from Swagelok&rsquo;s ordering-number rules ({kindById(config.kind).label.toLowerCase()} in{" "}
            {fitting.material.short}). Confirm availability and ratings on swagelok.com before release.
          </p>
        </div>
      </div>
    </article>
  );
}

function catalogNotes(fitting: Fitting | null): string {
  const lines = ["Added from the Fitting Selector (Swagelok ordering-number rules)."];
  if (fitting) {
    lines.push(`Ends: ${fitting.ends.map((end) => end.label).join(" × ") || "—"}.`);
    lines.push("Pressure rating: set by the tubing (Swagelok Tubing Data MS-01-181); enter the rating for the line class.");
    lines.push(`Product page: ${fitting.productUrl}`);
  }
  return lines.join("\n");
}

function catalogDimensions(fitting: Fitting): Record<string, unknown> {
  const dimensions: Record<string, unknown> = { tube_od_mm: fitting.tube.odMm };
  if (fitting.tube2) dimensions.tube2_od_mm = fitting.tube2.odMm;
  if (fitting.pipe && fitting.thread) dimensions.thread = `${fitting.pipe.label} ${THREADS[fitting.thread].label}`;
  return dimensions;
}

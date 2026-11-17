import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analysisApi, api, type AnalysisInputPayload } from "../api";
import { DataTable, FormError, Panel, StatusPill } from "../components/ui";
import { parseSizeInches } from "../engine/sizes";
import type {
  Analysis,
  AnalysisKind,
  AnalysisResults,
  AnalysisStatus,
  Drawing,
  PressureDropInputs,
  PressureDropResults,
  ReliefSizingInputs,
  ReliefSizingResults
} from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

const KIND_LABELS: Record<AnalysisKind, string> = { pressure_drop: "Pressure drop", relief_sizing: "Relief valve sizing" };
const STATUS_VALUES: AnalysisStatus[] = ["draft", "checked", "approved", "superseded"];
const PREVIEW_DELAY_MS = 350;

type SegmentForm = { id: number; name: string; diameter: string; length: string; roughness: string; k: string; elevation: string; cv: string };

type PressureDropForm = {
  fluidName: string;
  density: string;
  viscosity: string;
  flowBasis: "volumetric" | "mass";
  flow: string;
  velocityLimit: string;
  segments: SegmentForm[];
};

type ReliefForm = {
  service: "gas" | "liquid";
  fluidName: string;
  setPressure: string;
  overpressure: string;
  backPressure: string;
  atmosphere: string;
  kd: string;
  kc: string;
  massRate: string;
  temperature: string;
  molarMass: string;
  k: string;
  z: string;
  kb: string;
  volumeRate: string;
  density: string;
  viscosity: string;
  kw: string;
};

let segmentSeq = 0;
function newSegment(values: Partial<Omit<SegmentForm, "id">> = {}): SegmentForm {
  segmentSeq += 1;
  return { id: segmentSeq, name: "", diameter: "", length: "", roughness: "", k: "", elevation: "", cv: "", ...values };
}

function emptyPressureDrop(): PressureDropForm {
  return { fluidName: "", density: "", viscosity: "", flowBasis: "volumetric", flow: "", velocityLimit: "3", segments: [newSegment()] };
}

const EMPTY_RELIEF: ReliefForm = {
  service: "gas",
  fluidName: "",
  setPressure: "",
  overpressure: "10",
  backPressure: "0",
  atmosphere: "101.325",
  kd: "",
  kc: "1",
  massRate: "",
  temperature: "",
  molarMass: "",
  k: "",
  z: "1",
  kb: "1",
  volumeRate: "",
  density: "",
  viscosity: "",
  kw: "1"
};

const blank = (text: string) => text.trim() === "";
/** Number typed by the user; NaN when it is not a number (the server then names the field). */
const numberOf = (text: string) => Number(text.trim().replace(",", "."));
const optionalNumber = (text: string) => (blank(text) ? null : numberOf(text));
const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

/** Comma or space separated Cv values, e.g. "5, 12.5". */
function cvItems(input: string): Array<{ name: string; cv: number }> {
  return input
    .split(/[;,\s]+/)
    .filter(Boolean)
    .map((entry) => ({ name: "", cv: numberOf(entry) }));
}

/** Request payload, or the list of fields still missing before a preview makes sense. */
type Built = { inputs: AnalysisInputPayload; missing: string[] };

export function buildPressureDropInputs(form: PressureDropForm): Built {
  const missing: string[] = [];
  if (blank(form.density)) missing.push("density");
  if (blank(form.viscosity)) missing.push("viscosity");
  if (blank(form.flow)) missing.push("flow");
  if (!form.segments.length) missing.push("a segment");
  form.segments.forEach((segment, index) => {
    if (blank(segment.diameter)) missing.push(`inner diameter of segment ${index + 1}`);
  });
  const inputs: AnalysisInputPayload = {
    fluid_name: form.fluidName.trim(),
    density_kg_m3: numberOf(form.density),
    viscosity_mpa_s: numberOf(form.viscosity),
    [form.flowBasis === "mass" ? "mass_flow_kg_s" : "volumetric_flow_l_min"]: numberOf(form.flow),
    velocity_limit_m_s: blank(form.velocityLimit) ? 3 : numberOf(form.velocityLimit),
    segments: form.segments.map((segment) => ({
      name: segment.name.trim(),
      inner_diameter_mm: numberOf(segment.diameter),
      length_m: optionalNumber(segment.length) ?? 0,
      roughness_mm: optionalNumber(segment.roughness) ?? 0,
      k_sum: optionalNumber(segment.k) ?? 0,
      elevation_change_m: optionalNumber(segment.elevation) ?? 0,
      cv_items: cvItems(segment.cv)
    }))
  };
  return { inputs, missing };
}

export function buildReliefInputs(form: ReliefForm): Built {
  const missing: string[] = [];
  if (blank(form.setPressure)) missing.push("set pressure");
  const inputs: AnalysisInputPayload = {
    service: form.service,
    fluid_name: form.fluidName.trim(),
    set_pressure_kpag: numberOf(form.setPressure),
    overpressure_pct: optionalNumber(form.overpressure) ?? 10,
    back_pressure_kpag: optionalNumber(form.backPressure) ?? 0,
    atmospheric_pressure_kpa: optionalNumber(form.atmosphere) ?? 101.325,
    kd: optionalNumber(form.kd),
    kc: optionalNumber(form.kc) ?? 1
  };
  if (form.service === "gas") {
    if (blank(form.massRate)) missing.push("relieving rate");
    if (blank(form.temperature)) missing.push("relieving temperature");
    if (blank(form.molarMass)) missing.push("molar mass");
    if (blank(form.k)) missing.push("k");
    Object.assign(inputs, {
      mass_rate_kg_h: numberOf(form.massRate),
      relieving_temperature_c: numberOf(form.temperature),
      molar_mass_kg_kmol: numberOf(form.molarMass),
      k: numberOf(form.k),
      z: optionalNumber(form.z) ?? 1,
      kb: optionalNumber(form.kb) ?? 1
    });
  } else {
    if (blank(form.volumeRate)) missing.push("relieving rate");
    if (blank(form.density)) missing.push("density");
    Object.assign(inputs, {
      volume_rate_l_min: numberOf(form.volumeRate),
      density_kg_m3: numberOf(form.density),
      viscosity_mpa_s: optionalNumber(form.viscosity),
      kw: optionalNumber(form.kw) ?? 1
    });
  }
  return { inputs, missing };
}

function pressureDropFormOf(inputs: PressureDropInputs): PressureDropForm {
  const mass = inputs.mass_flow_kg_s !== null && inputs.mass_flow_kg_s !== undefined;
  return {
    fluidName: inputs.fluid_name ?? "",
    density: text(inputs.density_kg_m3),
    viscosity: text(inputs.viscosity_mpa_s),
    flowBasis: mass ? "mass" : "volumetric",
    flow: text(mass ? inputs.mass_flow_kg_s : inputs.volumetric_flow_l_min),
    velocityLimit: text(inputs.velocity_limit_m_s),
    segments: inputs.segments.map((segment) =>
      newSegment({
        name: segment.name,
        diameter: text(segment.inner_diameter_mm),
        length: text(segment.length_m),
        roughness: text(segment.roughness_mm),
        k: text(segment.k_sum),
        elevation: text(segment.elevation_change_m),
        cv: segment.cv_items.map((item) => item.cv).join(", ")
      })
    )
  };
}

function reliefFormOf(inputs: ReliefSizingInputs): ReliefForm {
  return {
    service: inputs.service,
    fluidName: inputs.fluid_name ?? "",
    setPressure: text(inputs.set_pressure_kpag),
    overpressure: text(inputs.overpressure_pct),
    backPressure: text(inputs.back_pressure_kpag),
    atmosphere: text(inputs.atmospheric_pressure_kpa),
    kd: text(inputs.kd),
    kc: text(inputs.kc),
    massRate: text(inputs.mass_rate_kg_h),
    temperature: text(inputs.relieving_temperature_c),
    molarMass: text(inputs.molar_mass_kg_kmol),
    k: text(inputs.k),
    z: text(inputs.z),
    kb: text(inputs.kb),
    volumeRate: text(inputs.volume_rate_l_min),
    density: text(inputs.density_kg_m3),
    viscosity: text(inputs.viscosity_mpa_s),
    kw: text(inputs.kw)
  };
}

/** Four significant figures, without exponent notation for everyday magnitudes. */
export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e7 || magnitude < 1e-4) return value.toExponential(digits - 1);
  if (magnitude >= 10 ** digits) return Math.round(value).toLocaleString("en-US");
  return String(Number(value.toPrecision(digits)));
}

/** Headline of a stored result for the list. */
export function resultSummary(results: AnalysisResults): string {
  if (results.kind === "pressure_drop") return `${formatNumber(results.totals.dp_total_kpa)} kPa`;
  const orifice = results.orifice ? `, orifice ${results.orifice.letter}` : ", above orifice T";
  return `${formatNumber(results.required_area_mm2)} mm²${orifice}`;
}

function NumberField({ label, unit, value, onChange, hint }: { label: string; unit?: string; value: string; onChange: (value: string) => void; hint?: string }) {
  return (
    <label className="calcField" title={hint}>
      <span>
        {label}
        {unit ? <span className="calcUnit"> ({unit})</span> : null}
      </span>
      <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Messages({ results }: { results: AnalysisResults }) {
  return (
    <>
      {results.warnings.length > 0 && (
        <div className="calcWarnings" role="alert">
          <strong>
            {results.warnings.length} warning{results.warnings.length === 1 ? "" : "s"}
          </strong>
          <ul>
            {results.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="calcAssumptions">
        <summary>Method and assumptions</summary>
        <ul>
          {results.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <p className="hint">Calculation version {results.calc_version}. Results are computed on the server and stored with the inputs.</p>
      </details>
    </>
  );
}

function Stat({ label, value, unit, alt }: { label: string; value: string; unit?: string; alt?: string }) {
  return (
    <div className="calcStat">
      <span className="calcStatLabel">{label}</span>
      <span className="calcStatValue">
        {value}
        {unit ? <small> {unit}</small> : null}
      </span>
      {alt ? <span className="calcStatAlt">{alt}</span> : null}
    </div>
  );
}

export function PressureDropResultView({ results }: { results: PressureDropResults }) {
  const totals = results.totals;
  return (
    <div className="calcResults">
      <div className="calcStats">
        <Stat label="Total pressure drop" value={formatNumber(totals.dp_total_kpa)} unit="kPa" alt={`${formatNumber(totals.dp_total_bar)} bar`} />
        <Stat label="Equivalent head of the fluid" value={formatNumber(totals.head_loss_m)} unit="m" />
        <Stat label="Flow" value={formatNumber(results.flow.volumetric_flow_l_min)} unit="L/min" alt={`${formatNumber(results.flow.mass_flow_kg_s)} kg/s`} />
      </div>
      <div className="tableWrap">
        <table aria-label="Pressure drop by segment">
          <thead>
            <tr>
              <th>Segment</th>
              <th>Velocity (m/s)</th>
              <th>Reynolds no.</th>
              <th>Regime</th>
              <th>Friction factor</th>
              <th>Friction (kPa)</th>
              <th>Fittings (kPa)</th>
              <th>Cv items (kPa)</th>
              <th>Elevation (kPa)</th>
              <th>Total (kPa)</th>
            </tr>
          </thead>
          <tbody>
            {results.segments.map((segment, index) => (
              <tr key={`${segment.name}-${index}`}>
                <td>{segment.name}</td>
                <td className="num">{formatNumber(segment.velocity_m_s)}</td>
                <td className="num">{formatNumber(segment.reynolds)}</td>
                <td>{segment.flow_regime}</td>
                <td className="num">{formatNumber(segment.friction_factor)}</td>
                <td className="num">{formatNumber(segment.dp_friction_kpa)}</td>
                <td className="num">{formatNumber(segment.dp_minor_kpa)}</td>
                <td className="num">{formatNumber(segment.dp_components_kpa)}</td>
                <td className="num">{formatNumber(segment.dp_elevation_kpa)}</td>
                <td className="num">{formatNumber(segment.dp_total_kpa)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={5}>Total</th>
              <td className="num">{formatNumber(totals.dp_friction_kpa)}</td>
              <td className="num">{formatNumber(totals.dp_minor_kpa)}</td>
              <td className="num">{formatNumber(totals.dp_components_kpa)}</td>
              <td className="num">{formatNumber(totals.dp_elevation_kpa)}</td>
              <td className="num">{formatNumber(totals.dp_total_kpa)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Messages results={results} />
    </div>
  );
}

const FACTOR_LABELS: Record<string, string> = { kd: "Kd", kb: "Kb", kc: "Kc", kw: "Kw", kv: "Kv" };

export function ReliefResultView({ results }: { results: ReliefSizingResults }) {
  const factors = Object.entries(results.factors).filter((entry): entry is [string, number] => entry[1] !== null);
  return (
    <div className="calcResults">
      <div className="calcStats">
        <Stat label="Required effective area" value={formatNumber(results.required_area_mm2)} unit="mm²" alt={`${formatNumber(results.required_area_in2)} in²`} />
        {results.orifice ? (
          <Stat
            label="Next API 526 orifice"
            value={results.orifice.letter}
            alt={`${formatNumber(results.orifice.area_mm2)} mm² (${formatNumber(results.orifice.area_in2)} in²)`}
          />
        ) : (
          <Stat label="Next API 526 orifice" value="None" alt="The area exceeds orifice T" />
        )}
        <Stat label="Flow" value={results.flow_regime === "liquid" ? "Liquid" : results.flow_regime === "critical" ? "Critical (choked)" : "Subcritical"} />
      </div>
      <dl className="calcDetails">
        <dt>Relieving pressure</dt>
        <dd>
          {formatNumber(results.relieving_pressure_kpag)} kPa gauge
          {results.relieving_pressure_kpa_abs !== undefined ? ` (${formatNumber(results.relieving_pressure_kpa_abs)} kPa abs)` : ""}
        </dd>
        {results.critical_flow_pressure_kpa_abs !== undefined && (
          <>
            <dt>Critical flow pressure</dt>
            <dd>
              {formatNumber(results.critical_flow_pressure_kpa_abs)} kPa abs; back pressure {formatNumber(results.back_pressure_kpa_abs)} kPa abs
            </dd>
          </>
        )}
        {results.coefficient_c !== undefined && (
          <>
            <dt>Coefficient C</dt>
            <dd>{formatNumber(results.coefficient_c)}</dd>
          </>
        )}
        {results.coefficient_f2 !== undefined && (
          <>
            <dt>Coefficient F2</dt>
            <dd>{formatNumber(results.coefficient_f2)}</dd>
          </>
        )}
        {results.specific_gravity !== undefined && (
          <>
            <dt>Specific gravity</dt>
            <dd>{formatNumber(results.specific_gravity)}</dd>
          </>
        )}
        {results.reynolds !== undefined && results.reynolds !== null && (
          <>
            <dt>Reynolds number at the orifice</dt>
            <dd>
              {formatNumber(results.reynolds)}; area before viscosity correction {formatNumber(results.preliminary_area_mm2)} mm²
            </dd>
          </>
        )}
        <dt>Factors used</dt>
        <dd>{factors.map(([key, value]) => `${FACTOR_LABELS[key] ?? key} = ${formatNumber(value)}`).join(", ")}</dd>
      </dl>
      <Messages results={results} />
    </div>
  );
}

/** Pressure-drop and relief-sizing calculators with a live preview and stored, reproducible results. */
export function AnalysisPage() {
  const { busy, canWrite, formErrors, runAction, selectedProjectId, selectedProject } = useWorkspace();
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [loadError, setLoadError] = useState("");
  const [openId, setOpenId] = useState("");
  const [kind, setKind] = useState<AnalysisKind>("pressure_drop");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<AnalysisStatus>("draft");
  const [drawingId, setDrawingId] = useState("");
  const [pressureDrop, setPressureDrop] = useState<PressureDropForm>(emptyPressureDrop);
  const [relief, setRelief] = useState<ReliefForm>(EMPTY_RELIEF);
  const [preview, setPreview] = useState<{ results: AnalysisResults | null; error: string; pending: boolean }>({ results: null, error: "", pending: false });
  const [seedNote, setSeedNote] = useState("");

  const projectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    projectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const refreshAnalyses = useCallback(async (projectId: string) => {
    const next = await analysisApi.list(projectId);
    if (projectIdRef.current === projectId) setAnalyses(next);
  }, []);

  function startNew(nextKind: AnalysisKind = kind) {
    setOpenId("");
    setKind(nextKind);
    setName("");
    setStatus("draft");
    setDrawingId("");
    setPressureDrop(emptyPressureDrop());
    setRelief(EMPTY_RELIEF);
    setSeedNote("");
  }

  useEffect(() => {
    setAnalyses([]);
    setDrawings([]);
    setLoadError("");
    startNew("pressure_drop");
    if (!selectedProjectId) return;
    let cancelled = false;
    analysisApi
      .list(selectedProjectId)
      .then((next) => {
        if (!cancelled) setAnalyses(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load analyses.");
      });
    api
      .listDrawings(selectedProjectId)
      .then((next) => {
        if (!cancelled) setDrawings(next);
      })
      .catch(() => {
        if (!cancelled) setDrawings([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  const built = useMemo(() => (kind === "pressure_drop" ? buildPressureDropInputs(pressureDrop) : buildReliefInputs(relief)), [kind, pressureDrop, relief]);
  const payloadKey = JSON.stringify(built.inputs);
  const incomplete = built.missing.length > 0;

  // Live preview: recompute on the server shortly after the last edit.
  useEffect(() => {
    if (incomplete) {
      setPreview({ results: null, error: "", pending: false });
      return;
    }
    const controller = new AbortController();
    setPreview((current) => ({ ...current, pending: true }));
    const timer = window.setTimeout(() => {
      analysisApi
        .preview(kind, JSON.parse(payloadKey) as AnalysisInputPayload, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) setPreview({ results: response.results, error: "", pending: false });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreview({ results: null, error: error instanceof Error ? error.message : "The calculation failed.", pending: false });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [kind, payloadKey, incomplete]);

  const openAnalysis = analyses.find((analysis) => analysis.id === openId) ?? null;

  function open(analysis: Analysis) {
    setOpenId(analysis.id);
    setKind(analysis.kind);
    setName(analysis.name);
    setStatus(analysis.status);
    setDrawingId(analysis.drawing_id ?? "");
    setSeedNote("");
    if (analysis.kind === "pressure_drop") setPressureDrop(pressureDropFormOf(analysis.inputs as PressureDropInputs));
    else setRelief(reliefFormOf(analysis.inputs as ReliefSizingInputs));
  }

  function save(asNew: boolean) {
    if (!selectedProjectId) return;
    const projectId = selectedProjectId;
    const body = { name: name.trim(), inputs: built.inputs, drawing_id: drawingId || null, status };
    if (openAnalysis && !asNew) {
      void runAction(`Saved ${body.name}.`, async () => {
        await analysisApi.update(openAnalysis.id, body);
        await refreshAnalyses(projectId);
      }, "analysis");
      return;
    }
    void runAction(`Saved ${body.name}.`, async () => {
      const created = await analysisApi.create(projectId, { kind, ...body });
      await refreshAnalyses(projectId);
      if (projectIdRef.current === projectId) setOpenId(created.id);
    }, "analysis");
  }

  function remove(analysis: Analysis) {
    if (!window.confirm(`Delete the analysis "${analysis.name}"?`)) return;
    const projectId = analysis.project_id;
    void runAction(`Deleted ${analysis.name}.`, async () => {
      await analysisApi.remove(analysis.id);
      await refreshAnalyses(projectId);
      if (analysis.id === openId) startNew();
    }, "analysis");
  }

  /** Replace the segments with the numbered lines of the chosen drawing's line list. */
  function seedFromLineList() {
    if (!drawingId) return;
    void runAction("Loaded the line list.", async () => {
      const list = await api.getDrawingList(drawingId, "line");
      const rows = list.rows.filter((row) => row.line_number);
      if (!rows.length) {
        setSeedNote("This drawing has no numbered lines on its saved sheets.");
        return;
      }
      let withoutSize = 0;
      let withoutLength = 0;
      const segments = rows.map((row) => {
        const inches = parseSizeInches(typeof row.size === "string" ? row.size : null);
        const length = typeof row.length_m === "number" ? row.length_m : null;
        if (inches === null) withoutSize += 1;
        if (length === null) withoutLength += 1;
        return newSegment({
          name: String(row.line_number),
          diameter: inches === null ? "" : String(Number((inches * 25.4).toFixed(2))),
          length: length === null ? "" : String(length)
        });
      });
      setPressureDrop((current) => ({ ...current, segments }));
      const gaps = [withoutSize ? `${withoutSize} without a size` : "", withoutLength ? `${withoutLength} without a length` : ""].filter(Boolean).join(", ");
      setSeedNote(
        `Loaded ${rows.length} line${rows.length === 1 ? "" : "s"}${gaps ? ` (${gaps})` : ""}. Diameters are the nominal line sizes and lengths are the line list's (drawn length scaled unless a physical length was entered): replace them with the actual bore and run, and check that the lines really are in series.`
      );
    }, "analysis");
  }

  const setPd = <K extends keyof PressureDropForm>(key: K, value: PressureDropForm[K]) => setPressureDrop((current) => ({ ...current, [key]: value }));
  const setSegment = (id: number, key: keyof Omit<SegmentForm, "id">, value: string) =>
    setPressureDrop((current) => ({ ...current, segments: current.segments.map((segment) => (segment.id === id ? { ...segment, [key]: value } : segment)) }));
  const setRv = <K extends keyof ReliefForm>(key: K, value: ReliefForm[K]) => setRelief((current) => ({ ...current, [key]: value }));
  const drawingLabel = (id: string | null) => drawings.find((drawing) => drawing.id === id)?.number ?? "";
  const canSave = canWrite && Boolean(selectedProject) && !busy && !blank(name) && !incomplete && !preview.error;

  return (
    <PageLayout title="Analysis" description="Pressure drop and relief valve sizing">
      <section className="grid">
        <Panel title="Stored analyses" className="panelWide">
          <FormError message={loadError} />
          {analyses.length ? (
            <DataTable
              rows={analyses}
              getKey={(analysis) => analysis.id}
              selectedKey={openId}
              columns={[
                {
                  header: "Name",
                  render: (analysis) => (
                    <button type="button" className="linkButton" onClick={() => open(analysis)} title="Open in the calculator">
                      {analysis.name}
                    </button>
                  )
                },
                { header: "Type", render: (analysis) => KIND_LABELS[analysis.kind] },
                { header: "Result", render: (analysis) => <span className="mono">{resultSummary(analysis.results)}</span> },
                {
                  header: "Warnings",
                  render: (analysis) =>
                    analysis.results.warnings.length ? <span className="pill pill-warn">{analysis.results.warnings.length}</span> : <span className="hint">none</span>
                },
                { header: "Status", render: (analysis) => <StatusPill value={analysis.status} /> },
                { header: "Drawing", render: (analysis) => <span className="mono">{drawingLabel(analysis.drawing_id)}</span> },
                { header: "Saved by", render: (analysis) => analysis.created_by ?? "" },
                { header: "Updated", render: (analysis) => new Date(analysis.updated_at).toLocaleDateString() },
                ...(canWrite
                  ? [
                      {
                        header: "",
                        render: (analysis: Analysis) => (
                          <button type="button" className="danger tableButton" disabled={busy} onClick={() => remove(analysis)}>
                            Delete
                          </button>
                        )
                      }
                    ]
                  : [])
              ]}
            />
          ) : (
            <p className="hint">{selectedProject ? "No stored analyses yet. Fill in a calculator below and save it." : "Select a project to see its analyses."}</p>
          )}
        </Panel>
        <Panel
          title={openAnalysis ? openAnalysis.name : `New ${KIND_LABELS[kind].toLowerCase()} analysis`}
          className="panelWide"
          actions={
            <span className="panelActions calcKinds" role="group" aria-label="Calculator">
              {(Object.keys(KIND_LABELS) as AnalysisKind[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={option === kind && !openAnalysis ? "primary" : undefined}
                  aria-pressed={option === kind && !openAnalysis}
                  onClick={() => startNew(option)}
                >
                  New {KIND_LABELS[option].toLowerCase()}
                </button>
              ))}
            </span>
          }
        >
          <div className="calcForm">
            <label className="calcField calcFieldWide">
              <span>Analysis name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="calcField">
              <span>Drawing (optional)</span>
              <select value={drawingId} onChange={(event) => setDrawingId(event.target.value)}>
                <option value="">None</option>
                {drawings.map((drawing) => (
                  <option key={drawing.id} value={drawing.id}>
                    {drawing.number} · {drawing.title.split("\n")[0]}
                  </option>
                ))}
              </select>
            </label>
            <label className="calcField">
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as AnalysisStatus)}>
                {STATUS_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {kind === "pressure_drop" ? (
            <>
              <h3 className="calcHeading">Fluid and flow</h3>
              <div className="calcForm">
                <label className="calcField">
                  <span>Fluid</span>
                  <input value={pressureDrop.fluidName} onChange={(event) => setPd("fluidName", event.target.value)} />
                </label>
                <NumberField label="Density" unit="kg/m³" value={pressureDrop.density} onChange={(value) => setPd("density", value)} />
                <NumberField label="Dynamic viscosity" unit="mPa·s = cP" value={pressureDrop.viscosity} onChange={(value) => setPd("viscosity", value)} />
                <label className="calcField">
                  <span>Flow given as</span>
                  <select value={pressureDrop.flowBasis} onChange={(event) => setPd("flowBasis", event.target.value as PressureDropForm["flowBasis"])}>
                    <option value="volumetric">Volumetric flow</option>
                    <option value="mass">Mass flow</option>
                  </select>
                </label>
                <NumberField label="Flow" unit={pressureDrop.flowBasis === "mass" ? "kg/s" : "L/min"} value={pressureDrop.flow} onChange={(value) => setPd("flow", value)} />
                <NumberField
                  label="Velocity limit"
                  unit="m/s"
                  value={pressureDrop.velocityLimit}
                  onChange={(value) => setPd("velocityLimit", value)}
                  hint="Segments faster than this are flagged; the result does not change."
                />
              </div>
              <h3 className="calcHeading">Line segments in series</h3>
              <div className="tableWrap">
                <table className="segmentTable" aria-label="Line segments">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Inner diameter (mm)</th>
                      <th>Length (m)</th>
                      <th title="Absolute roughness; 0 for a smooth tube">Roughness (mm)</th>
                      <th title="Sum of the K factors of bends, tees, and fittings in this segment">Fittings, sum of K</th>
                      <th title="Outlet height minus inlet height; positive when the line rises">Elevation change (m)</th>
                      <th title="US flow coefficient: US gal/min of water at 1 psi drop. Cv = 1.156 × Kv. Separate several with commas.">Valve Cv (US)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pressureDrop.segments.map((segment, index) => {
                      const cell = (key: keyof Omit<SegmentForm, "id">, label: string, numeric = true) => (
                        <td>
                          <input
                            aria-label={`${label}, segment ${index + 1}`}
                            inputMode={numeric ? "decimal" : undefined}
                            value={segment[key]}
                            onChange={(event) => setSegment(segment.id, key, event.target.value)}
                          />
                        </td>
                      );
                      return (
                        <tr key={segment.id}>
                          {cell("name", "Name", false)}
                          {cell("diameter", "Inner diameter")}
                          {cell("length", "Length")}
                          {cell("roughness", "Roughness")}
                          {cell("k", "Sum of K")}
                          {cell("elevation", "Elevation change")}
                          {cell("cv", "Valve Cv", false)}
                          <td>
                            <button
                              type="button"
                              className="danger"
                              aria-label={`Remove segment ${index + 1}`}
                              disabled={pressureDrop.segments.length === 1}
                              onClick={() => setPd("segments", pressureDrop.segments.filter((entry) => entry.id !== segment.id))}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="buttonRow calcSegmentActions">
                <button type="button" onClick={() => setPd("segments", [...pressureDrop.segments, newSegment()])}>
                  Add segment
                </button>
                <button type="button" disabled={busy || !drawingId} onClick={seedFromLineList} title={drawingId ? "Replace the segments with the drawing's numbered lines" : "Choose a drawing first"}>
                  Fill from the drawing's line list
                </button>
              </div>
              {seedNote && <p className="hint">{seedNote}</p>}
              <p className="hint">
                Blank length, roughness, K, and elevation count as zero. Cv is the US flow coefficient (US gal/min of water at 1 psi); convert a metric Kv with Cv = 1.156 × Kv.
              </p>
            </>
          ) : (
            <>
              <h3 className="calcHeading">Relief case</h3>
              <div className="calcForm">
                <label className="calcField">
                  <span>Service</span>
                  <select value={relief.service} onChange={(event) => setRv("service", event.target.value as ReliefForm["service"])}>
                    <option value="gas">Gas or vapour</option>
                    <option value="liquid">Liquid</option>
                  </select>
                </label>
                <label className="calcField">
                  <span>Fluid</span>
                  <input value={relief.fluidName} onChange={(event) => setRv("fluidName", event.target.value)} />
                </label>
                <NumberField label="Set pressure" unit="kPa gauge" value={relief.setPressure} onChange={(value) => setRv("setPressure", value)} />
                <NumberField label="Overpressure" unit="%" value={relief.overpressure} onChange={(value) => setRv("overpressure", value)} hint="10 % single valve, 16 % multiple valves, 21 % fire case (ASME VIII)." />
                <NumberField label="Total back pressure" unit="kPa gauge" value={relief.backPressure} onChange={(value) => setRv("backPressure", value)} hint="Superimposed plus built-up back pressure at the valve outlet while relieving." />
                <NumberField label="Atmospheric pressure" unit="kPa" value={relief.atmosphere} onChange={(value) => setRv("atmosphere", value)} />
                {relief.service === "gas" ? (
                  <>
                    <NumberField label="Required relieving rate" unit="kg/h" value={relief.massRate} onChange={(value) => setRv("massRate", value)} />
                    <NumberField label="Relieving temperature" unit="°C" value={relief.temperature} onChange={(value) => setRv("temperature", value)} />
                    <NumberField label="Molar mass" unit="kg/kmol" value={relief.molarMass} onChange={(value) => setRv("molarMass", value)} />
                    <NumberField label="Ratio of specific heats k" value={relief.k} onChange={(value) => setRv("k", value)} hint="Ideal-gas cp/cv at relieving conditions." />
                    <NumberField label="Compressibility Z" value={relief.z} onChange={(value) => setRv("z", value)} />
                  </>
                ) : (
                  <>
                    <NumberField label="Required relieving rate" unit="L/min" value={relief.volumeRate} onChange={(value) => setRv("volumeRate", value)} />
                    <NumberField label="Density" unit="kg/m³" value={relief.density} onChange={(value) => setRv("density", value)} />
                    <NumberField label="Viscosity, optional" unit="mPa·s = cP" value={relief.viscosity} onChange={(value) => setRv("viscosity", value)} hint="Leave blank to take the viscosity correction Kv as 1." />
                  </>
                )}
              </div>
              <h3 className="calcHeading">Valve factors</h3>
              <div className="calcForm">
                <NumberField
                  label="Discharge coefficient Kd"
                  value={relief.kd}
                  onChange={(value) => setRv("kd", value)}
                  hint="Leave blank for the API 520 preliminary value."
                />
                {relief.service === "gas" ? (
                  <NumberField label="Back pressure factor Kb" value={relief.kb} onChange={(value) => setRv("kb", value)} hint="1 for conventional and pilot valves in critical flow." />
                ) : (
                  <NumberField label="Back pressure factor Kw" value={relief.kw} onChange={(value) => setRv("kw", value)} hint="1 for conventional and pilot valves." />
                )}
                <NumberField label="Combination factor Kc" value={relief.kc} onChange={(value) => setRv("kc", value)} hint="1 without a rupture disc upstream; 0.9 with an uncertified combination." />
              </div>
              <p className="hint">
                Kd left blank uses the API 520 preliminary value ({relief.service === "gas" ? "0.975 for gas" : "0.65 for liquid"}). The relieving rate is your input: this calculator sizes the
                orifice, it does not work out the relief scenario.
              </p>
            </>
          )}

          <h3 className="calcHeading">
            Result{preview.pending ? <span className="hint"> · calculating…</span> : null}
          </h3>
          {incomplete ? (
            <p className="hint">Enter {built.missing.join(", ")} to see the result.</p>
          ) : preview.error ? (
            <FormError message={preview.error} />
          ) : preview.results ? (
            preview.results.kind === "pressure_drop" ? (
              <PressureDropResultView results={preview.results} />
            ) : (
              <ReliefResultView results={preview.results} />
            )
          ) : null}

          <FormError message={formErrors.analysis} />
          {canWrite ? (
            <div className="buttonRow">
              <button type="button" className="primary" disabled={!canSave} onClick={() => save(false)}>
                {openAnalysis ? "Save changes" : "Save analysis"}
              </button>
              {openAnalysis && (
                <button type="button" disabled={!canSave} onClick={() => save(true)}>
                  Save as new
                </button>
              )}
              {blank(name) && !incomplete && <span className="hint">Name the analysis to save it.</span>}
            </div>
          ) : (
            <p className="hint">This account is read-only: results can be previewed but not saved.</p>
          )}
        </Panel>
      </section>
    </PageLayout>
  );
}

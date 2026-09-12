/**
 * Safety hub: overview (risk matrix, attention tiles) and the hazard log.
 * FMEA, analyses, and project-wide design rules land in later phases.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { HazardDrawer } from "../components/safety/HazardDrawer";
import { RiskMatrix, type MatrixCell, type MatrixMode } from "../components/safety/RiskMatrix";
import { DataTable, Panel, StatusPill, SummaryCard } from "../components/ui";
import type { FluidSystem, Hazard, HazardMatrix, Project, Requirement, SafetySettings } from "../types";
import { PageLayout } from "./PageLayout";

type Tab = "overview" | "hazards" | "fmea" | "analyses" | "rules";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "hazards", label: "Hazard log" },
  { id: "fmea", label: "FMEA" },
  { id: "analyses", label: "Analyses" },
  { id: "rules", label: "Design rules" }
];

const CRITICAL = new Set(["I", "II"]);

function humanize(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

export function SafetyPage({
  project,
  systems,
  requirements,
  canWrite,
  onRequirementsChanged
}: {
  project: Project | null;
  systems: FluidSystem[];
  requirements: Requirement[];
  canWrite: boolean;
  onRequirementsChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [matrix, setMatrix] = useState<HazardMatrix | null>(null);
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [matrixMode, setMatrixMode] = useState<MatrixMode>("residual");
  const [cell, setCell] = useState<MatrixCell | null>(null);
  const [filters, setFilters] = useState({ category: "", computed: "", mode: "", severity: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const projectId = project?.id ?? "";

  const reload = useCallback(async () => {
    if (!projectId) {
      setHazards([]);
      setMatrix(null);
      setSettings(null);
      return;
    }
    try {
      const [nextHazards, nextMatrix, nextSettings] = await Promise.all([api.listHazards(projectId), api.getHazardMatrix(projectId), api.getSafetySettings(projectId)]);
      setHazards(nextHazards);
      setMatrix(nextMatrix);
      setSettings(nextSettings.settings);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the safety data.");
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
    setCell(null);
    void reload();
  }, [reload]);

  const selected = hazards.find((hazard) => hazard.id === selectedId) ?? null;

  const visible = useMemo(() => {
    return hazards.filter((hazard) => {
      if (filters.category && hazard.category !== filters.category) return false;
      if (filters.computed && hazard.computed_status !== filters.computed) return false;
      if (filters.mode && !(hazard.operating_modes ?? []).includes(filters.mode)) return false;
      if (filters.severity && hazard.severity_initial !== filters.severity) return false;
      if (cell) {
        const severity = matrixMode === "initial" ? hazard.severity_initial : hazard.severity_residual ?? hazard.severity_initial;
        const likelihood = matrixMode === "initial" ? hazard.likelihood_initial : hazard.likelihood_residual ?? hazard.likelihood_initial;
        if (severity !== cell.severity || likelihood !== cell.likelihood) return false;
      }
      return true;
    });
  }, [hazards, filters, cell, matrixMode]);

  const uncontrolledCritical = hazards.filter((hazard) => CRITICAL.has(hazard.severity_initial ?? "") && hazard.computed_status === "open");
  const safetyRequirements = requirements.filter((requirement) => requirement.category === "safety" || requirement.safety_critical);
  const verifiedSafety = safetyRequirements.filter((requirement) => requirement.verification_status === "verified" || requirement.verification_status === "waived");
  const withoutEvidence = requirements.filter((requirement) => requirement.safety_critical && (requirement.verification_status ?? "planned") === "planned");

  function upsert(hazard: Hazard) {
    setHazards((current) => {
      const exists = current.some((entry) => entry.id === hazard.id);
      const next = exists ? current.map((entry) => (entry.id === hazard.id ? hazard : entry)) : [...current, hazard];
      return next.sort((a, b) => a.key.localeCompare(b.key));
    });
    setSelectedId(hazard.id);
    setCreating(false);
    void api.getHazardMatrix(projectId).then(setMatrix).catch(() => undefined);
  }

  function openCell(next: MatrixCell | null) {
    setCell(next);
    if (next) setTab("hazards");
  }

  if (!project) {
    return (
      <PageLayout title="Safety" description="Hazards and analyses">
        <Panel title="Safety">
          <p className="hint">Select a project on the Systems page to open its hazard log.</p>
        </Panel>
      </PageLayout>
    );
  }

  const showDrawer = settings && (creating || selected);

  return (
    <PageLayout title="Safety" description={project.name}>
      <nav className="safetyTabs" aria-label="Safety sections">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>
      {error && <p className="formError">{error}</p>}

      {tab === "overview" && (
        <section className="safetyOverview">
          <div className="tileRow">
            <SummaryCard title="Uncontrolled I–II" value={uncontrolledCritical.length} detail="Severity I or II hazards still open" />
            <SummaryCard title="Open hazards" value={hazards.filter((hazard) => hazard.computed_status === "open").length} detail={`${hazards.length} in the log`} />
            <SummaryCard title="Controlled" value={hazards.filter((hazard) => hazard.computed_status === "controlled").length} detail="All controls verified, policy met" />
            <SummaryCard title="Accepted" value={hazards.filter((hazard) => hazard.status === "accepted").length} detail="Residual risk signed off" />
            <SummaryCard title="Safety reqs verified" value={verifiedSafety.length} detail={`of ${safetyRequirements.length} safety requirements`} />
            <SummaryCard title="Critical without evidence" value={withoutEvidence.length} detail="Safety-critical requirements still planned" />
          </div>
          <div className="grid">
            <Panel
              title="Risk matrix"
              actions={
                <span className="segmented" role="group" aria-label="Matrix mode">
                  <button type="button" className={matrixMode === "initial" ? "active" : ""} onClick={() => setMatrixMode("initial")}>
                    Initial
                  </button>
                  <button type="button" className={matrixMode === "residual" ? "active" : ""} onClick={() => setMatrixMode("residual")}>
                    Residual
                  </button>
                </span>
              }
            >
              {matrix ? <RiskMatrix matrix={matrix} mode={matrixMode} selected={cell} onSelect={openCell} /> : <p className="hint">Loading…</p>}
              <p className="hint">
                Severity down, likelihood across. Click a cell to filter the hazard log.
                {matrix && matrix.unrated ? ` ${matrix.unrated} hazard(s) have no initial rating.` : ""}
              </p>
            </Panel>
            <Panel title="Needs attention">
              {uncontrolledCritical.length === 0 ? (
                <p className="hint">No open severity I or II hazards.</p>
              ) : (
                <ul className="attentionList">
                  {uncontrolledCritical.map((hazard) => (
                    <li key={hazard.id}>
                      <button
                        type="button"
                        className="linkButton"
                        onClick={() => {
                          setSelectedId(hazard.id);
                          setTab("hazards");
                        }}
                      >
                        <span className="mono">{hazard.key}</span> {hazard.title}
                      </button>
                      <span className="hint">
                        {hazard.controls_verified} of {hazard.controls_total} controls verified · needs {hazard.fault_tolerance_required} independent
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </section>
      )}

      {tab === "hazards" && (
        <section className={`safetyLayout${showDrawer ? " withDrawer" : ""}`}>
          <Panel
            title={`Hazard log · ${visible.length} of ${hazards.length}`}
            actions={
              canWrite ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setSelectedId(null);
                    setCreating(true);
                  }}
                >
                  New hazard
                </button>
              ) : undefined
            }
          >
            <div className="filterRow">
              <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })} aria-label="Category">
                <option value="">All categories</option>
                {(settings?.hazard_categories ?? []).map((category) => (
                  <option key={category} value={category}>
                    {humanize(category)}
                  </option>
                ))}
              </select>
              <select value={filters.computed} onChange={(event) => setFilters({ ...filters, computed: event.target.value })} aria-label="State">
                <option value="">Any state</option>
                {["open", "controlled", "accepted", "closed"].map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
              <select value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })} aria-label="Severity">
                <option value="">Any severity</option>
                {(settings?.severity_scale ?? []).map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
              </select>
              <select value={filters.mode} onChange={(event) => setFilters({ ...filters, mode: event.target.value })} aria-label="Operating mode">
                <option value="">Any mode</option>
                {(settings?.operating_modes ?? []).map((mode) => (
                  <option key={mode} value={mode}>
                    {humanize(mode)}
                  </option>
                ))}
              </select>
              {cell && (
                <button type="button" onClick={() => setCell(null)}>
                  Clear matrix filter ({cell.severity}-{cell.likelihood})
                </button>
              )}
            </div>
            <DataTable
              rows={visible}
              selectedKey={selectedId ?? undefined}
              getKey={(hazard) => hazard.id}
              onSelect={(hazard) => {
                setCreating(false);
                setSelectedId(hazard.id);
              }}
              columns={[
                { header: "Key", render: (hazard) => <span className="mono">{hazard.key}</span> },
                { header: "Title", render: (hazard) => <span className="clamp" title={hazard.title}>{hazard.title}</span> },
                { header: "Category", render: (hazard) => humanize(hazard.category) },
                { header: "Modes", render: (hazard) => <span className="hint">{(hazard.operating_modes ?? []).map(humanize).join(", ") || "—"}</span> },
                {
                  header: "Initial",
                  render: (hazard) =>
                    hazard.severity_initial && hazard.likelihood_initial ? (
                      <span className={`pill risk-${hazard.risk_initial ?? "low"}`}>
                        {hazard.severity_initial}-{hazard.likelihood_initial}
                      </span>
                    ) : (
                      <span className="hint">unrated</span>
                    )
                },
                {
                  header: "Residual",
                  render: (hazard) =>
                    hazard.risk_residual ? (
                      <span className={`pill risk-${hazard.risk_residual}`}>
                        {hazard.severity_residual}-{hazard.likelihood_residual}
                      </span>
                    ) : (
                      <span className="hint">—</span>
                    )
                },
                {
                  header: "Controls",
                  render: (hazard) => (
                    <span className="mono">
                      {hazard.controls_verified}/{hazard.controls_total} · {hazard.independent_controls}/{hazard.fault_tolerance_required} ind.
                    </span>
                  )
                },
                { header: "State", render: (hazard) => <StatusPill value={hazard.computed_status} /> },
                { header: "Owner", render: (hazard) => hazard.owner ?? "—" }
              ]}
            />
          </Panel>
          {showDrawer && settings && (
            <HazardDrawer
              projectId={project.id}
              hazard={creating ? null : selected}
              settings={settings}
              systems={systems}
              requirements={requirements}
              canWrite={canWrite}
              onSaved={upsert}
              onDeleted={(hazardId) => {
                setHazards((current) => current.filter((hazard) => hazard.id !== hazardId));
                setSelectedId(null);
                void api.getHazardMatrix(projectId).then(setMatrix).catch(() => undefined);
              }}
              onRequirementsChanged={onRequirementsChanged}
              onClose={() => {
                setSelectedId(null);
                setCreating(false);
              }}
            />
          )}
        </section>
      )}

      {tab === "fmea" && (
        <Panel title="FMEA worksheets">
          <p className="hint">Worksheets bound to drawing items, generated from the failure-mode library, arrive in the next phase. Until then, record failure causes as hazards and link the controlling requirements.</p>
        </Panel>
      )}
      {tab === "analyses" && (
        <Panel title="Analyses">
          <p className="hint">Trapped-volume, relief-scenario, single-point-failure, and fault-tolerance analyses derived from saved sheets arrive after the FMEA phase.</p>
        </Panel>
      )}
      {tab === "rules" && (
        <Panel title="Design rules">
          <p className="hint">Open the Drafting page to run and waive design rule checks on a sheet. A project-wide view of findings and waivers arrives with the analyses phase.</p>
        </Panel>
      )}
    </PageLayout>
  );
}

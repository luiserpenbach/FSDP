/**
 * Requirements: filters and derivation tree, the grid, the verification
 * matrix, and a detail drawer with links, evidence, and history.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ImportDialog } from "../components/requirements/ImportDialog";
import { describeConstraint } from "../components/requirements/ConstraintBuilder";
import { CATEGORIES, RequirementDrawer } from "../components/requirements/RequirementDrawer";
import { DataTable, Panel, StatusPill } from "../components/ui";
import type { ComponentInstance, Drawing, Project, Requirement, RequirementCoverage, VerificationMatrix, VerificationRow } from "../types";
import { PageLayout } from "./PageLayout";

type Tab = "requirements" | "matrix" | "coverage";
const VERIFICATION_STATUSES = ["planned", "in_progress", "verified", "failed", "waived"];

type TreeRow = { requirement: Requirement; depth: number };

function humanize(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

/** Depth-first order by derivation; orphans (parent missing) are top level. */
export function treeOrder(requirements: Requirement[]): TreeRow[] {
  const byParent = new Map<string, Requirement[]>();
  const ids = new Set(requirements.map((entry) => entry.id));
  for (const requirement of requirements) {
    const parent = requirement.parent_id && ids.has(requirement.parent_id) ? requirement.parent_id : "";
    const list = byParent.get(parent) ?? [];
    list.push(requirement);
    byParent.set(parent, list);
  }
  const rows: TreeRow[] = [];
  const visit = (parent: string, depth: number, seen: Set<string>) => {
    for (const requirement of (byParent.get(parent) ?? []).sort((a, b) => a.key.localeCompare(b.key))) {
      if (seen.has(requirement.id)) continue;
      seen.add(requirement.id);
      rows.push({ requirement, depth });
      visit(requirement.id, depth + 1, seen);
    }
  };
  visit("", 0, new Set());
  return rows;
}

export function RequirementsPage({
  project,
  requirements,
  components,
  selectedRequirementId,
  canWrite,
  onSelectRequirement,
  onRequirementsChanged
}: {
  project: Project | null;
  requirements: Requirement[];
  /** Components of the diagram open on the Diagrams page, for trace links. */
  components: ComponentInstance[];
  selectedRequirementId: string;
  canWrite: boolean;
  onSelectRequirement: (requirementId: string) => void;
  onRequirementsChanged: (requirements: Requirement[]) => void;
}) {
  const [tab, setTab] = useState<Tab>("requirements");
  const [filters, setFilters] = useState({ q: "", category: "", verification: "", safetyOnly: false });
  const [tree, setTree] = useState(true);
  const [creating, setCreating] = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [matrix, setMatrix] = useState<VerificationMatrix | null>(null);
  const [coverageReport, setCoverageReport] = useState<RequirementCoverage | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  const projectId = project?.id ?? "";

  const refresh = useCallback(async () => {
    if (!projectId) {
      setDrawings([]);
      setMatrix(null);
      setCoverageReport(null);
      return;
    }
    try {
      const [nextDrawings, nextMatrix, nextCoverage] = await Promise.all([api.listDrawings(projectId), api.getVerificationMatrix(projectId), api.getRequirementCoverage(projectId)]);
      setDrawings(nextDrawings);
      setMatrix(nextMatrix);
      setCoverageReport(nextCoverage);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load verification data.");
    }
  }, [projectId]);

  useEffect(() => {
    setCreating(false);
    void refresh();
  }, [refresh, requirements]);

  const selected = requirements.find((requirement) => requirement.id === selectedRequirementId) ?? null;

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const filtered = requirements.filter((requirement) => {
      if (filters.category && (requirement.category ?? "functional") !== filters.category) return false;
      if (filters.verification && (requirement.verification_status ?? "planned") !== filters.verification) return false;
      if (filters.safetyOnly && !requirement.safety_critical) return false;
      if (q && !requirement.key.toLowerCase().includes(q) && !requirement.title.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!tree) return filtered.slice().sort((a, b) => a.key.localeCompare(b.key)).map((requirement) => ({ requirement, depth: 0 }));
    // Keep ancestors of matches so the tree stays readable when filtering.
    const keep = new Set(filtered.map((entry) => entry.id));
    const byId = new Map(requirements.map((entry) => [entry.id, entry]));
    for (const entry of filtered) {
      let parent = entry.parent_id ? byId.get(entry.parent_id) : undefined;
      while (parent && !keep.has(parent.id)) {
        keep.add(parent.id);
        parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
      }
    }
    return treeOrder(requirements.filter((entry) => keep.has(entry.id)));
  }, [requirements, filters, tree]);

  const coverage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const requirement of requirements) {
      const status = requirement.verification_status ?? "planned";
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }, [requirements]);

  async function reloadRequirements(selectId?: string) {
    if (!projectId) return;
    const next = await api.listRequirements(projectId);
    onRequirementsChanged(next);
    if (selectId !== undefined) onSelectRequirement(selectId);
  }

  async function download(kind: "requirements" | "matrix", format: "csv" | "xlsx") {
    try {
      const { blob, filename } = kind === "requirements" ? await api.downloadRequirements(projectId, format) : await api.downloadVerificationMatrix(projectId, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export.");
    }
  }

  if (!project) {
    return (
      <PageLayout title="Requirements" description="Traceable requirements">
        <Panel title="Requirements">
          <p className="hint">Select a project on the Systems page to manage its requirements.</p>
        </Panel>
      </PageLayout>
    );
  }

  const showDrawer = creating || selected;
  const total = requirements.length || 1;

  return (
    <PageLayout title="Requirements" description={project.name}>
      <nav className="safetyTabs" aria-label="Requirement views">
        <button type="button" className={tab === "requirements" ? "active" : ""} onClick={() => setTab("requirements")}>
          Requirements
        </button>
        <button type="button" className={tab === "matrix" ? "active" : ""} onClick={() => setTab("matrix")}>
          Verification matrix
        </button>
        <button type="button" className={tab === "coverage" ? "active" : ""} onClick={() => setTab("coverage")}>
          Coverage
          {coverageReport && coverageReport.untraced_requirements.length + coverageReport.critical_without_evidence.length + coverageReport.hazards_without_controls.length + coverageReport.uncovered_hardware_controls.length > 0 ? (
            <span className="tabCount">{coverageReport.untraced_requirements.length + coverageReport.critical_without_evidence.length + coverageReport.hazards_without_controls.length + coverageReport.uncovered_hardware_controls.length}</span>
          ) : null}
        </button>
      </nav>
      {error && <p className="formError">{error}</p>}

      {tab === "requirements" && (
        <section className={`safetyLayout${showDrawer ? " withDrawer" : ""}`}>
          <Panel
            title={`Requirements · ${visible.length} of ${requirements.length}`}
            actions={
              <span className="buttonRow compact">
                <button type="button" onClick={() => void download("requirements", "xlsx")}>
                  Export XLSX
                </button>
                {canWrite && (
                  <button type="button" onClick={() => setImporting(true)}>
                    Import…
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      onSelectRequirement("");
                      setCreating(true);
                    }}
                  >
                    New requirement
                  </button>
                )}
              </span>
            }
          >
            <div className="filterRow">
              <input value={filters.q} placeholder="Search key or title" aria-label="Search requirements" onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
              <select value={filters.category} aria-label="Category" onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
                <option value="">All categories</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select value={filters.verification} aria-label="Verification status" onChange={(event) => setFilters({ ...filters, verification: event.target.value })}>
                <option value="">Any verification status</option>
                {VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {humanize(status)}
                  </option>
                ))}
              </select>
              <label className="checkRow">
                <input type="checkbox" checked={filters.safetyOnly} onChange={(event) => setFilters({ ...filters, safetyOnly: event.target.checked })} />
                <span>Safety-critical only</span>
              </label>
              <label className="checkRow">
                <input type="checkbox" checked={tree} onChange={(event) => setTree(event.target.checked)} />
                <span>Tree by derivation</span>
              </label>
            </div>
            <DataTable
              rows={visible}
              selectedKey={selectedRequirementId || undefined}
              getKey={(row) => row.requirement.id}
              onSelect={(row) => {
                setCreating(false);
                onSelectRequirement(row.requirement.id);
              }}
              columns={[
                {
                  header: "Key",
                  render: (row) => (
                    <span className="mono" style={{ paddingLeft: `${row.depth * 14}px` }}>
                      {row.depth > 0 ? "↳ " : ""}
                      {row.requirement.key}
                    </span>
                  )
                },
                {
                  header: "Title",
                  render: (row) => (
                    <span className="clamp" title={row.requirement.title}>
                      {row.requirement.title}
                    </span>
                  )
                },
                { header: "Category", render: (row) => row.requirement.category ?? row.requirement.requirement_type },
                { header: "Method", render: (row) => humanize(row.requirement.verification_method) || <span className="hint">—</span> },
                {
                  header: "Check",
                  render: (row) => (row.requirement.constraint ? <span className="mono">{describeConstraint(row.requirement.constraint)}</span> : <span className="hint">manual</span>)
                },
                { header: "Verification", render: (row) => <StatusPill value={row.requirement.verification_status ?? "planned"} /> },
                { header: "Status", render: (row) => <StatusPill value={row.requirement.status} /> },
                { header: "Safety", render: (row) => (row.requirement.safety_critical ? <span className="pill pill-bad">critical</span> : <span className="hint">—</span>) }
              ]}
            />
            <p className="hint">
              Verification: {VERIFICATION_STATUSES.map((status) => `${coverage[status] ?? 0} ${humanize(status)}`).join(" · ")}
            </p>
            <div className="coverageBar" role="img" aria-label="Verification coverage">
              {VERIFICATION_STATUSES.map((status) => (
                <span key={status} className={`coverage-${status}`} style={{ width: `${((coverage[status] ?? 0) / total) * 100}%` }} title={`${coverage[status] ?? 0} ${humanize(status)}`} />
              ))}
            </div>
          </Panel>
          {showDrawer && (
            <RequirementDrawer
              projectId={project.id}
              requirement={creating ? null : selected}
              requirements={requirements}
              drawings={drawings}
              components={components}
              canWrite={canWrite}
              onSaved={(saved) => void reloadRequirements(saved.id)}
              onDeleted={() => void reloadRequirements("")}
              onClose={() => {
                setCreating(false);
                onSelectRequirement("");
              }}
            />
          )}
        </section>
      )}

      {tab === "matrix" && (
        <Panel
          title="Verification matrix"
          actions={
            <button type="button" onClick={() => void download("matrix", "xlsx")}>
              Export XLSX
            </button>
          }
        >
          {matrix?.rows.length ? (
            <DataTable<VerificationRow>
              rows={matrix.rows}
              selectedKey={selectedRequirementId || undefined}
              getKey={(row) => row.requirement_id}
              onSelect={(row) => {
                onSelectRequirement(row.requirement_id);
                setTab("requirements");
              }}
              columns={[
                { header: "Key", render: (row) => <span className="mono">{row.key}</span> },
                { header: "Title", render: (row) => <span className="clamp" title={row.title}>{row.title}</span> },
                { header: "Method", render: (row) => humanize(row.verification_method) || <span className="hint">—</span> },
                { header: "Owner", render: (row) => row.owner ?? <span className="hint">—</span> },
                { header: "Verification", render: (row) => <StatusPill value={row.verification_status ?? "planned"} /> },
                {
                  header: "DRC verdict",
                  render: (row) => <span className={`pill ${row.verdict === "pass" ? "pill-good" : row.verdict === "fail" ? "pill-bad" : "pill-muted"}`}>{humanize(row.verdict)}</span>
                },
                { header: "Checked", render: (row) => <span className="mono">{row.constraint ? `${row.passed} pass / ${row.failed} fail` : "—"}</span> },
                {
                  header: "Evidence",
                  render: (row) => (
                    <span className="mono">
                      {Object.entries(row.evidence ?? {})
                        .map(([kind, count]) => `${count} ${kind}`)
                        .join(", ") || "—"}
                    </span>
                  )
                },
                { header: "Hazards", render: (row) => <span className="mono">{row.hazards?.join(", ") || "—"}</span> },
                { header: "Drawings", render: (row) => (row.drawings.length ? row.drawings.map((entry) => `${entry.drawing_number} (sheets ${entry.sheets.join(", ")})`).join("; ") : "—") },
                { header: "Failures", render: (row) => (row.failures.length ? <span className="mono">{row.failures.map((failure) => `${failure.subject ?? failure.item_id}${failure.zone ? ` @ ${failure.zone}` : ""}`).join(", ")}</span> : "—") }
              ]}
            />
          ) : (
            <p className="hint">Requirements with a constraint are checked against every saved drawing sheet; open a drawing on the Drafting page and save it to populate the matrix.</p>
          )}
        </Panel>
      )}
      {tab === "coverage" && (
        <section className="grid">
          <CoverageList title="Requirements with no trace to hardware" hint="Link each requirement to a drawing, item, line, or component." rows={coverageReport?.untraced_requirements ?? []} onOpen={(id) => { onSelectRequirement(id); setTab("requirements"); }} />
          <CoverageList title="Safety-critical requirements without evidence" hint="Record test, analysis, inspection, or document evidence, or add a design rule." rows={coverageReport?.critical_without_evidence ?? []} onOpen={(id) => { onSelectRequirement(id); setTab("requirements"); }} />
          <CoverageList title="Hazards without controls" hint="Add a requirement or a hardware item as a control on the Safety page." rows={coverageReport?.hazards_without_controls ?? []} />
          <Panel title="Hardware controls with no requirement">
            {coverageReport?.uncovered_hardware_controls.length ? (
              <ul className="attentionList">
                {coverageReport.uncovered_hardware_controls.map((entry) => (
                  <li key={entry.link_id}>
                    <span>
                      <span className="mono">{entry.tag}</span> controls <span className="mono">{entry.hazard_key}</span>
                    </span>
                    <span className="hint">No requirement applies to this item: add a constraint that covers it or link a requirement to it.</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Every hardware control is covered by a requirement.</p>
            )}
          </Panel>
        </section>
      )}
      {importing && (
        <ImportDialog
          projectId={project.id}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            void reloadRequirements();
          }}
        />
      )}
    </PageLayout>
  );
}

function CoverageList({ title, hint, rows, onOpen }: { title: string; hint: string; rows: Array<{ id: string; key: string; title: string }>; onOpen?: (id: string) => void }) {
  return (
    <Panel title={`${title} · ${rows.length}`}>
      {rows.length === 0 ? (
        <p className="hint">Nothing outstanding.</p>
      ) : (
        <>
          <p className="hint">{hint}</p>
          <ul className="attentionList">
            {rows.map((row) => (
              <li key={row.id}>
                {onOpen ? (
                  <button type="button" className="linkButton" onClick={() => onOpen(row.id)}>
                    <span className="mono">{row.key}</span> {row.title}
                  </button>
                ) : (
                  <span>
                    <span className="mono">{row.key}</span> {row.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

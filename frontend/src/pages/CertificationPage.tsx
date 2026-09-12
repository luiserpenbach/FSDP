/**
 * Certification page: the evidence a project can show today (released
 * worksheets, accepted hazards, verified safety requirements, analyses,
 * review packages) and the gaps that keep it from a complete set.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { FormError, Panel, StatusPill, SummaryCard } from "../components/ui";
import type { CertificationEvidence, CertificationGap, Project } from "../types";
import { PageLayout } from "./PageLayout";

const GAP_LABELS: Record<string, string> = {
  hazard_not_accepted: "Hazard not accepted",
  requirement_not_verified: "Requirement not verified",
  worksheet_not_released: "Worksheet not released",
  worksheet_behind_drawing: "Worksheet behind drawing",
  analysis_outdated: "Analysis outdated",
  analysis_failed: "Analysis failed",
  drc_error: "Design rule error",
  no_package: "No review package"
};

function gapLink(gap: CertificationGap): string {
  switch (gap.ref_type) {
    case "hazard":
      return "/safety";
    case "requirement":
      return "/requirements";
    case "fmea_worksheet":
      return "/safety";
    case "analysis":
      return "/safety";
    case "sheet":
      return "/safety";
    default:
      return "/reviews";
  }
}

export function CertificationPage({ project }: { project: Project | null }) {
  const [evidence, setEvidence] = useState<CertificationEvidence | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEvidence(null);
    setError("");
    if (!project) return;
    void api
      .getCertificationEvidence(project.id)
      .then(setEvidence)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the evidence."));
  }, [project]);

  if (!project) {
    return (
      <PageLayout title="Certification" description="Evidence packages">
        <p className="hint">Select a project to see its certification evidence.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Certification" description={`Evidence and gaps · ${project.name}`}>
      <FormError message={error} />
      {!evidence && !error && <p className="hint">Loading…</p>}
      {evidence && (
        <>
          <section className="summaryGrid">
            <SummaryCard title="Evidence status" value={evidence.counts.gaps} detail={evidence.ready ? "no gaps: the evidence set is complete" : "gap(s) before the evidence set is complete"} />
            <SummaryCard title="Hazards accepted" value={evidence.counts.hazards_accepted} detail={`of ${evidence.counts.hazards} in the log`} />
            <SummaryCard title="Safety requirements verified" value={evidence.counts.requirements_verified} detail={`of ${evidence.counts.requirements_safety} safety-critical`} />
            <SummaryCard title="Worksheets released" value={evidence.counts.worksheets_released} detail={`of ${evidence.counts.worksheets} FMEA worksheets`} />
            <SummaryCard title="Review packages" value={evidence.counts.packages} detail={`${evidence.counts.analyses} analyses on file`} />
          </section>
          <section className="grid">
            <Panel title={evidence.ready ? "Gaps · none" : `Gaps · ${evidence.gaps.length}`}>
              {evidence.gaps.length === 0 ? (
                <p className="hint">Every severity I–II hazard is accepted, every safety-critical requirement is verified or waived, every worksheet is released against the current drawing revision, and a review package exists.</p>
              ) : (
                <ul className="gapList">
                  {evidence.gaps.map((gap) => (
                    <li key={`${gap.kind}:${gap.ref_id}`}>
                      <span className="pill pill-warn">{GAP_LABELS[gap.kind] ?? gap.kind.replaceAll("_", " ")}</span>
                      <span>
                        {gap.key ? <span className="mono">{gap.key} </span> : null}
                        {gap.title}
                        <span className="hint"> · {gap.detail}</span>
                      </span>
                      <Link to={gapLink(gap)} className="linkButton">
                        Open
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Accepted hazards">
              {evidence.accepted_hazards.length === 0 ? (
                <p className="hint">No accepted or closed hazards yet.</p>
              ) : (
                <ul className="controlList">
                  {evidence.accepted_hazards.map((hazard) => (
                    <li key={hazard.id}>
                      <span className="mono">{hazard.key}</span>
                      <span className="controlTitle">
                        {hazard.title}
                        <span className="hint"> · {hazard.accepted_by ?? "—"}{hazard.accepted_at ? `, ${new Date(hazard.accepted_at).toLocaleDateString()}` : ""}</span>
                      </span>
                      <StatusPill value={hazard.status} />
                      <span />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Verified safety requirements">
              {evidence.verified_requirements.length === 0 ? (
                <p className="hint">No safety-critical requirement is verified yet.</p>
              ) : (
                <ul className="controlList">
                  {evidence.verified_requirements.map((requirement) => (
                    <li key={requirement.id}>
                      <span className="mono">{requirement.key}</span>
                      <span className="controlTitle">
                        {requirement.title}
                        <span className="hint"> · {requirement.verification_method ?? "method not set"}</span>
                      </span>
                      <StatusPill value={requirement.verification_status} />
                      <span />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Released FMEA worksheets">
              {evidence.released_worksheets.length === 0 ? (
                <p className="hint">No worksheet has been released yet.</p>
              ) : (
                <ul className="controlList">
                  {evidence.released_worksheets.map((worksheet) => (
                    <li key={worksheet.id}>
                      <span className="mono">rev {worksheet.revision}</span>
                      <span className="controlTitle">
                        {worksheet.title}
                        <span className="hint">
                          {" "}
                          · {worksheet.drawing_number ?? "no drawing"} rev {worksheet.drawing_revision ?? "—"}
                          {worksheet.behind_drawing ? ` (drawing now at rev ${worksheet.current_drawing_revision})` : ""} · {worksheet.released_by ?? "—"}
                        </span>
                      </span>
                      <span className={worksheet.behind_drawing ? "pill pill-warn" : "pill pill-good"}>{worksheet.behind_drawing ? "behind drawing" : "current"}</span>
                      <span />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Analyses">
              {evidence.analyses.length === 0 ? (
                <p className="hint">No analyses on file.</p>
              ) : (
                <ul className="controlList">
                  {evidence.analyses.map((analysis) => (
                    <li key={analysis.id}>
                      <span className="mono">{analysis.kind.replaceAll("_", " ")}</span>
                      <span className="controlTitle">
                        {analysis.title}
                        <span className="hint">
                          {" "}
                          · {analysis.drawing_number ?? "project"}
                          {analysis.evidence_for.length ? ` · evidence for ${analysis.evidence_for.length} requirement(s)` : ""}
                        </span>
                      </span>
                      <StatusPill value={analysis.outdated ? "outdated" : (analysis.verdict ?? "not run")} />
                      <span />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Review packages">
              {evidence.packages.length === 0 ? (
                <p className="hint">
                  No package yet. Generate one on the <Link to="/reviews">Reviews page</Link>.
                </p>
              ) : (
                <ul className="controlList">
                  {evidence.packages.map((pkg) => (
                    <li key={pkg.id}>
                      <span className="mono">{pkg.generated_at ? new Date(pkg.generated_at).toLocaleDateString() : "—"}</span>
                      <span className="controlTitle">
                        {pkg.title}
                        <span className="hint"> · {pkg.generated_by ?? "—"}</span>
                      </span>
                      <Link to="/reviews" className="linkButton">
                        Download
                      </Link>
                      <span />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </section>
        </>
      )}
    </PageLayout>
  );
}

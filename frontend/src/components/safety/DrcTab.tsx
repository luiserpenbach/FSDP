/**
 * Design rules tab: every open and waived DRC finding across the project's
 * drawings, grouped by rule, with the hazard a relief finding created.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import type { ProjectDrc, ProjectDrcFinding } from "../../types";
import { FormError, Panel } from "../ui";

const SEVERITY_PILL: Record<string, string> = { error: "pill pill-bad", warning: "pill pill-warn", info: "pill pill-info" };

export function DrcTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [drc, setDrc] = useState<ProjectDrc | null>(null);
  const [error, setError] = useState("");
  const [showWaived, setShowWaived] = useState(false);
  const [rule, setRule] = useState("");

  useEffect(() => {
    void api
      .getProjectDrc(projectId)
      .then(setDrc)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the findings."));
  }, [projectId]);

  const groups = useMemo(() => {
    const byRule = new Map<string, ProjectDrcFinding[]>();
    for (const finding of drc?.findings ?? []) {
      if (!showWaived && finding.waived) continue;
      if (rule && finding.rule !== rule) continue;
      const list = byRule.get(finding.rule) ?? [];
      list.push(finding);
      byRule.set(finding.rule, list);
    }
    return [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [drc, showWaived, rule]);

  const rules = useMemo(() => [...new Set((drc?.findings ?? []).map((finding) => finding.rule))].sort(), [drc]);

  return (
    <Panel
      title="Design rule findings across drawings"
      actions={
        drc ? (
          <span className="hint">
            <span className={drc.counts.error ? "pill pill-bad" : "pill pill-good"}>{drc.counts.error} error(s)</span> <span className={drc.counts.warning ? "pill pill-warn" : "pill pill-muted"}>{drc.counts.warning} warning(s)</span>{" "}
            <span className="pill pill-muted">{drc.counts.waived} waived</span>
          </span>
        ) : undefined
      }
    >
      <FormError message={error} />
      <div className="filterRow">
        <select value={rule} aria-label="Rule" onChange={(event) => setRule(event.target.value)}>
          <option value="">All rules</option>
          {rules.map((entry) => (
            <option key={entry} value={entry}>
              {entry.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <label className="checkRow">
          <input type="checkbox" checked={showWaived} onChange={(event) => setShowWaived(event.target.checked)} />
          <span>Show waived</span>
        </label>
      </div>
      {groups.length === 0 && <p className="hint">No open findings. Save a sheet on the Drafting page to run the design rules.</p>}
      {groups.map(([ruleName, findings]) => (
        <details key={ruleName} open className="gateList">
          <summary>
            {ruleName.replaceAll("_", " ")} · {findings.length}
          </summary>
          <ul className="drcList">
            {findings.map((finding) => (
              <li key={`${finding.sheet_id}:${finding.key}`} className={`drcFinding drc-${finding.waived ? "waived" : finding.severity}`}>
                <span className={finding.waived ? "pill pill-muted" : SEVERITY_PILL[finding.severity] ?? "pill"}>{finding.waived ? "waived" : finding.severity}</span>
                <span className="drcMessage">
                  <span className="mono">
                    {finding.drawing_number} sh {finding.sheet_no}
                    {finding.zone ? ` ${finding.zone}` : ""}
                  </span>{" "}
                  {finding.message}
                  {finding.waived && finding.waiver_reason ? <em> — {finding.waiver_reason}</em> : null}
                  {finding.hazard_key ? <span className="mono ref"> · {finding.hazard_key}</span> : null}
                </span>
                <span className="drcActions">
                  {finding.item_id && (
                    <button type="button" className="linkButton" onClick={() => navigate(`/drafting?drawing=${finding.drawing_id}&sheet=${finding.sheet_id}&item=${encodeURIComponent(finding.item_id ?? "")}`)}>
                      Go
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </Panel>
  );
}

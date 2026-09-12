/**
 * Design rule check panel: live findings grouped by severity with jump-to-zone,
 * waive-with-reason (stored per sheet by finding key), and the waived list.
 */
import { useMemo, useState } from "react";
import { DRC_RULES, runDrc, type DrcResult, type DrcWaiver, type RequirementRef } from "../../engine/drc";
import type { Editor } from "../../engine/editor";
import type { SymbolRegistry } from "../../engine/library";
import type { PartLike } from "../../engine/parts";
import type { TagScheme } from "../../engine/tags";
import { useEditorSnapshot } from "./SchematicCanvas";

export type DrcInputs = {
  registry: SymbolRegistry;
  tagScheme: TagScheme;
  parts: Map<string, PartLike>;
  requirements: RequirementRef[];
  waivers: DrcWaiver[];
};

/** Live DRC over the editor's document; recomputed when the document or inputs change. */
export function useDrc(editor: Editor, inputs: DrcInputs): DrcResult {
  const { doc, connectivity } = useEditorSnapshot(editor);
  return useMemo(
    () => runDrc({ doc, registry: inputs.registry, connectivity, tagScheme: inputs.tagScheme, parts: inputs.parts, requirements: inputs.requirements, waivers: inputs.waivers }),
    [doc, connectivity, inputs.registry, inputs.tagScheme, inputs.parts, inputs.requirements, inputs.waivers]
  );
}

const SEVERITY_PILL = { error: "pill pill-bad", warning: "pill pill-warn", info: "pill pill-info" } as const;

export function DrcPanel({
  editor,
  inputs,
  canWrite,
  onLocate,
  onWaive,
  onUnwaive,
  onRun,
  onCreateHazard,
  hazardsByLine
}: {
  editor: Editor;
  inputs: DrcInputs;
  canWrite: boolean;
  onLocate: (itemId: string) => void;
  onWaive: (key: string, reason: string) => void;
  onUnwaive: (key: string) => void;
  onRun: (result: DrcResult) => void;
  /** Create a hazard from a relief-coverage finding (safety phase C). */
  onCreateHazard?: (finding: { key: string; itemId: string | null; message: string }) => void;
  /** Hazard keys already scoped to a volume, by the volume's first line id. */
  hazardsByLine?: Record<string, string[]>;
}) {
  const result = useDrc(editor, inputs);
  const [showInfo, setShowInfo] = useState(false);
  const [showWaived, setShowWaived] = useState(false);
  const visible = result.findings.filter((finding) => showInfo || finding.severity !== "info");
  const waive = (key: string, message: string) => {
    const reason = window.prompt(`Reason for waiving:\n${message}`);
    if (reason && reason.trim()) onWaive(key, reason.trim());
  };
  return (
    <article className="panel drcPanel" aria-label="Design rule check">
      <div className="panelHead">
        <h2>Design rule check</h2>
        <button type="button" className="linkButton" onClick={() => onRun(result)} title="Re-run the checks and report the counts">
          Run
        </button>
      </div>
      <p className="drcCounts">
        <span className={result.counts.error ? "pill pill-bad" : "pill pill-good"}>{result.counts.error} error(s)</span>{" "}
        <span className={result.counts.warning ? "pill pill-warn" : "pill pill-muted"}>{result.counts.warning} warning(s)</span>{" "}
        <button type="button" className={showInfo ? "pill pill-info" : "pill pill-muted"} onClick={() => setShowInfo((current) => !current)} title="Show or hide informational findings">
          {result.counts.info} info
        </button>{" "}
        <button type="button" className="pill pill-muted" onClick={() => setShowWaived((current) => !current)} title="Show or hide waived findings">
          {result.counts.waived} waived
        </button>
      </p>
      {visible.length === 0 && <p className="hint">No open findings. Rules: connectivity, tags, line data, port sizes, spec continuity, part status and rating, relief coverage, requirement constraints.</p>}
      <ul className="drcList">
        {visible.map((finding) => (
          <li key={finding.key} className={`drcFinding drc-${finding.severity}`}>
            <span className={SEVERITY_PILL[finding.severity]} title={DRC_RULES[finding.rule]?.description ?? finding.rule}>
              {DRC_RULES[finding.rule]?.title ?? finding.rule}
            </span>
            <span className="drcMessage">{finding.message}</span>
            <span className="drcActions">
              {finding.zone && <span className="mono">{finding.zone}</span>}
              {finding.itemId && (
                <button type="button" className="linkButton" onClick={() => onLocate(finding.itemId!)}>
                  Go
                </button>
              )}
              {finding.rule === "relief_coverage" && finding.itemId && (hazardsByLine?.[finding.itemId]?.length ? (
                <span className="mono ref">{hazardsByLine[finding.itemId].join(", ")}</span>
              ) : onCreateHazard ? (
                <button type="button" className="linkButton" disabled={!canWrite} onClick={() => onCreateHazard({ key: finding.key, itemId: finding.itemId, message: finding.message })}>
                  Create hazard
                </button>
              ) : null)}
              <button type="button" className="linkButton" disabled={!canWrite} onClick={() => waive(finding.key, finding.message)}>
                Waive…
              </button>
            </span>
          </li>
        ))}
      </ul>
      {showWaived && result.waived.length > 0 && (
        <ul className="drcList drcWaived">
          {result.waived.map((finding) => (
            <li key={finding.key} className="drcFinding drc-waived">
              <span className="pill pill-muted">waived</span>
              <span className="drcMessage">
                {finding.message} — <em>{finding.waiver.reason}</em>
                {finding.waiver.by ? ` (${finding.waiver.by})` : ""}
              </span>
              <span className="drcActions">
                {finding.itemId && (
                  <button type="button" className="linkButton" onClick={() => onLocate(finding.itemId!)}>
                    Go
                  </button>
                )}
                <button type="button" className="linkButton" disabled={!canWrite} onClick={() => onUnwaive(finding.key)}>
                  Unwaive
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

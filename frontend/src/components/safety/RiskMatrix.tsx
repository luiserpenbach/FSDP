/**
 * Severity × likelihood heat map from the project's risk matrix. Cells show
 * hazard counts; clicking one filters the hazard log.
 */
import type { HazardMatrix } from "../../types";

export type MatrixMode = "initial" | "residual";
export type MatrixCell = { severity: string; likelihood: string };

export function RiskMatrix({
  matrix,
  mode,
  selected,
  onSelect
}: {
  matrix: HazardMatrix;
  mode: MatrixMode;
  selected: MatrixCell | null;
  onSelect?: (cell: MatrixCell | null) => void;
}) {
  const counts = matrix[mode];
  return (
    <div className="riskMatrix" role="grid" aria-label={`${mode} risk matrix`} style={{ gridTemplateColumns: `36px repeat(${matrix.likelihood_scale.length}, 1fr)` }}>
      <span className="riskCorner" />
      {matrix.likelihood_scale.map((likelihood) => (
        <span key={likelihood.code} className="riskHead" title={`${likelihood.name}${likelihood.description ? `: ${likelihood.description}` : ""}`}>
          {likelihood.code}
        </span>
      ))}
      {matrix.severity_scale.map((severity) => (
        <RowCells key={severity.code} severity={severity} matrix={matrix} counts={counts[severity.code] ?? {}} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function RowCells({
  severity,
  matrix,
  counts,
  selected,
  onSelect
}: {
  severity: HazardMatrix["severity_scale"][number];
  matrix: HazardMatrix;
  counts: Record<string, number>;
  selected: MatrixCell | null;
  onSelect?: (cell: MatrixCell | null) => void;
}) {
  return (
    <>
      <span className="riskRowLabel" title={`${severity.name}${severity.description ? `: ${severity.description}` : ""}`}>
        {severity.code}
      </span>
      {matrix.likelihood_scale.map((likelihood) => {
        const riskClass = matrix.risk_matrix[severity.code]?.[likelihood.code] ?? "low";
        const count = counts[likelihood.code] ?? 0;
        const isSelected = selected?.severity === severity.code && selected?.likelihood === likelihood.code;
        return (
          <button
            key={likelihood.code}
            type="button"
            role="gridcell"
            className={`riskCell risk-${riskClass}${isSelected ? " selected" : ""}${count ? "" : " empty"}`}
            aria-label={`${severity.code}-${likelihood.code}: ${count} hazard${count === 1 ? "" : "s"}, ${riskClass}`}
            onClick={() => onSelect?.(isSelected ? null : { severity: severity.code, likelihood: likelihood.code })}
          >
            {count}
          </button>
        );
      })}
    </>
  );
}

/**
 * DRC findings page: a synthetic sheet in the drawing's frame listing the
 * open and waived findings, appended to a PDF export on request.
 */
import type { DrcFinding, DrcWaiver } from "./drc";
import type { DrawingContext } from "./frames";
import { wrapText } from "./frames";
import type { SymbolRegistry } from "./library";
import { renderDocumentSvg } from "./render";
import { frameRect } from "./sheet";
import type { LabelItem, SchematicDocument } from "./types";

const ROW_MM = 4.2;
const TEXT_MM = 2.5;

export function findingsDocument(base: SchematicDocument, findings: DrcFinding[], waived: Array<DrcFinding & { waiver: DrcWaiver }>): SchematicDocument {
  const rect = frameRect(base.sheet);
  const left = rect.x + 8;
  const columns = { severity: left, rule: left + 18, subject: left + 52, zone: left + 92, message: left + 104 };
  const messageWidth = rect.width - (columns.message - rect.x) - 12;
  const items: LabelItem[] = [];
  let y = rect.y + 10;
  let counter = 0;
  const label = (x: number, text: string, extra: Partial<LabelItem> = {}) => {
    items.push({ id: `drc-${counter++}`, kind: "label", layer: "annotation", position: { x, y }, text, fontSize: TEXT_MM, rotation: 0, anchor: "start", ...extra });
  };
  label(left, `DESIGN RULE CHECK — ${findings.length} open finding(s), ${waived.length} waived`, { fontSize: 3.5 });
  y += 7;
  const header = () => {
    label(columns.severity, "SEVERITY");
    label(columns.rule, "RULE");
    label(columns.subject, "ITEM");
    label(columns.zone, "ZONE");
    label(columns.message, "FINDING");
    y += ROW_MM;
  };
  header();
  const rows: Array<{ finding: DrcFinding; waiver?: DrcWaiver }> = [...findings.map((finding) => ({ finding })), ...waived.map((finding) => ({ finding, waiver: finding.waiver }))];
  const bottom = rect.y + rect.height - 60;
  for (const { finding, waiver } of rows) {
    const text = waiver ? `${finding.message} — WAIVED: ${waiver.reason}` : finding.message;
    const lines = wrapText(text, messageWidth, TEXT_MM);
    if (y + lines.length * ROW_MM > bottom) {
      label(left, "… continued in the DRC panel");
      break;
    }
    label(columns.severity, waiver ? "waived" : finding.severity.toUpperCase());
    label(columns.rule, finding.rule);
    label(columns.subject, finding.subject ?? "—");
    label(columns.zone, finding.zone ?? "—");
    for (const line of lines) {
      label(columns.message, line);
      y += ROW_MM;
    }
  }
  return { ...base, items, meta: { ...base.meta, title: "DRC" } };
}

export function renderFindingsSheet(base: SchematicDocument, registry: SymbolRegistry, context: DrawingContext | undefined, findings: DrcFinding[], waived: Array<DrcFinding & { waiver: DrcWaiver }>): string {
  const doc = findingsDocument(base, findings, waived);
  const pageContext: DrawingContext | undefined = context ? { ...context, sheetTitle: "DESIGN RULE CHECK FINDINGS", legends: undefined, notes: [] } : undefined;
  return renderDocumentSvg(doc, registry, { standalone: true, background: "#ffffff", context: pageContext });
}

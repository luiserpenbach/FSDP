/**
 * Frame templates: border, zone strip, title block, revision table, general
 * notes, and proprietary notice, laid out in mm from the sheet border.
 *
 * A template is data: cells with a label and a binding into `DrawingContext`.
 * The renderer draws whatever template the sheet names; the drawing/revision
 * rows supply the values, so the same sheet prints differently as the
 * drawing is revised without touching the document.
 */
import { frameRect } from "./sheet";
import type { Rect, Sheet } from "./types";

export type FrameTemplateId = "none" | "basic" | "fsdp-standard";

export const FRAME_TEMPLATE_LABELS: Record<FrameTemplateId, string> = {
  none: "No frame",
  basic: "Border and zones",
  "fsdp-standard": "Border, zones, title block, revisions, notes"
};

export type RevisionRow = {
  label: string;
  description: string;
  date?: string | null;
  by?: string | null;
  approvedBy?: string | null;
  status?: string;
};

export type DrawingContext = {
  number: string;
  /** Up to three lines separated by newlines. */
  title: string;
  projectName?: string;
  systemName?: string;
  company?: string;
  discipline?: string;
  units?: string;
  scale?: string;
  status?: string;
  sizeLabel?: string;
  sheetNo: number;
  sheetCount: number;
  sheetTitle?: string | null;
  revisions: RevisionRow[];
  notes: string[];
  proprietaryNotice?: string;
  /** ISO date printed in the DATE cell. */
  exportDate?: string;
  fields?: Record<string, string>;
};

export type TitleCell = {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: (ctx: DrawingContext) => string;
  /** Text height in mm for the value. */
  size?: number;
  bold?: boolean;
  align?: "start" | "middle";
  multiline?: boolean;
};

export type FrameTemplate = {
  id: FrameTemplateId;
  titleBlock?: { width: number; height: number; cells: TitleCell[] };
  revisionTable?: {
    width: number;
    rowHeight: number;
    columns: Array<{ label: string; w: number; value: (row: RevisionRow) => string; align?: "start" | "middle" }>;
  };
  notesBlock?: { x: number; y: number; width: number; lineHeight: number; maxLines: number };
  proprietary?: { width: number; lineHeight: number };
};

const currentRevision = (ctx: DrawingContext): RevisionRow | undefined => ctx.revisions[ctx.revisions.length - 1];

function joinNonEmpty(...parts: Array<string | null | undefined>): string {
  return parts.filter((part) => part && String(part).trim()).join("  ");
}

const STANDARD_CELLS: TitleCell[] = [
  { x: 0, y: 0, w: 110, h: 8, label: "COMPANY", value: (ctx) => ctx.company ?? ctx.projectName ?? "", size: 3.2, bold: true },
  { x: 110, y: 0, w: 70, h: 8, label: "DRAWING / DESIGN STATUS", value: (ctx) => (ctx.status ?? "working").toUpperCase(), size: 3 },
  { x: 0, y: 8, w: 180, h: 14, label: "TITLE", value: (ctx) => ctx.title, size: 3.6, bold: true, multiline: true },
  { x: 0, y: 22, w: 18, h: 8, label: "SIZE", value: (ctx) => ctx.sizeLabel ?? "", size: 3 },
  { x: 18, y: 22, w: 22, h: 8, label: "UNITS", value: (ctx) => (ctx.units ?? "mm").toUpperCase(), size: 3 },
  { x: 40, y: 22, w: 30, h: 8, label: "SCALE", value: (ctx) => ctx.scale ?? "NO SCALE", size: 3 },
  { x: 70, y: 22, w: 80, h: 8, label: "DRAWING NO.", value: (ctx) => ctx.number, size: 4.5, bold: true },
  { x: 150, y: 22, w: 30, h: 8, label: "REV", value: (ctx) => currentRevision(ctx)?.label ?? "-", size: 4.5, bold: true },
  { x: 0, y: 30, w: 45, h: 7.5, label: "DRAWN", value: (ctx) => joinNonEmpty(currentRevision(ctx)?.by, currentRevision(ctx)?.date), size: 2.5 },
  { x: 45, y: 30, w: 45, h: 7.5, label: "CHECKED", value: (ctx) => ctx.fields?.checked_by ?? "", size: 2.5 },
  { x: 90, y: 30, w: 45, h: 7.5, label: "APPROVED", value: (ctx) => currentRevision(ctx)?.approvedBy ?? "", size: 2.5 },
  { x: 135, y: 30, w: 45, h: 7.5, label: "SHEET", value: (ctx) => `${ctx.sheetNo} OF ${ctx.sheetCount}`, size: 3, bold: true },
  { x: 0, y: 37.5, w: 60, h: 7.5, label: "PROJECT", value: (ctx) => ctx.projectName ?? "", size: 2.5 },
  { x: 60, y: 37.5, w: 60, h: 7.5, label: "SYSTEM", value: (ctx) => ctx.systemName ?? ctx.sheetTitle ?? "", size: 2.5 },
  { x: 120, y: 37.5, w: 30, h: 7.5, label: "DATE", value: (ctx) => ctx.exportDate ?? "", size: 2.5 },
  { x: 150, y: 37.5, w: 30, h: 7.5, label: "SOFTWARE", value: () => "FSDP", size: 2.5 }
];

export const FRAME_TEMPLATES: Record<FrameTemplateId, FrameTemplate> = {
  none: { id: "none" },
  basic: { id: "basic" },
  "fsdp-standard": {
    id: "fsdp-standard",
    titleBlock: { width: 180, height: 45, cells: STANDARD_CELLS },
    revisionTable: {
      width: 180,
      rowHeight: 5,
      columns: [
        { label: "REV", w: 15, value: (row) => row.label, align: "middle" },
        { label: "DESCRIPTION", w: 105, value: (row) => row.description },
        { label: "DATE", w: 30, value: (row) => row.date ?? "", align: "middle" },
        { label: "APP", w: 30, value: (row) => row.approvedBy ?? row.by ?? "", align: "middle" }
      ]
    },
    notesBlock: { x: 5, y: 5, width: 120, lineHeight: 4, maxLines: 20 },
    proprietary: { width: 150, lineHeight: 3 }
  }
};

export function resolveTemplate(sheet: Sheet): FrameTemplate {
  const id = sheet.frame.template ?? (sheet.frame.kind === "none" ? "none" : "basic");
  return FRAME_TEMPLATES[id] ?? FRAME_TEMPLATES.basic;
}

/** Title block rectangle in sheet coordinates (bottom-right inside the border). */
export function titleBlockRect(sheet: Sheet): Rect | null {
  const template = resolveTemplate(sheet);
  if (!template.titleBlock) return null;
  const border = frameRect(sheet);
  const { width, height } = template.titleBlock;
  return { x: border.x + border.width - width, y: border.y + border.height - height, width, height };
}

/** Greedy word wrap on an average glyph advance of 0.55 em. */
export function wrapText(text: string, widthMm: number, sizeMm: number): string[] {
  const maxChars = Math.max(8, Math.floor(widthMm / (sizeMm * 0.55)));
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

export const DEFAULT_PROPRIETARY_NOTICE =
  "PROPRIETARY. THIS DOCUMENT CONTAINS PROPRIETARY INFORMATION WHICH IS THE PROPERTY OF {company}. DO NOT DISTRIBUTE WITHOUT WRITTEN AUTHORIZATION.";

export function proprietaryText(ctx: DrawingContext): string {
  const template = ctx.proprietaryNotice ?? DEFAULT_PROPRIETARY_NOTICE;
  return template.replace("{company}", ctx.company ?? ctx.projectName ?? "THE OWNER");
}

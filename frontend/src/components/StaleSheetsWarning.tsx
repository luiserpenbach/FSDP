import type { ReactNode } from "react";
import type { StaleSheet } from "../types";

/** Warning for list, BoM, and matrix responses built from out-of-date sheet indexes. */
export function StaleSheetsWarning({
  sheets,
  children
}: {
  sheets: Array<Pick<StaleSheet, "sheet_no"> & Partial<Pick<StaleSheet, "drawing_number">>>;
  children?: ReactNode;
}) {
  if (!sheets.length) return null;
  const names = sheets.map((sheet) => (sheet.drawing_number ? `${sheet.drawing_number} sheet ${sheet.sheet_no}` : `sheet ${sheet.sheet_no}`));
  return (
    <p className="staleWarning" role="note">
      <span className="pill pill-warn">stale index</span> {names.join(", ")}: index and design rule checks are out of date. {children}
    </p>
  );
}

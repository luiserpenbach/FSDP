import type { ReactNode } from "react";

export type DataGridColumnType = "text" | "number" | "enum" | "boolean" | "date";

export type DataGridOption = string | { value: string; label: string };

export interface DataGridColumn<T> {
  /** Stable id; also the default property read from the row (`row[key]`). */
  key: string;
  header: string;
  /** Initial width in px (user resizes are persisted under `storageKey`). */
  width?: number;
  minWidth?: number;
  /** Drives the default parser, formatter, editor, filter and alignment. Default "text". */
  type?: DataGridColumnType;
  /** Allowed values for `type: "enum"` (value or {value,label}). */
  options?: ReadonlyArray<DataGridOption>;
  /** Cells are editable only when the grid has `onCommit` and this is true / returns true. */
  editable?: boolean | ((row: T) => boolean);
  /** Custom cell content. Receives the row with any optimistic edit applied. */
  render?: (row: T, value: unknown) => ReactNode;
  /** Read the cell value (default `row[key]`). */
  getValue?: (row: T) => unknown;
  /** Produce a row with the value applied, used for optimistic display (default `{...row, [key]: value}`). */
  setValue?: (row: T, value: unknown) => T;
  /** Text (typed or pasted) -> value. Throw an Error to reject with its message. */
  parse?: (text: string, row: T) => unknown;
  /** Value -> text used for copy, CSV, quick filter and default display. */
  format?: (value: unknown, row: T) => string;
  /** Value used for sorting (default: the value; enum columns sort by label). */
  sortValue?: (row: T) => unknown;
  /** Return an error message to block the edit, or null/undefined when valid. */
  validate?: (value: unknown, row: T) => string | null | undefined;
  align?: "left" | "center" | "right";
  /** Pin to the left while scrolling horizontally (frozen columns are moved first). */
  frozen?: boolean;
  /** Hidden until the user shows it in the column chooser. */
  hidden?: boolean;
  /** Set false to keep the column out of the column chooser (always visible). */
  hideable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  /** Render in JetBrains Mono (tags, part numbers, identifiers). */
  mono?: boolean;
}

export interface DataGridEdit {
  rowId: string;
  key: string;
  value: unknown;
}

/** Per-cell server errors: `{ [rowId]: { [columnKey]: message } }`. */
export type DataGridCellErrors = Record<string, Record<string, string>>;

export type DataGridCommitResult = void | undefined | { errors?: DataGridCellErrors };

export interface DataGridSort {
  key: string;
  dir: "asc" | "desc";
}

export type DataGridFilter = { kind: "text"; text: string } | { kind: "set"; values: string[] };

export interface DataGridProps<T> {
  rows: ReadonlyArray<T>;
  /** Memoize this array (useMemo / module constant): sort and filter re-run when it changes. */
  columns: ReadonlyArray<DataGridColumn<T>>;
  getRowId: (row: T) => string;
  /** Persist edits. Omit for a read-only grid. Reject (throw) to roll back every edit in the batch. */
  onCommit?: (edits: DataGridEdit[]) => Promise<DataGridCommitResult>;
  /** Pasted rows that fall below the last row, keyed by column key (raw text). */
  onPasteNewRows?: (rows: Array<Record<string, string>>) => void;
  /** Controlled row selection. Omit for uncontrolled. */
  selectedIds?: ReadonlyArray<string>;
  defaultSelectedIds?: ReadonlyArray<string>;
  onSelectionChange?: (ids: string[]) => void;
  /** Show the checkbox column (default true). */
  selectable?: boolean;
  /** Rendered in the bulk toolbar when at least one row is selected. */
  bulkActions?: ReactNode | ((selectedRows: T[], clearSelection: () => void) => ReactNode);
  /** Double-click or Enter on a non-editable cell. */
  onRowActivate?: (row: T) => void;
  defaultSort?: ReadonlyArray<DataGridSort>;
  /** localStorage key suffix for column visibility and widths. Keep it stable. */
  storageKey?: string;
  /** CSV file name without extension (default "export"). */
  exportFileName?: string;
  /** Renders an "Export XLSX" button; receives the visible rows (filtered, sorted) and columns. */
  onExportXlsx?: (rows: T[], columns: DataGridColumn<T>[]) => void;
  /** Extra toolbar content (e.g. "Add row", "Import"). */
  toolbar?: ReactNode;
  loading?: boolean;
  emptyMessage?: ReactNode;
  /** Max height of the scroll viewport (default 480). */
  height?: number | string;
  rowHeight?: number;
  overscan?: number;
  rowClassName?: (row: T) => string | undefined;
  ariaLabel?: string;
  className?: string;
}

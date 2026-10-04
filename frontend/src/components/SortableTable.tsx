/**
 * Click-to-sort tables: `useSort` holds the sort state and returns the sorted
 * rows; `SortableTable` renders them with sortable column headers (click once
 * for ascending, again for descending). Numbers sort numerically, text sorts
 * naturally ("HV-2" before "HV-10"), and empty values always sort last.
 *
 * Kept small on purpose: the shared data grid (filter, multi-select, inline
 * edit, paste) builds on these pieces.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection };
export type SortValue = string | number | boolean | null | undefined;

export type SortableColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Value to sort by; columns without one are not sortable. */
  sortValue?: (row: T) => SortValue;
  className?: string;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function isEmpty(value: SortValue): boolean {
  return value === null || value === undefined || value === "";
}

/** Ascending order of two sort values; empty values compare greater than anything. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) === isEmpty(b) ? 0 : isEmpty(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** Sort `rows` by the column in `sort`; stable, and empty values stay last in both directions. */
export function sortRows<T>(rows: T[], columns: Array<SortableColumn<T>>, sort: SortState | null): T[] {
  const column = sort ? columns.find((entry) => entry.key === sort.key) : undefined;
  if (!sort || !column?.sortValue) return rows;
  const value = column.sortValue;
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: value(row) }))
    .sort((a, b) => {
      if (isEmpty(a.value) || isEmpty(b.value)) return compareSortValues(a.value, b.value) || a.index - b.index;
      return sign * compareSortValues(a.value, b.value) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export function useSort<T>(rows: T[], columns: Array<SortableColumn<T>>, initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  /** Sort by `key`, or flip the direction when it is already the sort column. */
  const toggle = useCallback((key: string) => {
    setSort((current) => (current?.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  }, []);
  return { sorted, sort, setSort, toggle };
}

export function SortableTable<T>({
  rows,
  columns,
  getKey,
  selectedKey,
  onSelect,
  initialSort = null,
  emptyText = "No records yet.",
  className = "",
  label
}: {
  rows: T[];
  columns: Array<SortableColumn<T>>;
  getKey: (row: T, index: number) => string;
  selectedKey?: string;
  onSelect?: (row: T) => void;
  initialSort?: SortState | null;
  emptyText?: string;
  className?: string;
  /** Accessible name of the table. */
  label?: string;
}) {
  const { sorted, sort, toggle } = useSort(rows, columns, initialSort);
  return (
    <div className={`tableWrap ${className}`.trim()}>
      <table className="sortableTable" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : column.sortValue ? "none" : undefined;
              return (
                <th key={column.key} aria-sort={ariaSort} className={column.className}>
                  {column.sortValue ? (
                    <button type="button" className={active ? "sortButton active" : "sortButton"} onClick={() => toggle(column.key)} title={`Sort by ${column.header}`}>
                      {column.header}
                      <span className="sortIndicator" aria-hidden="true">
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{emptyText}</td>
            </tr>
          ) : (
            sorted.map((row, index) => {
              const key = getKey(row, index);
              return (
                <tr key={key} className={selectedKey === key ? "selectedRow" : undefined} onClick={onSelect ? () => onSelect(row) : undefined}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

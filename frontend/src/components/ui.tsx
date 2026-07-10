import type { ReactNode } from "react";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="panel">
      <h2>{title}</h2>
      {children}
    </article>
  );
}

export function SummaryCard({ title, value, detail }: { title: string; value: number; detail: string }) {
  return (
    <article className="summaryCard">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  readOnly = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label>
      {label}
      <input readOnly={readOnly} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  readOnly = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label>
      {label}
      <textarea readOnly={readOnly} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
  allowEmpty = true,
  disabled = false
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
        {allowEmpty && <option value="">Select...</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FormError({ message }: { message?: string }) {
  return message ? <p className="formError">{message}</p> : null;
}

export function DataTable<T>({
  rows,
  columns,
  getKey,
  selectedKey,
  onSelect
}: {
  rows: T[];
  columns: Array<{ header: string; render: (row: T) => ReactNode }>;
  getKey: (row: T) => string;
  selectedKey?: string;
  onSelect?: (row: T) => void;
}) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>No records yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                className={selectedKey === getKey(row) ? "selectedRow" : undefined}
                key={getKey(row)}
                onClick={() => onSelect?.(row)}
              >
                {columns.map((column) => (
                  <td key={column.header}>{column.render(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

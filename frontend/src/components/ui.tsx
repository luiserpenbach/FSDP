import type { ReactNode } from "react";

export function Panel({
  title,
  children,
  className = ""
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`panel ${className}`.trim()}>
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
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label>
      {label}
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function Select({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select...</option>
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

const PILL_TONES: Record<string, string> = {
  preferred: "good",
  qualified: "info",
  unqualified: "muted",
  legacy: "warn",
  restricted: "bad",
  certified: "good",
  in_review: "warn",
  unreviewed: "muted",
  rejected: "bad",
  draft: "muted",
  active: "good",
  obsolete: "bad",
  disqualified: "bad",
  expired: "warn",
  in_qualification: "warn",
  approved: "good",
  released: "good",
  created: "good",
  updated: "info",
  deleted: "bad",
  admin: "warn",
  engineer: "info",
  viewer: "muted",
  inactive: "bad"
};

export function StatusPill({ value }: { value: string }) {
  const tone = PILL_TONES[value] ?? "muted";
  return <span className={`pill pill-${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function DataTable<T>({
  rows,
  columns,
  getKey,
  selectedKey,
  onSelect,
  className = ""
}: {
  rows: T[];
  columns: Array<{ header: string; render: (row: T) => ReactNode }>;
  getKey: (row: T, index: number) => string;
  selectedKey?: string;
  onSelect?: (row: T) => void;
  className?: string;
}) {
  return (
    <div className={`tableWrap ${className}`.trim()}>
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
            rows.map((row, index) => (
              <tr
                className={selectedKey === getKey(row, index) ? "selectedRow" : undefined}
                key={getKey(row, index)}
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

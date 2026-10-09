/** Small building blocks used by <DataGrid>: popover, set filter, column chooser, cell editor. */
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { columnType, optionList, setFilterOptions } from "./gridModel";
import type { DataGridColumn, DataGridFilter } from "./types";

export function Popover({
  label,
  ariaLabel,
  className = "",
  children
}: {
  label: ReactNode;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setPosition(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPosition(null);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 240)) : 0;
    setPosition({ top: rect ? rect.bottom + 4 : 0, left });
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        className={`dgButton ${className}`.trim()}
        onClick={toggle}
        ref={buttonRef}
        type="button"
      >
        {label}
      </button>
      {position && (
        <div aria-label={ariaLabel} className="dgPopover" ref={panelRef} role="dialog" style={{ top: position.top, left: position.left }}>
          {children}
        </div>
      )}
    </>
  );
}

export function SetFilter<T>({
  column,
  filter,
  onChange
}: {
  column: DataGridColumn<T>;
  filter: DataGridFilter | undefined;
  onChange: (filter: DataGridFilter | undefined) => void;
}) {
  const options = setFilterOptions(column);
  const selected = filter?.kind === "set" ? new Set(filter.values) : new Set(options.map((option) => option.value));
  const summary = filter?.kind === "set" ? `${filter.values.length} of ${options.length}` : "All";

  function update(next: Set<string>) {
    if (next.size === options.length) onChange(undefined);
    else onChange({ kind: "set", values: options.map((option) => option.value).filter((value) => next.has(value)) });
  }

  return (
    <Popover ariaLabel={`Filter ${column.header}`} className={`dgFilterButton ${filter ? "dgFilterOn" : ""}`} label={summary}>
      <div className="dgPopoverActions">
        <button className="dgLink" onClick={() => update(new Set(options.map((option) => option.value)))} type="button">
          All
        </button>
        <button className="dgLink" onClick={() => update(new Set())} type="button">
          None
        </button>
      </div>
      {options.map((option) => (
        <label className="dgCheckRow" key={option.value || "__blank"}>
          <input
            checked={selected.has(option.value)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(option.value);
              else next.delete(option.value);
              update(next);
            }}
            type="checkbox"
          />
          <span>{option.label}</span>
        </label>
      ))}
    </Popover>
  );
}

export function ColumnChooser<T>({
  columns,
  isVisible,
  onToggle,
  onReset
}: {
  columns: ReadonlyArray<DataGridColumn<T>>;
  isVisible: (column: DataGridColumn<T>) => boolean;
  onToggle: (column: DataGridColumn<T>, visible: boolean) => void;
  onReset: () => void;
}) {
  const hideable = columns.filter((column) => column.hideable !== false);
  const hiddenCount = hideable.filter((column) => !isVisible(column)).length;
  return (
    <Popover ariaLabel="Choose columns" label={hiddenCount ? `Columns (${hiddenCount} hidden)` : "Columns"}>
      {hideable.map((column) => (
        <label className="dgCheckRow" key={column.key}>
          <input checked={isVisible(column)} onChange={(event) => onToggle(column, event.target.checked)} type="checkbox" />
          <span>{column.header}</span>
        </label>
      ))}
      <div className="dgPopoverActions">
        <button className="dgLink" onClick={onReset} type="button">
          Reset columns &amp; widths
        </button>
      </div>
    </Popover>
  );
}

export type EditorMove = "up" | "down" | "left" | "right" | null;

export function CellEditor<T>({
  column,
  initialText,
  error,
  onCommit,
  onCancel
}: {
  column: DataGridColumn<T>;
  initialText: string;
  error: string | null;
  onCommit: (text: string, move: EditorMove, fromBlur: boolean) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const inputRef = useRef<HTMLInputElement>(null);
  const type = columnType(column);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit(draft, event.shiftKey ? "up" : "down", false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      onCommit(draft, event.shiftKey ? "left" : "right", false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const errorId = useId();
  const describedBy = error ? errorId : undefined;
  return (
    <>
      {type === "enum" ? (
        <select
          aria-invalid={error ? true : undefined}
          aria-label={`Edit ${column.header}`}
          autoFocus
          className="dgEditor"
          onBlur={() => onCommit(draft, null, true)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          value={draft}
        >
          <option value="">—</option>
          {optionList(column).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {draft && !optionList(column).some((option) => option.value === draft) && <option value={draft}>{draft}</option>}
        </select>
      ) : (
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-label={`Edit ${column.header}`}
          className="dgEditor"
          inputMode={type === "number" ? "decimal" : undefined}
          onBlur={() => onCommit(draft, null, true)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={type === "date" ? "YYYY-MM-DD" : undefined}
          ref={inputRef}
          spellCheck={type === "text"}
          value={draft}
        />
      )}
      {error && (
        <div className="dgEditError" id={errorId} role="alert">
          {error}
        </div>
      )}
    </>
  );
}

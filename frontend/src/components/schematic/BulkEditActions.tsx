/**
 * Bulk edit buttons shared by the lists drawer (selected rows) and the canvas
 * multi-select inspector (selected items): assign or clear a part on the
 * selected symbols and equipment, set the line class or service on the
 * selected lines. The host turns each action into field edits and writes
 * them through the same path as inline edits.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { LineClassLike } from "../../engine/fieldEdits";

function ValueForm({ label, placeholder, disabled, onApply }: { label: string; placeholder?: string; disabled?: boolean; onApply: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const name = label.replace(/…$/, "");
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onApply(value.trim());
    setValue("");
    setOpen(false);
  }
  return (
    <form className="bulkValueForm" onSubmit={submit}>
      <input
        aria-label={name}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        value={value}
      />
      <button type="submit" className="primary" disabled={disabled}>
        Apply
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function BulkEditActions({
  itemCount,
  lineCount,
  partCount = 0,
  lineClasses,
  disabled,
  onAssignPart,
  onClearPart,
  onSetLineClass,
  onSetService
}: {
  /** Selected symbols and equipment. */
  itemCount: number;
  /** Selected lines. */
  lineCount: number;
  /** Selected items that have a part (enables "Clear part"). */
  partCount?: number;
  lineClasses: readonly LineClassLike[];
  disabled?: boolean;
  onAssignPart?: () => void;
  onClearPart?: () => void;
  onSetLineClass?: (lineClass: string | null) => void;
  onSetService?: (service: string | null) => void;
}) {
  return (
    <div className="bulkEditActions">
      {itemCount > 0 && onAssignPart && (
        <button type="button" disabled={disabled} onClick={onAssignPart} title={`Assign one part to the ${itemCount} selected item(s)`}>
          Assign part…
        </button>
      )}
      {itemCount > 0 && onClearPart && (
        <button type="button" disabled={disabled || partCount === 0} onClick={onClearPart}>
          Clear part
        </button>
      )}
      {lineCount > 0 && onSetLineClass &&
        (lineClasses.length ? (
          <select
            aria-label="Set line class"
            disabled={disabled}
            value=""
            onChange={(event) => {
              const value = event.target.value;
              if (value) onSetLineClass(value === "__none" ? null : value);
            }}
          >
            <option value="">Set line class…</option>
            {lineClasses.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
                {entry.material ? ` · ${entry.material}` : ""}
              </option>
            ))}
            <option value="__none">None (clear)</option>
          </select>
        ) : (
          <ValueForm label="Set line class…" disabled={disabled} onApply={(value) => onSetLineClass(value || null)} />
        ))}
      {lineCount > 0 && onSetService && <ValueForm label="Set service…" placeholder="e.g. GHe" disabled={disabled} onApply={(value) => onSetService(value || null)} />}
    </div>
  );
}

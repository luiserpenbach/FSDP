/**
 * Assign-part modal: the whole catalog searchable, an optional type chip from
 * the symbol's category, and warn-only findings per part (draft, unqualified,
 * rating below the connected line's design pressure). Obsolete parts cannot
 * be assigned; everything else warns and lets the engineer decide.
 */
import { useMemo, useState } from "react";
import { partTone, partWarnings, suggestedPartType } from "../../engine/parts";
import type { LineItem } from "../../engine/types";
import type { Part } from "../../types";

export function AssignPartModal({
  parts,
  category,
  currentPartId,
  connectedLines,
  caption,
  onAssign,
  onClose
}: {
  parts: Part[];
  category: string | null;
  currentPartId: string | null | undefined;
  connectedLines: LineItem[];
  caption: string;
  onAssign: (partId: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const partTypes = useMemo(() => [...new Set(parts.map((part) => part.part_type))].sort(), [parts]);
  const suggested = useMemo(() => suggestedPartType(category, partTypes), [category, partTypes]);
  const [typeFilter, setTypeFilter] = useState<string | null>(suggested);
  const [selectedId, setSelectedId] = useState<string | null>(currentPartId ?? null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return parts
      .filter((part) => !typeFilter || part.part_type === typeFilter)
      .filter((part) => !needle || `${part.part_number} ${part.description} ${part.manufacturer ?? ""} ${part.material ?? ""}`.toLowerCase().includes(needle))
      .map((part) => ({ part, warnings: partWarnings(part, connectedLines), tone: partTone(part) }))
      .sort((a, b) => Number(b.part.preferred) - Number(a.part.preferred) || a.part.part_number.localeCompare(b.part.part_number))
      .slice(0, 200);
  }, [parts, typeFilter, query, connectedLines]);
  const selected = rows.find((row) => row.part.id === selectedId) ?? null;
  const blocked = selected?.part.lifecycle_status === "obsolete";

  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <div className="modal assignPartModal" role="dialog" aria-modal="true" aria-label="Assign part" onClick={(event) => event.stopPropagation()}>
        <div className="modalHeader">
          <h2>Assign part to {caption}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="assignPartFilters">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search part number, description, manufacturer…" aria-label="Search parts" />
          {partTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={typeFilter === type ? "chip active" : "chip"}
              onClick={() => setTypeFilter(typeFilter === type ? null : type)}
              title={type === suggested ? "Suggested from the symbol category" : undefined}
            >
              {type}
              {type === suggested ? " ✓" : ""}
            </button>
          ))}
        </div>
        <div className="assignPartList" role="listbox" aria-label="Parts">
          {rows.length === 0 && <p className="hint">No parts match. Clear the type chip or add the part on the Parts page.</p>}
          {rows.map(({ part, warnings, tone }) => (
            <button
              key={part.id}
              type="button"
              role="option"
              aria-selected={part.id === selectedId}
              className={part.id === selectedId ? "assignPartRow active" : "assignPartRow"}
              onClick={() => setSelectedId(part.id)}
              onDoubleClick={() => {
                if (part.lifecycle_status !== "obsolete") onAssign(part.id);
              }}
            >
              <span className="mono">{part.part_number}</span>
              <span className="assignPartDescription">{part.description}</span>
              <span className={`pill pill-${tone === "good" ? "good" : tone === "bad" ? "bad" : "warn"}`}>{part.lifecycle_status === "active" ? part.qualification_status : part.lifecycle_status}</span>
              <span className="assignPartMeta">
                {part.part_type}
                {part.material ? ` · ${part.material}` : ""}
                {part.pressure_rating_bar != null ? ` · ${part.pressure_rating_bar} bar` : ""}
              </span>
              {warnings.length > 0 && <span className="assignPartWarnings">{warnings.join(" ")}</span>}
            </button>
          ))}
        </div>
        <div className="modalActions">
          {currentPartId && (
            <button type="button" onClick={() => onAssign(null)}>
              Remove part
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!selected || blocked} onClick={() => selected && onAssign(selected.part.id)}>
            {currentPartId && selectedId !== currentPartId ? "Replace part" : "Assign part"}
          </button>
        </div>
        {blocked && <p className="formError">Obsolete parts cannot be assigned. Pick an alternate.</p>}
      </div>
    </div>
  );
}

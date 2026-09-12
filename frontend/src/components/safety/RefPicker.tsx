/**
 * One picker for every reference cell: a search box over a data source that
 * returns labelled options, keyboard navigable, closes on pick or Escape.
 */
import { useEffect, useRef, useState } from "react";

export type PickerOption = { id: string; label: string; detail?: string };

export function RefPicker({
  label,
  initialQuery = "",
  allowNone = true,
  search,
  onPick,
  onClose
}: {
  label: string;
  initialQuery?: string;
  allowNone?: boolean;
  search: (query: string) => Promise<PickerOption[]>;
  onPick: (option: PickerOption | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      search(query)
        .then((found) => {
          if (cancelled) return;
          setOptions(found);
          setActive(0);
          setError("");
        })
        .catch((caught) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : "Search failed.");
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, search]);

  return (
    <div className="refPicker" role="dialog" aria-label={label}>
      <input
        ref={inputRef}
        value={query}
        placeholder={`Search ${label.toLowerCase()}…`}
        aria-label={`Search ${label.toLowerCase()}`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => Math.min(options.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (options[active]) onPick(options[active]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      {error && <p className="formError">{error}</p>}
      <ul className="pickList" role="listbox">
        {allowNone && (
          <li>
            <button type="button" onClick={() => onPick(null)}>
              <span className="hint">None</span>
            </button>
          </li>
        )}
        {options.map((option, index) => (
          <li key={option.id}>
            <button type="button" role="option" aria-selected={index === active} className={index === active ? "active" : ""} onMouseEnter={() => setActive(index)} onClick={() => onPick(option)}>
              <span className="mono">{option.label}</span>
              {option.detail && <span className="hint">{option.detail}</span>}
            </button>
          </li>
        ))}
        {options.length === 0 && !error && (
          <li>
            <span className="hint pickEmpty">No matches.</span>
          </li>
        )}
      </ul>
    </div>
  );
}

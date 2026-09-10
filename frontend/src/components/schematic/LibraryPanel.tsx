/**
 * Library browser: searchable, categorised symbol palette with rendered
 * previews. Click a symbol to start placing it. Custom symbols expose their
 * library metadata (category, legend, tag letters) for editing.
 */
import { useMemo, useState } from "react";
import { CATEGORY_LABELS, CATEGORY_ORDER, CUSTOM_LIBRARY, SYMBOL_STROKE_MM, refFor, type SymbolRegistry } from "../../engine/library";
import type { SymbolDef, SymbolRef } from "../../engine/types";

export function SymbolPreview({ definition, size = 40 }: { definition: SymbolDef; size?: number }) {
  const width = Math.max(definition.width, 12);
  const height = Math.max(definition.height, 8);
  const pad = 2;
  return (
    <svg
      className="symbolPreview"
      viewBox={`${-width / 2 - pad} ${-height / 2 - pad} ${width + pad * 2} ${height + pad * 2}`}
      width={size}
      height={size * 0.6}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={SYMBOL_STROKE_MM * 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: definition.svg }}
      />
    </svg>
  );
}

export function LibraryPanel({
  registry,
  placing,
  canWrite,
  onPlace,
  onUpdateCustom
}: {
  registry: SymbolRegistry;
  placing: SymbolRef | null;
  canWrite: boolean;
  onPlace: (ref: SymbolRef) => void;
  onUpdateCustom?: (symbolId: string, patch: { category?: string; legend?: string; tag_prefix?: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SymbolDef | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ actuator: true });
  const [meta, setMeta] = useState({ category: "", legend: "", tag_prefix: "" });

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, SymbolDef[]>();
    for (const definition of registry.list()) {
      if (definition.key === "__missing__") continue;
      if (
        needle &&
        !definition.name.toLowerCase().includes(needle) &&
        !(definition.legend ?? "").toLowerCase().includes(needle) &&
        !(definition.tagPrefix ?? "").toLowerCase().includes(needle) &&
        !definition.key.includes(needle)
      ) {
        continue;
      }
      const bucket = map.get(definition.category) ?? [];
      bucket.push(definition);
      map.set(definition.category, bucket);
    }
    const ordered = [...CATEGORY_ORDER, ...[...map.keys()].filter((key) => !CATEGORY_ORDER.includes(key))];
    return ordered.filter((key) => map.has(key)).map((key) => ({ key, definitions: map.get(key)! }));
  }, [registry, query]);

  function choose(definition: SymbolDef) {
    setSelected(definition);
    setMeta({ category: definition.category, legend: definition.legend ?? "", tag_prefix: definition.tagPrefix ?? "" });
    if (definition.category !== "actuator") onPlace(refFor(definition));
  }

  const placingKey = placing ? `${placing.library}/${placing.key}` : "";

  return (
    <aside className="libraryPanel">
      <div className="libraryHead">
        <strong>Library</strong>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbols…" aria-label="Search symbols" />
      </div>
      <div className="libraryGroups">
        {groups.map((group) => {
          const open = query ? true : !collapsed[group.key];
          return (
            <section key={group.key} className="libraryGroup">
              <button type="button" className="libraryGroupHead" onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))}>
                <span>{CATEGORY_LABELS[group.key] ?? group.key}</span>
                <small>{group.definitions.length}</small>
              </button>
              {open && (
                <div className="libraryGrid">
                  {group.definitions.map((definition) => {
                    const key = `${definition.library}/${definition.key}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={key === placingKey ? "librarySymbol active" : "librarySymbol"}
                        onClick={() => choose(definition)}
                        title={`${definition.name}${definition.tagPrefix ? ` (${definition.tagPrefix})` : ""}${definition.category === "actuator" ? " — assign from the inspector" : ""}`}
                      >
                        <SymbolPreview definition={definition} />
                        <span>{definition.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {groups.length === 0 && <p className="hint">No symbols match.</p>}
      </div>
      {selected && (
        <div className="libraryDetail">
          <strong>{selected.name}</strong>
          <p>
            <span className="mono">
              {selected.library}/{selected.key} v{selected.version}
            </span>
            {selected.standardRef ? ` · ${selected.standardRef}` : ""}
          </p>
          <p>
            {selected.width} × {selected.height} mm · ports:{" "}
            {selected.ports.map((port) => `${port.id} (${port.kind ?? "process"})`).join(", ") || "none"}
          </p>
          {selected.library === CUSTOM_LIBRARY && onUpdateCustom ? (
            <form
              className="libraryMetaForm"
              onSubmit={(event) => {
                event.preventDefault();
                onUpdateCustom(selected.key, meta);
              }}
            >
              <label>
                Category
                <select value={meta.category} onChange={(event) => setMeta({ ...meta, category: event.target.value })} disabled={!canWrite}>
                  {CATEGORY_ORDER.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Legend text
                <input value={meta.legend} onChange={(event) => setMeta({ ...meta, legend: event.target.value })} disabled={!canWrite} />
              </label>
              <label>
                Tag letters
                <input value={meta.tag_prefix} onChange={(event) => setMeta({ ...meta, tag_prefix: event.target.value.toUpperCase() })} disabled={!canWrite} />
              </label>
              <button type="submit" disabled={!canWrite}>
                Save symbol metadata
              </button>
            </form>
          ) : (
            <p className="hint">Legend: {selected.legend ?? selected.name.toUpperCase()}</p>
          )}
        </div>
      )}
    </aside>
  );
}

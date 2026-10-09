import { useEffect, useMemo, useRef, useState } from "react";

/* ---------- Column preferences (visibility + widths), persisted ---------- */

export interface ColumnPrefs {
  /** Explicit user choice per column key; absent = column default. */
  visibility: Record<string, boolean>;
  widths: Record<string, number>;
}

const EMPTY_PREFS: ColumnPrefs = { visibility: {}, widths: {} };

export function columnPrefsStorageName(storageKey: string): string {
  return `fsdp.datagrid.${storageKey}`;
}

export function loadColumnPrefs(storageKey: string | undefined): ColumnPrefs {
  if (!storageKey) return EMPTY_PREFS;
  try {
    const raw = window.localStorage.getItem(columnPrefsStorageName(storageKey));
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
    const visibility: Record<string, boolean> = {};
    const widths: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.visibility ?? {})) if (typeof value === "boolean") visibility[key] = value;
    for (const [key, value] of Object.entries(parsed.widths ?? {}))
      if (typeof value === "number" && Number.isFinite(value) && value > 0) widths[key] = value;
    return { visibility, widths };
  } catch {
    return EMPTY_PREFS;
  }
}

function saveColumnPrefs(storageKey: string, prefs: ColumnPrefs): void {
  try {
    window.localStorage.setItem(columnPrefsStorageName(storageKey), JSON.stringify(prefs));
  } catch {
    // Storage full or blocked (private mode): preferences just won't persist.
  }
}

export function useColumnPrefs(storageKey: string | undefined) {
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => loadColumnPrefs(storageKey));
  const lastSaved = useRef<string | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    const serialized = JSON.stringify(prefs);
    if (lastSaved.current === null) {
      // First run: nothing changed yet, don't write back what we just loaded.
      lastSaved.current = serialized;
      return;
    }
    if (serialized === lastSaved.current) return;
    lastSaved.current = serialized;
    saveColumnPrefs(storageKey, prefs);
  }, [storageKey, prefs]);

  return {
    prefs,
    setVisible(key: string, visible: boolean) {
      setPrefs((prev) => ({ ...prev, visibility: { ...prev.visibility, [key]: visible } }));
    },
    setWidth(key: string, width: number) {
      setPrefs((prev) => ({ ...prev, widths: { ...prev.widths, [key]: Math.round(width) } }));
    },
    resetWidth(key: string) {
      setPrefs((prev) => {
        const widths = { ...prev.widths };
        delete widths[key];
        return { ...prev, widths };
      });
    },
    reset() {
      setPrefs(EMPTY_PREFS);
    }
  };
}

/* ---------- Row selection (controlled or uncontrolled) ---------- */

export function useRowSelection(
  selectedIds: ReadonlyArray<string> | undefined,
  defaultSelectedIds: ReadonlyArray<string> | undefined,
  onSelectionChange: ((ids: string[]) => void) | undefined
) {
  const [internal, setInternal] = useState<ReadonlyArray<string>>(() => defaultSelectedIds ?? []);
  const controlled = selectedIds !== undefined;
  const ids = controlled ? selectedIds : internal;
  const set = useMemo(() => new Set(ids), [ids]);

  function change(next: Iterable<string>) {
    const list = Array.from(new Set(next));
    if (!controlled) setInternal(list);
    onSelectionChange?.(list);
  }

  return { ids, set, change };
}

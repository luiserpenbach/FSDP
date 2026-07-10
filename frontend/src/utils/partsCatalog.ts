import type { Part } from "../types";

export type PartColumnKey = keyof Part;

export type PartColumnDef = {
  key: PartColumnKey;
  label: string;
  defaultVisible?: boolean;
};

export const PART_COLUMNS: PartColumnDef[] = [
  { key: "part_number", label: "Part number", defaultVisible: true },
  { key: "description", label: "Description", defaultVisible: true },
  { key: "part_type", label: "Type", defaultVisible: true },
  { key: "revision", label: "Revision", defaultVisible: true },
  { key: "manufacturer", label: "Manufacturer", defaultVisible: true },
  { key: "source_type", label: "Source", defaultVisible: true },
  { key: "material", label: "Material", defaultVisible: true },
  { key: "pressure_rating_bar", label: "Pressure (bar)", defaultVisible: true },
  { key: "qualification_status", label: "Qualification", defaultVisible: true },
  { key: "certification_status", label: "Certification", defaultVisible: true },
  { key: "lifecycle_status", label: "Lifecycle", defaultVisible: true }
];

export const DEFAULT_VISIBLE_COLUMNS = PART_COLUMNS.filter((column) => column.defaultVisible).map(
  (column) => column.key
);

const VISIBLE_COLUMNS_KEY = "fsdp-parts-visible-columns";

export function loadVisibleColumns(): PartColumnKey[] {
  try {
    const stored = localStorage.getItem(VISIBLE_COLUMNS_KEY);
    if (!stored) return DEFAULT_VISIBLE_COLUMNS;
    const parsed = JSON.parse(stored) as PartColumnKey[];
    return parsed.filter((key) => PART_COLUMNS.some((column) => column.key === key));
  } catch {
    return DEFAULT_VISIBLE_COLUMNS;
  }
}

export function saveVisibleColumns(columns: PartColumnKey[]) {
  localStorage.setItem(VISIBLE_COLUMNS_KEY, JSON.stringify(columns));
}

export type PartFormState = {
  part_number: string;
  description: string;
  part_type: string;
  revision: string;
  manufacturer: string;
  source_type: string;
  material: string;
  pressure_rating_bar: string;
  qualification_status: string;
  certification_status: string;
  lifecycle_status: string;
  family_id: string;
  replacement_part_id: string;
};

export type PartFilters = {
  part_type: string;
  source_type: string;
  qualification_status: string;
  lifecycle_status: string;
};

export type SavedPartView = {
  id: string;
  name: string;
  search: string;
  filters: PartFilters;
  visibleColumns: PartColumnKey[];
};

const SAVED_VIEWS_KEY = "fsdp-parts-saved-views";

export function emptyPartForm(): PartFormState {
  return {
    part_number: "",
    description: "",
    part_type: "valve",
    revision: "",
    manufacturer: "",
    source_type: "internal",
    material: "",
    pressure_rating_bar: "",
    qualification_status: "preferred",
    certification_status: "qualified",
    lifecycle_status: "active",
    family_id: "",
    replacement_part_id: ""
  };
}

export function partToForm(part: Part): PartFormState {
  return {
    part_number: part.part_number,
    description: part.description,
    part_type: part.part_type,
    revision: part.revision ?? "",
    manufacturer: part.manufacturer ?? "",
    source_type: part.source_type,
    material: part.material ?? "",
    pressure_rating_bar: String(part.pressure_rating_bar ?? ""),
    qualification_status: part.qualification_status,
    certification_status: part.certification_status,
    lifecycle_status: part.lifecycle_status ?? "active",
    family_id: part.family_id ?? "",
    replacement_part_id: part.replacement_part_id ?? ""
  };
}

export function getPartFieldValue(part: Part, key: PartColumnKey): string {
  const value = part[key as keyof Part];
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export type SortDirection = "asc" | "desc";

export function compareParts(a: Part, b: Part, key: PartColumnKey, direction: SortDirection) {
  const left = getPartFieldValue(a, key);
  const right = getPartFieldValue(b, key);
  const result = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

export function filterParts(parts: Part[], search: string, filters: PartFilters) {
  const query = search.trim().toLowerCase();
  return parts.filter((part) => {
    if (filters.part_type && part.part_type !== filters.part_type) return false;
    if (filters.source_type && part.source_type !== filters.source_type) return false;
    if (filters.qualification_status && part.qualification_status !== filters.qualification_status) {
      return false;
    }
    if (filters.lifecycle_status && part.lifecycle_status !== filters.lifecycle_status) return false;
    if (!query) return true;
    return PART_COLUMNS.some((column) => getPartFieldValue(part, column.key).toLowerCase().includes(query));
  });
}

export function loadSavedViews(): SavedPartView[] {
  try {
    const stored = localStorage.getItem(SAVED_VIEWS_KEY);
    return stored ? (JSON.parse(stored) as SavedPartView[]) : [];
  } catch {
    return [];
  }
}

export function saveSavedViews(views: SavedPartView[]) {
  localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
}

export const IMPORTABLE_FIELDS = [
  "part_number",
  "revision",
  "description",
  "manufacturer",
  "part_type",
  "source_type",
  "material",
  "pressure_rating_bar",
  "qualification_status",
  "certification_status",
  "lifecycle_status"
] as const;

export function uniquePartValues(parts: Part[], key: PartColumnKey) {
  return [...new Set(parts.map((part) => part[key]).filter((value) => value !== null && value !== undefined && value !== ""))].map(
    String
  );
}

export function exportPartsCsv(parts: Part[], columns: PartColumnDef[]) {
  const header = columns.map((column) => column.label);
  const rows = parts.map((part) =>
    columns.map((column) => {
      const raw = part[column.key];
      const value = raw === null || raw === undefined ? "" : String(raw);
      return `"${value.replaceAll('"', '""')}"`;
    })
  );
  const csv = [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `parts-catalog-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

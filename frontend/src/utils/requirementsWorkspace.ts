import type { Requirement, RequirementVerificationMatrixRow } from "../types";

export type RequirementColumnKey =
  | keyof Requirement
  | "link_count"
  | "coverage"
  | "verification_display"
  | "evidence_count";

export type RequirementColumnDef = {
  key: RequirementColumnKey;
  label: string;
  defaultVisible?: boolean;
  computed?: boolean;
};

export const REQUIREMENT_COLUMNS: RequirementColumnDef[] = [
  { key: "key", label: "Key", defaultVisible: true },
  { key: "title", label: "Title", defaultVisible: true },
  { key: "requirement_type", label: "Type", defaultVisible: true },
  { key: "status", label: "Status", defaultVisible: true },
  { key: "verification_method", label: "Verification", defaultVisible: true },
  { key: "verification_display", label: "V&V readiness", defaultVisible: true, computed: true },
  { key: "owner", label: "Owner", defaultVisible: true },
  { key: "coverage", label: "Coverage", defaultVisible: true, computed: true },
  { key: "link_count", label: "Links", computed: true },
  { key: "evidence_count", label: "Evidence", computed: true },
  { key: "lifecycle_status", label: "Lifecycle" },
  { key: "verification_status", label: "Verification status" },
  { key: "set_id", label: "Set" },
  { key: "text", label: "Text" },
  { key: "updated_at", label: "Updated" },
  { key: "created_at", label: "Created" }
];

export const DEFAULT_REQUIREMENT_COLUMNS = REQUIREMENT_COLUMNS.filter((column) => column.defaultVisible).map(
  (column) => column.key
);

export const IMPORTABLE_FIELDS = [
  "key",
  "title",
  "text",
  "requirement_type",
  "verification_method",
  "status",
  "owner",
  "lifecycle_status",
  "verification_status"
] as const;

const VISIBLE_COLUMNS_KEY = "fsdp-requirements-visible-columns";
const SAVED_VIEWS_KEY = "fsdp-requirements-saved-views";

export type RequirementFormState = {
  key: string;
  title: string;
  text: string;
  requirement_type: string;
  verification_method: string;
  status: string;
  owner: string;
  lifecycle_status: string;
  verification_status: string;
  set_id: string;
  superseded_by_requirement_id: string;
};

export type RequirementFilters = {
  requirement_type: string;
  status: string;
  verification_method: string;
  owner: string;
  link_status: "" | "linked" | "unlinked";
  lifecycle_status: string;
  verification_display: string;
  set_id: string;
};

export type RequirementCoverageMap = Record<
  string,
  {
    link_count: number;
    linked: boolean;
    evidence_count: number;
    verification_display: string;
  }
>;

export type SavedRequirementView = {
  id: string;
  name: string;
  search: string;
  filters: RequirementFilters;
  visibleColumns: RequirementColumnKey[];
};

export type SortDirection = "asc" | "desc";

export function loadVisibleColumns(): RequirementColumnKey[] {
  try {
    const stored = localStorage.getItem(VISIBLE_COLUMNS_KEY);
    if (!stored) return DEFAULT_REQUIREMENT_COLUMNS;
    const parsed = JSON.parse(stored) as RequirementColumnKey[];
    return parsed.filter((key) => REQUIREMENT_COLUMNS.some((column) => column.key === key));
  } catch {
    return DEFAULT_REQUIREMENT_COLUMNS;
  }
}

export function saveVisibleColumns(columns: RequirementColumnKey[]) {
  localStorage.setItem(VISIBLE_COLUMNS_KEY, JSON.stringify(columns));
}

export function loadSavedViews(): SavedRequirementView[] {
  try {
    const stored = localStorage.getItem(SAVED_VIEWS_KEY);
    return stored ? (JSON.parse(stored) as SavedRequirementView[]) : [];
  } catch {
    return [];
  }
}

export function saveSavedViews(views: SavedRequirementView[]) {
  localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
}

export function emptyRequirementForm(): RequirementFormState {
  return {
    key: "",
    title: "",
    text: "",
    requirement_type: "functional",
    verification_method: "analysis",
    status: "draft",
    owner: "",
    lifecycle_status: "active",
    verification_status: "not_started",
    set_id: "",
    superseded_by_requirement_id: ""
  };
}

export function requirementToForm(requirement: Requirement): RequirementFormState {
  return {
    key: requirement.key,
    title: requirement.title,
    text: requirement.text,
    requirement_type: requirement.requirement_type,
    verification_method: requirement.verification_method ?? "",
    status: requirement.status,
    owner: requirement.owner ?? "",
    lifecycle_status: requirement.lifecycle_status ?? "active",
    verification_status: requirement.verification_status ?? "not_started",
    set_id: requirement.set_id ?? "",
    superseded_by_requirement_id: requirement.superseded_by_requirement_id ?? ""
  };
}

export function getRequirementFieldValue(
  requirement: Requirement,
  key: RequirementColumnKey,
  coverage: RequirementCoverageMap
): string {
  if (key === "link_count") {
    return String(coverage[requirement.id]?.link_count ?? 0);
  }
  if (key === "evidence_count") {
    return String(coverage[requirement.id]?.evidence_count ?? 0);
  }
  if (key === "coverage") {
    return coverage[requirement.id]?.linked ? "Linked" : "Unlinked";
  }
  if (key === "verification_display") {
    return coverage[requirement.id]?.verification_display ?? "not_started";
  }
  const value = requirement[key as keyof Requirement];
  if (value === null || value === undefined || value === "") return "-";
  if (key === "text" && String(value).length > 80) {
    return `${String(value).slice(0, 80)}...`;
  }
  if (key === "updated_at" || key === "created_at") {
    return new Date(String(value)).toLocaleDateString();
  }
  return String(value);
}

export function compareRequirements(
  left: Requirement,
  right: Requirement,
  key: RequirementColumnKey,
  direction: SortDirection,
  coverage: RequirementCoverageMap
) {
  const leftValue = getRequirementFieldValue(left, key, coverage);
  const rightValue = getRequirementFieldValue(right, key, coverage);
  const result = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

export function filterRequirements(
  requirements: Requirement[],
  search: string,
  filters: RequirementFilters,
  coverage: RequirementCoverageMap
) {
  const query = search.trim().toLowerCase();
  return requirements.filter((requirement) => {
    if (filters.requirement_type && requirement.requirement_type !== filters.requirement_type) return false;
    if (filters.status && requirement.status !== filters.status) return false;
    if (filters.verification_method && requirement.verification_method !== filters.verification_method) {
      return false;
    }
    if (filters.owner && requirement.owner !== filters.owner) return false;
    if (filters.lifecycle_status && requirement.lifecycle_status !== filters.lifecycle_status) return false;
    if (filters.set_id && requirement.set_id !== filters.set_id) return false;
    const entry = coverage[requirement.id];
    const linked = entry?.linked ?? false;
    if (filters.link_status === "linked" && !linked) return false;
    if (filters.link_status === "unlinked" && linked) return false;
    if (filters.verification_display && entry?.verification_display !== filters.verification_display) {
      return false;
    }
    if (!query) return true;
    return REQUIREMENT_COLUMNS.some((column) =>
      getRequirementFieldValue(requirement, column.key, coverage).toLowerCase().includes(query)
    );
  });
}

export function uniqueRequirementValues(requirements: Requirement[], key: keyof Requirement) {
  return [
    ...new Set(
      requirements
        .map((requirement) => requirement[key])
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(String)
    )
  ];
}

export function exportRequirementsCsv(
  requirements: Requirement[],
  columns: RequirementColumnDef[],
  coverage: RequirementCoverageMap
) {
  const header = columns.map((column) => column.label);
  const rows = requirements.map((requirement) =>
    columns.map((column) => {
      const value = getRequirementFieldValue(requirement, column.key, coverage);
      return `"${value.replaceAll('"', '""')}"`;
    })
  );
  const csv = [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `requirements-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportVerificationMatrixCsv(rows: RequirementVerificationMatrixRow[]) {
  const header = [
    "Key",
    "Title",
    "Type",
    "Method",
    "Status",
    "Verification status",
    "V&V readiness",
    "Links",
    "Evidence",
    "Linked components",
    "Lifecycle"
  ];
  const body = rows.map((row) =>
    [
      row.key,
      row.title,
      row.requirement_type,
      row.verification_method ?? "",
      row.status,
      row.verification_status,
      row.verification_display,
      String(row.link_count),
      String(row.evidence_count),
      row.linked_components.join("; "),
      row.lifecycle_status
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(",")
  );
  const csv = [header.join(","), ...body].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `verification-matrix-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

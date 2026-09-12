/**
 * Requirement constraint builder: the machine-checkable rule the drawing DRC
 * evaluates per item (material, rating, qualification, line class, relief).
 */
import type { RequirementConstraintRead } from "../../types";

export type ConstraintForm = { kind: "" | RequirementConstraintRead["kind"]; values: string; services: string; categories: string };

export const EMPTY_CONSTRAINT: ConstraintForm = { kind: "", values: "", services: "", categories: "" };

export const CONSTRAINT_OPTIONS: Array<{ value: RequirementConstraintRead["kind"]; label: string }> = [
  { value: "material_in", label: "Part material must be one of…" },
  { value: "material_not_in", label: "Part material must not be…" },
  { value: "pressure_rating_min", label: "Part rating at least (bar)" },
  { value: "part_qualified", label: "Parts must be qualified or preferred" },
  { value: "line_class_in", label: "Line class must be one of…" },
  { value: "relief_required", label: "Every isolable volume has relief" }
];

export function constraintToForm(constraint: RequirementConstraintRead | null | undefined): ConstraintForm {
  return {
    kind: constraint?.kind ?? "",
    values: constraint?.values.join(", ") ?? "",
    services: constraint?.scope?.services?.join(", ") ?? "",
    categories: constraint?.scope?.categories?.join(", ") ?? ""
  };
}

export function formToConstraint(form: ConstraintForm): RequirementConstraintRead | null {
  if (!form.kind) return null;
  const split = (text: string) => text.split(",").map((entry) => entry.trim()).filter(Boolean);
  const scope: RequirementConstraintRead["scope"] = {};
  if (split(form.services).length) scope.services = split(form.services);
  if (split(form.categories).length) scope.categories = split(form.categories);
  return { kind: form.kind, values: split(form.values), scope };
}

export function describeConstraint(constraint: RequirementConstraintRead | null | undefined): string {
  if (!constraint) return "";
  return `${constraint.kind}${constraint.values.length ? ` ${constraint.values.join("|")}` : ""}`;
}

export function ConstraintBuilder({ value, onChange, disabled = false }: { value: ConstraintForm; onChange: (next: ConstraintForm) => void; disabled?: boolean }) {
  const needsValues = value.kind && value.kind !== "part_qualified" && value.kind !== "relief_required";
  const hasScope = value.kind && value.kind !== "relief_required";
  const hasCategories = hasScope && value.kind !== "line_class_in";
  return (
    <fieldset className="constraintBuilder">
      <legend>Design rule check</legend>
      <label>
        Rule
        <select value={value.kind} disabled={disabled} onChange={(event) => onChange({ ...value, kind: event.target.value as ConstraintForm["kind"] })}>
          <option value="">None (verified by hand)</option>
          {CONSTRAINT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {needsValues && (
        <label>
          Values (comma separated)
          <input value={value.values} disabled={disabled} onChange={(event) => onChange({ ...value, values: event.target.value })} />
        </label>
      )}
      {hasScope && (
        <label>
          Scope: services (blank = all)
          <input value={value.services} disabled={disabled} onChange={(event) => onChange({ ...value, services: event.target.value })} />
        </label>
      )}
      {hasCategories && (
        <label>
          Scope: symbol categories (blank = valves, regulators, inline, instruments, equipment)
          <input value={value.categories} disabled={disabled} onChange={(event) => onChange({ ...value, categories: event.target.value })} />
        </label>
      )}
    </fieldset>
  );
}

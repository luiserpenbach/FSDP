/**
 * Part assignment helpers (catalog concept Phase B): qualification tone for
 * canvas badges, warn-only checks when a part is picked for an item, and the
 * part type suggested by a symbol's category.
 */
import type { PartBadge, PartBadgeTone } from "./render";
import type { LineItem } from "./types";

/** Minimal part shape the engine needs (mirrors `Part` in the app types). */
export type PartLike = {
  id: string;
  part_number: string;
  description?: string;
  part_type?: string;
  material?: string | null;
  pressure_rating_bar?: number | null;
  lifecycle_status?: string;
  qualification_status?: string;
  preferred?: boolean;
};

export function partTone(part: PartLike): PartBadgeTone {
  if (part.lifecycle_status === "obsolete" || part.lifecycle_status === "restricted") return "bad";
  if (part.preferred || part.qualification_status === "qualified") return part.lifecycle_status === "draft" ? "warn" : "good";
  return "warn";
}

export function partBadge(part: PartLike): PartBadge {
  return { text: part.part_number, tone: partTone(part) };
}

const PRESSURE_UNITS: Array<[RegExp, number]> = [
  [/psi[ag]?/i, 0.0689476],
  [/mpa/i, 10],
  [/kpa/i, 0.01],
  [/bar[ag]?/i, 1],
  [/atm/i, 1.01325]
];

/** Parse "2500 psig", "150 bar", "1.5 MPa" to bar; null when unreadable. Bare numbers are bar. */
export function pressureToBar(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = /(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?/.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ?? "bar";
  for (const [pattern, factor] of PRESSURE_UNITS) if (pattern.test(unit)) return value * factor;
  return null;
}

/** Warn-only findings for assigning `part` to an item touched by `lines`. */
export function partWarnings(part: PartLike, lines: LineItem[] = []): string[] {
  const warnings: string[] = [];
  if (part.lifecycle_status === "obsolete") warnings.push("Part is obsolete and cannot be assigned.");
  if (part.lifecycle_status === "restricted") warnings.push("Part is restricted.");
  if (part.lifecycle_status === "draft") warnings.push("Part is still a draft.");
  if (!part.preferred && part.qualification_status !== "qualified") warnings.push("Part is not qualified or preferred.");
  if (part.pressure_rating_bar === null || part.pressure_rating_bar === undefined) {
    warnings.push("Pressure rating is missing.");
  } else {
    const design = Math.max(...lines.map((line) => pressureToBar(line.designPressure) ?? -1));
    if (design > part.pressure_rating_bar) {
      warnings.push(`Rated ${part.pressure_rating_bar} bar, below the connected line design pressure of ${Math.round(design * 10) / 10} bar.`);
    }
  }
  if (!part.material) warnings.push("Material is missing.");
  return warnings;
}

const TYPE_HINTS: Record<string, string[]> = {
  valve: ["valve"],
  regulator: ["regulator", "valve"],
  instrument: ["instrument", "sensor", "transducer", "gauge"],
  inline: ["filter", "fitting", "inline"],
  equipment: ["equipment", "vessel", "tank"]
};

/** Catalog part type that matches a symbol category, when the catalog has one. */
export function suggestedPartType(category: string | null | undefined, partTypes: string[]): string | null {
  const hints = TYPE_HINTS[category ?? ""] ?? [];
  for (const hint of hints) {
    const match = partTypes.find((type) => type.toLowerCase().includes(hint));
    if (match) return match;
  }
  return null;
}

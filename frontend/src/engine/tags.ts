/**
 * Tag schemes: how component tags are built and checked on a project.
 *
 *   simple      {letters}{sep}{sequence}             e.g. HV-12
 *   structured  {letters}{sep}{system}{class}{seq}   e.g. PT 3222
 *                                                    (3 = helium, 2 = test hardware, 22 = sequence)
 *
 * The structured form matches the "component prefix letters" legend on the
 * reference drawing. Function letters follow ISA-5.1; the tables here also
 * feed the instrument letter legend block.
 */
import type { Command } from "./commands";
import type { SchematicDocument, SymbolItem } from "./types";

export type FunctionLetter = { letters: string; description: string };
export type DigitMeaning = { digit: string; name: string };
export type LetterMeaning = { letter: string; meaning: string };

export type TagScheme = {
  kind: "simple" | "structured";
  /** Separator between the letters and the number: "-", " ", or "". */
  separator: string;
  /** Allowed function-letter groups. Empty means any letters are accepted. */
  functionLetters: FunctionLetter[];
  /** ISA first-letter meanings (measured variable), printed in the letter table. */
  firstLetters: LetterMeaning[];
  /** ISA succeeding-letter meanings (function), printed in the letter table. */
  succeedingLetters: LetterMeaning[];
  /** Structured only: meaning of the first identification digit. */
  systems: DigitMeaning[];
  /** Structured only: meaning of the second identification digit. */
  classes: DigitMeaning[];
  /** Digits in the sequence part (simple: minimum padding; structured: exact). */
  sequenceLength: number;
  /** Reject letters that are not in `functionLetters`. */
  strictLetters: boolean;
};

export const ISA_FIRST_LETTERS: LetterMeaning[] = [
  { letter: "A", meaning: "Analysis" },
  { letter: "B", meaning: "Burner / combustion" },
  { letter: "C", meaning: "Conductivity" },
  { letter: "D", meaning: "Density" },
  { letter: "E", meaning: "Voltage" },
  { letter: "F", meaning: "Flow" },
  { letter: "H", meaning: "Hand" },
  { letter: "I", meaning: "Current" },
  { letter: "J", meaning: "Power" },
  { letter: "K", meaning: "Time" },
  { letter: "L", meaning: "Level" },
  { letter: "M", meaning: "Moisture" },
  { letter: "P", meaning: "Pressure" },
  { letter: "Q", meaning: "Quantity" },
  { letter: "R", meaning: "Radiation" },
  { letter: "S", meaning: "Speed / frequency" },
  { letter: "T", meaning: "Temperature" },
  { letter: "U", meaning: "Multivariable" },
  { letter: "V", meaning: "Vibration" },
  { letter: "W", meaning: "Weight / force" },
  { letter: "X", meaning: "Unclassified" },
  { letter: "Y", meaning: "Event / state" },
  { letter: "Z", meaning: "Position" }
];

export const ISA_SUCCEEDING_LETTERS: LetterMeaning[] = [
  { letter: "A", meaning: "Alarm" },
  { letter: "C", meaning: "Control" },
  { letter: "D", meaning: "Differential" },
  { letter: "E", meaning: "Element (sensor)" },
  { letter: "G", meaning: "Glass / gauge" },
  { letter: "H", meaning: "High" },
  { letter: "I", meaning: "Indicate" },
  { letter: "L", meaning: "Low" },
  { letter: "O", meaning: "Orifice" },
  { letter: "Q", meaning: "Totalize" },
  { letter: "R", meaning: "Record" },
  { letter: "S", meaning: "Switch / safety" },
  { letter: "T", meaning: "Transmit" },
  { letter: "V", meaning: "Valve / damper" },
  { letter: "Y", meaning: "Relay / compute" },
  { letter: "Z", meaning: "Driver / actuator" }
];

export const DEFAULT_FUNCTION_LETTERS: FunctionLetter[] = [
  { letters: "HV", description: "Hand valve" },
  { letters: "NV", description: "Needle valve" },
  { letters: "CV", description: "Check valve" },
  { letters: "SV", description: "Solenoid valve" },
  { letters: "PV", description: "Pressure control valve (actuated)" },
  { letters: "XV", description: "On/off valve" },
  { letters: "MOV", description: "Motor operated valve" },
  { letters: "PCV", description: "Pressure regulator" },
  { letters: "BPR", description: "Back-pressure regulator" },
  { letters: "PSV", description: "Pressure safety / relief valve" },
  { letters: "PSE", description: "Rupture disc" },
  { letters: "PT", description: "Pressure transmitter" },
  { letters: "PG", description: "Pressure gauge" },
  { letters: "PI", description: "Pressure indicator" },
  { letters: "PDT", description: "Differential pressure transmitter" },
  { letters: "TE", description: "Temperature element" },
  { letters: "TT", description: "Temperature transmitter" },
  { letters: "TC", description: "Thermocouple / temperature controller" },
  { letters: "FT", description: "Flow transmitter" },
  { letters: "FE", description: "Flow element" },
  { letters: "FM", description: "Flow meter" },
  { letters: "FO", description: "Flow orifice" },
  { letters: "LT", description: "Level transmitter" },
  { letters: "F", description: "Filter" },
  { letters: "TK", description: "Tank" },
  { letters: "K", description: "Gas cylinder" },
  { letters: "P", description: "Pump" },
  { letters: "C", description: "Compressor" },
  { letters: "HX", description: "Heat exchanger" },
  { letters: "H", description: "Hardware / equipment" },
  { letters: "V", description: "Vessel" },
  { letters: "N", description: "Nitrogen hardware" },
  { letters: "W", description: "Water hardware" }
];

export const DEFAULT_TAG_SCHEME: TagScheme = {
  kind: "simple",
  separator: "-",
  functionLetters: DEFAULT_FUNCTION_LETTERS,
  firstLetters: ISA_FIRST_LETTERS,
  succeedingLetters: ISA_SUCCEEDING_LETTERS,
  systems: [],
  classes: [],
  sequenceLength: 1,
  strictLetters: false
};

/** The scheme printed on the reference drawing (AMB2-9003). */
export const REFERENCE_TAG_SCHEME: TagScheme = {
  ...DEFAULT_TAG_SCHEME,
  kind: "structured",
  separator: " ",
  systems: [
    { digit: "0", name: "Vacuum" },
    { digit: "3", name: "Helium" },
    { digit: "4", name: "Nitrogen" },
    { digit: "7", name: "Water" }
  ],
  classes: [
    { digit: "1", name: "Facility hardware" },
    { digit: "2", name: "Test hardware" }
  ],
  sequenceLength: 2,
  strictLetters: false
};

export type ParsedTag = {
  letters: string;
  separator: string;
  system?: string;
  cls?: string;
  sequence: number;
  /** The full numeric part as written. */
  number: string;
};

export type TagContext = { system?: string; cls?: string };

/** Parse leniently (any separator); validation applies the scheme strictly. */
export function parseTag(tag: string, scheme: TagScheme): ParsedTag | null {
  const match = /^([A-Za-z]+)([-\s]?)(\d+)$/.exec(tag.trim());
  if (!match) return null;
  const letters = match[1].toUpperCase();
  const separator = match[2];
  const number = match[3];
  if (scheme.kind === "structured") {
    if (number.length !== 2 + scheme.sequenceLength) return null;
    return {
      letters,
      separator,
      system: number[0],
      cls: number[1],
      sequence: Number(number.slice(2)),
      number
    };
  }
  return { letters, separator, sequence: Number(number), number };
}

export function validateTag(tag: string, scheme: TagScheme): { ok: boolean; reason?: string } {
  const parsed = parseTag(tag, scheme);
  if (!parsed) {
    return {
      ok: false,
      reason:
        scheme.kind === "structured"
          ? `Expected letters, "${scheme.separator}", then ${2 + scheme.sequenceLength} digits (system, class, sequence)`
          : `Expected letters, "${scheme.separator}", then a number`
    };
  }
  if (parsed.separator !== scheme.separator) {
    return { ok: false, reason: `Use "${scheme.separator || "no"}" separator between letters and number` };
  }
  if (scheme.strictLetters && scheme.functionLetters.length && !scheme.functionLetters.some((entry) => entry.letters === parsed.letters)) {
    return { ok: false, reason: `Letters ${parsed.letters} are not in the project's function letter table` };
  }
  if (scheme.kind === "structured") {
    if (scheme.systems.length && !scheme.systems.some((entry) => entry.digit === parsed.system)) {
      return { ok: false, reason: `System digit ${parsed.system} is not defined (${scheme.systems.map((entry) => `${entry.digit}=${entry.name}`).join(", ")})` };
    }
    if (scheme.classes.length && !scheme.classes.some((entry) => entry.digit === parsed.cls)) {
      return { ok: false, reason: `Class digit ${parsed.cls} is not defined (${scheme.classes.map((entry) => `${entry.digit}=${entry.name}`).join(", ")})` };
    }
  }
  return { ok: true };
}

export function formatTag(scheme: TagScheme, letters: string, sequence: number, context: TagContext = {}): string {
  if (scheme.kind === "structured") {
    const system = context.system ?? scheme.systems[0]?.digit ?? "0";
    const cls = context.cls ?? scheme.classes[0]?.digit ?? "1";
    return `${letters}${scheme.separator}${system}${cls}${String(sequence).padStart(scheme.sequenceLength, "0")}`;
  }
  return `${letters}${scheme.separator}${String(sequence).padStart(scheme.sequenceLength, "0")}`;
}

function taggedItems(doc: SchematicDocument): Array<{ id: string; tag: string; item: SymbolItem }> {
  return doc.items
    .filter((item): item is SymbolItem => item.kind === "symbol" && Boolean(item.tag))
    .map((item) => ({ id: item.id, tag: item.tag as string, item }));
}

/** Next free sequence for the letters (and system/class when structured). */
export function nextTag(doc: SchematicDocument, scheme: TagScheme, letters: string, context: TagContext = {}): string {
  const upper = letters.toUpperCase();
  const system = context.system ?? scheme.systems[0]?.digit ?? "0";
  const cls = context.cls ?? scheme.classes[0]?.digit ?? "1";
  let highest = 0;
  for (const { tag } of taggedItems(doc)) {
    const parsed = parseTag(tag, scheme);
    if (!parsed || parsed.letters !== upper) continue;
    if (scheme.kind === "structured" && (parsed.system !== system || parsed.cls !== cls)) continue;
    highest = Math.max(highest, parsed.sequence);
  }
  return formatTag(scheme, upper, highest + 1, { system, cls });
}

export type TagIssue = { itemId: string; tag: string; issue: "invalid" | "duplicate"; message: string };

/** Tags that do not parse under the scheme, and duplicates on the sheet. */
export function tagIssues(doc: SchematicDocument, scheme: TagScheme): TagIssue[] {
  const issues: TagIssue[] = [];
  const seen = new Map<string, string>();
  for (const { id, tag } of taggedItems(doc)) {
    const verdict = validateTag(tag, scheme);
    if (!verdict.ok) issues.push({ itemId: id, tag, issue: "invalid", message: verdict.reason ?? "Invalid tag" });
    const key = tag.replace(/[-\s]/g, "").toUpperCase();
    const previous = seen.get(key);
    if (previous) issues.push({ itemId: id, tag, issue: "duplicate", message: `Duplicate of ${previous}` });
    else seen.set(key, tag);
  }
  return issues;
}

/**
 * Re-sequence the selected symbols per letter group in reading order (top to
 * bottom, then left to right), starting at `startAt`. Unselected tags keep
 * their numbers; new numbers skip any that remain in use elsewhere.
 */
export function renumberCommand(
  doc: SchematicDocument,
  scheme: TagScheme,
  ids: string[],
  context: TagContext = {},
  startAt = 1
): Command {
  const selected = new Set(ids);
  const groups = new Map<string, Array<{ item: SymbolItem; parsed: ParsedTag }>>();
  const reserved = new Map<string, Set<number>>();
  for (const { item, tag } of taggedItems(doc)) {
    const parsed = parseTag(tag, scheme);
    if (!parsed) continue;
    const system = scheme.kind === "structured" ? (parsed.system ?? "") : "";
    const cls = scheme.kind === "structured" ? (parsed.cls ?? "") : "";
    const groupKey = `${parsed.letters}|${system}${cls}`;
    if (selected.has(item.id)) {
      const bucket = groups.get(groupKey) ?? [];
      bucket.push({ item, parsed });
      groups.set(groupKey, bucket);
    } else {
      const taken = reserved.get(groupKey) ?? new Set<number>();
      taken.add(parsed.sequence);
      reserved.set(groupKey, taken);
    }
  }
  const commands: Command[] = [];
  for (const [groupKey, entries] of groups) {
    entries.sort((a, b) => a.item.position.y - b.item.position.y || a.item.position.x - b.item.position.x);
    const taken = reserved.get(groupKey) ?? new Set<number>();
    let sequence = startAt;
    for (const entry of entries) {
      while (taken.has(sequence)) sequence += 1;
      const tag = formatTag(scheme, entry.parsed.letters, sequence, {
        system: entry.parsed.system ?? context.system,
        cls: entry.parsed.cls ?? context.cls
      });
      if (tag !== entry.item.tag) commands.push({ type: "update", id: entry.item.id, patch: { tag } });
      sequence += 1;
    }
  }
  return { type: "batch", commands, label: "Renumber" };
}

export function normalizeScheme(raw: unknown): TagScheme {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<TagScheme>;
  return {
    ...DEFAULT_TAG_SCHEME,
    ...source,
    kind: source.kind === "structured" ? "structured" : "simple",
    separator: typeof source.separator === "string" ? source.separator : "-",
    functionLetters: Array.isArray(source.functionLetters) ? source.functionLetters : DEFAULT_FUNCTION_LETTERS,
    firstLetters: Array.isArray(source.firstLetters) && source.firstLetters.length ? source.firstLetters : ISA_FIRST_LETTERS,
    succeedingLetters: Array.isArray(source.succeedingLetters) && source.succeedingLetters.length ? source.succeedingLetters : ISA_SUCCEEDING_LETTERS,
    systems: Array.isArray(source.systems) ? source.systems : [],
    classes: Array.isArray(source.classes) ? source.classes : [],
    sequenceLength: Number.isInteger(source.sequenceLength) && Number(source.sequenceLength) > 0 ? Number(source.sequenceLength) : 1,
    strictLetters: Boolean(source.strictLetters)
  };
}

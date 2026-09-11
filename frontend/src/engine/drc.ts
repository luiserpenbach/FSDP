/**
 * Design rule checks over a sheet document and its connectivity.
 *
 * Rules are pure functions of the document, the symbol library, the tag
 * scheme, the catalog parts referenced by items, and the project's
 * requirement constraints. Findings carry a stable key so a waiver stored on
 * the server survives re-runs, and an item id and zone so the panel can jump
 * to them on the sheet. Requirement constraints are evaluated as rules and
 * also reported per item (pass or fail) for the verification matrix.
 */
import { computeConnectivity, indexPorts, type Connectivity, type LineEnd } from "./connectivity";
import { polylineLength } from "./geometry";
import type { SymbolRegistry } from "./library";
import { pointAlong } from "./lines";
import { partWarnings, pressureToBar, type PartLike } from "./parts";
import { zoneAt } from "./sheet";
import { sizesDiffer } from "./sizes";
import { tagIssues, type TagScheme } from "./tags";
import type { EquipmentItem, Item, LineItem, SchematicDocument, SymbolItem } from "./types";

export type DrcSeverity = "error" | "warning" | "info";

export type DrcFinding = {
  /** Stable identity for waivers: `${rule}:${subject}`. */
  key: string;
  rule: string;
  severity: DrcSeverity;
  message: string;
  itemId: string | null;
  /** Tag, line number, or name of the subject when it has one. */
  subject: string | null;
  zone: string | null;
  /** Set on requirement findings. */
  requirementId?: string;
};

export type DrcWaiver = { key: string; reason: string; by?: string | null; at?: string | null };

export type RequirementConstraintKind =
  | "material_in"
  | "material_not_in"
  | "pressure_rating_min"
  | "part_qualified"
  | "line_class_in"
  | "relief_required";

export type RequirementConstraint = {
  kind: RequirementConstraintKind;
  /** Allowed / forbidden values, or a single number for rating minimums (bar). */
  values: string[];
  scope?: {
    /** Symbol categories in scope (default: valve, regulator, inline, instrument, equipment). */
    categories?: string[];
    /** Only items touched by lines of these services. */
    services?: string[];
  };
};

export type RequirementRef = { id: string; key: string; title: string; constraint: RequirementConstraint | null };

export type RequirementCheck = {
  requirementId: string;
  itemId: string;
  subject: string | null;
  zone: string | null;
  status: "pass" | "fail";
  message: string;
};

export type DrcInput = {
  doc: SchematicDocument;
  registry: SymbolRegistry;
  connectivity?: Connectivity;
  tagScheme: TagScheme;
  /** Catalog parts by id (only those referenced need to be present). */
  parts?: Map<string, PartLike>;
  requirements?: RequirementRef[];
  waivers?: DrcWaiver[];
};

export type DrcResult = {
  /** Open findings (not waived), errors first. */
  findings: DrcFinding[];
  /** Findings that a stored waiver covers. */
  waived: Array<DrcFinding & { waiver: DrcWaiver }>;
  requirementChecks: RequirementCheck[];
  counts: Record<DrcSeverity, number> & { waived: number };
};

export const DRC_RULES: Record<string, { title: string; description: string }> = {
  dangling_line: { title: "Dangling line", description: "A line end touches neither a port nor another line." },
  open_port: { title: "Open process port", description: "A process port or nozzle has no line attached." },
  duplicate_tag: { title: "Duplicate tag", description: "Two items on the sheet carry the same tag." },
  invalid_tag: { title: "Tag scheme", description: "A tag does not follow the project tag scheme." },
  missing_tag: { title: "Untagged item", description: "A valve, regulator, or instrument has no tag." },
  line_unnumbered: { title: "Unnumbered line", description: "A process line carries no line number." },
  line_missing_size: { title: "Line without size", description: "A numbered line has no size." },
  line_missing_spec: { title: "Line without spec", description: "A numbered line has neither a spec nor a line class." },
  port_size_mismatch: { title: "Port size mismatch", description: "A line's size differs from the port or nozzle it connects to." },
  size_change_missing: { title: "Size change not marked", description: "Two joined lines differ in size with no size-change marker." },
  spec_break_missing: { title: "Spec break not marked", description: "Two joined lines differ in spec or class with no spec break." },
  part_status: { title: "Part status", description: "An assigned part is obsolete, restricted, draft, or unqualified." },
  part_rating: { title: "Part rating", description: "An assigned part is rated below the connected line's design pressure." },
  part_missing: { title: "Part not in catalog", description: "An item references a part id that is not in the catalog." },
  relief_coverage: { title: "Relief coverage", description: "An isolable volume has no relief device." },
  required_fields: { title: "Required fields", description: "A symbol field defined by the library has no value." },
  requirement: { title: "Requirement", description: "A requirement constraint is violated." }
};

const SEVERITY_ORDER: Record<DrcSeverity, number> = { error: 0, warning: 1, info: 2 };
const TAGGED_CATEGORIES = new Set(["valve", "regulator", "instrument"]);
const DEFAULT_SCOPE_CATEGORIES = ["valve", "regulator", "inline", "instrument", "equipment"];
const RELIEF_KEYS = new Set(["relief_valve", "safety_valve", "rupture_disc"]);
const OPEN_KEYS = new Set(["vent_atmosphere", "drain"]);
const PROCESS_LINE_TYPES = new Set(["process", "vacuum", "capillary"]);
const STUB_MM = 25;

function caption(item: Item | undefined): string | null {
  if (!item) return null;
  if (item.kind === "symbol") return item.tag ?? item.label ?? null;
  if (item.kind === "equipment") return item.tag ?? item.name;
  if (item.kind === "line") return item.lineNumber ?? null;
  return null;
}

function describe(item: Item | undefined): string {
  if (!item) return "item";
  const text = caption(item);
  if (text) return item.kind === "line" ? `line ${text}` : text;
  if (item.kind === "symbol") return item.symbol.key;
  return item.kind;
}

function anchor(item: Item): { x: number; y: number } {
  if (item.kind === "line") return pointAlong(item.points, 0.5)?.point ?? item.points[0];
  if (item.kind === "equipment") return { x: item.position.x + item.size.width / 2, y: item.position.y + item.size.height / 2 };
  return item.position;
}

function isRelief(item: SymbolItem): boolean {
  return RELIEF_KEYS.has(item.symbol.key);
}

class Union {
  private parent = new Map<string, string>();
  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Isolable volumes: process nets joined through non-isolating devices and equipment. */
export type Volume = { id: string; lineIds: string[]; itemIds: string[]; isolable: boolean; relieved: boolean };

export function isolableVolumes(doc: SchematicDocument, registry: SymbolRegistry, connectivity: Connectivity): Volume[] {
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const processNets = new Set<string>();
  for (const net of connectivity.nets) {
    const first = net.lineIds.map((id) => byId.get(id)).find((item): item is LineItem => item?.kind === "line");
    if (first && PROCESS_LINE_TYPES.has(first.lineType)) processNets.add(net.id);
  }
  const union = new Union();
  const netsOfItem = new Map<string, Set<string>>();
  for (const [key, netId] of connectivity.portNet) {
    if (!processNets.has(netId)) continue;
    const itemId = key.slice(0, key.lastIndexOf(":"));
    const set = netsOfItem.get(itemId) ?? new Set<string>();
    set.add(netId);
    netsOfItem.set(itemId, set);
  }
  const isolating = new Set<string>();
  const relieving = new Set<string>();
  const open = new Set<string>();
  for (const [itemId, nets] of netsOfItem) {
    const item = byId.get(itemId);
    if (!item) continue;
    let passThrough = true;
    if (item.kind === "symbol") {
      const definition = registry.has(item.symbol) ? registry.resolve(item.symbol) : null;
      if (isRelief(item)) {
        relieving.add(itemId);
        passThrough = false;
      } else if (OPEN_KEYS.has(item.symbol.key)) {
        open.add(itemId);
        passThrough = false;
      } else if (definition?.category === "valve" || definition?.category === "regulator") {
        isolating.add(itemId);
        passThrough = false;
      }
    }
    if (passThrough) {
      const list = [...nets];
      for (let index = 1; index < list.length; index += 1) union.union(list[0], list[index]);
    }
  }
  const groups = new Map<string, { nets: Set<string>; items: Set<string> }>();
  for (const netId of processNets) {
    const root = union.find(netId);
    const group = groups.get(root) ?? { nets: new Set<string>(), items: new Set<string>() };
    group.nets.add(netId);
    groups.set(root, group);
  }
  for (const [itemId, nets] of netsOfItem) for (const netId of nets) groups.get(union.find(netId))?.items.add(itemId);
  const volumes: Volume[] = [];
  for (const [root, group] of groups) {
    const lineIds = connectivity.nets.filter((net) => group.nets.has(net.id)).flatMap((net) => net.lineIds);
    const items = [...group.items];
    volumes.push({
      id: root,
      lineIds,
      itemIds: items,
      isolable: items.some((id) => isolating.has(id)) && !items.some((id) => open.has(id)),
      relieved: items.some((id) => relieving.has(id))
    });
  }
  return volumes;
}

function withinScope(item: SymbolItem | EquipmentItem, registry: SymbolRegistry, scope: RequirementConstraint["scope"], servicesOf: (id: string) => string[]): boolean {
  const categories = scope?.categories?.length ? scope.categories : DEFAULT_SCOPE_CATEGORIES;
  const category = item.kind === "symbol" ? (registry.has(item.symbol) ? registry.resolve(item.symbol).category : "custom") : "equipment";
  if (!categories.includes(category)) return false;
  if (scope?.services?.length) {
    const wanted = scope.services.map((service) => service.toLowerCase());
    if (!servicesOf(item.id).some((service) => wanted.includes(service.toLowerCase()))) return false;
  }
  return true;
}

/** Run every rule and requirement constraint over the sheet. */
export function runDrc(input: DrcInput): DrcResult {
  const { doc, registry, tagScheme } = input;
  const connectivity = input.connectivity ?? computeConnectivity(doc, registry);
  const parts = input.parts ?? new Map<string, PartLike>();
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const findings: DrcFinding[] = [];
  const zoneOf = (item: Item | undefined): string | null => (item ? zoneAt(doc.sheet, anchor(item)) : null);
  const add = (rule: string, severity: DrcSeverity, item: Item | undefined, message: string, subjectKey?: string, extra: Partial<DrcFinding> = {}) => {
    findings.push({
      key: `${rule}:${subjectKey ?? item?.id ?? "sheet"}`,
      rule,
      severity,
      message,
      itemId: item?.id ?? null,
      subject: caption(item),
      zone: zoneOf(item),
      ...extra
    });
  };

  // Lines touching each item's ports.
  const linesByItem = new Map<string, LineItem[]>();
  const endsByLine = new Map<string, LineEnd[]>();
  for (const end of connectivity.lineEnds) {
    endsByLine.set(end.lineId, [...(endsByLine.get(end.lineId) ?? []), end]);
    const line = byId.get(end.lineId);
    if (line?.kind !== "line") continue;
    for (const attachment of end.attachments) {
      if (attachment.kind !== "port") continue;
      const list = linesByItem.get(attachment.itemId) ?? [];
      if (!list.includes(line)) list.push(line);
      linesByItem.set(attachment.itemId, list);
    }
  }
  const servicesOf = (itemId: string): string[] => [...new Set((linesByItem.get(itemId) ?? []).map((line) => line.service?.trim()).filter((service): service is string => Boolean(service)))];
  const ports = new Map(indexPorts(doc, registry).map((port) => [`${port.itemId}:${port.id}`, port]));

  // ---- connectivity ----
  for (const end of connectivity.danglingEnds) {
    const line = byId.get(end.lineId);
    add("dangling_line", "error", line, `${describe(line)} end ${end.end === 0 ? "start" : "finish"} at (${end.position.x}, ${end.position.y}) mm is not connected`, `${end.lineId}:${end.end}`);
  }
  for (const port of connectivity.openPorts) {
    if (port.kind !== "process" && port.kind !== "nozzle") continue;
    const item = byId.get(port.itemId);
    if (item?.kind === "symbol" && registry.has(item.symbol) && registry.resolve(item.symbol).category === "connector") continue;
    // Relief outlets vent to atmosphere without a drawn line.
    if (item?.kind === "symbol" && isRelief(item) && port.id === "vent") continue;
    add("open_port", "warning", item, `${describe(item)} port ${port.id} has no line`, `${port.itemId}:${port.id}`);
  }

  // ---- tags ----
  for (const issue of tagIssues(doc, tagScheme)) {
    const item = byId.get(issue.itemId);
    if (issue.issue === "duplicate") add("duplicate_tag", "error", item, `${issue.tag}: ${issue.message}`);
    else add("invalid_tag", "warning", item, `${issue.tag}: ${issue.message}`);
  }
  for (const item of doc.items) {
    if (item.kind !== "symbol" || item.tag || !registry.has(item.symbol)) continue;
    const definition = registry.resolve(item.symbol);
    if (TAGGED_CATEGORIES.has(definition.category)) add("missing_tag", "warning", item, `${definition.name} at (${item.position.x}, ${item.position.y}) mm has no tag`);
  }

  // ---- lines ----
  for (const item of doc.items) {
    if (item.kind !== "line" || !PROCESS_LINE_TYPES.has(item.lineType)) continue;
    const hasData = Boolean(item.size || item.spec || item.lineClass || item.service);
    if (!item.lineNumber) {
      if (polylineLength(item.points) >= STUB_MM || hasData) add("line_unnumbered", "warning", item, `Process line from (${item.points[0].x}, ${item.points[0].y}) mm has no line number`);
      continue;
    }
    if (!item.size) add("line_missing_size", "warning", item, `Line ${item.lineNumber} has no size`);
    if (!item.spec && !item.lineClass) add("line_missing_spec", "warning", item, `Line ${item.lineNumber} has no spec or line class`);
  }
  const joinsSeen = new Set<string>();
  for (const [lineId, ends] of endsByLine) {
    const line = byId.get(lineId);
    if (line?.kind !== "line") continue;
    for (const end of ends) {
      for (const attachment of end.attachments) {
        if (attachment.kind === "port") {
          const port = ports.get(`${attachment.itemId}:${attachment.portId}`);
          if (port?.size && line.size && sizesDiffer(line.size, port.size)) {
            add("port_size_mismatch", "error", line, `${describe(line)} (${line.size}) connects to ${describe(byId.get(attachment.itemId))} port ${attachment.portId} (${port.size})`, `${lineId}:${end.end}`);
          }
        } else {
          const pair = [line.id, attachment.lineId].sort().join(":");
          if (joinsSeen.has(pair)) continue;
          joinsSeen.add(pair);
          const other = byId.get(attachment.lineId);
          if (other?.kind !== "line") continue;
          const marked = (kind: "size_change" | "spec_break") => [line, other].some((entry) => entry.annotations?.some((annotation) => annotation.kind === kind));
          if (line.size && other.size && sizesDiffer(line.size, other.size) && !marked("size_change")) {
            add("size_change_missing", "warning", line, `${describe(line)} (${line.size}) joins ${describe(other)} (${other.size}) without a size-change marker`, pair);
          }
          const specA = line.lineClass ?? line.spec;
          const specB = other.lineClass ?? other.spec;
          if (specA && specB && specA !== specB && !marked("spec_break")) {
            add("spec_break_missing", "warning", line, `${describe(line)} (${specA}) joins ${describe(other)} (${specB}) without a spec break`, pair);
          }
        }
      }
    }
  }

  // ---- parts ----
  for (const item of doc.items) {
    if (item.kind !== "symbol" && item.kind !== "equipment") continue;
    if (!item.partId) continue;
    const part = parts.get(item.partId);
    if (!part) {
      add("part_missing", "warning", item, `${describe(item)} references part ${item.partId}, which is not in the catalog`);
      continue;
    }
    if (part.lifecycle_status === "obsolete" || part.lifecycle_status === "restricted") {
      add("part_status", "error", item, `${describe(item)} uses ${part.part_number}, which is ${part.lifecycle_status}`);
    } else if (part.lifecycle_status === "draft" || (!part.preferred && part.qualification_status !== "qualified")) {
      add("part_status", "warning", item, `${describe(item)} uses ${part.part_number}, which is ${part.lifecycle_status === "draft" ? "a draft" : "not qualified"}`);
    }
    const rating = partWarnings(part, linesByItem.get(item.id) ?? []).find((warning) => warning.startsWith("Rated"));
    if (rating) add("part_rating", "warning", item, `${describe(item)} uses ${part.part_number}: ${rating}`);
  }

  // ---- relief coverage ----
  const volumes = isolableVolumes(doc, registry, connectivity);
  const volumeLines = (volume: Volume) => volume.lineIds.map((id) => byId.get(id)).filter((item): item is LineItem => item?.kind === "line");
  const volumeName = (volume: Volume) => {
    const lines = volumeLines(volume);
    const names = [...lines.map((line) => line.lineNumber).filter(Boolean), ...volume.itemIds.map((id) => caption(byId.get(id))).filter(Boolean)];
    return names.slice(0, 6).join(", ") || `${lines.length} line(s)`;
  };
  for (const volume of volumes) {
    if (!volume.isolable || volume.relieved) continue;
    add("relief_coverage", "warning", volumeLines(volume)[0], `Isolable volume (${volumeName(volume)}) has no relief device`, volume.lineIds.slice().sort()[0]);
  }

  // ---- required fields ----
  for (const item of doc.items) {
    if (item.kind !== "symbol" || !registry.has(item.symbol)) continue;
    const definition = registry.resolve(item.symbol);
    for (const field of definition.fields ?? []) {
      const value = item.fields[field.key];
      if (value === undefined || value === null || value === "") add("required_fields", "info", item, `${describe(item)} has no ${field.label}`, `${item.id}:${field.key}`);
    }
  }

  // ---- requirement constraints ----
  const requirementChecks: RequirementCheck[] = [];
  for (const requirement of input.requirements ?? []) {
    const constraint = requirement.constraint;
    if (!constraint) continue;
    const label = `${requirement.key} (${requirement.title})`;
    const check = (item: Item, status: "pass" | "fail", message: string, subject?: string) => {
      requirementChecks.push({ requirementId: requirement.id, itemId: item.id, subject: subject ?? caption(item), zone: zoneOf(item), status, message });
      if (status === "fail") add("requirement", "error", item, `${label}: ${message}`, `${requirement.id}:${item.id}`, { requirementId: requirement.id });
    };
    const values = constraint.values.map((value) => value.trim()).filter(Boolean);
    const lower = values.map((value) => value.toLowerCase());
    if (constraint.kind === "line_class_in") {
      for (const item of doc.items) {
        if (item.kind !== "line" || !PROCESS_LINE_TYPES.has(item.lineType) || !item.lineNumber) continue;
        if (constraint.scope?.services?.length && !constraint.scope.services.map((service) => service.toLowerCase()).includes((item.service ?? "").toLowerCase())) continue;
        const cls = item.lineClass ?? item.spec ?? "";
        if (cls && lower.includes(cls.toLowerCase())) check(item, "pass", `line ${item.lineNumber} uses ${cls}`);
        else check(item, "fail", `line ${item.lineNumber} uses ${cls || "no class"}, expected one of ${values.join(", ")}`);
      }
      continue;
    }
    if (constraint.kind === "relief_required") {
      for (const volume of volumes) {
        if (!volume.isolable) continue;
        const first = volumeLines(volume)[0];
        if (!first) continue;
        const names = volumeName(volume);
        check(first, volume.relieved ? "pass" : "fail", volume.relieved ? `volume (${names}) is relieved` : `isolable volume (${names}) has no relief device`, names);
      }
      continue;
    }
    for (const item of doc.items) {
      if (item.kind !== "symbol" && item.kind !== "equipment") continue;
      if (!withinScope(item, registry, constraint.scope, servicesOf)) continue;
      if (!item.partId) continue;
      const part = parts.get(item.partId);
      if (!part) continue;
      const material = (part.material ?? "").toLowerCase();
      switch (constraint.kind) {
        case "material_in": {
          const ok = lower.some((value) => material.includes(value));
          check(item, ok ? "pass" : "fail", ok ? `${part.part_number} material ${part.material}` : `${part.part_number} material ${part.material || "unknown"} is not one of ${values.join(", ")}`);
          break;
        }
        case "material_not_in": {
          const hit = lower.find((value) => material && material.includes(value));
          check(item, hit ? "fail" : "pass", hit ? `${part.part_number} material ${part.material} is forbidden (${hit})` : `${part.part_number} material ${part.material || "unknown"}`);
          break;
        }
        case "pressure_rating_min": {
          const minimum = pressureToBar(values[0]) ?? Number(values[0]);
          const rating = part.pressure_rating_bar ?? null;
          const ok = rating !== null && Number.isFinite(minimum) && rating >= minimum;
          check(item, ok ? "pass" : "fail", ok ? `${part.part_number} rated ${rating} bar` : `${part.part_number} rated ${rating ?? "unknown"} bar, below ${values[0]}`);
          break;
        }
        case "part_qualified": {
          const ok = Boolean(part.preferred || part.qualification_status === "qualified") && part.lifecycle_status !== "obsolete" && part.lifecycle_status !== "restricted";
          check(item, ok ? "pass" : "fail", ok ? `${part.part_number} is qualified` : `${part.part_number} is ${part.lifecycle_status === "active" ? part.qualification_status : part.lifecycle_status}`);
          break;
        }
        default:
          break;
      }
    }
  }

  // ---- waivers and ordering ----
  const waivers = new Map((input.waivers ?? []).map((waiver) => [waiver.key, waiver]));
  const open: DrcFinding[] = [];
  const waived: Array<DrcFinding & { waiver: DrcWaiver }> = [];
  for (const finding of findings) {
    const waiver = waivers.get(finding.key);
    if (waiver) waived.push({ ...finding, waiver });
    else open.push(finding);
  }
  const order = (a: DrcFinding, b: DrcFinding) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule) || (a.subject ?? "").localeCompare(b.subject ?? "");
  open.sort(order);
  waived.sort(order);
  const counts = { error: 0, warning: 0, info: 0, waived: waived.length };
  for (const finding of open) counts[finding.severity] += 1;
  return { findings: open, waived, requirementChecks, counts };
}

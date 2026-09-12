/**
 * Isolable volumes: process nets joined through pass-through devices and
 * equipment, bounded by isolating items (valves, regulators), relieved when
 * a relief device sits on them, and open when a vent or drain does.
 *
 * A volume's key is derived from its sorted line ids, so it is stable across
 * saves while the same lines make up the volume; hazards, FMEA rows, and
 * analyses reference volumes by key.
 */
import type { Connectivity } from "./connectivity";
import { polylineLength } from "./geometry";
import type { SymbolRegistry } from "./library";
import { lineLengthM } from "./index";
import type { LineItem, SchematicDocument, SymbolItem } from "./types";

export const RELIEF_KEYS = new Set(["relief_valve", "safety_valve", "rupture_disc"]);
export const OPEN_KEYS = new Set(["vent_atmosphere", "drain"]);
export const PROCESS_LINE_TYPES = new Set(["process", "vacuum", "capillary"]);

export type Volume = { id: string; lineIds: string[]; itemIds: string[]; isolable: boolean; relieved: boolean };

export type SheetIndexVolume = {
  key: string;
  line_ids: string[];
  item_ids: string[];
  isolable: boolean;
  relieved: boolean;
  relief_item_ids: string[];
  isolating_item_ids: string[];
  service: string | null;
  design_pressure: string | null;
  design_temperature: string | null;
  line_numbers: string[];
  length_m: number;
};

export function isRelief(item: SymbolItem): boolean {
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

/** Short stable hash of the sorted line ids (FNV-1a, 32-bit, hex). */
export function volumeKey(lineIds: string[]): string {
  const text = [...lineIds].sort().join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `vol-${hash.toString(16).padStart(8, "0")}`;
}

function mostCommon(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    const text = (value ?? "").trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Volumes as index rows, with service and design conditions from their lines. */
export function describeVolumes(doc: SchematicDocument, registry: SymbolRegistry, connectivity: Connectivity): SheetIndexVolume[] {
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  return isolableVolumes(doc, registry, connectivity).map((volume) => {
    const lines = volume.lineIds.map((id) => byId.get(id)).filter((item): item is LineItem => item?.kind === "line");
    const items = volume.itemIds.map((id) => byId.get(id)).filter((item): item is SymbolItem => item?.kind === "symbol");
    const definitionCategory = (item: SymbolItem) => (registry.has(item.symbol) ? registry.resolve(item.symbol).category : null);
    return {
      key: volumeKey(volume.lineIds),
      line_ids: [...volume.lineIds].sort(),
      item_ids: [...volume.itemIds].sort(),
      isolable: volume.isolable,
      relieved: volume.relieved,
      relief_item_ids: items.filter(isRelief).map((item) => item.id),
      isolating_item_ids: items.filter((item) => !isRelief(item) && !OPEN_KEYS.has(item.symbol.key) && (definitionCategory(item) === "valve" || definitionCategory(item) === "regulator")).map((item) => item.id),
      service: mostCommon(lines.map((line) => line.service)),
      design_pressure: mostCommon(lines.map((line) => line.designPressure)),
      design_temperature: mostCommon(lines.map((line) => line.designTemperature)),
      line_numbers: lines.map((line) => (line.lineNumber ?? "").trim()).filter(Boolean).sort(),
      length_m: Math.round(lines.reduce((total, line) => total + lineLengthM(line, polylineLength(line.points)), 0) * 1000) / 1000
    };
  });
}

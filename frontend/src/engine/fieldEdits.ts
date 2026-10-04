/**
 * Field edits: the pure "set these fields on these items" step behind the
 * lists drawer's inline editing, paste from Excel, and the bulk actions (in
 * the drawer and in the canvas multi-select inspector).
 *
 * `planFieldEdits` validates every edit against the document and the project
 * rules and returns one batch command (one undo step) plus per-edit errors:
 *
 *  - tags must follow the project tag scheme and must not repeat a tag on the
 *    sheet or on the drawing's other sheets (`reservedTags`); a rejected tag
 *    is reported, never written,
 *  - parts must exist in the catalog (when one is given) and must not be obsolete,
 *  - line classes must be project line classes (when any are defined); setting
 *    one also applies its spec and insulation, like the inspector does.
 *
 * The open sheet dispatches the command through the editor (undoable, marks
 * the sheet dirty); another sheet of the drawing applies it to its stored
 * document with `applyFieldEdits` before re-deriving and saving that sheet.
 */
import { applyCommand, type Command } from "./commands";
import type { PartLike } from "./parts";
import { tagKey, validateTag, type TagScheme } from "./tags";
import type { EquipmentItem, FieldValue, Item, LineItem, SchematicDocument, SymbolItem } from "./types";

/** Symbol / equipment fields. `name` is the equipment name, or the label of a symbol. */
export type ItemEditField = "tag" | "name" | "partId" | "dnp" | "spare" | "notes" | "mounting";

export type LineEditField =
  | "lineNumber"
  | "lineClass"
  | "service"
  | "size"
  | "spec"
  | "designPressure"
  | "designTemperature"
  | "operatingPressure"
  | "operatingTemperature"
  | "insulation"
  | "tracing";

export type EditField = ItemEditField | LineEditField;

export const ITEM_EDIT_FIELDS: readonly ItemEditField[] = ["tag", "name", "partId", "dnp", "spare", "notes", "mounting"];
export const LINE_EDIT_FIELDS: readonly LineEditField[] = [
  "lineNumber",
  "lineClass",
  "service",
  "size",
  "spec",
  "designPressure",
  "designTemperature",
  "operatingPressure",
  "operatingTemperature",
  "insulation",
  "tracing"
];

export type FieldEdit = { itemId: string; field: EditField; value: FieldValue | undefined };

export type FieldEditError = { itemId: string; field: EditField; message: string };

/** Minimal line class shape (mirrors `LineClass` in the app types). */
export type LineClassLike = {
  name: string;
  material?: string | null;
  wall?: string | null;
  insulation?: string | null;
  sizes?: string[];
};

export type FieldEditOptions = {
  tagScheme: TagScheme;
  /** Tags used on the drawing's other sheets: writing one of them here is refused as a duplicate. */
  reservedTags?: Iterable<string>;
  /** Project line classes. When non-empty, `lineClass` must name one of them. */
  lineClasses?: readonly LineClassLike[];
  /** Catalog parts by id. When given, `partId` must name one of them. */
  parts?: ReadonlyMap<string, PartLike>;
};

export type FieldEditPlan = {
  /** One batch of `update` commands (empty when nothing changes). */
  command: Command;
  errors: FieldEditError[];
  /** Edits that were accepted (they may still be no-ops). */
  applied: FieldEdit[];
};

const ITEM_FIELDS = new Set<string>(ITEM_EDIT_FIELDS);
const LINE_FIELDS = new Set<string>(LINE_EDIT_FIELDS);

type TaggedItem = SymbolItem | EquipmentItem;

function isTagged(item: Item): item is TaggedItem {
  return item.kind === "symbol" || item.kind === "equipment";
}

/** Trimmed text, or undefined when blank. */
function text(value: FieldValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const result = String(value).trim();
  return result ? result : undefined;
}

/** Spec text a line class implies ("316L x 0.035 WALL"), as the line inspector writes it. */
export function lineClassSpec(lineClass: LineClassLike): string | undefined {
  return [lineClass.material, lineClass.wall ? `x ${lineClass.wall} WALL` : ""].filter(Boolean).join(" ") || undefined;
}

/**
 * Patch for setting (or clearing, with null) a line's class: the class name,
 * its spec and its insulation. Size is left alone: a class with other sizes
 * is a review finding, not a silent rewrite.
 */
export function lineClassPatch(line: LineItem, lineClass: LineClassLike | null): Record<string, unknown> {
  if (!lineClass) return { lineClass: undefined };
  return {
    lineClass: lineClass.name,
    spec: lineClassSpec(lineClass) ?? line.spec,
    insulation: lineClass.insulation ?? line.insulation
  };
}

type TagEdit = { edit: FieldEdit; item: TaggedItem; tag: string | undefined };

type Pending = { item: Item; patch: Record<string, unknown>; fields?: Record<string, FieldValue> };

/** Validate and plan `edits` against `doc`. Pure: `doc` is not changed. */
export function planFieldEdits(doc: SchematicDocument, edits: readonly FieldEdit[], options: FieldEditOptions): FieldEditPlan {
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const errors: FieldEditError[] = [];
  const applied: FieldEdit[] = [];
  const pending = new Map<string, Pending>();
  const tagEdits: TagEdit[] = [];
  const lineClasses = options.lineClasses ?? [];
  const fail = (edit: FieldEdit, message: string) => errors.push({ itemId: edit.itemId, field: edit.field, message });
  const entry = (item: Item): Pending => {
    let found = pending.get(item.id);
    if (!found) {
      found = { item, patch: {} };
      pending.set(item.id, found);
    }
    return found;
  };
  const setField = (item: Item & { fields: Record<string, FieldValue> }, key: string, value: FieldValue | undefined) => {
    const target = entry(item);
    const fields = target.fields ?? { ...item.fields };
    const cleaned = text(value);
    if (cleaned === undefined) delete fields[key];
    else fields[key] = cleaned;
    target.fields = fields;
  };

  // A line class sets spec and insulation; explicit spec / insulation edits in the same batch win.
  const ordered = [...edits].sort((a, b) => Number(b.field === "lineClass") - Number(a.field === "lineClass"));
  for (const edit of ordered) {
    const item = byId.get(edit.itemId);
    if (!item) {
      fail(edit, "Item is no longer on the sheet.");
      continue;
    }
    if (ITEM_FIELDS.has(edit.field) && !isTagged(item)) {
      fail(edit, "Only symbols and equipment have this field.");
      continue;
    }
    if (LINE_FIELDS.has(edit.field) && item.kind !== "line") {
      fail(edit, "Only lines have this field.");
      continue;
    }
    if (!ITEM_FIELDS.has(edit.field) && !LINE_FIELDS.has(edit.field)) {
      fail(edit, `Field ${edit.field} cannot be edited here.`);
      continue;
    }
    if (isTagged(item)) {
      switch (edit.field as ItemEditField) {
        case "tag": {
          const tag = text(edit.value);
          if (tag) {
            const verdict = validateTag(tag, options.tagScheme);
            if (!verdict.ok) {
              fail(edit, `${tag}: ${verdict.reason ?? "does not follow the tag scheme"}`);
              continue;
            }
          }
          tagEdits.push({ edit, item, tag });
          continue;
        }
        case "name": {
          const name = text(edit.value);
          if (item.kind === "equipment") {
            if (!name) {
              fail(edit, "Equipment needs a name.");
              continue;
            }
            entry(item).patch.name = name;
          } else {
            entry(item).patch.label = name;
          }
          break;
        }
        case "partId": {
          const partId = text(edit.value);
          if (partId && options.parts) {
            const part = options.parts.get(partId);
            if (!part) {
              fail(edit, "Unknown part.");
              continue;
            }
            if (part.lifecycle_status === "obsolete") {
              fail(edit, `${part.part_number} is obsolete and cannot be assigned. Pick an alternate.`);
              continue;
            }
          }
          entry(item).patch.partId = partId ?? null;
          break;
        }
        case "dnp": {
          const value = edit.value;
          const on = value === true || (typeof value === "string" && /^(true|yes|y|1|x|dnp)$/i.test(value.trim()));
          entry(item).patch.dnp = on || undefined;
          break;
        }
        case "spare": {
          const value = edit.value === null || edit.value === undefined || edit.value === "" ? 0 : Number(edit.value);
          if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
            fail(edit, "Spares must be a whole number of 0 or more.");
            continue;
          }
          entry(item).patch.spare = value || undefined;
          break;
        }
        case "notes":
        case "mounting":
          setField(item, edit.field, edit.value);
          break;
      }
      applied.push(edit);
      continue;
    }
    if (item.kind !== "line") continue;
    const field = edit.field as LineEditField;
    if (field === "lineClass") {
      const name = text(edit.value);
      let chosen: LineClassLike | null = null;
      if (name) {
        chosen = lineClasses.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null;
        if (!chosen && lineClasses.length) {
          fail(edit, `${name} is not a project line class.`);
          continue;
        }
        chosen ??= { name };
      }
      Object.assign(entry(item).patch, lineClassPatch(item, chosen));
    } else {
      entry(item).patch[field] = text(edit.value);
    }
    applied.push(edit);
  }

  // Tags: refuse a tag already used by another item on this sheet (after the
  // batch), by an earlier edit of the batch, or on another sheet. Swaps
  // within one batch are fine. Refusing an edit keeps that item's old tag,
  // which can collide with an accepted edit, so settle until stable.
  const reserved = new Map<string, string>();
  for (const tag of options.reservedTags ?? []) if (!reserved.has(tagKey(tag))) reserved.set(tagKey(tag), tag);
  // The last tag edit of an item wins.
  const lastTag = new Map<string, TagEdit>();
  for (const tagEdit of tagEdits) lastTag.set(tagEdit.item.id, tagEdit);
  let accepted = [...lastTag.values()];
  const refused = new Map<string, string>();
  for (;;) {
    const editedIds = new Set(accepted.map((tagEdit) => tagEdit.item.id));
    const kept = new Map<string, string>();
    for (const item of doc.items) if (isTagged(item) && item.tag && !editedIds.has(item.id)) kept.set(tagKey(item.tag), item.tag);
    const claimed = new Map<string, string>();
    const newlyRefused = new Set<string>();
    for (const tagEdit of accepted) {
      if (!tagEdit.tag) continue;
      const key = tagKey(tagEdit.tag);
      const onSheet = kept.get(key) ?? claimed.get(key);
      const elsewhere = reserved.get(key);
      if (onSheet) refused.set(tagEdit.item.id, `${tagEdit.tag} is already used on this sheet (${onSheet}).`);
      else if (elsewhere) refused.set(tagEdit.item.id, `${tagEdit.tag} is already used on another sheet of this drawing (${elsewhere}).`);
      else {
        claimed.set(key, tagEdit.tag);
        continue;
      }
      newlyRefused.add(tagEdit.item.id);
    }
    if (!newlyRefused.size) break;
    accepted = accepted.filter((tagEdit) => !newlyRefused.has(tagEdit.item.id));
  }
  for (const tagEdit of tagEdits) {
    const message = refused.get(tagEdit.item.id);
    if (message) fail(tagEdit.edit, message);
    else applied.push(tagEdit.edit);
  }
  for (const tagEdit of accepted) entry(tagEdit.item).patch.tag = tagEdit.tag;

  const commands: Command[] = [];
  for (const { item, patch, fields } of pending.values()) {
    const full: Record<string, unknown> = fields ? { ...patch, fields } : patch;
    const current = item as unknown as Record<string, unknown>;
    const changed = Object.keys(full).some((key) => (key === "fields" ? JSON.stringify(current.fields ?? {}) !== JSON.stringify(full.fields) : (current[key] ?? undefined) !== (full[key] ?? undefined)));
    if (changed) commands.push({ type: "update", id: item.id, patch: full });
  }
  return { command: { type: "batch", commands, label: "Edit fields" }, errors, applied };
}

/** Plan and apply `edits` to a stored document (another sheet of the drawing). */
export function applyFieldEdits(doc: SchematicDocument, edits: readonly FieldEdit[], options: FieldEditOptions): FieldEditPlan & { doc: SchematicDocument } {
  const plan = planFieldEdits(doc, edits, options);
  return { ...plan, doc: applyCommand(doc, plan.command) };
}

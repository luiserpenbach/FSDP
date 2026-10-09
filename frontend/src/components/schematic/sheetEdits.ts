/**
 * Write field edits from the lists drawer (inline edits, paste, bulk actions)
 * back into the drawing.
 *
 *  - Items on the open sheet go through the editor: one batch command, so one
 *    undo step per commit, and the sheet is marked dirty like any other edit.
 *  - Items on the drawing's other sheets: the stored document is loaded, the
 *    same pure edit (`applyFieldEdits`) is applied, the index and DRC are
 *    re-derived exactly as a save does (`deriveSheetData`), and the sheet is
 *    stored. Sheets are written one after another; a failed sheet reports its
 *    edits as errors and the rest carry on.
 *
 * A released drawing (or a viewer) refuses the whole batch with an error.
 *
 * The open sheet can change while an other-sheet commit is in flight (locate /
 * sheet tab). Routing and post-save hydration use `getOpenSession` so a later
 * Save cannot PUT a pre-edit document over the list write-back.
 */
import type { SheetDoc } from "../../engine/connectors";
import { deriveSheetData } from "../../engine/derived";
import type { DrcWaiver, RequirementRef } from "../../engine/drc";
import type { Editor } from "../../engine/editor";
import { applyFieldEdits, planFieldEdits, type FieldEdit, type FieldEditError, type FieldEditOptions, type LineClassLike } from "../../engine/fieldEdits";
import type { SymbolRegistry } from "../../engine/library";
import type { PartLike } from "../../engine/parts";
import { tagsOf, type TagScheme } from "../../engine/tags";
import type { SchematicDocument } from "../../engine/types";

export type SheetFieldEdit = FieldEdit & { sheetId: string };
export type SheetFieldEditError = FieldEditError & { sheetId: string };

export type SheetEditResult = {
  errors: SheetFieldEditError[];
  /** Edits written (to the editor or to a stored sheet). */
  applied: number;
  /** Other sheets stored by this commit. */
  savedSheetIds: string[];
};

export type OpenSheetSession = { sheetId: string; editor: Editor };

export type SheetEditContext = {
  drawing: { id: string; number: string; sheets: Array<{ id: string; sheet_no: number }> } | null;
  /** The drawing is released: every edit is refused. */
  locked: boolean;
  /** The user may write (false for viewers). */
  canWrite: boolean;
  /** Editor of the open sheet when the commit was enqueued (may be stale mid-flight). */
  editor: Editor | null;
  openSheetId: string;
  /**
   * Live open session. Checked when each sheet group is processed and again
   * after an other-sheet PUT, so a switch/locate mid-commit still hydrates
   * the editor that would otherwise hold a pre-edit document.
   */
  getOpenSession?: () => OpenSheetSession | null;
  /** Stored documents of the drawing's other sheets (reserved tags, connector targets). */
  otherSheets: SheetDoc[];
  registry: SymbolRegistry;
  tagScheme: TagScheme;
  lineClasses: readonly LineClassLike[];
  parts: Map<string, PartLike>;
  requirements?: RequirementRef[];
  loadSheet: (sheetId: string) => Promise<{ sheet_no: number; document: unknown }>;
  loadWaivers: (sheetId: string) => Promise<DrcWaiver[]>;
  saveSheet: (sheetId: string, body: { document: SchematicDocument; index: unknown; drc: unknown }) => Promise<unknown>;
  /** Normalize a stored document as the editor would (e.g. the drawing's frame template). */
  prepareDocument?: (doc: SchematicDocument) => SchematicDocument;
  /** Called just before a stored sheet is written (background re-indexing stands down). */
  onBeforeSave?: (sheetId: string) => void;
  /** Called after a stored sheet is written with its new document and DRC error count. */
  onSheetSaved?: (sheetId: string, sheetNo: number, doc: SchematicDocument, drcErrors: number) => void;
};

export class SheetEditRefused extends Error {}

function editError(sheetId: string, edit: FieldEdit, message: string): SheetFieldEditError {
  return { sheetId, itemId: edit.itemId, field: edit.field, message };
}

/** Apply field edits through the live editor (one undo step). */
function applyViaEditor(
  editor: Editor,
  sheetId: string,
  group: readonly FieldEdit[],
  options: FieldEditOptions,
  result: SheetEditResult,
  docs: Map<string, SchematicDocument>
): void {
  const plan = planFieldEdits(editor.store.doc, group, options);
  for (const error of plan.errors) result.errors.push({ ...error, sheetId });
  if (plan.command.type === "batch" && plan.command.commands.length && !editor.dispatch(plan.command)) {
    for (const edit of plan.applied) result.errors.push(editError(sheetId, edit, "The sheet is read-only."));
    return;
  }
  docs.set(sheetId, editor.store.doc);
  result.applied += plan.applied.length;
}

/**
 * After an other-sheet PUT, keep a newly opened editor in sync so Save cannot
 * restore the pre-edit document. Clean editors load the written doc; dirty
 * ones (canvas edits during the race) get the same field edits re-applied.
 */
function hydrateOpenEditor(
  open: OpenSheetSession,
  sheetId: string,
  written: SchematicDocument,
  applied: readonly FieldEdit[],
  options: FieldEditOptions,
  docs: Map<string, SchematicDocument>
): void {
  if (open.sheetId !== sheetId) return;
  if (!open.editor.store.dirty) {
    open.editor.store.load(written);
    docs.set(sheetId, open.editor.store.doc);
    return;
  }
  const plan = planFieldEdits(open.editor.store.doc, applied, options);
  if (plan.command.type === "batch" && plan.command.commands.length) open.editor.dispatch(plan.command);
  docs.set(sheetId, open.editor.store.doc);
}

/** Apply `edits` (possibly across several sheets of the open drawing). Throws `SheetEditRefused` when the drawing cannot be edited. */
export async function commitSheetEdits(context: SheetEditContext, edits: readonly SheetFieldEdit[]): Promise<SheetEditResult> {
  const { drawing } = context;
  if (!drawing) throw new SheetEditRefused("Open a drawing first.");
  if (context.locked) throw new SheetEditRefused(`${drawing.number} is released and cannot be edited. Start a new revision to change it.`);
  if (!context.canWrite) throw new SheetEditRefused("Your role can view this drawing but not edit it.");

  const liveOpen = (): OpenSheetSession | null => {
    const fromGetter = context.getOpenSession?.() ?? null;
    if (fromGetter) return fromGetter;
    if (context.editor && context.openSheetId) return { sheetId: context.openSheetId, editor: context.editor };
    return null;
  };

  const result: SheetEditResult = { errors: [], applied: 0, savedSheetIds: [] };
  const groups = new Map<string, SheetFieldEdit[]>();
  for (const edit of edits) {
    const group = groups.get(edit.sheetId);
    if (group) group.push(edit);
    else groups.set(edit.sheetId, [edit]);
  }

  // Latest documents of every sheet: reserved tags for each sheet come from the others.
  const docs = new Map<string, SchematicDocument>();
  for (const sheet of context.otherSheets) if (sheet.sheetId) docs.set(sheet.sheetId, sheet.doc);
  const initialOpen = liveOpen();
  if (initialOpen) docs.set(initialOpen.sheetId, initialOpen.editor.store.doc);
  const sheetNos = new Map(drawing.sheets.map((sheet) => [sheet.id, sheet.sheet_no]));
  const optionsFor = (sheetId: string): FieldEditOptions => ({
    tagScheme: context.tagScheme,
    lineClasses: context.lineClasses,
    parts: context.parts,
    reservedTags: tagsOf([...docs.entries()].filter(([id]) => id !== sheetId).map(([, doc]) => doc))
  });
  const tagErrors = (group: SheetFieldEdit[], errors: FieldEditError[]) => {
    for (const error of errors) result.errors.push({ ...error, sheetId: group[0].sheetId });
  };

  // Prefer the sheet that is open *now* first (live), so its tags reserve for the others.
  const openIdNow = () => liveOpen()?.sheetId ?? context.openSheetId;
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(b === openIdNow()) - Number(a === openIdNow()));
  for (const [sheetId, group] of ordered) {
    if (!sheetNos.has(sheetId)) {
      for (const edit of group) result.errors.push(editError(sheetId, edit, "That sheet is not part of the open drawing."));
      continue;
    }
    const open = liveOpen();
    if (open && open.sheetId === sheetId) {
      applyViaEditor(open.editor, sheetId, group, optionsFor(sheetId), result, docs);
      continue;
    }
    let pending: readonly FieldEdit[] = group;
    try {
      // User may have switched onto this sheet while we were waiting on another group.
      const switched = liveOpen();
      if (switched && switched.sheetId === sheetId) {
        applyViaEditor(switched.editor, sheetId, group, optionsFor(sheetId), result, docs);
        continue;
      }
      const stored = await context.loadSheet(sheetId);
      const afterLoad = liveOpen();
      if (afterLoad && afterLoad.sheetId === sheetId) {
        applyViaEditor(afterLoad.editor, sheetId, group, optionsFor(sheetId), result, docs);
        continue;
      }
      const raw = stored.document as unknown as SchematicDocument;
      const doc = context.prepareDocument ? context.prepareDocument(raw) : raw;
      const plan = applyFieldEdits(doc, group, optionsFor(sheetId));
      tagErrors(group, plan.errors);
      pending = plan.applied;
      if (plan.command.type !== "batch" || !plan.command.commands.length) {
        result.applied += plan.applied.length;
        continue;
      }
      const waivers = await context.loadWaivers(sheetId);
      const beforeSave = liveOpen();
      if (beforeSave && beforeSave.sheetId === sheetId) {
        applyViaEditor(beforeSave.editor, sheetId, group, optionsFor(sheetId), result, docs);
        continue;
      }
      const sheetNo = stored.sheet_no ?? sheetNos.get(sheetId) ?? 1;
      const others: SheetDoc[] = [...docs.entries()].filter(([id]) => id !== sheetId).map(([id, other]) => ({ sheetId: id, sheetNo: sheetNos.get(id) ?? 0, doc: other }));
      const derived = deriveSheetData({
        doc: plan.doc,
        sheetId,
        sheetNo,
        otherSheets: others,
        registry: context.registry,
        tagScheme: context.tagScheme,
        parts: context.parts,
        requirements: context.requirements,
        waivers
      });
      context.onBeforeSave?.(sheetId);
      await context.saveSheet(sheetId, { document: plan.doc, ...derived.payload });
      docs.set(sheetId, plan.doc);
      result.applied += plan.applied.length;
      result.savedSheetIds.push(sheetId);
      context.onSheetSaved?.(sheetId, sheetNo, plan.doc, derived.drc.counts.error);
      const afterSave = liveOpen();
      if (afterSave) hydrateOpenEditor(afterSave, sheetId, plan.doc, pending, optionsFor(sheetId), docs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the sheet.";
      for (const edit of pending) result.errors.push(editError(sheetId, edit, `Sheet ${sheetNos.get(sheetId)}: ${message}`));
    }
  }
  return result;
}

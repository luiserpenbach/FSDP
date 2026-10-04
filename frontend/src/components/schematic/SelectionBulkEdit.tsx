/**
 * Bulk edits for a canvas multi-selection: assign (or clear) one part on
 * every selected symbol and equipment boundary, set the line class or the
 * service on every selected line. Each action is one editor command, so one
 * undo step, validated by the same engine function as the lists drawer.
 */
import { useMemo, useState } from "react";
import type { Editor } from "../../engine/editor";
import { planFieldEdits, type EditField, type FieldEdit, type LineClassLike } from "../../engine/fieldEdits";
import type { SymbolRegistry } from "../../engine/library";
import type { EquipmentItem, FieldValue, Item, LineItem, SymbolItem } from "../../engine/types";
import type { Part } from "../../types";
import { AssignPartModal } from "./AssignPartModal";
import { BulkEditActions } from "./BulkEditActions";
import { useEditorSnapshot } from "./SchematicCanvas";

type Tagged = SymbolItem | EquipmentItem;

export function SelectionBulkEdit({
  editor,
  items,
  registry,
  parts,
  lineClasses,
  canWrite
}: {
  editor: Editor;
  items: Item[];
  registry: SymbolRegistry;
  parts: Part[];
  lineClasses: readonly LineClassLike[];
  canWrite: boolean;
}) {
  const { connectivity, doc } = useEditorSnapshot(editor);
  const [assigning, setAssigning] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const tagged = items.filter((item): item is Tagged => item.kind === "symbol" || item.kind === "equipment");
  const lines = items.filter((item): item is LineItem => item.kind === "line");
  const partMap = useMemo(() => new Map(parts.map((part) => [part.id, part])), [parts]);

  if (!tagged.length && !lines.length) return null;

  /** Lines touching the selected items' ports: their design pressures drive the part warnings. */
  function connectedLines(): LineItem[] {
    const ids = new Set(tagged.map((item) => item.id));
    const lineIds = new Set<string>();
    for (const end of connectivity.lineEnds) if (end.attachments.some((attachment) => attachment.kind === "port" && ids.has(attachment.itemId))) lineIds.add(end.lineId);
    return doc.items.filter((entry): entry is LineItem => entry.kind === "line" && lineIds.has(entry.id));
  }

  function apply(targets: Item[], field: EditField, value: FieldValue, done: string) {
    const edits: FieldEdit[] = targets.map((item) => ({ itemId: item.id, field, value }));
    const plan = planFieldEdits(editor.store.doc, edits, { tagScheme: editor.tagScheme, reservedTags: editor.reservedTags, lineClasses, parts: partMap });
    if (plan.command.type === "batch" && plan.command.commands.length) editor.dispatch(plan.command);
    const refused = plan.errors.length;
    setNotice({
      text: refused ? `${done} on ${targets.length - refused} of ${targets.length}; ${refused} refused: ${plan.errors[0].message}` : `${done} on ${targets.length} item(s).`,
      error: refused > 0
    });
  }

  const categories = new Set(tagged.map((item) => (item.kind === "equipment" ? "equipment" : registry.has(item.symbol) ? registry.resolve(item.symbol).category : null)));
  const partIds = new Set(tagged.map((item) => item.partId ?? null));
  const assigned = tagged.filter((item) => item.partId).length;

  return (
    <div className="selectionBulkEdit">
      <p className="hint">
        {tagged.length ? `${tagged.length} symbol(s) or equipment` : ""}
        {tagged.length && lines.length ? " and " : ""}
        {lines.length ? `${lines.length} line(s)` : ""} selected.
      </p>
      <BulkEditActions
        itemCount={tagged.length}
        lineCount={lines.length}
        partCount={assigned}
        lineClasses={lineClasses}
        disabled={!canWrite}
        onAssignPart={() => setAssigning(true)}
        onClearPart={() => apply(tagged, "partId", null, "Cleared the part")}
        onSetLineClass={(value) => apply(lines, "lineClass", value, value ? `Set line class ${value}` : "Cleared the line class")}
        onSetService={(value) => apply(lines, "service", value, value ? `Set service ${value}` : "Cleared the service")}
      />
      {notice && (
        <p className={notice.error ? "formError" : "hint"} role="status">
          {notice.text}
        </p>
      )}
      {assigning && (
        <AssignPartModal
          parts={parts}
          category={categories.size === 1 ? [...categories][0] : null}
          currentPartId={partIds.size === 1 ? [...partIds][0] : null}
          assignedCount={assigned}
          targetCount={tagged.length}
          connectedLines={connectedLines()}
          caption={tagged.length === 1 ? (tagged[0].tag ?? tagged[0].id) : `${tagged.length} selected items`}
          onAssign={(partId) => {
            setAssigning(false);
            const part = partId ? partMap.get(partId) : null;
            apply(tagged, "partId", partId, part ? `Assigned ${part.part_number}` : "Cleared the part");
          }}
          onClose={() => setAssigning(false)}
        />
      )}
    </div>
  );
}

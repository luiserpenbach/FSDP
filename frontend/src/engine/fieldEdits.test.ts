import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { applyFieldEdits, planFieldEdits, type FieldEdit } from "./fieldEdits";
import { smallPanelDocument } from "./fixtures";
import type { PartLike } from "./parts";
import { DEFAULT_TAG_SCHEME, normalizeScheme } from "./tags";
import type { EquipmentItem, Item, LineItem, SchematicDocument, SymbolItem } from "./types";

const scheme = DEFAULT_TAG_SCHEME;

function item<T extends Item>(doc: SchematicDocument, id: string): T {
  const found = doc.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found as T;
}

const parts = new Map<string, PartLike>([
  ["p-ball", { id: "p-ball", part_number: "AMB2-001", lifecycle_status: "active", qualification_status: "qualified", pressure_rating_bar: 200, material: "316L" }],
  ["p-old", { id: "p-old", part_number: "AMB2-003", lifecycle_status: "obsolete", qualification_status: "qualified", pressure_rating_bar: 50, material: "brass" }]
]);

const lineClasses = [
  { name: "CS150", material: "A106", wall: "SCH40", insulation: "PP", sizes: ['1"'] },
  { name: "SS316", material: "316L", wall: "0.035", sizes: ['1/4"'] }
];

describe("planFieldEdits", () => {
  it("batches every accepted edit into one command and leaves the document untouched", () => {
    const doc = smallPanelDocument();
    const before = JSON.stringify(doc);
    const plan = planFieldEdits(
      doc,
      [
        { itemId: "hv", field: "tag", value: "HV-3290" },
        { itemId: "hv", field: "partId", value: "p-ball" },
        { itemId: "hv", field: "notes", value: " capped " },
        { itemId: "pt", field: "mounting", value: "panel" },
        { itemId: "pt", field: "dnp", value: true },
        { itemId: "l2", field: "service", value: "GHe" },
        { itemId: "l2", field: "designPressure", value: "3000 psig" }
      ],
      { tagScheme: scheme, parts }
    );
    expect(plan.errors).toEqual([]);
    expect(plan.applied).toHaveLength(7);
    expect(plan.command.type).toBe("batch");
    // One update per item.
    expect(plan.command.type === "batch" && plan.command.commands.map((command) => (command.type === "update" ? command.id : "?")).sort()).toEqual(["hv", "l2", "pt"]);
    expect(JSON.stringify(doc)).toBe(before);

    const next = applyCommand(doc, plan.command);
    const hv = item<SymbolItem>(next, "hv");
    expect(hv.tag).toBe("HV-3290");
    expect(hv.partId).toBe("p-ball");
    expect(hv.fields.notes).toBe("capped");
    expect(item<SymbolItem>(next, "pt").fields.mounting).toBe("panel");
    expect(item<SymbolItem>(next, "pt").dnp).toBe(true);
    expect(item<LineItem>(next, "l2").service).toBe("GHe");
    expect(item<LineItem>(next, "l2").designPressure).toBe("3000 psig");
  });

  it("rejects tags that break the scheme, without writing them", () => {
    const doc = smallPanelDocument();
    const structured = normalizeScheme({ kind: "structured", separator: "-", sequenceLength: 2, systems: [{ digit: "3", name: "Helium" }], classes: [{ digit: "2", name: "Test" }] });
    const plan = planFieldEdits(
      doc,
      [
        { itemId: "hv", field: "tag", value: "HV12" },
        { itemId: "pt", field: "tag", value: "PT-3205" }
      ],
      { tagScheme: structured }
    );
    expect(plan.errors).toEqual([{ itemId: "hv", field: "tag", message: expect.stringContaining("HV12:") }]);
    const next = applyCommand(doc, plan.command);
    expect(item<SymbolItem>(next, "hv").tag).toBe("HV-3201");
    expect(item<SymbolItem>(next, "pt").tag).toBe("PT-3205");
  });

  it("refuses duplicates on the sheet, within the batch, and on other sheets; allows swaps", () => {
    const doc = smallPanelDocument();
    const plan = planFieldEdits(
      doc,
      [
        // Already used by the regulator on this sheet.
        { itemId: "hv", field: "tag", value: "pcv-3202" },
        // Used on another sheet of the drawing.
        { itemId: "pt", field: "tag", value: "PT-9" },
        // Two edits claim the same new tag: the first wins.
        { itemId: "psv", field: "tag", value: "PSV-50" },
        { itemId: "bottle", field: "tag", value: "PSV 50" }
      ],
      { tagScheme: { ...scheme, separator: "-" }, reservedTags: ["PT-9"] }
    );
    const messages = Object.fromEntries(plan.errors.map((error) => [error.itemId, error.message]));
    expect(Object.keys(messages).sort()).toEqual(["bottle", "hv", "pt"]);
    expect(messages.hv).toContain("already used on this sheet (PCV-3202)");
    expect(messages.pt).toContain("already used on another sheet of this drawing (PT-9)");
    const next = applyCommand(doc, plan.command);
    expect(item<SymbolItem>(next, "psv").tag).toBe("PSV-50");
    expect(item<SymbolItem>(next, "bottle").tag).toBe("K-3201");

    const swap = applyFieldEdits(
      doc,
      [
        { itemId: "hv", field: "tag", value: "PCV-3202" },
        { itemId: "pcv", field: "tag", value: "HV-3201" }
      ],
      { tagScheme: scheme }
    );
    expect(swap.errors).toEqual([]);
    expect(item<SymbolItem>(swap.doc, "hv").tag).toBe("PCV-3202");
    expect(item<SymbolItem>(swap.doc, "pcv").tag).toBe("HV-3201");
  });

  it("settles when a refused edit keeps a tag another edit wanted", () => {
    const doc = smallPanelDocument();
    // hv -> PT-9 is refused (other sheet), so hv keeps HV-3201 and pcv cannot take it.
    const plan = planFieldEdits(
      doc,
      [
        { itemId: "hv", field: "tag", value: "PT-9" },
        { itemId: "pcv", field: "tag", value: "HV-3201" }
      ],
      { tagScheme: scheme, reservedTags: ["PT-9"] }
    );
    expect(plan.errors.map((error) => error.itemId).sort()).toEqual(["hv", "pcv"]);
    expect(plan.command.type === "batch" && plan.command.commands).toEqual([]);
  });

  it("blocks obsolete and unknown parts, and clears parts", () => {
    const doc = smallPanelDocument();
    (doc.items.find((entry) => entry.id === "pt") as SymbolItem).partId = "p-ball";
    const { doc: next, errors } = applyFieldEdits(
      doc,
      [
        { itemId: "hv", field: "partId", value: "p-old" },
        { itemId: "pcv", field: "partId", value: "nope" },
        { itemId: "pt", field: "partId", value: null },
        { itemId: "l1", field: "partId", value: "p-ball" }
      ],
      { tagScheme: scheme, parts }
    );
    expect(errors.map((error) => [error.itemId, error.message])).toEqual([
      ["hv", "AMB2-003 is obsolete and cannot be assigned. Pick an alternate."],
      ["pcv", "Unknown part."],
      ["l1", "Only symbols and equipment have this field."]
    ]);
    expect(item<SymbolItem>(next, "hv").partId).toBeUndefined();
    expect(item<SymbolItem>(next, "pt").partId).toBeNull();
  });

  it("sets line classes with their spec and insulation, and refuses unknown classes", () => {
    const doc = smallPanelDocument();
    const { doc: next, errors } = applyFieldEdits(
      doc,
      [
        { itemId: "l1", field: "lineClass", value: "cs150" },
        { itemId: "l2", field: "insulation", value: "None" },
        { itemId: "l2", field: "lineClass", value: "CS150" },
        { itemId: "l3", field: "lineClass", value: "XX9" },
        { itemId: "hv", field: "lineClass", value: "CS150" }
      ],
      { tagScheme: scheme, lineClasses }
    );
    expect(errors.map((error) => [error.itemId, error.field])).toEqual([
      ["l3", "lineClass"],
      ["hv", "lineClass"]
    ]);
    const l1 = item<LineItem>(next, "l1");
    expect(l1).toMatchObject({ lineClass: "CS150", spec: "A106 x SCH40 WALL", insulation: "PP" });
    // An explicit edit in the same batch wins over the class default.
    expect(item<LineItem>(next, "l2")).toMatchObject({ lineClass: "CS150", insulation: "None" });
    expect(item<LineItem>(next, "l3").lineClass).toBeUndefined();

    // Without project classes any class name is accepted; blank clears it.
    const free = applyFieldEdits(next, [{ itemId: "l3", field: "lineClass", value: "ANY" }, { itemId: "l1", field: "lineClass", value: "" }], { tagScheme: scheme });
    expect(free.errors).toEqual([]);
    expect(item<LineItem>(free.doc, "l3").lineClass).toBe("ANY");
    expect(item<LineItem>(free.doc, "l1").lineClass).toBeUndefined();
  });

  it("renames equipment (name required) and labels symbols; reports missing items", () => {
    const doc = smallPanelDocument();
    const tank: EquipmentItem = { id: "tank", kind: "equipment", layer: "equipment", position: { x: 250, y: 150 }, size: { width: 40, height: 60 }, name: "Tank", boundary: "solid", fields: {} };
    doc.items.push(tank);
    const edits: FieldEdit[] = [
      { itemId: "tank", field: "name", value: "" },
      { itemId: "hv", field: "name", value: "Isolation" },
      { itemId: "gone", field: "tag", value: "HV-1" },
      { itemId: "tank", field: "spare", value: 2 },
      { itemId: "pt", field: "spare", value: -1 }
    ];
    const { doc: next, errors } = applyFieldEdits(doc, edits, { tagScheme: scheme });
    expect(errors.map((error) => [error.itemId, error.field])).toEqual([
      ["tank", "name"],
      ["gone", "tag"],
      ["pt", "spare"]
    ]);
    expect(item<SymbolItem>(next, "hv").label).toBe("Isolation");
    expect(item<EquipmentItem>(next, "tank")).toMatchObject({ name: "Tank", spare: 2 });
  });

  it("skips updates that change nothing", () => {
    const doc = smallPanelDocument();
    const plan = planFieldEdits(doc, [{ itemId: "hv", field: "tag", value: "HV-3201" }], { tagScheme: scheme });
    expect(plan.errors).toEqual([]);
    expect(plan.command.type === "batch" && plan.command.commands).toEqual([]);
  });
});

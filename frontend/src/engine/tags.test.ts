import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { smallPanelDocument, symbolAt } from "./fixtures";
import { DEFAULT_TAG_SCHEME, REFERENCE_TAG_SCHEME, formatTag, nextTag, normalizeScheme, parseTag, renumberCommand, tagIssues, tagsOf, validateTag } from "./tags";
import type { EquipmentItem, SymbolItem } from "./types";

describe("tag schemes", () => {
  it("parses and validates simple tags", () => {
    expect(parseTag("HV-12", DEFAULT_TAG_SCHEME)).toMatchObject({ letters: "HV", sequence: 12, separator: "-" });
    expect(validateTag("HV-12", DEFAULT_TAG_SCHEME)).toEqual({ ok: true });
    expect(validateTag("HV 12", DEFAULT_TAG_SCHEME).ok).toBe(false);
    expect(validateTag("valve", DEFAULT_TAG_SCHEME).ok).toBe(false);
    expect(validateTag("ZZ-1", { ...DEFAULT_TAG_SCHEME, strictLetters: true }).reason).toContain("ZZ");
  });

  it("parses and validates the reference structured scheme", () => {
    const parsed = parseTag("PT 3222", REFERENCE_TAG_SCHEME);
    expect(parsed).toMatchObject({ letters: "PT", system: "3", cls: "2", sequence: 22 });
    expect(validateTag("PT 3222", REFERENCE_TAG_SCHEME)).toEqual({ ok: true });
    expect(validateTag("HV 4201", REFERENCE_TAG_SCHEME)).toEqual({ ok: true });
    expect(validateTag("HV-4201", REFERENCE_TAG_SCHEME).reason).toContain("separator");
    expect(validateTag("HV 5201", REFERENCE_TAG_SCHEME).reason).toContain("System digit 5");
    expect(validateTag("HV 4301", REFERENCE_TAG_SCHEME).reason).toContain("Class digit 3");
    expect(validateTag("HV 42", REFERENCE_TAG_SCHEME).ok).toBe(false);
    expect(formatTag(REFERENCE_TAG_SCHEME, "PSV", 7, { system: "3", cls: "2" })).toBe("PSV 3207");
  });

  it("suggests the next free number per letter group and system/class", () => {
    const doc = smallPanelDocument(); // HV-3201, PCV-3202, PSV-3203, PT-3204, K-3201
    expect(nextTag(doc, DEFAULT_TAG_SCHEME, "HV")).toBe("HV-3202");
    expect(nextTag(doc, DEFAULT_TAG_SCHEME, "FV")).toBe("FV-1");
    const structured = smallPanelDocument();
    (structured.items[1] as SymbolItem).tag = "HV 3201";
    (structured.items[2] as SymbolItem).tag = "HV 3205";
    (structured.items[3] as SymbolItem).tag = "HV 4201";
    expect(nextTag(structured, REFERENCE_TAG_SCHEME, "HV", { system: "3", cls: "2" })).toBe("HV 3206");
    expect(nextTag(structured, REFERENCE_TAG_SCHEME, "HV", { system: "4", cls: "2" })).toBe("HV 4202");
    expect(nextTag(structured, REFERENCE_TAG_SCHEME, "HV", { system: "7", cls: "1" })).toBe("HV 7101");
  });

  it("finds invalid and duplicate tags", () => {
    const doc = smallPanelDocument();
    doc.items.push(symbolAt("dup", "valve", { x: 300, y: 200 }, { tag: "HV-3201" }));
    doc.items.push(symbolAt("bad", "valve", { x: 320, y: 200 }, { tag: "valve one" }));
    const issues = tagIssues(doc, DEFAULT_TAG_SCHEME);
    expect(issues.map((issue) => `${issue.itemId}:${issue.issue}`).sort()).toEqual(["bad:invalid", "dup:duplicate"]);
  });

  it("renumbers a selection in reading order and skips numbers still in use", () => {
    const doc = smallPanelDocument();
    doc.items.push(symbolAt("a", "valve", { x: 50, y: 300 }, { tag: "HV-9" }));
    doc.items.push(symbolAt("b", "valve", { x: 150, y: 250 }, { tag: "HV-7" }));
    doc.items.push(symbolAt("c", "valve", { x: 100, y: 250 }, { tag: "HV-8" }));
    // hv keeps HV-3201; renumber the three new valves from 1.
    const renumbered = applyCommand(doc, renumberCommand(doc, DEFAULT_TAG_SCHEME, ["a", "b", "c"]));
    const tagOf = (id: string) => (renumbered.items.find((item) => item.id === id) as SymbolItem).tag;
    expect(tagOf("c")).toBe("HV-1"); // y 250, x 100
    expect(tagOf("b")).toBe("HV-2"); // y 250, x 150
    expect(tagOf("a")).toBe("HV-3"); // y 300
    expect(tagOf("hv")).toBe("HV-3201");
    const clash = applyCommand(doc, renumberCommand(doc, DEFAULT_TAG_SCHEME, ["a"], {}, 3201));
    expect((clash.items.find((item) => item.id === "a") as SymbolItem).tag).toBe("HV-3202");
  });

  it("skips tags reserved on other sheets when suggesting and renumbering", () => {
    const doc = smallPanelDocument(); // HV-3201 on this sheet
    expect(nextTag(doc, DEFAULT_TAG_SCHEME, "HV", {}, ["HV-3207", "PT-9"])).toBe("HV-3208");
    expect(nextTag(doc, DEFAULT_TAG_SCHEME, "FV", {}, ["FV 4"])).toBe("FV-5");
    doc.items.push(symbolAt("a", "valve", { x: 50, y: 300 }, { tag: "HV-9" }));
    const renumbered = applyCommand(doc, renumberCommand(doc, DEFAULT_TAG_SCHEME, ["a"], {}, 1, ["HV-1", "HV-2"]));
    expect((renumbered.items.find((entry) => entry.id === "a") as SymbolItem).tag).toBe("HV-3");
  });

  it("flags a tag that is used on another sheet", () => {
    const doc = smallPanelDocument();
    const issues = tagIssues(doc, DEFAULT_TAG_SCHEME, ["hv 3201", "XV-1"]);
    expect(issues).toEqual([{ itemId: "hv", tag: "HV-3201", issue: "duplicate", message: "Duplicate of hv 3201 on another sheet" }]);
    expect(tagsOf([doc, smallPanelDocument()])).toHaveLength(10);
  });

  it("numbers and checks equipment tags alongside symbol tags", () => {
    const doc = smallPanelDocument();
    const tank: EquipmentItem = {
      id: "tk",
      kind: "equipment",
      layer: "equipment",
      position: { x: 10, y: 10 },
      size: { width: 20, height: 20 },
      tag: "TK-1",
      name: "TANK",
      boundary: "solid",
      fields: {}
    };
    doc.items.push(tank, symbolAt("tk-symbol", "tank", { x: 300, y: 300 }, { tag: "TK-1" }));
    expect(tagIssues(doc, DEFAULT_TAG_SCHEME)).toEqual([{ itemId: "tk-symbol", tag: "TK-1", issue: "duplicate", message: "Duplicate of TK-1" }]);
    expect(nextTag(doc, DEFAULT_TAG_SCHEME, "TK")).toBe("TK-2");
    expect(tagsOf([doc])).toContain("TK-1");
  });

  it("never suggests a used structured tag when the sequence is exhausted", () => {
    const doc = smallPanelDocument();
    const used = Array.from({ length: 99 }, (_, index) => formatTag(REFERENCE_TAG_SCHEME, "PT", index + 1, { system: "3", cls: "2" }));
    expect(used[98]).toBe("PT 3299");
    // 99 is taken: fill the lowest gap instead of overflowing to an unparseable "PT 32100".
    const gapped = used.filter((tag) => tag !== "PT 3207");
    expect(nextTag(doc, REFERENCE_TAG_SCHEME, "PT", { system: "3", cls: "2" }, gapped)).toBe("PT 3207");
    expect(nextTag(doc, REFERENCE_TAG_SCHEME, "PT", { system: "3", cls: "2" }, used)).toBeNull();
    expect(nextTag(doc, REFERENCE_TAG_SCHEME, "PT", { system: "4", cls: "2" }, used)).toBe("PT 4201");
    // Renumbering a group that does not fit the width leaves its tags alone (no "PT 32100").
    doc.items.push(symbolAt("a", "instrument", { x: 50, y: 300 }, { tag: "PT 3250" }));
    expect(renumberCommand(doc, REFERENCE_TAG_SCHEME, ["a"], {}, 1, used)).toMatchObject({ type: "batch", commands: [] });
    expect(renumberCommand(doc, REFERENCE_TAG_SCHEME, ["a"], {}, 1, gapped)).toMatchObject({ commands: [{ type: "update", id: "a", patch: { tag: "PT 3207" } }] });
  });

  it("normalises stored schemes with defaults", () => {
    const scheme = normalizeScheme({ kind: "structured", separator: " ", systems: [{ digit: "3", name: "Helium" }], sequenceLength: 2 });
    expect(scheme.kind).toBe("structured");
    expect(scheme.classes).toEqual([]);
    expect(scheme.firstLetters.length).toBeGreaterThan(10);
    expect(normalizeScheme(null)).toEqual(DEFAULT_TAG_SCHEME);
  });
});

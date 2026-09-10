import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { smallPanelDocument, symbolAt } from "./fixtures";
import { DEFAULT_TAG_SCHEME, REFERENCE_TAG_SCHEME, formatTag, nextTag, normalizeScheme, parseTag, renumberCommand, tagIssues, validateTag } from "./tags";
import type { SymbolItem } from "./types";

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

  it("normalises stored schemes with defaults", () => {
    const scheme = normalizeScheme({ kind: "structured", separator: " ", systems: [{ digit: "3", name: "Helium" }], sequenceLength: 2 });
    expect(scheme.kind).toBe("structured");
    expect(scheme.classes).toEqual([]);
    expect(scheme.firstLetters.length).toBeGreaterThan(10);
    expect(normalizeScheme(null)).toEqual(DEFAULT_TAG_SCHEME);
  });
});

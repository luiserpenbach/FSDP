import { describe, expect, it } from "vitest";
import { isolableVolumes, runDrc, trappedVolumes, type RequirementRef } from "./drc";
import { findingsDocument, renderFindingsSheet } from "./drcSheet";
import { lineThrough, symbolAt } from "./fixtures";
import { SymbolRegistry } from "./library";
import { computeConnectivity } from "./connectivity";
import { parseSizeInches, sizesDiffer } from "./sizes";
import { DEFAULT_TAG_SCHEME } from "./tags";
import { createEmptyDocument, type EquipmentItem, type LineItem, type SchematicDocument, type SymbolItem } from "./types";
import { makeSheet } from "./sheet";

const registry = SymbolRegistry.withBuiltins();
const parts = new Map([
  ["p-316", { id: "p-316", part_number: "AMB2-001", material: "316L SS", pressure_rating_bar: 400, lifecycle_status: "active", qualification_status: "qualified", preferred: true }],
  ["p-brass", { id: "p-brass", part_number: "AMB2-003", material: "Brass", pressure_rating_bar: 100, lifecycle_status: "active", qualification_status: "qualified", preferred: false }],
  ["p-draft", { id: "p-draft", part_number: "AMB2-004", material: "316L", pressure_rating_bar: 50, lifecycle_status: "draft", qualification_status: "unqualified", preferred: false }]
]);

/** A clean helium fill slice: every isolable volume relieved, every line numbered and sized. */
function cleanDocument(): SchematicDocument {
  const doc = createEmptyDocument();
  doc.sheet = makeSheet("A3");
  const spec = { size: '1/4"', spec: 'ST x .035" WALL', lineClass: "HE-1", service: "GHe" };
  const chamber: EquipmentItem = {
    id: "vc",
    kind: "equipment",
    layer: "equipment",
    position: { x: 240, y: 105 },
    size: { width: 40, height: 30 },
    tag: "VC-1",
    name: "VACUUM CHAMBER",
    boundary: "dashed",
    nozzles: [{ id: "N1", x: 0, y: 15, side: "left", size: '1/4"' }],
    fields: {}
  };
  doc.items = [
    symbolAt("bottle", "gas_bottle", { x: 40, y: 150 }, { tag: "K-3201" }),
    symbolAt("hv", "hand_valve", { x: 80, y: 120 }, { tag: "HV-3201", partId: "p-brass" }),
    symbolAt("pcv", "regulator", { x: 130, y: 120 }, { tag: "PCV-3202", partId: "p-316" }),
    symbolAt("psv1", "relief_valve", { x: 65, y: 90 }, { tag: "PSV-3205" }),
    symbolAt("psv2", "relief_valve", { x: 115, y: 90 }, { tag: "PSV-3206" }),
    symbolAt("psv", "relief_valve", { x: 170, y: 90 }, { tag: "PSV-3203" }),
    symbolAt("pt", "instrument", { x: 200, y: 100 }, { tag: "PT-3204" }),
    chamber,
    lineThrough("l1", [{ x: 40, y: 137.5 }, { x: 40, y: 120 }, { x: 70, y: 120 }], { lineNumber: "3101", ...spec }),
    lineThrough("l1r", [{ x: 55, y: 120 }, { x: 55, y: 90 }], { lineNumber: "3105", ...spec }),
    lineThrough("l2", [{ x: 90, y: 120 }, { x: 120, y: 120 }], { lineNumber: "3102", ...spec }),
    lineThrough("l2r", [{ x: 105, y: 120 }, { x: 105, y: 90 }], { lineNumber: "3106", ...spec }),
    lineThrough("l3", [{ x: 140, y: 120 }, { x: 200, y: 120 }, { x: 200, y: 105 }], { lineNumber: "3103", ...spec }),
    lineThrough("l4", [{ x: 160, y: 120 }, { x: 160, y: 90 }], { lineNumber: "3107", ...spec }),
    lineThrough("l5", [{ x: 200, y: 120 }, { x: 240, y: 120 }], { lineNumber: "3104", ...spec })
  ];
  return doc;
}

function item<T>(doc: SchematicDocument, id: string): T {
  return doc.items.find((entry) => entry.id === id) as T;
}

describe("size parsing", () => {
  it("reads fractions, decimals, millimetres, and DN", () => {
    expect(parseSizeInches('1/4"')).toBeCloseTo(0.25);
    expect(parseSizeInches("1/4 in")).toBeCloseTo(0.25);
    expect(parseSizeInches('1-1/2"')).toBeCloseTo(1.5);
    expect(parseSizeInches('0.5" NPT')).toBeCloseTo(0.5);
    expect(parseSizeInches("6 mm")).toBeCloseTo(0.236, 2);
    expect(parseSizeInches("DN15")).toBeCloseTo(0.59, 2);
    expect(parseSizeInches("tube")).toBeNull();
    expect(sizesDiffer('1/4"', "0.25 in")).toBe(false);
    expect(sizesDiffer('1/4"', '1/2"')).toBe(true);
    expect(sizesDiffer('1/4"', null)).toBe(false);
  });
});

describe("design rule checks", () => {
  it("passes a clean sheet", () => {
    const result = runDrc({ doc: cleanDocument(), registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(result.counts.error).toBe(0);
  });

  it("finds exactly the injected faults on a deliberately broken copy", () => {
    const doc = cleanDocument();
    // 1. Unconnected PT: move the transmitter off its line.
    item<SymbolItem>(doc, "pt").position = { x: 220, y: 80 };
    // 2. Duplicate HV tag.
    item<SymbolItem>(doc, "pcv").tag = "HV-3201";
    // 3. Unnumbered line.
    delete item<LineItem>(doc, "l2").lineNumber;
    // 4. 1/4" line into a 1/2" nozzle.
    item<EquipmentItem>(doc, "vc").nozzles![0].size = '1/2"';
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    const keys = result.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.key).sort();
    expect(keys).toEqual(["dangling_line:l3:1", "duplicate_tag:pcv", "line_unnumbered:l2", "open_port:pt:process", "port_size_mismatch:l5:1"].sort());
    expect(result.counts).toEqual({ error: 3, warning: 2, info: 0, waived: 0 });
    const mismatch = result.findings.find((finding) => finding.rule === "port_size_mismatch")!;
    expect(mismatch.message).toContain('line 3104 (1/4") connects to VC-1 port N1 (1/2")');
    expect(mismatch.zone).toMatch(/^[A-Z]-\d$/);
    expect(result.findings.find((finding) => finding.rule === "duplicate_tag")!.message).toBe("HV-3201: Duplicate of HV-3201");
  });

  it("flags tags that duplicate another sheet's tags or equipment tags", () => {
    const doc = cleanDocument();
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts, reservedTags: ["HV-3201", "XV-9"] });
    const duplicates = result.findings.filter((finding) => finding.rule === "duplicate_tag");
    expect(duplicates.map((finding) => [finding.itemId, finding.message])).toEqual([["hv", "HV-3201: Duplicate of HV-3201 on another sheet"]]);
    expect(duplicates[0].severity).toBe("error");
    item<SymbolItem>(doc, "pcv").tag = "VC-1"; // the vacuum chamber equipment's tag
    const equipment = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    expect(equipment.findings.filter((finding) => finding.rule === "duplicate_tag").map((finding) => finding.message)).toEqual(["VC-1: Duplicate of VC-1"]);
  });

  it("flags relief coverage, size changes, spec breaks, and part status", () => {
    const doc = cleanDocument();
    doc.items = doc.items.filter((entry) => entry.id !== "psv2" && entry.id !== "l2r");
    const l5 = item<LineItem>(doc, "l5");
    l5.size = '1/2"';
    l5.lineClass = "HE-2";
    item<EquipmentItem>(doc, "vc").nozzles![0].size = '1/2"';
    item<SymbolItem>(doc, "hv").partId = "p-draft";
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    const byRule = new Map(result.findings.map((finding) => [finding.rule, finding]));
    expect(byRule.get("relief_coverage")?.message).toBe("Isolable volume (3102, HV-3201, PCV-3202) has no relief device");
    expect(byRule.get("size_change_missing")?.message).toContain('line 3104 (1/2") joins line 3103 (1/4")');
    expect(byRule.get("spec_break_missing")?.message).toContain("line 3104 (HE-2) joins line 3103 (HE-1)");
    expect(byRule.get("part_status")?.message).toBe("HV-3201 uses AMB2-004, which is a draft");
    expect(byRule.has("port_size_mismatch")).toBe(false);
    // Marking the joins clears those two findings.
    l5.annotations = [{ id: "a", kind: "size_change", at: 0.1, text: '1/4"x1/2"' }, { id: "b", kind: "spec_break", at: 0.2 }];
    const marked = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    expect(marked.findings.some((finding) => finding.rule === "size_change_missing" || finding.rule === "spec_break_missing")).toBe(false);
  });

  it("computes isolable volumes through pass-through devices and equipment", () => {
    const doc = cleanDocument();
    const volumes = isolableVolumes(doc, registry, computeConnectivity(doc, registry));
    expect(volumes).toHaveLength(3);
    const downstream = volumes.find((volume) => volume.lineIds.includes("l3"))!;
    expect(new Set(downstream.lineIds)).toEqual(new Set(["l3", "l4", "l5"]));
    expect(downstream.itemIds).toEqual(expect.arrayContaining(["pcv", "psv", "pt", "vc"]));
    expect(downstream.isolable).toBe(true);
    expect(downstream.relieved).toBe(true);
  });

  it("warns on part rating below the connected line design pressure", () => {
    const doc = cleanDocument();
    item<LineItem>(doc, "l2").designPressure = "2500 psig";
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts });
    expect(result.findings.find((finding) => finding.rule === "part_rating")?.message).toContain("HV-3201 uses AMB2-003: Rated 100 bar, below the connected line design pressure of 172.4 bar");
  });

  it("evaluates requirement constraints and reports checks for the matrix", () => {
    const doc = cleanDocument();
    const requirements: RequirementRef[] = [
      { id: "r1", key: "REQ-7", title: "316L wetted", constraint: { kind: "material_in", values: ["316L"], scope: { services: ["GHe"] } } },
      { id: "r2", key: "REQ-8", title: "Relief on every volume", constraint: { kind: "relief_required", values: [] } },
      { id: "r3", key: "REQ-9", title: "Rated 300 bar", constraint: { kind: "pressure_rating_min", values: ["300 bar"], scope: { categories: ["regulator"] } } },
      { id: "r4", key: "REQ-10", title: "Line class", constraint: { kind: "line_class_in", values: ["HE-1"] } },
      { id: "r5", key: "REQ-11", title: "No constraint", constraint: null }
    ];
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts, requirements });
    const failures = result.findings.filter((finding) => finding.rule === "requirement");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ key: "requirement:r1:hv", severity: "error", requirementId: "r1", subject: "HV-3201" });
    expect(failures[0].message).toBe("REQ-7 (316L wetted): AMB2-003 material Brass is not one of 316L");
    const checks = result.requirementChecks;
    expect(checks.filter((check) => check.requirementId === "r1").map((check) => [check.subject, check.status])).toEqual([["HV-3201", "fail"], ["PCV-3202", "pass"]]);
    expect(checks.filter((check) => check.requirementId === "r2").every((check) => check.status === "pass")).toBe(true);
    expect(checks.filter((check) => check.requirementId === "r2")).toHaveLength(3);
    expect(checks.filter((check) => check.requirementId === "r3").map((check) => [check.subject, check.status])).toEqual([["PCV-3202", "pass"]]);
    expect(checks.filter((check) => check.requirementId === "r4")).toHaveLength(7);
    expect(checks.some((check) => check.requirementId === "r5")).toBe(false);
  });

  it("applies waivers by key and keeps them out of the open list", () => {
    const doc = cleanDocument();
    delete item<LineItem>(doc, "l2").lineNumber;
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts, waivers: [{ key: "line_unnumbered:l2", reason: "stub between valve and regulator", by: "eng" }] });
    expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(result.waived).toHaveLength(1);
    expect(result.waived[0].waiver.reason).toBe("stub between valve and regulator");
    expect(result.counts.waived).toBe(1);
  });

  it("renders a findings page in the drawing frame", () => {
    const doc = cleanDocument();
    doc.sheet.frame.template = "fsdp-standard";
    item<SymbolItem>(doc, "pt").position = { x: 220, y: 80 };
    const result = runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME, parts, waivers: [{ key: "dangling_line:l3:1", reason: "future tie-in" }] });
    const page = findingsDocument(doc, result.findings, result.waived);
    expect(page.items.every((entry) => entry.kind === "label")).toBe(true);
    const svg = renderFindingsSheet(doc, registry, { number: "AMB2-9003", title: "P&ID", sheetNo: 1, sheetCount: 1, revisions: [], notes: [] }, result.findings, result.waived);
    expect(svg).toContain("DESIGN RULE CHECK — 1 open finding(s), 1 waived");
    expect(svg).toContain("WAIVED: future tie-in");
    expect(svg).toContain("PT-3204 port process has no line");
    expect(svg).toContain("DESIGN RULE CHECK FINDINGS");
  });
});

describe("trapped volume rule", () => {
  // Inline symbols have their ports 10 mm either side of the centre: a valve at
  // x = 50 spans 40..60. The section under test is the line between x = 60 and 100.
  function section(left: string, right: string, extra: SchematicDocument["items"] = []): SchematicDocument {
    const doc = createEmptyDocument();
    doc.sheet = makeSheet("A3");
    doc.items = [
      symbolAt("left", left, { x: 50, y: 100 }, { tag: "HV-1" }),
      symbolAt("right", right, { x: 110, y: 100 }, { tag: "HV-2" }),
      symbolAt("src", "terminator_in", { x: 5, y: 100 }),
      symbolAt("dst", "terminator", { x: 155, y: 100 }),
      lineThrough("up", [{ x: 20, y: 100 }, { x: 40, y: 100 }], { lineNumber: "100" }),
      lineThrough("mid", [{ x: 60, y: 100 }, { x: 100, y: 100 }], { lineNumber: "101" }),
      lineThrough("down", [{ x: 120, y: 100 }, { x: 140, y: 100 }], { lineNumber: "102" }),
      ...extra
    ];
    return doc;
  }
  const trapped = (doc: SchematicDocument) => runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME }).findings.filter((finding) => finding.rule === "trapped_volume");
  const tee = (id: string, to: { x: number; y: number }) => lineThrough(id, [{ x: 80, y: 100 }, { x: 80, y: to.y }, to], { lineNumber: "103" });

  it("flags a section closed in by two isolation valves", () => {
    const findings = trapped(section("hand_valve", "ball_valve"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: "trapped_volume:mid", severity: "warning", itemId: "mid", subject: "101" });
    expect(findings[0].message).toBe(
      "Section (101) can be closed in by HV-1, HV-2 and has no relief device or vent; fluid trapped there can overpressure as it warms"
    );
    expect(findings[0].zone).toMatch(/^[A-Z]-\d$/);
  });

  it("follows the section through inline components and instruments", () => {
    // HV-1 - line - filter - line (with a PT teed off) - solenoid valve.
    const doc = section("hand_valve", "solenoid_valve", [
      symbolAt("f", "filter", { x: 80, y: 100 }, { tag: "F-1" }),
      symbolAt("pt", "instrument", { x: 80, y: 75 }, { tag: "PT-1" }),
      lineThrough("m1", [{ x: 60, y: 100 }, { x: 70, y: 100 }], { lineNumber: "101" }),
      lineThrough("m2", [{ x: 90, y: 100 }, { x: 100, y: 100 }], { lineNumber: "104" }),
      lineThrough("branch", [{ x: 95, y: 100 }, { x: 95, y: 80 }, { x: 80, y: 80 }], { lineNumber: "103" })
    ]);
    doc.items = doc.items.filter((entry) => entry.id !== "mid");
    const volumes = trappedVolumes(doc, registry, computeConnectivity(doc, registry));
    expect(volumes).toHaveLength(1);
    expect(new Set(volumes[0].lineIds)).toEqual(new Set(["m1", "m2", "branch"]));
    expect(new Set(volumes[0].valveIds)).toEqual(new Set(["left", "right"]));
    expect(volumes[0].itemIds).toEqual(expect.arrayContaining(["f", "pt"]));
    expect(trapped(doc)[0].message).toContain("Section (101, 104, 103, F-1, PT-1) can be closed in by HV-1, HV-2");
  });

  it("is satisfied by a relief device, a rupture disc, or a vent on the section", () => {
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("psv", "relief_valve", { x: 90, y: 80 }, { tag: "PSV-1" }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("psv", "safety_valve", { x: 90, y: 80 }, { tag: "PSV-1" }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("pse", "rupture_disc", { x: 90, y: 80 }, { tag: "PSE-1" }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("vent", "vent_atmosphere", { x: 90, y: 80 }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
  });

  it("treats a check valve as closed against reverse flow only", () => {
    // Outlet on the section: fluid cannot leave backwards, so it is a boundary.
    const outletSide = trapped(section("check_valve", "hand_valve"));
    expect(outletSide).toHaveLength(1);
    expect(outletSide[0].message).toContain("can be closed in by HV-1, HV-2");
    // Inlet on the section: fluid can leave through the check valve.
    expect(trapped(section("hand_valve", "check_valve"))).toEqual([]);
    expect(trapped(section("hand_valve", "check_valve_swing"))).toEqual([]);
  });

  it("stays quiet when a boundary is not a positive isolation valve", () => {
    for (const key of ["regulator", "back_pressure_regulator", "three_way_valve", "excess_flow_valve"]) {
      expect(trapped(section("hand_valve", key))).toEqual([]);
    }
    const custom = section("hand_valve", "hand_valve");
    (custom.items[1] as SymbolItem).symbol = { library: "custom", key: "my_valve", version: 1 };
    expect(trapped(custom)).toEqual([]);
  });

  it("stays quiet when the drawing leaves an end open or unknown", () => {
    // A dangling stub.
    expect(trapped(section("hand_valve", "hand_valve", [lineThrough("stub", [{ x: 80, y: 100 }, { x: 80, y: 80 }], { lineNumber: "103" })]))).toEqual([]);
    // A tee to an off-page connector: the section continues on another sheet.
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("opc", "off_page_connector", { x: 95, y: 80 }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
    // A pass-through component with an unconnected port.
    expect(trapped(section("hand_valve", "hand_valve", [symbolAt("f", "filter", { x: 90, y: 80 }, { tag: "F-1" }), tee("branch", { x: 80, y: 80 })]))).toEqual([]);
    // A quick disconnect can be opened.
    expect(trapped(section("hand_valve", "quick_disconnect"))).toEqual([]);
  });

  it("ignores dead legs behind a single valve and capped stubs count as closed", () => {
    const deadLeg = section("hand_valve", "cap");
    deadLeg.items = deadLeg.items.filter((entry) => entry.id !== "down" && entry.id !== "dst");
    expect(trapped(deadLeg)).toEqual([]);
    // A capped branch on a two-valve section does not open it.
    const capped = section("hand_valve", "hand_valve", [symbolAt("cap", "cap", { x: 90, y: 80 }), tee("branch", { x: 80, y: 80 })]);
    expect(trapped(capped)).toHaveLength(1);
  });

  it("ignores signal lines and can be waived by key", () => {
    const doc = section("hand_valve", "hand_valve");
    (doc.items.find((entry) => entry.id === "mid") as LineItem).lineType = "signal_electric";
    expect(trapped(doc)).toEqual([]);
    const waived = runDrc({ doc: section("hand_valve", "hand_valve"), registry, tagScheme: DEFAULT_TAG_SCHEME, waivers: [{ key: "trapped_volume:mid", reason: "Gas service, vented by procedure" }] });
    expect(waived.findings.some((finding) => finding.rule === "trapped_volume")).toBe(false);
    expect(waived.waived.map((finding) => finding.key)).toContain("trapped_volume:mid");
  });

  it("does not fire on the clean reference sheet", () => {
    const doc = cleanDocument();
    expect(trappedVolumes(doc, registry, computeConnectivity(doc, registry))).toEqual([]);
  });
});

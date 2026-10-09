import { describe, expect, it } from "vitest";
import { allFittings, buildFitting, normalizeConfig, parseQuery, searchFittings } from "./swagelok";

const first = (text: string) => searchFittings(text).results[0];

describe("Swagelok ordering numbers", () => {
  it.each([
    [{ kind: "union", material: "SS", tube: "1/4in" }, "SS-400-6"],
    [{ kind: "union_tee", material: "SS", tube: "1/4in" }, "SS-400-3"],
    [{ kind: "union_elbow", material: "B", tube: "3/8in" }, "B-600-9"],
    [{ kind: "union_cross", material: "SS", tube: "1/2in" }, "SS-810-4"],
    [{ kind: "bulkhead_union", material: "SS", tube: "1/4in" }, "SS-400-61"],
    [{ kind: "reducing_union", material: "SS", tube: "3/8in", tube2: "1/4in" }, "SS-600-6-4"],
    [{ kind: "male_connector", material: "SS", tube: "1/4in", pipe: "1/4in", thread: "NPT" }, "SS-400-1-4"],
    [{ kind: "male_connector", material: "SS", tube: "3/8in", pipe: "3/4in", thread: "ISO_T" }, "SS-600-1-12RT"],
    [{ kind: "female_connector", material: "SS", tube: "1/2in", pipe: "1/4in", thread: "ISO_T" }, "SS-810-7-4RT"],
    [{ kind: "female_connector", material: "SS", tube: "1/8in", pipe: "1/4in", thread: "ISO_P" }, "SS-200-7-4RG"],
    [{ kind: "male_elbow", material: "SS", tube: "3/8in", pipe: "1/4in", thread: "NPT" }, "SS-600-2-4"],
    [{ kind: "male_branch_tee", material: "SS", tube: "1/4in", pipe: "1/4in", thread: "NPT" }, "SS-400-3-4TTM"],
    [{ kind: "female_run_tee", material: "SS", tube: "1/4in", pipe: "1/4in", thread: "NPT" }, "SS-400-3-4TFT"],
    [{ kind: "tube_adapter_male", material: "SS", tube: "1/4in", pipe: "1/4in", thread: "NPT" }, "SS-4-TA-1-4"],
    [{ kind: "cap", material: "SS", tube: "6mm" }, "SS-6M0-C"],
    [{ kind: "nut", material: "SS", tube: "1/4in" }, "SS-402-1"],
    [{ kind: "front_ferrule", material: "SS", tube: "1/2in" }, "SS-813-1"],
    [{ kind: "back_ferrule", material: "SS", tube: "6mm" }, "SS-6M4-1"],
    [{ kind: "ferrule_set", material: "SS", tube: "1/4in" }, "SS-400-SET"]
  ] as const)("%o is %s", (config, partNumber) => {
    expect(buildFitting(config)?.partNumber).toBe(partNumber);
  });

  it("refuses combinations outside the ordering rules", () => {
    expect(buildFitting({ kind: "male_connector", material: "SS", tube: "1/16in", pipe: "1in", thread: "NPT" })).toBeNull();
    expect(buildFitting({ kind: "male_connector", material: "SS", tube: "1/4in", pipe: "1/4in", thread: "ISO_P" })).toBeNull();
    expect(buildFitting({ kind: "reducing_union", material: "SS", tube: "1/4in", tube2: "3/8in" })).toBeNull();
    expect(buildFitting({ kind: "tube_adapter_male", material: "SS", tube: "6mm", pipe: "1/4in", thread: "NPT" })).toBeNull();
  });

  it("describes a fitting the way Swagelok does and never invents a pressure", () => {
    const fitting = buildFitting({ kind: "male_elbow", material: "SS", tube: "3/8in", pipe: "1/4in", thread: "NPT" });
    expect(fitting?.description).toBe("Stainless Steel Swagelok Tube Fitting, Male Elbow, 3/8 in. Tube OD x 1/4 in. Male NPT");
    expect(fitting?.ends.map((end) => end.type)).toEqual(["tube", "male"]);
    const pressure = fitting?.specs.find((row) => row.label === "Pressure rating");
    expect(pressure?.value).toBe("Rated to the tubing");
  });

  it("keeps every generated ordering number unique within a material", () => {
    const numbers = allFittings("SS").map((fitting) => fitting.partNumber);
    expect(numbers.length).toBeGreaterThan(500);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("normalizes a configuration after a field change", () => {
    // 1/16 in. tube cannot take a 1 in. thread: the nearest valid thread size is picked.
    expect(normalizeConfig({ kind: "male_connector", material: "SS", tube: "1/16in", pipe: "1in", thread: "NPT" })).toEqual({
      kind: "male_connector",
      material: "SS",
      tube: "1/16in",
      pipe: "1/16in",
      thread: "NPT"
    });
    // Switching a reducing union's large end below the small end picks a new small end.
    expect(normalizeConfig({ kind: "reducing_union", material: "SS", tube: "1/4in", tube2: "1/2in" }).tube2).toBe("1/8in");
  });
});

describe("reading a description", () => {
  it("separates tube and thread sizes", () => {
    const query = parseQuery("3/8 tube to 1/4 male NPT elbow");
    expect(query.tubes.map((tube) => tube.id)).toEqual(["3/8in"]);
    expect(query.pipe?.id).toBe("1/4in");
    expect(query.gender).toBe("male");
    expect(query.kinds).toEqual(["male_elbow"]);
  });

  it("reads materials, metric sizes, and ISO threads", () => {
    const query = parseQuery("brass 6 mm female connector 1/4 BSPT");
    expect(query.material).toBe("B");
    expect(query.tubes[0]?.id).toBe("6mm");
    expect(query.thread).toBe("ISO_T");
    expect(query.kinds).toEqual(["female_connector"]);
  });

  it("does not read the 316 of a material or a 90° angle as a size", () => {
    const query = parseQuery("316 stainless 90° elbow 1/2\"");
    expect(query.material).toBe("SS");
    expect(query.tubes.map((tube) => tube.id)).toEqual(["1/2in"]);
    expect(query.warnings).toEqual([]);
  });

  it("finds the best match first", () => {
    expect(first("1/4 union tee")?.partNumber).toBe("SS-400-3");
    expect(first("3/8 x 1/4 reducing union")?.partNumber).toBe("SS-600-6-4");
    expect(first("1/2 tube to 1/2 male npt connector")?.partNumber).toBe("SS-810-1-8");
    expect(first("1/4in cap brass")?.partNumber).toBe("B-400-C");
    expect(first("ferrule set 1/4")?.partNumber).toBe("SS-400-SET");
    expect(first("1/4 tube x 1/8 female npt branch tee")?.partNumber).toBe("SS-400-3-2TTF");
    expect(first('1/2" 90° elbow')?.partNumber).toBe("SS-810-9");
  });

  it("looks up ordering numbers, exact match first", () => {
    const result = searchFittings("ss-400-1-4");
    expect(result.results[0]?.partNumber).toBe("SS-400-1-4");
    expect(result.results.map((fitting) => fitting.partNumber)).toContain("SS-400-1-4RT");
    expect(searchFittings("XX-400-6").message).toMatch(/not a Swagelok material prefix/);
  });

  it("explains a description it cannot use", () => {
    expect(searchFittings("valve").message).toMatch(/Name a fitting type/);
    expect(searchFittings("").results).toEqual([]);
  });
});

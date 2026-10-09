import { describe, expect, it } from "vitest";
import { compileFilter, parseCellText, sortRows } from "./gridModel";
import type { DataGridColumn } from "./types";
import { naturalCompare, parseTsv, spreadsheetSafe, toCsv, toTsv } from "./utils";

describe("naturalCompare", () => {
  it("orders tag numbers numerically", () => {
    const tags = ["HV-10", "HV-2", "hv-1", "PT-100", "PT-20", "HV-2A"];
    expect([...tags].sort(naturalCompare)).toEqual(["hv-1", "HV-2", "HV-2A", "HV-10", "PT-20", "PT-100"]);
  });

  it("is total: case variants tie-break deterministically", () => {
    expect(naturalCompare("a", "A")).not.toBe(0);
    expect(Math.sign(naturalCompare("a", "A"))).toBe(-Math.sign(naturalCompare("A", "a")));
  });
});

describe("parseTsv", () => {
  it("splits tabs and CRLF rows and drops the trailing newline", () => {
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("handles quoted cells with tabs, newlines and escaped quotes", () => {
    expect(parseTsv('"x\ty"\t"line1\nline2"\t"say ""hi"""\nplain\t2" pipe\t\n')).toEqual([
      ["x\ty", "line1\nline2", 'say "hi"'],
      ["plain", '2" pipe', ""]
    ]);
  });

  it("keeps empty cells and a lone empty line", () => {
    expect(parseTsv("\t\n")).toEqual([["", ""]]);
    expect(parseTsv("\r\n")).toEqual([[""]]);
    expect(parseTsv("")).toEqual([]);
  });

  it("treats an unterminated quote as literal text", () => {
    expect(parseTsv('"abc\tdef')).toEqual([['"abc', "def"]]);
  });

  it("round-trips with toTsv", () => {
    const block = [
      ["a\tb", '"quoted"', "multi\nline"],
      ["", "x", "3"]
    ];
    expect(parseTsv(toTsv(block))).toEqual(block);
  });
});

describe("toCsv", () => {
  it("escapes formula injection on strings but not numbers", () => {
    const csv = toCsv([
      ["Tag", "Note", "Qty"],
      ["=SUM(A1)", "+1", -3],
      ["@cmd", "-x", 4.5],
      ["\tlead", "ok", null]
    ]);
    expect(csv).toBe(["Tag,Note,Qty", "'=SUM(A1),'+1,-3", "'@cmd,'-x,4.5", "'\tlead,ok,", ""].join("\r\n"));
  });

  it("quotes commas, quotes and newlines", () => {
    expect(toCsv([["a,b", 'say "hi"', "l1\nl2", true]])).toBe('"a,b","say ""hi""","l1\nl2",TRUE\r\n');
  });

  it("matches the backend spreadsheet_safe rule", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(spreadsheetSafe(`${lead}x`)).toBe(`'${lead}x`);
    expect(spreadsheetSafe("x=1")).toBe("x=1");
  });
});

interface Row {
  tag: string;
  qty: number | null;
  status: string | null;
}

const columns: DataGridColumn<Row>[] = [
  { key: "tag", header: "Tag" },
  { key: "qty", header: "Qty", type: "number" },
  { key: "status", header: "Status", type: "enum", options: [{ value: "draft", label: "Draft" }, "released"] }
];

describe("gridModel", () => {
  it("parses per column type", () => {
    expect(parseCellText(columns[1], " 1,250.5 ", {} as Row)).toBe(1250.5);
    expect(parseCellText(columns[1], "", {} as Row)).toBeNull();
    expect(() => parseCellText(columns[1], "abc", {} as Row)).toThrow(/not a number/);
    expect(parseCellText(columns[2], "DRAFT", {} as Row)).toBe("draft");
    expect(() => parseCellText(columns[2], "nope", {} as Row)).toThrow(/not one of/);
    const bool: DataGridColumn<Row> = { key: "b", header: "B", type: "boolean" };
    expect(parseCellText(bool, "Yes", {} as Row)).toBe(true);
    expect(parseCellText(bool, "FALSE", {} as Row)).toBe(false);
    const date: DataGridColumn<Row> = { key: "d", header: "D", type: "date" };
    expect(parseCellText(date, "2026-02-03", {} as Row)).toBe("2026-02-03");
    expect(() => parseCellText(date, "2026-02-31", {} as Row)).toThrow(/valid date/);
  });

  it("sorts blanks last in both directions", () => {
    const rows: Row[] = [
      { tag: "A", qty: null, status: null },
      { tag: "B", qty: 2, status: null },
      { tag: "C", qty: 10, status: null }
    ];
    expect(sortRows(rows, columns, [{ key: "qty", dir: "asc" }]).map((row) => row.tag)).toEqual(["B", "C", "A"]);
    expect(sortRows(rows, columns, [{ key: "qty", dir: "desc" }]).map((row) => row.tag)).toEqual(["C", "B", "A"]);
  });

  it("supports filter operators", () => {
    const row = (qty: number | null): Row => ({ tag: "T", qty, status: null });
    const gt = compileFilter(columns[1], { kind: "text", text: ">5" })!;
    expect([gt(row(6)), gt(row(5)), gt(row(null))]).toEqual([true, false, false]);
    const range = compileFilter(columns[1], { kind: "text", text: "2..4" })!;
    expect([range(row(2)), range(row(4)), range(row(5))]).toEqual([true, true, false]);
    const blank = compileFilter(columns[1], { kind: "text", text: "=" })!;
    expect([blank(row(null)), blank(row(1))]).toEqual([true, false]);
    const exact = compileFilter(columns[0], { kind: "text", text: "=t" })!;
    expect(exact(row(1))).toBe(true);
  });
});

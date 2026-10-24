import { describe, expect, it } from "vitest";
import { otherSheetsMatchSiblings, type SheetDoc } from "./connectors";
import { createEmptyDocument } from "./types";

function sheet(id: string, sheetNo: number): SheetDoc {
  return { sheetId: id, sheetNo, doc: createEmptyDocument() };
}

describe("otherSheetsMatchSiblings", () => {
  it("accepts the exact sibling set", () => {
    expect(otherSheetsMatchSiblings([sheet("sh2", 2), sheet("sh3", 3)], ["sh2", "sh3"])).toBe(true);
    expect(otherSheetsMatchSiblings([], [])).toBe(true);
  });

  it("rejects missing, extra, duplicate, or foreign sheets", () => {
    expect(otherSheetsMatchSiblings([sheet("sh2", 2)], ["sh2", "sh3"])).toBe(false);
    expect(otherSheetsMatchSiblings([sheet("sh2", 2), sheet("sh3", 3)], ["sh2"])).toBe(false);
    expect(otherSheetsMatchSiblings([sheet("sh2", 2), sheet("sh2", 2)], ["sh2"])).toBe(false);
    expect(otherSheetsMatchSiblings([sheet("shX", 9)], ["sh2"])).toBe(false);
    expect(otherSheetsMatchSiblings([{ sheetNo: 2, doc: createEmptyDocument() }], ["sh2"])).toBe(false);
  });
});

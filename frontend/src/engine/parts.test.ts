import { describe, expect, it } from "vitest";
import { partWarnings, pressureToBar } from "./parts";
import type { LineItem } from "./types";

function close(value: number | null, expected: number) {
  expect(value).not.toBeNull();
  expect(value as number).toBeCloseTo(expected, 6);
}

describe("pressureToBar", () => {
  it("reads bar variants and bare numbers as bar", () => {
    close(pressureToBar("150 bar"), 150);
    close(pressureToBar("10 barg"), 10);
    close(pressureToBar("10 bara"), 10);
    close(pressureToBar("200"), 200);
    close(pressureToBar("1.5 bar(g)"), 1.5);
  });

  it("does not read mbar as bar", () => {
    close(pressureToBar("10 mbar"), 0.01);
    close(pressureToBar("500mbarg"), 0.5);
  });

  it("converts psi, kPa, MPa, Pa, and atm", () => {
    close(pressureToBar("100 psi"), 6.89476);
    close(pressureToBar("2500 psig"), 172.369);
    close(pressureToBar("14.7 psia"), 1.01353);
    close(pressureToBar("250 kPa"), 2.5);
    close(pressureToBar("1.5 MPa"), 15);
    close(pressureToBar("100000 Pa"), 1);
    close(pressureToBar("2 atm"), 2.0265);
  });

  it("treats a comma before three digits as a thousands separator", () => {
    close(pressureToBar("1,000 psig"), 68.9476);
    close(pressureToBar("1,000.5 bar"), 1000.5);
    close(pressureToBar("1,000,000 Pa"), 10);
  });

  it("treats other commas as a decimal comma", () => {
    close(pressureToBar("2,5 bar"), 2.5);
    close(pressureToBar("1,25 MPa"), 12.5);
    close(pressureToBar("0,125 bar"), 0.125);
  });

  it("returns null for unknown units and unreadable text", () => {
    expect(pressureToBar("10 furlongs")).toBeNull();
    expect(pressureToBar("high")).toBeNull();
    expect(pressureToBar("")).toBeNull();
    expect(pressureToBar(null)).toBeNull();
  });

  it("flags an under-rated part against a thousands-separated design pressure", () => {
    const line = { designPressure: "1,000 psig" } as LineItem;
    const warnings = partWarnings({ id: "p", part_number: "V-1", pressure_rating_bar: 50, preferred: true, material: "316" }, [line]);
    expect(warnings.some((warning) => warning.startsWith("Rated 50 bar"))).toBe(true);
  });
});

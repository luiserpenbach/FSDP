/**
 * Nominal size parsing for design rule checks: `1/4"`, `1/4 in`, `1-1/2"`,
 * `0.5"`, `6 mm`, `DN6`, `1/2" NPT` all resolve to inches so line and port
 * sizes can be compared regardless of how they were typed.
 */

const MM_PER_INCH = 25.4;

/** Nominal size in inches, or null when the text carries no size. */
export function parseSizeInches(text: string | null | undefined): number | null {
  if (!text) return null;
  const value = text.trim();
  const mm = /(\d+(?:[.,]\d+)?)\s*mm\b/i.exec(value);
  if (mm) return Number(mm[1].replace(",", ".")) / MM_PER_INCH;
  const dn = /\bDN\s*(\d+)/i.exec(value);
  if (dn) return Number(dn[1]) / MM_PER_INCH;
  const mixed = /(\d+)[\s-]+(\d+)\s*\/\s*(\d+)/.exec(value);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /(\d+)\s*\/\s*(\d+)/.exec(value);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  const decimal = /(\d+(?:[.,]\d+)?)/.exec(value);
  if (decimal) return Number(decimal[1].replace(",", "."));
  return null;
}

/** True when both sizes parse and differ by more than 2%. */
export function sizesDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseSizeInches(a);
  const right = parseSizeInches(b);
  if (left === null || right === null) return false;
  return Math.abs(left - right) > 0.02 * Math.max(left, right, 1e-9);
}

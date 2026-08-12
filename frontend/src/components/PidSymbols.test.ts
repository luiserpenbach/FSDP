import { describe, expect, it } from "vitest";
import { importSvgMarkup } from "./pid/SymbolEditorModal";
import {
  PALETTE_SYMBOLS,
  SYMBOL_PORTS,
  customSymbolId,
  customSymbolType,
  parseViewBox
} from "./PidSymbols";

describe("symbol ports", () => {
  it("declares at least one port for every palette symbol", () => {
    for (const symbol of PALETTE_SYMBOLS) {
      expect(SYMBOL_PORTS[symbol]?.length, symbol).toBeGreaterThan(0);
    }
  });

  it("keeps all port coordinates inside the shared viewBox", () => {
    const viewBox = parseViewBox(undefined);
    for (const [symbol, ports] of Object.entries(SYMBOL_PORTS)) {
      for (const port of ports) {
        expect(port.x, `${symbol}:${port.id} x`).toBeGreaterThanOrEqual(viewBox.x);
        expect(port.x, `${symbol}:${port.id} x`).toBeLessThanOrEqual(viewBox.x + viewBox.width);
        expect(port.y, `${symbol}:${port.id} y`).toBeGreaterThanOrEqual(viewBox.y);
        expect(port.y, `${symbol}:${port.id} y`).toBeLessThanOrEqual(viewBox.y + viewBox.height);
      }
    }
  });

  it("gives ports unique ids per symbol", () => {
    for (const [symbol, ports] of Object.entries(SYMBOL_PORTS)) {
      const ids = ports.map((port) => port.id);
      expect(new Set(ids).size, symbol).toBe(ids.length);
    }
  });
});

describe("custom symbol types", () => {
  it("round-trips a symbol id through the custom type prefix", () => {
    expect(customSymbolId(customSymbolType("abc-123"))).toBe("abc-123");
    expect(customSymbolId("valve")).toBeNull();
  });
});

describe("importSvgMarkup", () => {
  it("wraps bare path elements in the default viewBox", () => {
    const result = importSvgMarkup('<path d="M2 20 H62" />');
    expect(result.viewBox).toBe("0 0 64 40");
    expect(result.inner).toContain("path");
  });

  it("keeps the source viewBox of a full svg document", () => {
    const result = importSvgMarkup('<svg viewBox="0 0 100 50"><circle cx="50" cy="25" r="10" /></svg>');
    expect(result.viewBox).toBe("0 0 100 50");
    expect(result.inner).toContain("circle");
  });

  it("strips scripts and event handler attributes", () => {
    const result = importSvgMarkup(
      '<svg viewBox="0 0 64 40"><script>alert(1)</script><rect width="4" height="4" onclick="alert(1)" /></svg>'
    );
    expect(result.inner).not.toContain("script");
    expect(result.inner).not.toContain("onclick");
  });

  it("rejects markup with no drawable content", () => {
    expect(() => importSvgMarkup('<svg viewBox="0 0 64 40"><script>x</script></svg>')).toThrow();
  });
});

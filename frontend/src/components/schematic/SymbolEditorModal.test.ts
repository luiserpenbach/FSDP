import { describe, expect, it } from "vitest";
import { sanitizeSvgInner } from "../../engine/svgSanitize";
import {
  buildSafeCombinedSvg,
  centerOffsetLabel,
  importSvgMarkup,
  linePath,
  normalizedRect,
  parseViewBox,
  serializeShape,
  zoomedViewBox
} from "./SymbolEditorModal";

/** An Inkscape-saved symbol: editor namespaces, metadata, comments, and non-presentation style properties. */
const INKSCAPE_SYMBOL = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!-- Created with Inkscape (http://www.inkscape.org/) -->",
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
  ' xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
  ' xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"',
  ' width="64mm" height="40mm" viewBox="0 0 64 40" inkscape:version="1.3" sodipodi:docname="sensor.svg">',
  '<sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="8" />',
  '<metadata id="metadata5"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format></cc:Work></rdf:RDF></metadata>',
  "<!-- drawn in Inkscape -->",
  '<g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(0,-2)">',
  '<path style="fill:none;stroke:#000000;stroke-width:2.2;stroke-linecap:round;-inkscape-stroke:none;font-variation-settings:normal" d="M 2,20 H 62" id="path1" sodipodi:nodetypes="cc" inkscape:connector-curvature="0" />',
  '<circle cx="32" cy="20" r="8" id="c1" data-name="body" xlink:href="#path1" />',
  '<text xml:space="preserve" x="28" y="24" style="font-size:6px;line-height:1.25;font-family:sans-serif" id="t1"><tspan sodipodi:role="line" id="ts1" x="28" y="24">PT</tspan></text>',
  "</g>",
  "</svg>"
].join("");

/**
 * What the editor uploads for INKSCAPE_SYMBOL. The backend test
 * test_symbol_accepts_editor_output_for_inkscape_markup (tests/test_symbols.py)
 * posts this exact markup; keep the two in step.
 */
const INKSCAPE_SYMBOL_CLEANED =
  '<g xmlns="http://www.w3.org/2000/svg" id="layer1" transform="translate(0,-2)">' +
  '<path style="fill:none;stroke:#000000;stroke-width:2.2;stroke-linecap:round" d="M 2,20 H 62" id="path1"/>' +
  '<circle cx="32" cy="20" r="8" id="c1" href="#path1"/>' +
  '<text xml:space="preserve" x="28" y="24" style="font-size:6px;font-family:sans-serif" id="t1"><tspan id="ts1" x="28" y="24">PT</tspan></text>' +
  "</g>";

describe("parseViewBox", () => {
  it("parses four numbers and falls back to the default box", () => {
    expect(parseViewBox("-10 -5 20 10")).toEqual({ x: -10, y: -5, width: 20, height: 10 });
    expect(parseViewBox("0,0,0,10")).toEqual({ x: 0, y: 0, width: 64, height: 40 });
    expect(parseViewBox(undefined)).toEqual({ x: 0, y: 0, width: 64, height: 40 });
  });
});

describe("Inkscape import", () => {
  it("drops editor metadata so the saved markup passes the server allowlist", () => {
    const { viewBox, inner } = importSvgMarkup(INKSCAPE_SYMBOL);
    expect(viewBox).toBe("0 0 64 40");
    const saved = buildSafeCombinedSvg(inner, []);
    expect(saved).toBe(INKSCAPE_SYMBOL_CLEANED);
    // No namespaced elements or attributes survive except xml:space, which the server allows.
    expect(saved).not.toMatch(/<\/?[\w-]+:/);
    expect([...saved.matchAll(/\s([\w-]+):[\w-]+=/g)].map((match) => match[1])).toEqual(["xml"]);
    expect(saved).not.toMatch(/xmlns:|metadata|namedview|<!--|data-name|inkscape|sodipodi/);
  });

  it("parses pasted fragments that use editor prefixes without declaring them", () => {
    const { inner } = importSvgMarkup('<path inkscape:label="stub" sodipodi:nodetypes="cc" d="M2 20 H62"/>');
    expect(buildSafeCombinedSvg(inner, [])).toBe('<path xmlns="http://www.w3.org/2000/svg" d="M2 20 H62"/>');
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

  it("strips nested-SVG and SMIL vectors that bypassed script/onload checks", () => {
    const result = importSvgMarkup(
      [
        '<svg viewBox="0 0 64 40">',
        '<path d="M2 20 H62" />',
        '<use href="data:image/svg+xml;base64,PHN2Zz4=" />',
        '<set attributeName="onload" to="alert(1)"/>',
        '<style>@import "https://evil.example/x.css"</style>',
        "</svg>"
      ].join("")
    );
    expect(result.inner).toContain("path");
    expect(result.inner.toLowerCase()).not.toContain("<use");
    expect(result.inner.toLowerCase()).not.toContain("<set");
    expect(result.inner.toLowerCase()).not.toContain("<style");
    expect(result.inner.toLowerCase()).not.toContain("data:");
  });

  it("sanitizeSvgInner clears active content for render-time defense", () => {
    const cleaned = sanitizeSvgInner(
      '<path d="M0 0 H10" /><image href="data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E" />'
    );
    expect(cleaned).toContain("path");
    expect(cleaned.toLowerCase()).not.toContain("<image");
    expect(cleaned.toLowerCase()).not.toContain("data:");
  });

  it("rejects markup with no drawable content", () => {
    expect(() => importSvgMarkup('<svg viewBox="0 0 64 40"><script>x</script></svg>')).toThrow();
  });
});

describe("linePath", () => {
  it("builds an absolute move/line path from clicked vertices", () => {
    expect(linePath([{ x: 2, y: 4 }, { x: 10, y: 4 }, { x: 10, y: 20 }])).toBe("M 2 4 L 10 4 L 10 20");
  });

  it("drops the duplicate vertex left behind by a finishing double-click", () => {
    expect(linePath([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 0 }])).toBe("M 0 0 L 8 0");
  });

  it("returns null when fewer than two distinct points remain", () => {
    expect(linePath([])).toBeNull();
    expect(linePath([{ x: 4, y: 4 }])).toBeNull();
    expect(linePath([{ x: 4, y: 4 }, { x: 4, y: 4 }])).toBeNull();
  });
});

describe("normalizedRect", () => {
  it("normalizes a negative drag into a positive rect", () => {
    expect(normalizedRect({ x: 20, y: 30 }, { x: 4, y: 10 })).toEqual({ x: 4, y: 10, width: 16, height: 20 });
  });

  it("rejects rects under two units on either side", () => {
    expect(normalizedRect({ x: 0, y: 0 }, { x: 1, y: 40 })).toBeNull();
    expect(normalizedRect({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe("serializeShape", () => {
  it("omits stroke attributes on default shapes so they inherit currentColor", () => {
    expect(serializeShape({ kind: "rect", x: 2, y: 4, width: 10, height: 6 })).toBe(
      '<rect x="2" y="4" width="10" height="6" />'
    );
    expect(serializeShape({ kind: "path", d: "M 0 0 L 8 0" })).toBe('<path d="M 0 0 L 8 0" />');
  });

  it("carries explicit color and stroke width", () => {
    expect(serializeShape({ kind: "circle", cx: 0, cy: 2, r: 5, color: "#2257c4", strokeWidth: 1.4 })).toBe(
      '<circle cx="0" cy="2" r="5" stroke="#2257c4" stroke-width="1.4" />'
    );
    expect(serializeShape({ kind: "path", d: "M 0 0 L 8 0", strokeWidth: 3.2 })).toBe(
      '<path d="M 0 0 L 8 0" stroke-width="3.2" />'
    );
  });
});

describe("buildSafeCombinedSvg", () => {
  it("joins imported markup with serialized drawn shapes for save", () => {
    const combined = buildSafeCombinedSvg('<path d="M2 20 H62" />', [
      { kind: "circle", cx: 32, cy: 20, r: 4 }
    ]);
    expect(combined).toContain('d="M2 20 H62"');
    expect(combined).toContain('cx="32"');
    expect(combined).toContain('cy="20"');
    expect(combined).toContain('r="4"');
    expect(combined).toBeTruthy();
  });

  it("returns empty when there is nothing to save", () => {
    expect(buildSafeCombinedSvg("", [])).toBe("");
  });

  it("strips active content before persistence", () => {
    const combined = buildSafeCombinedSvg(
      '<path d="M0 0 H10" /><script>alert(1)</script>',
      [{ kind: "path", d: "M 0 0 L 8 0" }]
    );
    expect(combined.toLowerCase()).not.toContain("<script");
    expect(combined).toContain('d="M0 0 H10"');
    expect(combined).toContain('d="M 0 0 L 8 0"');
  });
});

describe("centerOffsetLabel", () => {
  it("reports the cursor relative to the viewBox center with signed offsets", () => {
    const viewBox = { x: 0, y: 0, width: 64, height: 40 };
    expect(centerOffsetLabel({ x: 44, y: 16 }, viewBox)).toBe("x +12 · y −4");
    expect(centerOffsetLabel({ x: 32, y: 20 }, viewBox)).toBe("x +0 · y +0");
  });

  it("honors a non-zero viewBox origin", () => {
    expect(centerOffsetLabel({ x: 0, y: 0 }, { x: -20, y: -10, width: 40, height: 20 })).toBe("x +0 · y +0");
  });
});

describe("zoomedViewBox", () => {
  it("windows the viewBox around its center when zooming in", () => {
    expect(zoomedViewBox({ x: 0, y: 0, width: 64, height: 40 }, 2)).toEqual({ x: 16, y: 10, width: 32, height: 20 });
  });

  it("returns the original box at 100%", () => {
    expect(zoomedViewBox({ x: -20, y: -10, width: 40, height: 20 }, 1)).toEqual({ x: -20, y: -10, width: 40, height: 20 });
  });

  it("expands the window around the same center when zooming out", () => {
    expect(zoomedViewBox({ x: 0, y: 0, width: 64, height: 40 }, 0.5)).toEqual({ x: -32, y: -20, width: 128, height: 80 });
  });
});

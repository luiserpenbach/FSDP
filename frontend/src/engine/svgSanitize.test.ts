import { describe, expect, it } from "vitest";
import { customSymbolDef, SymbolRegistry } from "./library";
import { symbolAt } from "./fixtures";
import { renderItem } from "./render";
import { sanitizeSvgInner, scrubSvgElement } from "./svgSanitize";
import type { PidSymbolDef } from "../types";

/** Paint sanitized markup the way the canvas does (innerHTML into an SVG <g>) and collect what became live. */
function paint(markup: string): { html: string; elements: string[]; handlers: string[] } {
  const host = document.createElementNS("http://www.w3.org/2000/svg", "g");
  document.createElementNS("http://www.w3.org/2000/svg", "svg").appendChild(host);
  host.innerHTML = markup;
  const elements = [...host.querySelectorAll("*")].map((element) => element.localName.toLowerCase());
  const handlers = [...host.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].filter((attribute) => attribute.name.toLowerCase().startsWith("on")).map((attribute) => attribute.name)
  );
  return { html: host.innerHTML, elements, handlers };
}

const PAYLOADS: Record<string, string> = {
  "slash-separated img onerror": "<img/src=x/onerror=alert(1)>",
  "well-formed img onerror": '<img src="x" onerror="alert(1)"/>',
  "xhtml img": '<img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="alert(1)"/>',
  foreignObject: '<foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject>',
  script: "<script>alert(1)</script>",
  "javascript href": '<a href="javascript:alert(1)"><text>click</text></a>',
  "set onclick": '<set attributeName="onclick" to="alert(1)"/>',
  "animate href": '<animate attributeName="href" to="javascript:alert(1)"/>',
  "event attribute": '<path d="M0 0 H10" onclick="alert(1)" onmouseover="alert(1)"/>',
  "use external": '<use href="https://evil.test/x.svg#a"/>',
  style: "<style>path{fill:url(https://evil.test/beacon)}</style>",
  "cdata in desc": "<desc><![CDATA[</desc><img src=x onerror=alert(1)>]]></desc>",
  "cdata in text": "<text><![CDATA[<img src=x onerror=alert(1)>]]></text>",
  "comment breakout": "<desc><!--</desc><img src=x onerror=alert(1)>--></desc>",
  "nested svg onload": '<svg onload="alert(1)"><path d="M0 0"/></svg>'
};

describe("sanitizeSvgInner", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`defeats ${name}`, () => {
      const cleaned = sanitizeSvgInner(`<path d="M0 0 H10"/>${payload}`);
      const painted = paint(cleaned);
      expect(painted.handlers).toEqual([]);
      for (const element of painted.elements) expect(["path", "text", "svg"]).toContain(element);
      expect(cleaned.toLowerCase()).not.toMatch(/javascript:|<script|<img|<foreignobject|<set|<animate|<use|<style|<a[\s>]|<!\[cdata|<!--|<desc|https:/);
    });
  }

  it("keeps drawing markup, local references, and text", () => {
    const cleaned = sanitizeSvgInner(
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><path d="M0 0 H10" fill="url(#g)"/><circle cx="5" cy="5" r="2"/><text x="1" y="2">P &amp; T &lt;1&gt;</text>'
    );
    const painted = paint(cleaned);
    expect(painted.elements).toEqual(["defs", "lineargradient", "stop", "path", "circle", "text"]);
    expect(cleaned).toContain('fill="url(#g)"');
    expect(painted.html).toContain("P &amp; T &lt;1&gt;");
  });

  it("drops external url() references and script URLs in any attribute", () => {
    const cleaned = sanitizeSvgInner('<path d="M0 0" fill="url(https://evil.test/x)" style="fill: url( \'http://evil.test\' )" stroke="java&#9;script:alert(1)"/>');
    expect(cleaned).toMatch(/^<path [^>]*d="M0 0"\/>$/);
    expect(cleaned).not.toMatch(/fill|style|stroke|script/);
  });

  it("returns nothing for markup that does not parse", () => {
    expect(sanitizeSvgInner("<path d='M0 0'")).toBe("");
    expect(sanitizeSvgInner("   ")).toBe("");
  });

  it("follows the server allowlist: no foreign namespaces, unknown attributes, or non-presentation styles", () => {
    const cleaned = sanitizeSvgInner(
      [
        '<g xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:x="http://www.w3.org/1999/xlink" xmlns:s="http://www.w3.org/2000/svg" inkscape:label="Layer" data-layer="1" id="g1">',
        '<s:path d="M0 0 H10" style="stroke:#000;-inkscape-stroke:none;line-height:1.25" inkscape:connector-curvature="0"/>',
        '<circle r="2" x:href="#g1" class="body" fill="url(#grad)" tabindex="0"/>',
        '<mask id="m"><rect width="4" height="4"/></mask><pattern id="p"><rect width="1" height="1"/></pattern>',
        '<svg viewBox="0 0 4 4"><path d="M1 1"/></svg>',
        '<text xml:space="preserve" font-family="a@b">T</text>',
        "</g>"
      ].join("")
    );
    expect(cleaned).toBe(
      '<g xmlns="http://www.w3.org/2000/svg" id="g1">' +
        '<path d="M0 0 H10" style="stroke:#000"/>' +
        '<circle r="2" class="body" fill="url(#grad)" href="#g1"/>' +
        '<text xml:space="preserve">T</text>' +
        "</g>"
    );
  });

  it("scrubs a root element's own event attributes", () => {
    const root = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><path d="M0 0"/></svg>', "image/svg+xml").documentElement;
    scrubSvgElement(root);
    expect(root.getAttribute("onload")).toBeNull();
    expect(root.getAttribute("viewBox")).toBe("0 0 10 10");
  });
});

describe("custom symbols in the registry", () => {
  const custom: PidSymbolDef = {
    id: "evil",
    name: "Evil valve",
    view_box: "0 0 20 10",
    svg: '<path d="M0 0 H20"/><img/src=x/onerror=alert(1)><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    ports: []
  };

  it("sanitizes stored markup before it reaches the canvas or library panel", () => {
    // The slash-separated payload is not well-formed XML, so the whole body is dropped.
    expect(customSymbolDef(custom).svg).toMatch(/^<g transform="[^"]+" stroke-width="[^"]+"><\/g>$/);
    const wellFormed = customSymbolDef({ ...custom, svg: '<path d="M0 0 H20"/><image href="x" onerror="alert(1)"/><set attributeName="onclick" to="alert(1)"/>' });
    expect(wellFormed.svg).toMatch(/<path [^>]*d="M0 0 H20"\/>/);
    expect(wellFormed.svg).not.toMatch(/image|onerror|<set|onclick/);
    const registry = SymbolRegistry.withBuiltins([{ ...custom, svg: '<path d="M0 0" onclick="alert(1)"/>' }]);
    const ref = { library: "custom", key: "evil", version: 1 };
    expect(paint(registry.resolve(ref).svg).handlers).toEqual([]);
    const rendered = renderItem(symbolAt("x", "evil", { x: 10, y: 10 }, { symbol: ref }), { registry });
    expect(rendered).toContain('d="M0 0"');
    expect(paint(rendered).handlers).toEqual([]);
  });
});
